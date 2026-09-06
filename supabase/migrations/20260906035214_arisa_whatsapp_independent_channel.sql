begin;
set local lock_timeout='10s';
set local statement_timeout='90s';

-- Administrative traffic shares the encrypted provider credentials, not the CRM
-- enable switch, lead records, Bia queue, or commercial conversation state.
create table crm_private.arisa_whatsapp_channel (
  organization_id uuid primary key references public.organizations(id),
  enabled boolean not null default false,
  webhook_confirmed_at timestamptz,
  webhook_verified_at timestamptz,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
alter table crm_private.arisa_whatsapp_channel enable row level security;
revoke all on crm_private.arisa_whatsapp_channel from public,anon,authenticated,service_role;
grant select on crm_private.arisa_whatsapp_channel to service_role;
create index arisa_whatsapp_channel_actor on crm_private.arisa_whatsapp_channel(updated_by);

create table public.arisa_whatsapp_threads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  phone_number_id text not null check(phone_number_id ~ '^[0-9]{1,64}$'),
  phone text not null check(phone ~ '^[1-9][0-9]{7,14}$'),
  contact_id uuid references public.contacts(id),
  contact_name text,
  last_inbound_at timestamptz,
  last_message_at timestamptz,
  opted_out_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique(organization_id,phone_number_id,phone)
);
create index arisa_whatsapp_threads_contact on public.arisa_whatsapp_threads(contact_id);
create index arisa_whatsapp_threads_creator on public.arisa_whatsapp_threads(created_by);

create table public.arisa_whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  thread_id uuid not null references public.arisa_whatsapp_threads(id),
  operation_id uuid references public.arisa_whatsapp_operations(id),
  direction text not null check(direction in('inbound','outbound')),
  content text not null check(length(content) between 1 and 12000),
  message_type text not null default 'text',
  provider_message_id text,
  delivery_status text not null default 'prepared' check(delivery_status in('prepared','queued','accepted','sent','delivered','read','failed','unknown')),
  metadata jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  status_at timestamptz,
  created_at timestamptz not null default now(),
  unique(organization_id,provider_message_id)
);
create index arisa_whatsapp_messages_thread on public.arisa_whatsapp_messages(thread_id,occurred_at desc);
create index arisa_whatsapp_messages_org on public.arisa_whatsapp_messages(organization_id,occurred_at desc,id);
create unique index arisa_whatsapp_messages_operation on public.arisa_whatsapp_messages(operation_id) where operation_id is not null;
alter table public.arisa_whatsapp_operations
  add column thread_id uuid references public.arisa_whatsapp_threads(id),
  add column channel_message_id uuid references public.arisa_whatsapp_messages(id),
  add column phone_number_id text;
create index arisa_whatsapp_ops_thread on public.arisa_whatsapp_operations(thread_id);
create index arisa_whatsapp_ops_channel_message on public.arisa_whatsapp_operations(channel_message_id);
alter table public.arisa_whatsapp_threads enable row level security;
alter table public.arisa_whatsapp_messages enable row level security;
revoke all on public.arisa_whatsapp_threads,public.arisa_whatsapp_messages from public,anon,authenticated,service_role;
grant select on public.arisa_whatsapp_threads,public.arisa_whatsapp_messages to authenticated,service_role;
create policy arisa_whatsapp_threads_admin on public.arisa_whatsapp_threads for select to authenticated using(private.arisa_is_admin(organization_id));
create policy arisa_whatsapp_messages_admin on public.arisa_whatsapp_messages for select to authenticated using(private.arisa_is_admin(organization_id));

