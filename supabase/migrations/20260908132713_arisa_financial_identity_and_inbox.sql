-- Self-scoped Arisa inbox shared by the chat bell and the authenticated manager.
create or replace function public.arisa_my_notifications(p_organization_id uuid,p_limit integer default 20,p_offset integer default 0,p_unread_only boolean default false)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; unread bigint; total bigint;
begin
 if auth.uid() is null or not public.is_org_member(p_organization_id) then raise exception 'MEMBER_REQUIRED' using errcode='42501'; end if;
 select count(*),count(*) filter(where read_at is null) into total,unread from public.activity_notifications
 where organization_id=p_organization_id and recipient_user_id=auth.uid() and metadata->>'source'='arisa_whatsapp';
 select coalesce(jsonb_agg(to_jsonb(n) order by n.created_at desc,n.id desc),'[]'::jsonb) into result from (
  select id,title,message,read_at,created_at,metadata from public.activity_notifications where organization_id=p_organization_id and recipient_user_id=auth.uid() and metadata->>'source'='arisa_whatsapp'
  and (not p_unread_only or read_at is null) order by created_at desc,id desc limit least(greatest(coalesce(p_limit,20),1),100) offset greatest(coalesce(p_offset,0),0)
 )n;
 return jsonb_build_object('items',result,'unread_count',unread,'total',total,'as_of',now());
end $$;
revoke all on function public.arisa_my_notifications(uuid,integer,integer,boolean) from public,anon;
grant execute on function public.arisa_my_notifications(uuid,integer,integer,boolean) to authenticated;
create or replace function public.arisa_mark_notifications_read(p_organization_id uuid,p_ids uuid[])
returns integer language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
 if auth.uid() is null or not public.is_org_member(p_organization_id) then raise exception 'MEMBER_REQUIRED' using errcode='42501';end if;
 if cardinality(p_ids)>100 then raise exception 'TOO_MANY_NOTIFICATIONS';end if;
 update public.activity_notifications set read_at=now() where id=any(p_ids) and organization_id=p_organization_id and recipient_user_id=auth.uid() and metadata->>'source'='arisa_whatsapp' and read_at is null;
 get diagnostics changed=row_count;return changed;
end $$;
revoke all on function public.arisa_mark_notifications_read(uuid,uuid[]) from public,anon;
grant execute on function public.arisa_mark_notifications_read(uuid,uuid[]) to authenticated;

