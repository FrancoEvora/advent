alter table crm_private.arisa_whatsapp_reply_jobs add column attention jsonb, add column attention_result jsonb;
create table crm_private.arisa_whatsapp_recipients(
 organization_id uuid not null references public.organizations(id) on delete cascade,
 user_id uuid not null references public.profiles(id) on delete cascade,
 phone text not null check(phone~'^[1-9][0-9]{7,14}$'),enabled boolean not null default true,
 updated_by uuid not null,updated_at timestamptz not null default now(),primary key(organization_id,user_id),unique(organization_id,phone)
);
create table crm_private.arisa_whatsapp_authorizations(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id) on delete cascade,
 source_message_id uuid not null unique references public.arisa_whatsapp_messages(id) on delete cascade,
 thread_id uuid not null references public.arisa_whatsapp_threads(id) on delete cascade,
 summary text not null,status text not null default 'pending' check(status in('pending','approved','denied','sent','unknown','failed')),
 approved_content text,approved_by uuid,approved_at timestamptz,result jsonb,created_at timestamptz not null default now()
);
create index arisa_whatsapp_authorizations_org on crm_private.arisa_whatsapp_authorizations(organization_id,status,created_at);
create index arisa_whatsapp_authorizations_thread on crm_private.arisa_whatsapp_authorizations(thread_id);
create table crm_private.arisa_whatsapp_notice_jobs(
 id uuid primary key references public.activity_notifications(id) on delete cascade,
 organization_id uuid not null references public.organizations(id) on delete cascade,recipient_user_id uuid not null,actor_user_id uuid not null,
 status text not null default 'pending' check(status in('pending','processing','sending','awaiting_contact','awaiting_template','sent','failed','unknown','skipped')),
 phone text,lease uuid,lease_until timestamptz,available_at timestamptz not null default now(),attempts integer not null default 0,
 result jsonb,error_code text,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index arisa_whatsapp_notice_pending on crm_private.arisa_whatsapp_notice_jobs(available_at,created_at) where status in('pending','awaiting_contact','awaiting_template');
create index arisa_whatsapp_notice_org on crm_private.arisa_whatsapp_notice_jobs(organization_id,created_at);
alter table crm_private.arisa_whatsapp_recipients enable row level security;
alter table crm_private.arisa_whatsapp_authorizations enable row level security;
alter table crm_private.arisa_whatsapp_notice_jobs enable row level security;
revoke all on crm_private.arisa_whatsapp_recipients,crm_private.arisa_whatsapp_authorizations,crm_private.arisa_whatsapp_notice_jobs from public,anon,authenticated;

create function private.arisa_name_key(value text) returns text language sql immutable strict parallel safe set search_path='' as $$
 select trim(regexp_replace(translate(lower(value),'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc'),'[^a-z0-9]+',' ','g'));
$$;
revoke all on function private.arisa_name_key(text) from public,anon,authenticated;

create function private.arisa_dispatch_whatsapp_notices() returns bigint language plpgsql security definer set search_path='' as $$
declare v_id bigint;
begin
 if not exists(select 1 from crm_private.arisa_whatsapp_notice_jobs where status in('pending','awaiting_contact','awaiting_template') and available_at<=now() or status in('processing','sending') and lease_until<now()) then return null;end if;
 select net.http_post(url:='https://qsdffayasuzsmngteika.supabase.co/functions/v1/arisa-whatsapp-notifications',headers:=jsonb_build_object('content-type','application/json','x-arisa-worker-secret',public.arisa_background_secret()),body:='{}'::jsonb,timeout_milliseconds:=145000) into v_id;return v_id;
end $$;
revoke all on function private.arisa_dispatch_whatsapp_notices() from public,anon,authenticated;
grant execute on function private.arisa_dispatch_whatsapp_notices() to service_role;

create function public.arisa_whatsapp_attention(p_job uuid,p_lease uuid,p_analysis jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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
 if kind not in('none','meeting','subject','authorization') or length(summary)>1500 then raise exception 'WHATSAPP_ATTENTION_INVALID';end if;
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
  if unresolved or needs_auth then
   if private.arisa_actor_admin(j.organization_id,j.actor_user_id) and not j.actor_user_id=any(recipients) then recipients=array_append(recipients,j.actor_user_id);end if;
  end if;
  if needs_auth then
   insert into crm_private.arisa_whatsapp_authorizations(organization_id,source_message_id,thread_id,summary) values(j.organization_id,j.id,j.thread_id,summary) on conflict(source_message_id) do nothing;
   select id into req from crm_private.arisa_whatsapp_authorizations where source_message_id=j.id;
  end if;
  foreach recipient in array recipients loop
   insert into public.activity_notifications(organization_id,recipient_user_id,actor_user_id,notification_type,title,message,metadata,dedupe_key)
    values(j.organization_id,recipient,null,'arisa_whatsapp',case when needs_auth then 'Arisa: informação aguardando autorização' when kind='meeting' then 'Arisa: pedido de reunião' else 'Arisa: assunto recebido no WhatsApp' end,
     coalesce(nullif(t.contact_name,''),'Contato')||' (+'||t.phone||'): '||summary,
     jsonb_build_object('source','arisa_whatsapp','thread_id',j.thread_id,'source_message_id',j.id,'phone',t.phone,'kind',kind,'authorization_required',needs_auth,'authorization_id',req,'unresolved_recipient',unresolved,'whatsapp_status','pending'),
     'arisa-whatsapp:'||j.id::text||':'||recipient::text) on conflict(dedupe_key) where dedupe_key is not null do nothing returning id into notice;
   if notice is not null then insert into crm_private.arisa_whatsapp_notice_jobs(id,organization_id,recipient_user_id,actor_user_id) values(notice,j.organization_id,recipient,j.actor_user_id) on conflict do nothing;end if;
  end loop;
  perform private.arisa_dispatch_whatsapp_notices();
  v_result=jsonb_build_object('status','notified','notified_names',names,'needs_clarification',unresolved,'authorization_pending',needs_auth,'meeting_confirmed',false,'whatsapp_delivery_confirmed',false);
 end if;
 update crm_private.arisa_whatsapp_reply_jobs set attention=p_analysis,attention_result=v_result where id=j.id;
 return v_result;
end $$;
revoke all on function public.arisa_whatsapp_attention(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.arisa_whatsapp_attention(uuid,uuid,jsonb) to service_role;

create function public.arisa_whatsapp_notice_worker(p_action text,p_args jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare j crm_private.arisa_whatsapp_notice_jobs;r crm_private.arisa_whatsapp_recipients;v_result jsonb;window_open boolean;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'SERVICE_REQUIRED' using errcode='42501';end if;
 if p_action='claim' then
  update crm_private.arisa_whatsapp_notice_jobs set status='unknown',error_code='WHATSAPP_NOTICE_SEND_INTERRUPTED',updated_at=now() where status='sending' and lease_until<now();
  update crm_private.arisa_whatsapp_notice_jobs set status='pending',available_at=now(),updated_at=now() where status='processing' and lease_until<now();
  for j in select * from crm_private.arisa_whatsapp_notice_jobs where status in('pending','awaiting_contact','awaiting_template') and available_at<=now() order by created_at limit 30 for update skip locked loop
   if not exists(select 1 from public.organization_members where organization_id=j.organization_id and user_id=j.recipient_user_id and active) or not private.arisa_actor_admin(j.organization_id,j.actor_user_id) then
    update crm_private.arisa_whatsapp_notice_jobs set status='skipped',error_code='USER_INACTIVE',updated_at=now() where id=j.id;continue;end if;
   if not exists(select 1 from crm_private.arisa_whatsapp_channel where organization_id=j.organization_id and enabled) then continue;end if;
   select * into r from crm_private.arisa_whatsapp_recipients where organization_id=j.organization_id and user_id=j.recipient_user_id and enabled;
   if r.phone is null then
    update crm_private.arisa_whatsapp_notice_jobs set status='awaiting_contact',available_at=now()+interval '5 minutes',updated_at=now() where id=j.id;
    update public.activity_notifications set metadata=metadata||jsonb_build_object('whatsapp_status','awaiting_contact') where id=j.id;continue;end if;
   select exists(select 1 from public.arisa_whatsapp_threads t join crm_private.whatsapp_runtime_settings rt on rt.organization_id=t.organization_id and rt.phone_number_id=t.phone_number_id where t.organization_id=j.organization_id and t.phone=r.phone and t.last_inbound_at>now()-interval '24 hours') into window_open;
   update crm_private.arisa_whatsapp_notice_jobs set status='processing',phone=r.phone,lease=gen_random_uuid(),lease_until=now()+interval '3 minutes',attempts=attempts+1,updated_at=now() where id=j.id returning * into j;
   return to_jsonb(j)-'result'||jsonb_build_object('window_open',window_open);
  end loop;return '{}';
 end if;
 select * into j from crm_private.arisa_whatsapp_notice_jobs where id=(p_args->>'id')::uuid for update;
 if j.id is null or j.lease is distinct from (p_args->>'lease')::uuid or j.lease_until<=now() then raise exception 'WHATSAPP_NOTICE_LEASE_CHANGED';end if;
 if p_action='send' and j.status='processing' then
  if not exists(select 1 from crm_private.arisa_whatsapp_recipients r join public.organization_members m using(organization_id,user_id) where r.organization_id=j.organization_id and r.user_id=j.recipient_user_id and r.enabled and r.phone=j.phone and m.active) then
   update crm_private.arisa_whatsapp_notice_jobs set status='awaiting_contact',available_at=now()+interval '5 minutes' where id=j.id;return jsonb_build_object('proceed',false);end if;
  update crm_private.arisa_whatsapp_notice_jobs set status='sending',updated_at=now() where id=j.id;return jsonb_build_object('proceed',true,'phone',j.phone);
 elsif p_action='defer' and j.status='processing' then
  update crm_private.arisa_whatsapp_notice_jobs set status='awaiting_template',available_at=now()+interval '5 minutes',updated_at=now() where id=j.id;
 elsif p_action='finish' and j.status='sending' then
  v_result=p_args->'result';update crm_private.arisa_whatsapp_notice_jobs set status=case when v_result->>'accepted_by_meta'='true' then 'sent' else 'unknown' end,result=v_result,updated_at=now() where id=j.id;
 elsif p_action='fail' and j.status in('processing','sending') then
  update crm_private.arisa_whatsapp_notice_jobs set status=case when j.status='sending' then 'unknown' when attempts>=3 then 'failed' else 'pending' end,available_at=now()+interval '5 minutes',error_code=left(p_args->>'error',128),updated_at=now() where id=j.id;
 else raise exception 'WHATSAPP_NOTICE_INVALID';end if;
 update public.activity_notifications n set metadata=n.metadata||jsonb_build_object('whatsapp_status',q.status,'whatsapp_operation_id',q.result->>'operation_id') from crm_private.arisa_whatsapp_notice_jobs q where n.id=j.id and q.id=j.id;
 return jsonb_build_object('ok',true);
end $$;
revoke all on function public.arisa_whatsapp_notice_worker(text,jsonb) from public,anon,authenticated;
grant execute on function public.arisa_whatsapp_notice_worker(text,jsonb) to service_role;

create function public.arisa_whatsapp_attention_admin(p_action text,p_org uuid,p_actor uuid,p_args jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare req crm_private.arisa_whatsapp_authorizations;t public.arisa_whatsapp_threads;rows jsonb;phone text;recipient uuid;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' or not private.arisa_actor_admin(p_org,p_actor) then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
 if p_action='attention' then
  return jsonb_build_object(
   'recipients',(select coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'name',p.full_name,'phone',r.phone,'enabled',coalesce(r.enabled,false)) order by p.full_name),'[]') from public.organization_members m join public.profiles p on p.id=m.user_id left join crm_private.arisa_whatsapp_recipients r on r.organization_id=m.organization_id and r.user_id=m.user_id where m.organization_id=p_org and m.active),
   'requests',(select coalesce(jsonb_agg(to_jsonb(q)),'[]') from(select a.id,a.summary,a.status,a.approved_content,a.created_at,t.phone,t.contact_name from crm_private.arisa_whatsapp_authorizations a join public.arisa_whatsapp_threads t on t.id=a.thread_id where a.organization_id=p_org order by a.created_at desc limit 20)q),
   'notices',(select coalesce(jsonb_agg(to_jsonb(q)),'[]') from(select n.title,n.message,p.full_name recipient_name,j.status,j.error_code,m.delivery_status,j.created_at from crm_private.arisa_whatsapp_notice_jobs j join public.activity_notifications n on n.id=j.id join public.profiles p on p.id=j.recipient_user_id left join public.arisa_whatsapp_messages m on m.id=nullif(j.result->>'message_id','')::uuid where j.organization_id=p_org order by j.created_at desc limit 20)q));
 elsif p_action='save_recipient' then
  recipient=(p_args->>'user_id')::uuid;phone=regexp_replace(coalesce(p_args->>'phone',''),'[^0-9]','','g');
  if not exists(select 1 from public.organization_members where organization_id=p_org and user_id=recipient and active) or phone!~'^[1-9][0-9]{7,14}$' or jsonb_typeof(p_args->'enabled') is distinct from 'boolean' then raise exception 'WHATSAPP_RECIPIENT_INVALID';end if;
  insert into crm_private.arisa_whatsapp_recipients(organization_id,user_id,phone,enabled,updated_by) values(p_org,recipient,phone,(p_args->>'enabled')::boolean,p_actor) on conflict(organization_id,user_id) do update set phone=excluded.phone,enabled=excluded.enabled,updated_by=p_actor,updated_at=now();
  update crm_private.arisa_whatsapp_notice_jobs set available_at=now() where organization_id=p_org and recipient_user_id=recipient and status='awaiting_contact';
  perform private.arisa_dispatch_whatsapp_notices();return jsonb_build_object('ok',true);
 end if;
 select * into req from crm_private.arisa_whatsapp_authorizations where id=(p_args->>'id')::uuid and organization_id=p_org for update;
 if req.id is null then raise exception 'WHATSAPP_AUTHORIZATION_NOT_FOUND';end if;
 select * into t from public.arisa_whatsapp_threads where id=req.thread_id and organization_id=p_org;
 if p_action='authorize' then
  if length(trim(coalesce(p_args->>'content',''))) not between 1 and 4096 then raise exception 'WHATSAPP_INVALID';end if;
  if req.status='pending' then
   if t.last_inbound_at is null or t.last_inbound_at<=now()-interval '24 hours' then raise exception 'WHATSAPP_TEMPLATE_REQUIRED';end if;
   update crm_private.arisa_whatsapp_authorizations set status='approved',approved_content=trim(p_args->>'content'),approved_by=p_actor,approved_at=now() where id=req.id returning * into req;
  elsif req.status not in('approved','sent','unknown','failed') or req.approved_by is distinct from p_actor or req.approved_content is distinct from trim(p_args->>'content') then raise exception 'WHATSAPP_AUTHORIZATION_CHANGED';end if;
  return jsonb_build_object('id',req.id,'phone',t.phone,'contact_id',t.contact_id,'content',req.approved_content);
 elsif p_action='deny' and req.status='pending' then
  update crm_private.arisa_whatsapp_authorizations set status='denied',approved_by=p_actor,approved_at=now() where id=req.id;return jsonb_build_object('ok',true);
 elsif p_action='authorization_result' and req.approved_by=p_actor then
  update crm_private.arisa_whatsapp_authorizations set status=case when p_args->'result'->>'accepted_by_meta'='true' then 'sent' else 'unknown' end,result=p_args->'result' where id=req.id;return jsonb_build_object('ok',true);
 end if;
 raise exception 'WHATSAPP_AUTHORIZATION_INVALID';
end $$;
revoke all on function public.arisa_whatsapp_attention_admin(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.arisa_whatsapp_attention_admin(text,uuid,uuid,jsonb) to service_role;
select cron.schedule('evora-arisa-whatsapp-notices-1m','* * * * *','select private.arisa_dispatch_whatsapp_notices();');