create function public.arisa_whatsapp_credentials(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'SERVICE_REQUIRED' using errcode='42501';end if;
  result=public.get_whatsapp_runtime_credentials(p_organization_id);
  if result is null then return null;end if;
  return result || jsonb_build_object('legacy_crm_enabled',coalesce((result->>'enabled')::boolean,false),'enabled',coalesce((select enabled from crm_private.arisa_whatsapp_channel where organization_id=p_organization_id),false),'configured',nullif(result->>'phone_number_id','') is not null and nullif(result->>'waba_id','') is not null and nullif(result->>'access_token','') is not null and nullif(result->>'app_secret','') is not null and nullif(result->>'verify_token','') is not null);
end $$;
create function public.arisa_whatsapp_credentials_by_phone_number_id(p_phone_number_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'SERVICE_REQUIRED' using errcode='42501';end if;
  select organization_id into org from crm_private.whatsapp_runtime_settings where phone_number_id=trim(p_phone_number_id);
  if org is null then return null;end if;
  return public.arisa_whatsapp_credentials(org);
end $$;
create function public.arisa_whatsapp_verify_webhook(p_organization_id uuid,p_phone_number_id text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' or not exists(select 1 from crm_private.whatsapp_runtime_settings where organization_id=p_organization_id and phone_number_id=p_phone_number_id) then raise exception 'SERVICE_REQUIRED' using errcode='42501';end if;
  insert into crm_private.arisa_whatsapp_channel(organization_id,webhook_verified_at) values(p_organization_id,now()) on conflict(organization_id) do update set webhook_verified_at=now(),updated_at=now();
  return true;
end $$;

create or replace function public.arisa_whatsapp_service(p_action text,p_org uuid,p_actor uuid,p_args jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  op public.arisa_whatsapp_operations;ct public.contacts;th public.arisa_whatsapp_threads;msg public.arisa_whatsapp_messages;
  rt crm_private.whatsapp_runtime_settings;ch crm_private.arisa_whatsapp_channel;
  v_phone text;v_content text;v_template text;v_lang text;v_components jsonb;v_window boolean;v_result jsonb;v_count integer;v_limit integer;v_offset integer;v_fresh boolean;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' or not private.arisa_actor_admin(p_org,p_actor) then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
  select * into rt from crm_private.whatsapp_runtime_settings where organization_id=p_org;
  select * into ch from crm_private.arisa_whatsapp_channel where organization_id=p_org;
  if p_action='status' then
    return jsonb_build_object('enabled',coalesce(ch.enabled,false),'configured',rt.phone_number_id is not null and rt.waba_id is not null and rt.graph_api_version is not null and rt.access_token_vault_id is not null and rt.app_secret_vault_id is not null and rt.verify_token_vault_id is not null,'ready',coalesce(ch.enabled,false) and rt.phone_number_id is not null and rt.waba_id is not null and rt.graph_api_version is not null and rt.access_token_vault_id is not null and rt.app_secret_vault_id is not null and rt.verify_token_vault_id is not null and (ch.webhook_verified_at is not null or ch.webhook_confirmed_at is not null),'legacy_crm_enabled',coalesce(rt.enabled,false),'mode','administrative','waba_id',rt.waba_id,'phone_number_id',rt.phone_number_id,'graph_api_version',rt.graph_api_version,'display_phone_number',rt.display_phone_number,'access_token_configured',rt.access_token_vault_id is not null,'app_secret_configured',rt.app_secret_vault_id is not null,'verify_token_configured',rt.verify_token_vault_id is not null,'webhook_path','/api/integrations/whatsapp/webhook','webhook_confirmed',ch.webhook_confirmed_at is not null or ch.webhook_verified_at is not null,'webhook_verified_at',ch.webhook_verified_at,'last_inbound_at',(select max(last_inbound_at) from public.arisa_whatsapp_threads where organization_id=p_org),'auto_reply_enabled',false);
  elsif p_action='configure' then
    if jsonb_typeof(p_args->'enabled') is distinct from 'boolean' then raise exception 'WHATSAPP_INVALID';end if;
    if (p_args->>'enabled')::boolean and (rt.phone_number_id is null or rt.waba_id is null or rt.graph_api_version is null or rt.access_token_vault_id is null or rt.app_secret_vault_id is null or rt.verify_token_vault_id is null) then raise exception 'WHATSAPP_NOT_CONFIGURED';end if;
    if (p_args->>'enabled')::boolean and ch.webhook_verified_at is null and ch.webhook_confirmed_at is null and coalesce(p_args->>'webhook_confirmed','false')<>'true' then raise exception 'WHATSAPP_WEBHOOK_REQUIRED';end if;
    insert into crm_private.arisa_whatsapp_channel(organization_id,enabled,webhook_confirmed_at,updated_by) values(p_org,(p_args->>'enabled')::boolean,case when p_args->>'webhook_confirmed'='true' then now() end,p_actor) on conflict(organization_id) do update set enabled=excluded.enabled,webhook_confirmed_at=coalesce(excluded.webhook_confirmed_at,crm_private.arisa_whatsapp_channel.webhook_confirmed_at),updated_by=p_actor,updated_at=now();
    return public.arisa_whatsapp_service('status',p_org,p_actor);
  elsif p_action='list' then
    v_limit=least(greatest(coalesce((p_args->>'limit')::integer,50),1),100);v_offset=greatest(coalesce((p_args->>'offset')::integer,0),0);
    select coalesce(jsonb_agg(row_value order by occurred_at desc,id desc),'[]'::jsonb) into v_result from (
      select m.id,m.occurred_at,jsonb_build_object('id',m.id,'thread_id',m.thread_id,'operation_id',m.operation_id,'direction',m.direction,'content',m.content,'message_type',m.message_type,'contact_id',t.contact_id,'contact_name',coalesce(c.name,t.contact_name),'phone',t.phone,'occurred_at',m.occurred_at,'status',o.status,'delivery_status',m.delivery_status,'template_name',o.template_name,'provider_message_id',m.provider_message_id,'metadata',m.metadata) row_value
      from public.arisa_whatsapp_messages m join public.arisa_whatsapp_threads t on t.id=m.thread_id left join public.contacts c on c.id=t.contact_id left join public.arisa_whatsapp_operations o on o.id=m.operation_id
      where m.organization_id=p_org and (nullif(p_args->>'thread_id','') is null or t.id=(p_args->>'thread_id')::uuid) and (nullif(p_args->>'contact_id','') is null or t.contact_id=(p_args->>'contact_id')::uuid) and (nullif(p_args->>'phone','') is null or t.phone=regexp_replace(p_args->>'phone','[^0-9]','','g'))
      order by m.occurred_at desc,m.id desc limit v_limit+1 offset v_offset
    ) rows;
    return jsonb_build_object('messages',case when jsonb_array_length(v_result)>v_limit then v_result-v_limit else v_result end,'has_more',jsonb_array_length(v_result)>v_limit,'next_offset',v_offset+v_limit);
  elsif p_action='resolve' then
    v_phone=regexp_replace(coalesce(p_args->>'phone',''),'[^0-9]','','g');
    if nullif(p_args->>'contact_id','') is not null then
      select * into ct from public.contacts where id=(p_args->>'contact_id')::uuid and organization_id=p_org and active;
      if not found then raise exception 'WHATSAPP_CONTACT_NOT_FOUND';end if;
      if v_phone<>'' and v_phone<>regexp_replace(coalesce(ct.phone,''),'[^0-9]','','g') then raise exception 'WHATSAPP_CONTACT_PHONE_MISMATCH';end if;
      v_phone=regexp_replace(coalesce(ct.phone,''),'[^0-9]','','g');
    end if;
    if v_phone!~'^[1-9][0-9]{7,14}$' then raise exception 'WHATSAPP_PHONE_INVALID';end if;
    if ct.id is null then
      select count(*) into v_count from public.contacts c where c.organization_id=p_org and c.active and regexp_replace(coalesce(c.phone,''),'[^0-9]','','g')=v_phone;
      if v_count>1 then raise exception 'WHATSAPP_CONTACT_AMBIGUOUS';end if;
      select * into ct from public.contacts c where c.organization_id=p_org and c.active and regexp_replace(coalesce(c.phone,''),'[^0-9]','','g')=v_phone;
    end if;
    if ct.do_not_contact_at is not null or lower(coalesce(ct.marketing_consent_status,'')) in('denied','revoked') then raise exception 'WHATSAPP_CONTACT_BLOCKED' using errcode='42501';end if;
    return jsonb_build_object('phone',v_phone,'contact_id',ct.id,'contact_name',ct.name);
  elsif p_action='prepare' then
    if not coalesce(ch.enabled,false) or rt.phone_number_id is null then raise exception 'WHATSAPP_NOT_CONFIGURED';end if;
    if coalesce(p_args->>'operation_key','')!~'^[a-f0-9]{64}$' or coalesce(p_args->>'payload_hash','')!~'^[a-f0-9]{64}$' then raise exception 'WHATSAPP_INVALID';end if;
    perform pg_advisory_xact_lock(hashtextextended('arisa-whatsapp:'||p_org::text||':'||(p_args->>'operation_key'),0));
    select * into op from public.arisa_whatsapp_operations where organization_id=p_org and operation_key=p_args->>'operation_key' for update;
    if found then
      if op.actor_user_id<>p_actor then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
      if op.payload_hash<>p_args->>'payload_hash' then raise exception 'WHATSAPP_REQUEST_CHANGED';end if;
      return to_jsonb(op)||jsonb_build_object('proceed',false);
    end if;
    if nullif(p_args->>'message_id','') is not null and not exists(select 1 from public.arisa_chat_messages m where m.id=(p_args->>'message_id')::uuid and m.organization_id=p_org and m.owner_user_id=p_actor and m.role='user' and m.status='processing' and m.lease_token=(p_args->>'lease')::uuid and m.lease_expires_at>now()) then raise exception 'ARISA_LEASE_CHANGED';end if;
    v_content=trim(coalesce(p_args->>'content',''));if length(v_content) not between 1 and 12000 then raise exception 'WHATSAPP_INVALID';end if;
    v_phone=regexp_replace(coalesce(p_args->>'phone',''),'[^0-9]','','g');
    if nullif(p_args->>'contact_id','') is not null then
      select * into ct from public.contacts where id=(p_args->>'contact_id')::uuid and organization_id=p_org and active;
      if not found then raise exception 'WHATSAPP_CONTACT_NOT_FOUND';end if;
      if v_phone<>'' and v_phone<>regexp_replace(coalesce(ct.phone,''),'[^0-9]','','g') then raise exception 'WHATSAPP_CONTACT_PHONE_MISMATCH';end if;
      v_phone=regexp_replace(coalesce(ct.phone,''),'[^0-9]','','g');
    end if;
    if v_phone!~'^[1-9][0-9]{7,14}$' then raise exception 'WHATSAPP_PHONE_INVALID';end if;
    if ct.id is null then
      select count(*) into v_count from public.contacts c where c.organization_id=p_org and c.active and regexp_replace(coalesce(c.phone,''),'[^0-9]','','g')=v_phone;
      if v_count>1 then raise exception 'WHATSAPP_CONTACT_AMBIGUOUS';end if;
      select * into ct from public.contacts c where c.organization_id=p_org and c.active and regexp_replace(coalesce(c.phone,''),'[^0-9]','','g')=v_phone;
    end if;
    if ct.do_not_contact_at is not null or lower(coalesce(ct.marketing_consent_status,'')) in('denied','revoked') then raise exception 'WHATSAPP_CONTACT_BLOCKED' using errcode='42501';end if;
    insert into public.arisa_whatsapp_threads(organization_id,phone_number_id,phone,contact_id,contact_name,created_by) values(p_org,rt.phone_number_id,v_phone,ct.id,coalesce(ct.name,nullif(left(trim(p_args->>'contact_name'),180),'')),p_actor) on conflict(organization_id,phone_number_id,phone) do update set contact_id=coalesce(excluded.contact_id,public.arisa_whatsapp_threads.contact_id),contact_name=coalesce(excluded.contact_name,public.arisa_whatsapp_threads.contact_name) returning * into th;
    if th.opted_out_at is not null then raise exception 'WHATSAPP_CONTACT_BLOCKED' using errcode='42501';end if;
    v_window=th.last_inbound_at is not null and th.last_inbound_at>now()-interval '24 hours' and th.last_inbound_at<=now();
    v_template=nullif(trim(p_args->>'template_name'),'');v_lang=coalesce(nullif(trim(p_args->>'template_language'),''),'pt_BR');v_components=coalesce(p_args->'template_components','[]'::jsonb);
    if jsonb_typeof(v_components)<>'array' or pg_column_size(v_components)>32768 then raise exception 'WHATSAPP_INVALID';end if;
    if not v_window and v_template is null then raise exception 'WHATSAPP_TEMPLATE_REQUIRED';end if;
    if v_template is null and length(v_content)>4096 then raise exception 'WHATSAPP_INVALID';end if;
    insert into public.arisa_whatsapp_operations(organization_id,actor_user_id,source_message_id,operation_key,payload_hash,contact_id,phone,phone_number_id,thread_id,send_mode,template_name,template_language,template_components) values(p_org,p_actor,nullif(p_args->>'message_id','')::uuid,p_args->>'operation_key',p_args->>'payload_hash',ct.id,v_phone,rt.phone_number_id,th.id,case when v_template is null then 'freeform' else 'template' end,v_template,v_lang,v_components) returning * into op;
    insert into public.arisa_whatsapp_messages(organization_id,thread_id,operation_id,direction,content,metadata) values(p_org,th.id,op.id,'outbound',v_content,jsonb_build_object('send_mode',op.send_mode,'template_name',v_template,'template_components',v_components,'requested_content',p_args->>'requested_content')) returning * into msg;
    update public.arisa_whatsapp_operations set channel_message_id=msg.id where id=op.id returning * into op;
    return to_jsonb(op)||jsonb_build_object('proceed',true,'window_open',v_window,'last_inbound_at',th.last_inbound_at);
  elsif p_action in('get','claim','finish','fail') then
    select * into op from public.arisa_whatsapp_operations where id=(p_args->>'id')::uuid and organization_id=p_org and actor_user_id=p_actor for update;
    if not found then raise exception 'WHATSAPP_NOT_FOUND';end if;
    select * into msg from public.arisa_whatsapp_messages where id=op.channel_message_id and organization_id=p_org;
    if p_action='get' then return to_jsonb(op)||jsonb_build_object('delivery_status',msg.delivery_status,'provider_message_id',msg.provider_message_id,'content',msg.content);end if;
    if p_action='claim' then
      if op.status<>'prepared' then return to_jsonb(op)||jsonb_build_object('proceed',false);end if;
      if not coalesce(ch.enabled,false) or rt.phone_number_id is distinct from op.phone_number_id then raise exception 'WHATSAPP_NOT_CONFIGURED';end if;
      select * into th from public.arisa_whatsapp_threads where id=op.thread_id and organization_id=p_org for update;
      select * into ct from public.contacts where id=op.contact_id and organization_id=p_org;
      if (op.contact_id is not null and (ct.id is null or not ct.active)) or ct.do_not_contact_at is not null or lower(coalesce(ct.marketing_consent_status,'')) in('denied','revoked') or th.opted_out_at is not null then raise exception 'WHATSAPP_CONTACT_BLOCKED' using errcode='42501';end if;
      if ct.id is not null and regexp_replace(coalesce(ct.phone,''),'[^0-9]','','g')<>op.phone then raise exception 'WHATSAPP_CONTACT_PHONE_MISMATCH';end if;
      v_window=th.last_inbound_at is not null and th.last_inbound_at>now()-interval '24 hours' and th.last_inbound_at<=now();
      if op.send_mode='freeform' and not v_window then raise exception 'WHATSAPP_TEMPLATE_REQUIRED';end if;
      update public.arisa_whatsapp_operations set status='queued',updated_at=now() where id=op.id returning * into op;
      update public.arisa_whatsapp_messages set delivery_status='queued' where id=msg.id;
      return to_jsonb(op)||jsonb_build_object('proceed',true,'content',msg.content,'window_open',v_window,'last_inbound_at',th.last_inbound_at);
    elsif p_action='finish' then
      if op.status='completed' then return op.result||jsonb_build_object('delivery_status',msg.delivery_status,'provider_message_id',msg.provider_message_id);end if;
      if length(coalesce(p_args->>'provider_message_id','')) not between 8 and 512 then raise exception 'WHATSAPP_INVALID';end if;
      if msg.provider_message_id is not null and msg.provider_message_id<>p_args->>'provider_message_id' then raise exception 'WHATSAPP_REQUEST_CHANGED';end if;
      update public.arisa_whatsapp_messages set provider_message_id=p_args->>'provider_message_id',delivery_status=case when delivery_status in('sent','delivered','read','failed') then delivery_status else 'accepted' end,metadata=metadata||jsonb_build_object('accepted_at',now()) where id=msg.id returning * into msg;
      v_result=jsonb_build_object('ok',true,'operation_id',op.id,'message_id',msg.id,'provider_message_id',msg.provider_message_id,'delivery_status',msg.delivery_status,'send_mode',op.send_mode,'phone',op.phone,'content',msg.content,'template_name',op.template_name,'accepted_by_meta',true,'delivered',msg.delivery_status in('delivered','read'),'read',msg.delivery_status='read');
      update public.arisa_whatsapp_operations set status='completed',result=v_result,error_code=null,updated_at=now() where id=op.id;
      update public.arisa_whatsapp_threads set last_message_at=greatest(last_message_at,now()) where id=op.thread_id;
      if op.source_message_id is not null then insert into public.arisa_chat_actions(organization_id,actor_user_id,message_id,operation_key,action,entity,record_id,summary,result) values(p_org,p_actor,op.source_message_id,op.operation_key,'send','whatsapp',msg.id::text,'WhatsApp aceito pela Meta para +'||op.phone,v_result) on conflict do nothing;end if;
      perform private.arisa_archive_put(p_org,p_actor,'arisa_whatsapp_operations',op.id::text,'platform','action','arisa','whatsapp:'||msg.id,'WhatsApp','WhatsApp para +'||op.phone,msg.content,v_result,now(),false);
      return v_result;
    else
      if op.status='completed' then return jsonb_build_object('ok',true,'status','completed');end if;
      update public.arisa_whatsapp_operations set status=case when p_args->>'status'='failed' then 'failed' else 'unknown' end,error_code=left(coalesce(p_args->>'error','WHATSAPP_UNAVAILABLE'),128),updated_at=now() where id=op.id;
      update public.arisa_whatsapp_messages set delivery_status=case when p_args->>'status'='failed' then 'failed' else 'unknown' end,metadata=metadata||jsonb_build_object('error_code',left(coalesce(p_args->>'error','WHATSAPP_UNAVAILABLE'),128)) where id=msg.id and provider_message_id is null;
      return jsonb_build_object('ok',true);
    end if;
  end if;
  raise exception 'WHATSAPP_INVALID';
end $$;

create function public.arisa_whatsapp_webhook(p_organization_id uuid,p_phone_number_id text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item jsonb;th public.arisa_whatsapp_threads;ct public.contacts;msg public.arisa_whatsapp_messages;op public.arisa_whatsapp_operations;v_phone text;v_id text;v_status text;v_time timestamptz;v_count integer;v_rank integer;v_old_rank integer;v_messages jsonb:='[]';v_statuses jsonb:='[]';v_result jsonb;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'SERVICE_REQUIRED' using errcode='42501';end if;
  if not exists(select 1 from crm_private.whatsapp_runtime_settings s where s.organization_id=p_organization_id and s.phone_number_id=p_phone_number_id) then return jsonb_build_object('handled_message_ids',v_messages,'handled_status_ids',v_statuses);end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or pg_column_size(p_payload)>1048576 then raise exception 'WHATSAPP_INVALID';end if;
  for item in select value from jsonb_array_elements(coalesce(p_payload->'messages','[]')) loop
    th=null;ct=null;v_id=item->>'provider_message_id';v_phone=regexp_replace(coalesce(item->>'from_phone',''),'[^0-9]','','g');
    if length(coalesce(v_id,'')) not between 8 and 512 or v_phone!~'^[1-9][0-9]{7,14}$' or length(coalesce(item->>'content','')) not between 1 and 12000 then continue;end if;
    select * into th from public.arisa_whatsapp_threads where organization_id=p_organization_id and phone_number_id=p_phone_number_id and phone=v_phone for update;
    if th.id is null then
      select count(*) into v_count from public.contacts where organization_id=p_organization_id and active and regexp_replace(coalesce(phone,''),'[^0-9]','','g')=v_phone;
      if v_count<>1 then continue;end if;
      select * into ct from public.contacts where organization_id=p_organization_id and active and regexp_replace(coalesce(phone,''),'[^0-9]','','g')=v_phone;
      if ct.contact_type not in('fornecedor','colaborador','terrenista') then continue;end if;
      insert into public.arisa_whatsapp_threads(organization_id,phone_number_id,phone,contact_id,contact_name) values(p_organization_id,p_phone_number_id,v_phone,ct.id,ct.name) on conflict(organization_id,phone_number_id,phone) do update set contact_name=coalesce(public.arisa_whatsapp_threads.contact_name,excluded.contact_name) returning * into th;
    end if;
    v_messages=v_messages||jsonb_build_array(v_id);
    v_time=coalesce(nullif(item->>'occurred_at','')::timestamptz,now());
    if v_time>now()+interval '5 minutes' then continue;end if;v_time=least(v_time,now());
    insert into public.arisa_whatsapp_messages(organization_id,thread_id,direction,content,message_type,provider_message_id,delivery_status,metadata,occurred_at) values(p_organization_id,th.id,'inbound',item->>'content',left(coalesce(item->>'message_type','text'),40),v_id,'delivered',coalesce(item->'metadata','{}'),v_time) on conflict(organization_id,provider_message_id) do nothing returning * into msg;
    if not found then continue;end if;
    update public.arisa_whatsapp_threads set last_inbound_at=greatest(last_inbound_at,v_time),last_message_at=greatest(last_message_at,v_time),opted_out_at=case when lower(trim(item->>'content')) in('pare','parar','sair','stop','não quero receber mensagens','nao quero receber mensagens') then now() else opted_out_at end where id=th.id;
  end loop;
  for item in select value from jsonb_array_elements(coalesce(p_payload->'statuses','[]')) loop
    op=null;msg=null;v_id=item->>'provider_message_id';v_status=item->>'status';
    if length(coalesce(v_id,'')) not between 8 and 512 or v_status not in('sent','delivered','read','failed') then continue;end if;
    select m.* into msg from public.arisa_whatsapp_messages m join public.arisa_whatsapp_threads t on t.id=m.thread_id where m.organization_id=p_organization_id and t.phone_number_id=p_phone_number_id and m.provider_message_id=v_id and m.direction='outbound';
    if msg.id is null and coalesce(item->>'operation_id','')~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      select * into op from public.arisa_whatsapp_operations where id=(item->>'operation_id')::uuid and organization_id=p_organization_id and phone_number_id=p_phone_number_id and status in('queued','unknown','completed') for update;
      if op.id is not null then select * into msg from public.arisa_whatsapp_messages where id=op.channel_message_id and organization_id=p_organization_id for update;end if;
    end if;
    if msg.id is null or (msg.provider_message_id is not null and msg.provider_message_id<>v_id) then continue;end if;
    -- Match finish's operation-then-message locking order.
    if op.id is null then select * into op from public.arisa_whatsapp_operations where id=msg.operation_id for update;end if;
    if nullif(item->>'recipient_phone','') is not null and regexp_replace(item->>'recipient_phone','[^0-9]','','g') is distinct from op.phone then continue;end if;
    select * into msg from public.arisa_whatsapp_messages where id=msg.id for update;
    v_statuses=v_statuses||jsonb_build_array(v_id);v_time=coalesce(nullif(item->>'occurred_at','')::timestamptz,now());
    if v_time>now()+interval '5 minutes' then continue;end if;v_time=least(v_time,now());
    v_rank=case v_status when 'read' then 4 when 'delivered' then 3 when 'sent' then 2 else 1 end;v_old_rank=case msg.delivery_status when 'read' then 4 when 'delivered' then 3 when 'sent' then 2 else 0 end;
    update public.arisa_whatsapp_messages set provider_message_id=v_id,delivery_status=case when v_status='failed' and v_old_rank<3 then 'failed' when v_rank>v_old_rank and (msg.delivery_status<>'failed' or v_status in('delivered','read')) then v_status else delivery_status end,status_at=greatest(status_at,v_time),metadata=metadata||jsonb_strip_nulls(jsonb_build_object('provider_status',v_status,'provider_status_at',v_time,'provider_error_code',left(item->>'error_code',128))) where id=msg.id returning * into msg;
    if op.id is null then select * into op from public.arisa_whatsapp_operations where id=msg.operation_id for update;end if;
    if op.id is not null then
      v_result=jsonb_build_object('ok',msg.delivery_status<>'failed','operation_id',op.id,'message_id',msg.id,'provider_message_id',v_id,'delivery_status',msg.delivery_status,'phone',op.phone,'content',msg.content,'accepted_by_meta',true,'delivered',msg.delivery_status in('delivered','read'),'read',msg.delivery_status='read');
      update public.arisa_whatsapp_operations set status='completed',result=v_result,updated_at=now() where id=op.id;
    end if;
  end loop;
  return jsonb_build_object('handled_message_ids',v_messages,'handled_status_ids',v_statuses);
end $$;

revoke all on function public.arisa_whatsapp_credentials(uuid),public.arisa_whatsapp_credentials_by_phone_number_id(text),public.arisa_whatsapp_verify_webhook(uuid,text),public.arisa_whatsapp_service(text,uuid,uuid,jsonb),public.arisa_whatsapp_webhook(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.arisa_whatsapp_credentials(uuid),public.arisa_whatsapp_credentials_by_phone_number_id(text),public.arisa_whatsapp_verify_webhook(uuid,text),public.arisa_whatsapp_service(text,uuid,uuid,jsonb),public.arisa_whatsapp_webhook(uuid,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
