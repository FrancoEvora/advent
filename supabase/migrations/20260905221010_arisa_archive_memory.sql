begin;
set local lock_timeout='10s';
set local statement_timeout='120s';

create table public.arisa_archive (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  owner_user_id uuid references auth.users(id),
  source text not null, source_id text not null, version_hash text not null,
  channel text not null, kind text not null, author_type text not null,
  subject_key text not null, subject_label text not null default '',
  title text not null, content text not null default '', payload jsonb not null default '{}',
  occurred_at timestamptz not null, created_at timestamptz not null default now(),
  search_vector tsvector generated always as (to_tsvector('portuguese',title||' '||subject_label||' '||left(content,100000))) stored,
  unique(organization_id,source,source_id,version_hash)
);
create index arisa_archive_scope on public.arisa_archive(organization_id,owner_user_id,occurred_at desc,id);
create index arisa_archive_owner on public.arisa_archive(owner_user_id);
create index arisa_archive_subject on public.arisa_archive(organization_id,subject_key,occurred_at desc);
create index arisa_archive_search on public.arisa_archive using gin(search_vector);
alter table public.arisa_archive enable row level security;
revoke all on public.arisa_archive from public,anon,authenticated,service_role;
grant select on public.arisa_archive to authenticated;
grant select,insert on public.arisa_archive to service_role;
create policy arisa_archive_read on public.arisa_archive for select to authenticated using (
  private.arisa_is_admin(organization_id) and (owner_user_id is null or owner_user_id=(select auth.uid()))
);

create table public.arisa_memories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id), owner_user_id uuid references auth.users(id),
  source_event_id uuid not null references public.arisa_archive(id),
  subject_key text not null, subject_label text not null,
  kind text not null check(kind in ('fact','preference','commitment','observation','analysis')),
  topic text not null check(topic in ('project','process','communication','needs','objection','decision_criteria','commitment','relationship')),
  claim text not null check(char_length(claim) between 3 and 1200),
  evidence text not null check(char_length(evidence) between 3 and 2000),
  confidence numeric not null check(confidence between 0 and 1),
  status text not null default 'active' check(status in ('active','rejected','superseded')),
  observed_at timestamptz not null, expires_at timestamptz,
  reviewed_by uuid references auth.users(id), reviewed_at timestamptz, review_note text,
  created_at timestamptz not null default now(),
  search_vector tsvector generated always as(to_tsvector('portuguese',subject_label||' '||claim)) stored,
  unique(source_event_id,claim)
);
create index arisa_memories_scope on public.arisa_memories(organization_id,owner_user_id,status,observed_at desc);
create index arisa_memories_subject on public.arisa_memories(organization_id,subject_key,status);
create index arisa_memories_source on public.arisa_memories(source_event_id);
create index arisa_memories_owner on public.arisa_memories(owner_user_id);
create index arisa_memories_reviewer on public.arisa_memories(reviewed_by);
create index arisa_memories_search on public.arisa_memories using gin(search_vector);
alter table public.arisa_memories enable row level security;
revoke all on public.arisa_memories from public,anon,authenticated,service_role;
grant select on public.arisa_memories to authenticated;
grant select,insert,update on public.arisa_memories to service_role;
create policy arisa_memories_read on public.arisa_memories for select to authenticated using (
  private.arisa_is_admin(organization_id) and (owner_user_id is null or owner_user_id=(select auth.uid()))
);

create table private.arisa_memory_jobs (
  event_id uuid primary key references public.arisa_archive(id),
  status text not null default 'pending' check(status in ('pending','processing','completed','failed')),
  attempts integer not null default 0, lease uuid, lease_until timestamptz,
  available_at timestamptz not null default now(), error_code text,
  model text, usage jsonb, completed_at timestamptz
);
create index arisa_memory_jobs_pending on private.arisa_memory_jobs(available_at) where status in ('pending','processing');
alter table private.arisa_memory_jobs enable row level security;
revoke all on private.arisa_memory_jobs from public,anon,authenticated,service_role;