-- Identity is checked in Postgres against the incoming channel, never by the model.
create table crm_private.arisa_whatsapp_finance_sessions(
 thread_id uuid primary key references public.arisa_whatsapp_threads(id) on delete cascade,
 organization_id uuid not null references public.organizations(id) on delete cascade,
 contact_id uuid references public.contacts(id) on delete cascade,
 stage text not null default 'awaiting' check(stage in('awaiting','verified','locked','closed')),
 original_request text not null default '', fingerprint text,
 challenge_until timestamptz,verified_until timestamptz,locked_until timestamptz,
 failed_attempts integer not null default 0,attempt_window timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index arisa_finance_sessions_contact on crm_private.arisa_whatsapp_finance_sessions(contact_id);
create index arisa_finance_sessions_org on crm_private.arisa_whatsapp_finance_sessions(organization_id);
create table crm_private.arisa_whatsapp_finance_events(
 message_id uuid primary key references public.arisa_whatsapp_messages(id) on delete cascade,
 organization_id uuid not null references public.organizations(id) on delete cascade,
 thread_id uuid not null references public.arisa_whatsapp_threads(id) on delete cascade,
 contact_id uuid references public.contacts(id) on delete set null,
 contains_identity boolean not null default false,disclosed boolean not null default false,
 result jsonb not null default '{}',created_at timestamptz not null default now()
);
create index arisa_finance_events_thread on crm_private.arisa_whatsapp_finance_events(thread_id,created_at);
create index arisa_finance_events_org on crm_private.arisa_whatsapp_finance_events(organization_id);
create index arisa_finance_events_contact on crm_private.arisa_whatsapp_finance_events(contact_id);
alter table crm_private.arisa_whatsapp_finance_sessions enable row level security;
alter table crm_private.arisa_whatsapp_finance_events enable row level security;
revoke all on crm_private.arisa_whatsapp_finance_sessions,crm_private.arisa_whatsapp_finance_events from public,anon,authenticated;

create function private.arisa_finance_contact_phone(p_phone text,p_country text) returns text language sql immutable set search_path='' as $$
 select case when length(v) in(10,11) and lower(coalesce(p_country,'br')) in('br','brasil','brazil') then '55'||v else v end from(select regexp_replace(coalesce(p_phone,''),'[^0-9]','','g') v)s;
$$;
create function private.arisa_finance_fingerprint(c public.contacts) returns text language sql immutable set search_path='' as $$
 select md5(concat_ws('|',c.id::text,c.organization_id::text,c.name,c.document,c.email,c.phone,c.contact_type,c.active::text,c.do_not_contact_at::text));
$$;
create function private.arisa_finance_valid(p_thread uuid,p_org uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(
  select 1 from crm_private.arisa_whatsapp_finance_sessions s
  join public.arisa_whatsapp_threads t on t.id=s.thread_id and t.organization_id=s.organization_id
  join public.contacts c on c.id=s.contact_id and c.organization_id=s.organization_id
  where s.thread_id=p_thread and s.organization_id=p_org and s.stage='verified' and s.verified_until>now()
  and c.active and c.do_not_contact_at is null and c.contact_type in('cliente','fornecedor') and t.opted_out_at is null
  and s.fingerprint=private.arisa_finance_fingerprint(c)
  and private.arisa_finance_contact_phone(c.phone,c.country)=any(crm_private.whatsapp_phone_variants(t.phone))
  and (select count(*) from public.contacts other where other.organization_id=p_org and other.active and private.arisa_finance_contact_phone(other.phone,other.country)=any(crm_private.whatsapp_phone_variants(t.phone)))=1
 );
$$;
revoke all on function private.arisa_finance_contact_phone(text,text),private.arisa_finance_fingerprint(public.contacts),private.arisa_finance_valid(uuid,uuid) from public,anon,authenticated;

create function public.arisa_whatsapp_finance(p_job uuid,p_lease uuid,p_action text default 'probe',p_reference text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare j crm_private.arisa_whatsapp_reply_jobs; t public.arisa_whatsapp_threads; m public.arisa_whatsapp_messages;
 s crm_private.arisa_whatsapp_finance_sessions;c public.contacts; cached crm_private.arisa_whatsapp_finance_events;
 ids uuid[];redacted jsonb;v_result jsonb;v_doc text;v_email text;v_name text;v_rows jsonb;v_total bigint;v_identity boolean:=false;v_ready boolean:=false;
 v_ask text:='Para consultar seus pagamentos, confirme em uma mensagem: nome completo ou razão social, CPF/CNPJ e e-mail cadastrado. A confirmação vale apenas para seus próprios assuntos financeiros.';
 v_help text:='Não consegui confirmar o cadastro com segurança por aqui. Vou pedir à equipe que confira seu atendimento antes de consultar valores.';
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'SERVICE_REQUIRED' using errcode='42501';end if;
 if p_action not in('probe','start','consult') or length(coalesce(p_reference,''))>100 then raise exception 'FINANCE_REQUEST_INVALID';end if;
 select * into j from crm_private.arisa_whatsapp_reply_jobs where id=p_job for update;
 if j.id is null or j.lease is distinct from p_lease or j.status<>'processing' or j.lease_until<=now() then raise exception 'WHATSAPP_REPLY_LEASE_CHANGED';end if;
 select * into t from public.arisa_whatsapp_threads where id=j.thread_id and organization_id=j.organization_id for update;
 select * into m from public.arisa_whatsapp_messages where id=j.id and thread_id=t.id and direction='inbound';
 if m.id is null or t.opted_out_at is not null or not exists(select 1 from crm_private.arisa_whatsapp_channel where organization_id=j.organization_id and enabled and auto_reply_enabled) then raise exception 'FINANCE_CHANNEL_UNAVAILABLE';end if;
 select coalesce(jsonb_agg(message_id),'[]'::jsonb) into redacted from crm_private.arisa_whatsapp_finance_events where thread_id=t.id and organization_id=j.organization_id and contains_identity;
 select * into cached from crm_private.arisa_whatsapp_finance_events where message_id=j.id;
 select * into s from crm_private.arisa_whatsapp_finance_sessions where thread_id=t.id for update;
 if private.arisa_finance_valid(t.id,j.organization_id) then
  if p_action<>'consult' then
   return jsonb_build_object('verified',true,'handled',false,'redacted_message_ids',redacted)
    || case when cached.result->>'just_verified'='true' then jsonb_build_object('just_verified',true,'request',s.original_request) else '{}'::jsonb end;
  end if;
  select * into c from public.contacts where id=s.contact_id and organization_id=j.organization_id;
  -- Only finalized customer receivables or supplier payables belonging to this exact contact.
  -- Internal notes, bank balances, risk, other contacts, drafts and provisions are never selected.
  select count(*) into v_total from public.financial_entries e where e.organization_id=j.organization_id and e.contact_id=c.id
    and e.type=case when c.contact_type='cliente' then 'entrada' else 'saida' end
    and e.status in('pendente','vencido','pago','recebido','cancelado') and coalesce(e.is_provision,false)=false
    and (coalesce(p_reference,'')='' or private.arisa_name_key(e.document_number)=private.arisa_name_key(p_reference));
  select coalesce(jsonb_agg(to_jsonb(entry)),'[]'::jsonb) into v_rows from(
    select e.document_number,e.installment_number,e.installment_total,e.amount,e.open_amount,e.due_date,e.status,e.settlement_date,
      case when e.approval_status='aprovado' and e.status in('pendente','vencido') then e.scheduled_payment_date else null end as scheduled_payment_date
    from public.financial_entries e where e.organization_id=j.organization_id and e.contact_id=c.id
      and e.type=case when c.contact_type='cliente' then 'entrada' else 'saida' end
      and e.status in('pendente','vencido','pago','recebido','cancelado') and coalesce(e.is_provision,false)=false
      and (coalesce(p_reference,'')='' or private.arisa_name_key(e.document_number)=private.arisa_name_key(p_reference))
    order by case when e.status in('pendente','vencido') then 0 else 1 end,e.due_date desc,e.id limit 20
  )entry;
  insert into crm_private.arisa_whatsapp_finance_events(message_id,organization_id,thread_id,contact_id,disclosed)
   values(j.id,j.organization_id,t.id,c.id,true) on conflict(message_id) do update set disclosed=true,contact_id=excluded.contact_id;
  return jsonb_build_object('verified',true,'scope','own_contact_only','contact_name',c.name,'contact_type',c.contact_type,
    'entries',v_rows,'total',v_total,'truncated',v_total>20,'as_of',now(),'changes_allowed',false,'negotiation_policy','proposal_requires_administrator_approval');
 end if;
 if p_action='consult' then raise exception 'FINANCE_IDENTITY_REQUIRED' using errcode='42501';end if;
 if cached.message_id is not null and coalesce(cached.result->>'just_verified','false')<>'true' then
  return cached.result||jsonb_build_object('redacted_message_ids',redacted);
 end if;
 if s.stage='verified' then
  update crm_private.arisa_whatsapp_finance_sessions set stage='closed',verified_until=null where thread_id=t.id;
  s.stage='closed';
 end if;
 if p_action='probe' and (s.thread_id is null or s.stage not in('awaiting','locked')) then
  return jsonb_build_object('verified',false,'handled',false,'redacted_message_ids',redacted);
 end if;
 if s.locked_until>now() then
  v_result=jsonb_build_object('verified',false,'handled',true,'reply','A confirmação está temporariamente bloqueada após tentativas divergentes. A equipe pode dar continuidade ao atendimento.','escalate',false);
 else
  select array_agg(contact.id) into ids from public.contacts contact where contact.organization_id=j.organization_id and contact.active
   and private.arisa_finance_contact_phone(contact.phone,contact.country)=any(crm_private.whatsapp_phone_variants(t.phone));
  if cardinality(ids)=1 then select * into c from public.contacts where id=ids[1] and contact_type in('cliente','fornecedor') and do_not_contact_at is null;end if;
  v_ready=c.id is not null and length(trim(coalesce(c.name,'')))>=3 and length(regexp_replace(coalesce(c.document,''),'[^0-9]','','g')) in(11,14)
   and coalesce(c.email,'') ~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$';
  if not coalesce(v_ready,false) then
   v_result=jsonb_build_object('verified',false,'handled',true,'reply',v_help,'escalate',true);
   update crm_private.arisa_whatsapp_finance_sessions set stage='closed',verified_until=null where thread_id=t.id;
  else
   if s.thread_id is null then
    insert into crm_private.arisa_whatsapp_finance_sessions(thread_id,organization_id,contact_id,original_request,challenge_until)
     values(t.id,j.organization_id,c.id,left(m.content,3000),now()+interval '15 minutes') returning * into s;
   elsif p_action='start' and (s.stage<>'awaiting' or s.challenge_until<=now()) then
    update crm_private.arisa_whatsapp_finance_sessions set contact_id=c.id,stage='awaiting',original_request=left(m.content,3000),
      challenge_until=now()+interval '15 minutes',verified_until=null,
      failed_attempts=case when attempt_window<=now()-interval '24 hours' then 0 else failed_attempts end,
      attempt_window=case when attempt_window<=now()-interval '24 hours' then now() else attempt_window end,updated_at=now()
     where thread_id=t.id returning * into s;
   end if;
   if s.stage='awaiting' and s.challenge_until<=now() then
    update crm_private.arisa_whatsapp_finance_sessions set stage='closed' where thread_id=t.id;
    v_result=jsonb_build_object('verified',false,'handled',true,'reply','A confirmação expirou. Diga qual assunto financeiro deseja tratar para começarmos novamente.');
   elsif private.arisa_name_key(m.content) in('cancelar','cancelar verificacao','outro assunto','depois') then
    update crm_private.arisa_whatsapp_finance_sessions set stage='closed' where thread_id=t.id;
    v_result=jsonb_build_object('verified',false,'handled',true,'reply','Tudo bem. Qual assunto você quer tratar agora?');
   else
    select lower(matches[1]) into v_email from regexp_matches(m.content,'([A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,})','g') matches limit 1;
    select regexp_replace(matches[1],'[^0-9]','','g') into v_doc from regexp_matches(m.content,'([0-9]{3}[.][0-9]{3}[.][0-9]{3}-[0-9]{2}|[0-9]{2}[.][0-9]{3}[.][0-9]{3}/[0-9]{4}-[0-9]{2}|[0-9]{14}|[0-9]{11})','g') matches limit 1;
    v_name=private.arisa_name_key(m.content);v_identity=v_doc is not null or v_email is not null;
    if v_doc is not null and v_email is not null then
     if v_doc=regexp_replace(c.document,'[^0-9]','','g') and v_email=lower(trim(c.email))
       and position(' '||private.arisa_name_key(c.name)||' ' in ' '||v_name||' ')>0 then
      update crm_private.arisa_whatsapp_finance_sessions set stage='verified',contact_id=c.id,fingerprint=private.arisa_finance_fingerprint(c),
       verified_until=now()+interval '30 minutes',updated_at=now() where thread_id=t.id;
      v_result=jsonb_build_object('verified',true,'handled',false,'just_verified',true,'request',s.original_request);
     else
      update crm_private.arisa_whatsapp_finance_sessions set failed_attempts=failed_attempts+1,
       stage=case when failed_attempts+1>=3 then 'locked' else 'awaiting' end,
       locked_until=case when failed_attempts+1>=3 then now()+interval '24 hours' else null end,updated_at=now()
       where thread_id=t.id returning * into s;
      v_result=jsonb_build_object('verified',false,'handled',true,'escalate',s.stage='locked','reply',
       case when s.stage='locked' then v_help else 'Os dados não conferiram em conjunto. Confira nome completo ou razão social, CPF/CNPJ e e-mail cadastrados e envie os três novamente. Você também pode cancelar a confirmação.' end);
     end if;
    else
     v_result=jsonb_build_object('verified',false,'handled',true,'reply',v_ask);
    end if;
   end if;
  end if;
 end if;
 insert into crm_private.arisa_whatsapp_finance_events(message_id,organization_id,thread_id,contact_id,contains_identity,result)
  values(j.id,j.organization_id,t.id,case when v_result->>'verified'='true' then c.id else null end,v_identity,v_result)
  on conflict(message_id) do update set result=excluded.result,contact_id=excluded.contact_id,contains_identity=excluded.contains_identity;
 if v_identity then redacted=redacted||jsonb_build_array(j.id);end if;
 return v_result||jsonb_build_object('redacted_message_ids',redacted);
end $$;
revoke all on function public.arisa_whatsapp_finance(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.arisa_whatsapp_finance(uuid,uuid,text,text) to service_role;

CREATE OR REPLACE FUNCTION public.arisa_whatsapp_attention(p_job uuid, p_lease uuid, p_analysis jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare j crm_private.arisa_whatsapp_reply_jobs;t public.arisa_whatsapp_threads;m public.arisa_whatsapp_messages;target text;key text;context text;ids uuid[];recipients uuid[]:='{}';recipient uuid;notice uuid;names jsonb:='[]';unresolved boolean:=false;needs_auth boolean;kind text;summary text;v_result jsonb;req uuid;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'SERVICE_REQUIRED' using errcode='42501';end if;
 select * into j from crm_private.arisa_whatsapp_reply_jobs where id=p_job for update;
 if j.id is null or j.lease is distinct from p_lease or j.status<>'processing' or j.lease_until<=now() then raise exception 'WHATSAPP_REPLY_LEASE_CHANGED';end if;
 if j.attention_result is not null then return j.attention_result;end if;
 select * into t from public.arisa_whatsapp_threads where id=j.thread_id;
 select * into m from public.arisa_whatsapp_messages where id=j.id;
 if t.opted_out_at is not null or not exists(select 1 from crm_private.arisa_whatsapp_channel where organization_id=j.organization_id and enabled and auto_reply_enabled) then return jsonb_build_object('status','paused');end if;
 if jsonb_typeof(p_analysis) is distinct from 'object' or pg_column_size(p_analysis)>12000 or jsonb_typeof(p_analysis->'target_names') is distinct from 'array' or jsonb_array_length(p_analysis->'target_names')>3 or jsonb_typeof(p_analysis->'requires_authorization') is distinct from 'boolean' or jsonb_typeof(p_analysis->'needs_notification') is distinct from 'boolean' then raise exception 'WHATSAPP_ATTENTION_INVALID';end if;
 needs_auth=(p_analysis->>'requires_authorization')::boolean;kind=p_analysis->>'kind';summary=trim(coalesce(p_analysis->>'summary',''));
 if kind not in('none','meeting','subject','authorization','negotiation') or length(summary)>1500 then raise exception 'WHATSAPP_ATTENTION_INVALID';end if;
 if kind='negotiation' and not private.arisa_finance_valid(j.thread_id,j.organization_id) then raise exception 'FINANCE_IDENTITY_REQUIRED' using errcode='42501';end if;
 needs_auth=needs_auth or kind='authorization';
 if not (p_analysis->>'needs_notification')::boolean and not needs_auth then
  v_result=jsonb_build_object('status','not_needed');
 else
  if length(summary)<3 then raise exception 'WHATSAPP_ATTENTION_INVALID';end if;
  select private.arisa_name_key(string_agg(h.content,' ')) into context from(select content from public.arisa_whatsapp_messages where thread_id=j.thread_id and organization_id=j.organization_id order by occurred_at desc,created_at desc limit 20)h;
  for target in select jsonb_array_elements_text(p_analysis->'target_names') loop
   key=private.arisa_name_key(target);ids=null;
   -- The model supplies a name found in this conversation, never a user ID or phone.
   if length(key)<3 or length(key)>120 or position(' '||key||' ' in ' '||coalesce(context,'')||' ')=0 then unresolved=true;continue;end if;
   select array_agg(om.user_id) into ids from public.organization_members om join public.profiles p on p.id=om.user_id where om.organization_id=j.organization_id and om.active and private.arisa_name_key(p.full_name)=key;
   if cardinality(ids) is null then
    select array_agg(om.user_id) into ids from public.organization_members om join public.profiles p on p.id=om.user_id where om.organization_id=j.organization_id and om.active and private.arisa_name_key(p.full_name) like key||' %';
   end if;
   if cardinality(ids)=1 then
    if not ids[1]=any(recipients) then recipients=array_append(recipients,ids[1]);names=names||jsonb_build_array(target);end if;
   else unresolved=true;end if;
  end loop;
  if cardinality(recipients)=0 then unresolved=true;end if;
  -- Unresolved requests and sensitive-data requests go to the channel's administrator for review.
  if unresolved or needs_auth or kind='negotiation' then
   if private.arisa_actor_admin(j.organization_id,j.actor_user_id) and not j.actor_user_id=any(recipients) then recipients=array_append(recipients,j.actor_user_id);end if;
  end if;
  if needs_auth then
   insert into crm_private.arisa_whatsapp_authorizations(organization_id,source_message_id,thread_id,summary) values(j.organization_id,j.id,j.thread_id,summary) on conflict(source_message_id) do nothing;
   select id into req from crm_private.arisa_whatsapp_authorizations where source_message_id=j.id;
  end if;
  foreach recipient in array recipients loop
   insert into public.activity_notifications(organization_id,recipient_user_id,actor_user_id,notification_type,title,message,metadata,dedupe_key)
    values(j.organization_id,recipient,null,'arisa_whatsapp',case when needs_auth then 'Arisa: informação aguardando autorização' when kind='meeting' then 'Arisa: pedido de reunião' when kind='negotiation' then 'Arisa: proposta financeira para aprovação' else 'Arisa: assunto recebido no WhatsApp' end,
     coalesce(nullif(t.contact_name,''),'Contato')||' (+'||t.phone||'): '||summary,
     jsonb_build_object('source','arisa_whatsapp','thread_id',j.thread_id,'source_message_id',j.id,'phone',t.phone,'kind',kind,'authorization_required',needs_auth,'authorization_id',req,'unresolved_recipient',unresolved,'whatsapp_status','pending','proposal_status',case when kind='negotiation' then 'pending' end,'verified_contact_id',case when kind='negotiation' then (select contact_id from crm_private.arisa_whatsapp_finance_sessions where thread_id=j.thread_id) end),
     'arisa-whatsapp:'||j.id::text||':'||recipient::text) on conflict(dedupe_key) where dedupe_key is not null do nothing returning id into notice;
   if notice is not null then insert into crm_private.arisa_whatsapp_notice_jobs(id,organization_id,recipient_user_id,actor_user_id) values(notice,j.organization_id,recipient,j.actor_user_id) on conflict do nothing;end if;
  end loop;
  perform private.arisa_dispatch_whatsapp_notices();
  v_result=jsonb_build_object('status','notified','notified_names',names,'needs_clarification',unresolved and kind<>'negotiation','authorization_pending',needs_auth,'meeting_confirmed',false,'whatsapp_delivery_confirmed',false);
 end if;
 update crm_private.arisa_whatsapp_reply_jobs set attention=p_analysis,attention_result=v_result where id=j.id;
 return v_result;
end $function$
;
create or replace function public.arisa_whatsapp_reply_worker(p_action text,p_args jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare j crm_private.arisa_whatsapp_reply_jobs;t public.arisa_whatsapp_threads;c public.contacts;m public.arisa_whatsapp_messages;history jsonb;reason text;v_result jsonb;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'SERVICE_REQUIRED' using errcode='42501';end if;
  if p_action='claim' then
    update crm_private.arisa_whatsapp_reply_jobs set status='unknown',error_code='WHATSAPP_REPLY_SEND_INTERRUPTED',updated_at=now() where status='sending' and lease_until<now();
    update crm_private.arisa_whatsapp_reply_jobs set status=case when attempts<3 then 'pending' else 'failed' end,available_at=now(),lease=null,lease_until=null,updated_at=now() where status='processing' and lease_until<now();
    for j in select q.* from crm_private.arisa_whatsapp_reply_jobs q where q.status='pending' and q.available_at<=now()
      and not exists(select 1 from crm_private.arisa_whatsapp_reply_jobs other where other.thread_id=q.thread_id and other.status in('processing','sending') and other.lease_until>=now())
      order by q.created_at,q.id limit 30 for update skip locked loop
      -- Serialize claims per conversation even when two different jobs are claimed concurrently.
      if not pg_try_advisory_xact_lock(hashtextextended('arisa-whatsapp-reply:'||j.thread_id::text,0)) then continue;end if;
      if exists(select 1 from crm_private.arisa_whatsapp_reply_jobs other where other.thread_id=j.thread_id and other.id<>j.id and other.status in('processing','sending') and other.lease_until>=now()) then continue;end if;
      select * into t from public.arisa_whatsapp_threads where id=j.thread_id and organization_id=j.organization_id;
      select * into c from public.contacts where id=t.contact_id and organization_id=j.organization_id;
      select * into m from public.arisa_whatsapp_messages where id=j.id;
      reason=null;
      if not exists(select 1 from crm_private.arisa_whatsapp_channel ch join crm_private.whatsapp_runtime_settings rt using(organization_id) where ch.organization_id=j.organization_id and ch.enabled and ch.auto_reply_enabled and not rt.enabled and rt.phone_number_id=t.phone_number_id) or not private.arisa_actor_admin(j.organization_id,j.actor_user_id) then reason='WHATSAPP_REPLY_DISABLED';
      elsif t.opted_out_at is not null or (t.contact_id is not null and (c.id is null or not c.active)) or c.do_not_contact_at is not null or lower(coalesce(c.marketing_consent_status,'')) in('denied','revoked') then reason='WHATSAPP_CONTACT_BLOCKED';
      elsif m.occurred_at<=now()-interval '24 hours' then reason='WHATSAPP_REPLY_EXPIRED';
      elsif exists(select 1 from public.arisa_whatsapp_messages newer where newer.thread_id=j.thread_id and newer.direction='inbound' and (newer.occurred_at,newer.created_at,newer.id)>(m.occurred_at,m.created_at,m.id)) then reason='WHATSAPP_REPLY_SUPERSEDED';end if;
      if reason is not null then update crm_private.arisa_whatsapp_reply_jobs set status='skipped',error_code=reason,updated_at=now() where id=j.id;continue;end if;
      update crm_private.arisa_whatsapp_reply_jobs set status='processing',attempts=attempts+1,lease=gen_random_uuid(),lease_until=now()+interval '3 minutes',updated_at=now() where id=j.id returning * into j;
      select coalesce(jsonb_agg(jsonb_build_object('direction',h.direction,'content',h.content) order by h.occurred_at,h.created_at,h.id),'[]') into history from (
        select h.id,h.direction,h.content,h.occurred_at,h.created_at from public.arisa_whatsapp_messages h
        where h.organization_id=j.organization_id and h.thread_id=j.thread_id and (h.direction='inbound' or h.delivery_status in('accepted','sent','delivered','read'))
        order by h.occurred_at desc,h.created_at desc,h.id desc limit 20
      ) h;
      return jsonb_build_object('id',j.id,'lease',j.lease,'organization_id',j.organization_id,'actor_user_id',j.actor_user_id,'phone',t.phone,'contact_id',t.contact_id,'history',history);
    end loop;
    return '{}'::jsonb;
  end if;
  select * into j from crm_private.arisa_whatsapp_reply_jobs where id=(p_args->>'id')::uuid for update;
  if j.id is null or j.lease is distinct from (p_args->>'lease')::uuid or j.lease_until<=now() then raise exception 'WHATSAPP_REPLY_LEASE_CHANGED';end if;
  if p_action='send' then
    if j.status<>'processing' then return jsonb_build_object('proceed',false);end if;
    select * into t from public.arisa_whatsapp_threads where id=j.thread_id;
    select * into m from public.arisa_whatsapp_messages where id=j.id;
    if t.opted_out_at is not null or m.occurred_at<=now()-interval '24 hours' or not exists(select 1 from crm_private.arisa_whatsapp_channel ch join crm_private.whatsapp_runtime_settings rt using(organization_id) where ch.organization_id=j.organization_id and ch.enabled and ch.auto_reply_enabled and not rt.enabled and rt.phone_number_id=t.phone_number_id)
      or exists(select 1 from public.arisa_whatsapp_messages newer where newer.thread_id=j.thread_id and newer.direction='inbound' and (newer.occurred_at,newer.created_at,newer.id)>(m.occurred_at,m.created_at,m.id)) then
      update crm_private.arisa_whatsapp_reply_jobs set status='skipped',error_code='WHATSAPP_REPLY_CONTEXT_CHANGED',updated_at=now() where id=j.id;return jsonb_build_object('proceed',false);
    end if;
    if exists(select 1 from crm_private.arisa_whatsapp_finance_events where message_id=j.id and disclosed) and not private.arisa_finance_valid(j.thread_id,j.organization_id) then
      update crm_private.arisa_whatsapp_reply_jobs set status='skipped',error_code='WHATSAPP_FINANCE_IDENTITY_CHANGED',updated_at=now() where id=j.id;return jsonb_build_object('proceed',false);
    end if;
    if length(trim(coalesce(p_args->>'content',''))) not between 1 and 4096 or pg_column_size(p_args)>32768 then raise exception 'WHATSAPP_REPLY_INVALID';end if;
    update crm_private.arisa_whatsapp_reply_jobs set status='sending',generated_content=p_args->>'content',response_id=left(p_args->>'response_id',200),model=left(p_args->>'model',100),usage=p_args->'usage',updated_at=now() where id=j.id;
    return jsonb_build_object('proceed',true);
  elsif p_action='finish' and j.status='sending' then
    v_result=p_args->'result';
    update crm_private.arisa_whatsapp_reply_jobs set status=case when v_result->>'accepted_by_meta'='true' then 'sent' when v_result->>'status'='failed' then 'failed' else 'unknown' end,result=v_result,updated_at=now() where id=j.id;
    update public.arisa_whatsapp_messages set metadata=metadata||jsonb_build_object('auto_reply',true,'reply_to_message_id',j.id) where id=nullif(v_result->>'message_id','')::uuid and organization_id=j.organization_id and thread_id=j.thread_id;
    return jsonb_build_object('ok',true);
  elsif p_action='fail' and j.status in('processing','sending') then
    update crm_private.arisa_whatsapp_reply_jobs set status=case when j.status='sending' then 'unknown' when attempts>=3 then 'failed' else 'pending' end,available_at=now()+interval '1 minute'*greatest(attempts,1),error_code=left(p_args->>'error',128),updated_at=now() where id=j.id;
    return jsonb_build_object('ok',true);
  end if;
  raise exception 'WHATSAPP_REPLY_INVALID';
end $$;