create function private.arisa_redact(p_value jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare result jsonb; k text; v jsonb;
begin
  if jsonb_typeof(p_value)='object' then
    result:='{}';
    for k,v in select * from jsonb_each(p_value) loop
      result:=result||jsonb_build_object(k,case when k ~* '(password|senha|api.?key|access.?token|refresh.?token|authorization|client.?secret|lease.?token|code_verifier|signed_url|file_data|image_url|encrypted_content)' then '"[REDACTED]"'::jsonb else private.arisa_redact(v) end);
    end loop; return result;
  elsif jsonb_typeof(p_value)='array' then
    select coalesce(jsonb_agg(private.arisa_redact(value)),'[]') into result from jsonb_array_elements(p_value); return result;
  end if;
  return p_value;
end $$;

create function private.arisa_archive_put(p_org uuid,p_owner uuid,p_source text,p_source_id text,p_channel text,p_kind text,p_author text,p_subject text,p_label text,p_title text,p_content text,p_payload jsonb,p_occurred timestamptz,p_learn boolean default false)
returns uuid language plpgsql security definer set search_path='' as $$
declare event_id uuid; clean jsonb:=private.arisa_redact(coalesce(p_payload,'{}')); fingerprint text;
begin
  fingerprint:=encode(extensions.digest(coalesce(p_content,'')||clean::text,'sha256'),'hex');
  insert into public.arisa_archive(organization_id,owner_user_id,source,source_id,version_hash,channel,kind,author_type,subject_key,subject_label,title,content,payload,occurred_at)
    values(p_org,p_owner,p_source,p_source_id,fingerprint,p_channel,p_kind,p_author,p_subject,coalesce(p_label,''),left(p_title,300),coalesce(p_content,''),clean,coalesce(p_occurred,now()))
    on conflict(organization_id,source,source_id,version_hash) do nothing returning id into event_id;
  if event_id is not null and p_learn and length(btrim(coalesce(p_content,'')))>=10 then
    insert into private.arisa_memory_jobs(event_id) values(event_id) on conflict do nothing;
  end if;
  return event_id;
end $$;

create function private.arisa_archive_row(p_source text,r jsonb,p_learn boolean default true)
returns void language plpgsql security definer set search_path='' as $$
declare org uuid:=(r->>'organization_id')::uuid; owner_id uuid; subject text; label text:=''; body text; kind text; author text; channel text; data jsonb; learn boolean:=false;
begin
  if org is null then return; end if;
  if p_source='arisa_chat_messages' then
    owner_id:=(r->>'owner_user_id')::uuid; subject:='user:'||owner_id; label:='Administrador'; channel:='arisa_chat'; kind:='message'; author:=r->>'role'; body:=r->>'content';
    data:=r-'lease_token'-'lease_expires_at'-'updated_at'; learn:=p_learn and ((author='user' and r->>'status'='queued') or (author='assistant' and r->>'status'='completed'));
  elsif p_source='crm_messages' then
    subject:='conversation:'||(r->>'conversation_id');
    select 'crm:'||c.id,c.person_name into subject,label from public.crm_records c where c.id=(r->>'crm_record_id')::uuid and c.organization_id=org;
    subject:=coalesce(subject,'conversation:'||(r->>'conversation_id')); label:=coalesce(label,'Contato ainda não identificado');
    channel:=r->>'channel'; kind:='message'; author:=case when r->>'direction'='inbound' then 'external' else 'crm_'||coalesce(r->>'actor_type','team') end; body:=r->>'content'; data:=r;
    learn:=p_learn and (r->>'direction'='inbound' or r->>'delivery_status' in ('sent','delivered','read'));
  elsif p_source='arisa_chat_files' then
    owner_id:=(r->>'owner_user_id')::uuid; subject:='user:'||owner_id; label:='Administrador'; channel:='arisa_chat'; kind:='file'; author:='user'; body:=r->>'file_name'; data:=r;
  elsif p_source='arisa_chat_actions' then
    owner_id:=(r->>'actor_user_id')::uuid; subject:='user:'||owner_id; label:='Administrador'; channel:='platform'; kind:='action'; author:='arisa'; body:=r->>'summary'; data:=r;
  else
    subject:='organization:'||org; channel:='platform'; kind:=case when p_source='insights' then 'insight' else 'operation' end; author:='arisa'; data:=r-'lease_token'-'lease_expires_at';
    body:=case when p_source='insights' then coalesce(r->>'title','')||E'\n'||data::text else data::text end;
    learn:=p_learn and p_source in ('insights','arisa_operation_items');
  end if;
  perform private.arisa_archive_put(org,owner_id,p_source,r->>'id',coalesce(channel,'platform'),kind,author,subject,label,
    case when p_source='crm_messages' then 'CRM · '||coalesce(label,'Contato') when kind='file' then body else 'Arisa · '||kind end,
    body,data,coalesce((r->>'occurred_at')::timestamptz,(r->>'created_at')::timestamptz,now()),learn);
end $$;

create function private.arisa_archive_capture() returns trigger language plpgsql security definer set search_path='' as $$
declare learn boolean:=tg_op='INSERT'; before_row jsonb; after_row jsonb:=to_jsonb(new);
begin
  if tg_op='UPDATE' then
    before_row:=to_jsonb(old);
    learn:=case when tg_table_name='crm_messages' then (before_row->>'content' is distinct from after_row->>'content') or (before_row->>'delivery_status' not in ('sent','delivered','read') and after_row->>'delivery_status' in ('sent','delivered','read'))
      when tg_table_name='arisa_operation_items' then before_row->'extracted' is distinct from after_row->'extracted'
      else false end;
  end if;
  perform private.arisa_archive_row(tg_table_name,after_row,learn);
  return new;
end $$;
do $$ declare t text; r jsonb; begin
  foreach t in array array['arisa_chat_messages','arisa_chat_files','arisa_chat_actions','arisa_operation_items','arisa_operation_events','crm_messages','insights'] loop
    execute format('create trigger arisa_archive_capture after insert or update on public.%I for each row execute function private.arisa_archive_capture()',t);
    for r in execute format('select to_jsonb(t) from public.%I t',t) loop
      -- Historical user messages are already completed; enqueue their content too.
      perform private.arisa_archive_row(t,r,true);
      if t='arisa_chat_messages' and r->>'role'='user' and r->>'status'<>'queued' then
        insert into private.arisa_memory_jobs(event_id) select id from public.arisa_archive where source=t and source_id=r->>'id' on conflict do nothing;
      end if;
    end loop;
  end loop;
end $$;

create function public.arisa_archive_search(p_organization_id uuid,p_query text default '',p_kind text default null,p_limit integer default 40,p_offset integer default 0)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare rows jsonb; total bigint; q tsquery:=websearch_to_tsquery('portuguese',left(coalesce(p_query,''),300));
begin
  if not private.arisa_is_admin(p_organization_id) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  select count(*) into total from public.arisa_archive a where a.organization_id=p_organization_id and (nullif(p_kind,'') is null or a.kind=p_kind) and (nullif(btrim(p_query),'') is null or a.search_vector@@q);
  select coalesce(jsonb_agg(to_jsonb(a)-'search_vector'),'[]') into rows from (
    select a.* from public.arisa_archive a where a.organization_id=p_organization_id and (nullif(p_kind,'') is null or a.kind=p_kind) and (nullif(btrim(p_query),'') is null or a.search_vector@@q)
    order by a.occurred_at desc,a.id desc limit greatest(1,least(coalesce(p_limit,40),100)) offset greatest(0,least(coalesce(p_offset,0),100000))
  ) a;
  return jsonb_build_object('rows',rows,'total',total);
end $$;

create function public.arisa_recall(p_organization_id uuid,p_query text default '',p_subject text default null,p_limit integer default 20)
returns jsonb language sql stable security invoker set search_path='' as $$
  select coalesce(jsonb_agg(to_jsonb(m)-'search_vector'),'[]') from (
    select m.* from public.arisa_memories m where m.organization_id=p_organization_id and private.arisa_is_admin(p_organization_id)
      and m.status='active' and (m.expires_at is null or m.expires_at>now()) and (p_subject is null or m.subject_key=p_subject)
      and (nullif(btrim(p_query),'') is null or m.search_vector@@websearch_to_tsquery('portuguese',left(p_query,300)))
    order by m.observed_at desc,m.id desc limit greatest(1,least(coalesce(p_limit,20),50))
  ) m;
$$;

create function public.arisa_memory_review(p_memory_id uuid,p_status text,p_note text,p_correction text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.arisa_memories; before_row jsonb;
begin
  select * into m from public.arisa_memories where id=p_memory_id for update;
  if not found or not private.arisa_is_admin(m.organization_id) or (m.owner_user_id is not null and m.owner_user_id<>auth.uid()) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  if p_status not in ('active','rejected') or length(btrim(coalesce(p_note,'')))<3 or length(p_note)>1200 or (p_correction is not null and length(btrim(p_correction)) not between 3 and 1200) then raise exception 'Informe uma justificativa e uma correção válida.'; end if;
  before_row:=to_jsonb(m)-'search_vector';
  update public.arisa_memories set status=p_status,claim=coalesce(nullif(btrim(p_correction),''),claim),reviewed_by=auth.uid(),reviewed_at=now(),review_note=p_note where id=m.id returning * into m;
  perform private.arisa_archive_put(m.organization_id,m.owner_user_id,'memory_review',gen_random_uuid()::text,'platform','review','administrator',m.subject_key,m.subject_label,'Revisão de memória',p_note,jsonb_build_object('before',before_row,'after',to_jsonb(m)-'search_vector','actor',auth.uid()),now(),false);
  return to_jsonb(m)-'search_vector';
end $$;

-- Service-only worker API. Ownership comes from the archived source, never the model.
create function public.arisa_memory_worker(p_action text,p_args jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare job private.arisa_memory_jobs; event public.arisa_archive; item jsonb; n integer:=0; token uuid:=gen_random_uuid();
begin
  if p_action='claim' then
    select j.* into job from private.arisa_memory_jobs j join public.arisa_archive a on a.id=j.event_id join public.organizations o on o.id=a.organization_id
      where o.active and (nullif(p_args->>'organization_id','') is null or a.organization_id=(p_args->>'organization_id')::uuid)
        and j.attempts<6 and j.available_at<=now() and (j.status='pending' or (j.status='processing' and j.lease_until<now()))
      order by a.occurred_at desc,j.event_id for update of j skip locked limit 1;
    if not found then return null; end if;
    update private.arisa_memory_jobs set status='processing',attempts=attempts+1,lease=token,lease_until=now()+interval '3 minutes' where event_id=job.event_id;
    select * into event from public.arisa_archive where id=job.event_id;
    return jsonb_build_object('lease',token,'event',to_jsonb(event)-'search_vector');
  end if;
  select * into job from private.arisa_memory_jobs where event_id=(p_args->>'event_id')::uuid and lease=(p_args->>'lease')::uuid and status='processing' and lease_until>now() for update;
  if not found then raise exception 'MEMORY_LEASE_CHANGED'; end if;
  select * into event from public.arisa_archive where id=job.event_id;
  if p_action='finish' then
    for item in select value from jsonb_array_elements(coalesce(p_args->'memories','[]')) loop
      if n>=8 then exit; end if;
      if length(coalesce(item->>'evidence',''))<3 or position(lower(item->>'evidence') in lower(event.content))=0 then continue; end if;
      if item->>'kind' not in ('fact','preference','commitment','observation','analysis') or item->>'topic' not in ('project','process','communication','needs','objection','decision_criteria','commitment','relationship') then continue; end if;
      if length(coalesce(item->>'claim','')) not between 3 and 1200 or length(item->>'evidence')>2000 then continue; end if;
      if event.author_type not in ('user','external','human','administrator') and (item->>'kind'<>'analysis' or item->>'topic' not in ('project','process')) then continue; end if;
      if item->>'topic' not in ('project','process') and coalesce((item->>'about_speaker')::boolean,false) is not true then continue; end if;
      insert into public.arisa_memories(organization_id,owner_user_id,source_event_id,subject_key,subject_label,kind,topic,claim,evidence,confidence,observed_at,expires_at)
        values(event.organization_id,event.owner_user_id,event.id,case when item->>'topic' in ('project','process') then 'organization:'||event.organization_id else event.subject_key end,
          case when item->>'topic' in ('project','process') then 'Organização' else event.subject_label end,item->>'kind',item->>'topic',item->>'claim',item->>'evidence',
          least(case when item->>'kind' in ('observation','analysis') then 0.75 else 1 end,greatest(0,(item->>'confidence')::numeric)),event.occurred_at,
          case when item->>'kind' in ('observation','analysis') then event.occurred_at+interval '90 days' when item->>'kind'='preference' then event.occurred_at+interval '1 year' else null end)
        on conflict(source_event_id,claim) do nothing;
      n:=n+1;
    end loop;
    update private.arisa_memory_jobs set status='completed',lease=null,lease_until=null,completed_at=now(),model=p_args->>'model',usage=p_args->'usage',error_code=null where event_id=job.event_id;
    perform private.arisa_archive_put(event.organization_id,event.owner_user_id,'memory_job',event.id::text,'platform','log','system',event.subject_key,event.subject_label,'Memória processada','',jsonb_build_object('source_event_id',event.id,'memories',n,'model',p_args->>'model','usage',p_args->'usage'),now(),false);
    return jsonb_build_object('count',n);
  elsif p_action='fail' then
    update private.arisa_memory_jobs set status=case when attempts>=6 then 'failed' else 'pending' end,lease=null,lease_until=null,available_at=now()+interval '5 minutes'*greatest(attempts,1),error_code=left(p_args->>'error',80) where event_id=job.event_id;
    perform private.arisa_archive_put(event.organization_id,event.owner_user_id,'memory_error',gen_random_uuid()::text,'platform','log','system',event.subject_key,event.subject_label,'Falha no processamento da memória','',jsonb_build_object('source_event_id',event.id,'attempt',job.attempts,'error',left(p_args->>'error',80)),now(),false);
    return jsonb_build_object('ok',true);
  end if;
  raise exception 'INVALID_ACTION';
end $$;

create function public.arisa_trace(p_message_id uuid,p_lease uuid,p_event jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare m public.arisa_chat_messages;
begin
  select * into m from public.arisa_chat_messages where id=p_message_id and status='processing' and lease_token=p_lease and lease_expires_at>now();
  if not found then raise exception 'ARISA_LEASE_CHANGED'; end if;
  return private.arisa_archive_put(m.organization_id,m.owner_user_id,'manager_trace',gen_random_uuid()::text,'arisa_chat','log','arisa','user:'||m.owner_user_id,'Administrador','Execução da Arisa',coalesce(p_event->>'text',''),p_event||jsonb_build_object('message_id',m.id,'thread_id',m.thread_id),now(),false);
end $$;

create function public.arisa_create_content(p_organization_id uuid,p_title text,p_content text,p_format text default 'txt') returns jsonb language plpgsql security definer set search_path='' as $$
declare id uuid;
begin
  if not private.arisa_is_admin(p_organization_id) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  if p_format not in ('txt','md','csv','html') or length(btrim(p_title)) not between 1 and 180 or length(p_content) not between 1 and 150000 then raise exception 'Conteúdo inválido.'; end if;
  id:=private.arisa_archive_put(p_organization_id,auth.uid(),'generated_content',gen_random_uuid()::text,'platform','content','arisa','user:'||auth.uid(),'Administrador',p_title,p_content,jsonb_build_object('format',p_format,'file_name',p_title||'.'||p_format),now(),true);
  return jsonb_build_object('id',id,'archive_id',id,'title',p_title,'format',p_format,'saved',true);
end $$;

create function public.arisa_knowledge_status(p_organization_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not private.arisa_is_admin(p_organization_id) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  return jsonb_build_object('archive',(select count(*) from public.arisa_archive where organization_id=p_organization_id and (owner_user_id is null or owner_user_id=auth.uid())),
    'memories',(select count(*) from public.arisa_memories where organization_id=p_organization_id and status='active' and (expires_at is null or expires_at>now()) and (owner_user_id is null or owner_user_id=auth.uid())),
    'queue',(select coalesce(jsonb_object_agg(status,n),'{}') from (select j.status,count(*) n from private.arisa_memory_jobs j join public.arisa_archive a on a.id=j.event_id where a.organization_id=p_organization_id and (a.owner_user_id is null or a.owner_user_id=auth.uid()) group by j.status) x));
end $$;

create function public.arisa_archive_transcription(p_file_id uuid,p_actor uuid,p_text text) returns uuid language plpgsql security definer set search_path='' as $$
declare f public.arisa_chat_files;
begin
  select * into f from public.arisa_chat_files where id=p_file_id and owner_user_id=p_actor;
  if not found or not exists(select 1 from public.organization_members m join public.organizations o on o.id=m.organization_id where m.organization_id=f.organization_id and m.user_id=p_actor and m.active and m.role='admin' and o.active) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  return private.arisa_archive_put(f.organization_id,p_actor,'transcription',f.id::text,'audio','content','arisa','user:'||p_actor,'Administrador','Transcrição · '||f.file_name,p_text,jsonb_build_object('file_id',f.id,'thread_id',f.thread_id,'reviewed',false),now(),false);
end $$;

revoke all on function private.arisa_redact(jsonb),private.arisa_archive_put(uuid,uuid,text,text,text,text,text,text,text,text,text,jsonb,timestamptz,boolean),private.arisa_archive_row(text,jsonb,boolean),private.arisa_archive_capture() from public,anon,authenticated,service_role;
revoke all on function public.arisa_archive_search(uuid,text,text,integer,integer),public.arisa_recall(uuid,text,text,integer),public.arisa_memory_review(uuid,text,text,text),public.arisa_create_content(uuid,text,text,text),public.arisa_memory_worker(text,jsonb),public.arisa_trace(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.arisa_archive_search(uuid,text,text,integer,integer),public.arisa_recall(uuid,text,text,integer),public.arisa_memory_review(uuid,text,text,text),public.arisa_create_content(uuid,text,text,text) to authenticated;
grant execute on function public.arisa_memory_worker(text,jsonb),public.arisa_trace(uuid,uuid,jsonb) to service_role;
revoke all on function public.arisa_knowledge_status(uuid),public.arisa_archive_transcription(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.arisa_knowledge_status(uuid) to authenticated;
grant execute on function public.arisa_archive_transcription(uuid,uuid,text) to service_role;
commit;
