begin;
alter table public.arisa_whatsapp_connections drop constraint arisa_connect_no_unverified_assets;
alter table public.arisa_whatsapp_connections drop constraint arisa_whatsapp_connections_coexistence_status_check;
alter table public.arisa_whatsapp_connections drop constraint arisa_whatsapp_connections_onboarding_status_check;
alter table public.arisa_whatsapp_connections add constraint arisa_connect_status check (onboarding_status in ('not_started','checking','blocked','error','authorized','connected','cancelled','disconnected'));
alter table public.arisa_whatsapp_connections add constraint arisa_connect_coexistence check (coexistence_status in ('unknown','verified'));
alter table public.arisa_whatsapp_connections add constraint arisa_connect_verified_assets check (
  (coexistence_status='unknown' and phone_number_id is null and waba_id is null and is_on_biz_app is null and platform_type is null and business_portfolio_id is null and phone_number_masked is null)
  or (coexistence_status='verified' and phone_number_id is not null and waba_id is not null and platform_type is not null and phone_number_id ~ '^[0-9]{5,32}$' and waba_id ~ '^[0-9]{5,32}$' and is_on_biz_app is true and platform_type='CLOUD_API'));
create unique index arisa_connect_phone_unique on public.arisa_whatsapp_connections(phone_number_id) where phone_number_id is not null;
-- The existing NOT automation_enabled constraint is intentionally preserved.
alter table public.arisa_whatsapp_connection_audit drop constraint arisa_whatsapp_connection_audit_event_check;
alter table public.arisa_whatsapp_connection_audit drop constraint arisa_whatsapp_connection_audit_from_state_check;
alter table public.arisa_whatsapp_connection_audit drop constraint arisa_whatsapp_connection_audit_to_state_check;
alter table public.arisa_whatsapp_connection_audit drop constraint arisa_whatsapp_connection_audit_reason_check;
alter table public.arisa_whatsapp_connection_audit add constraint arisa_connect_audit_event check(event in ('preflight_started','onboarding_blocked','onboarding_started','token_received','coexistence_verified','onboarding_connected','onboarding_cancelled','onboarding_error'));
alter table public.arisa_whatsapp_connection_audit add constraint arisa_connect_audit_states check(from_state in ('not_started','checking','blocked','error','authorized','connected','cancelled','disconnected') and to_state in ('not_started','checking','blocked','error','authorized','connected','cancelled','disconnected'));
alter table public.arisa_whatsapp_connection_audit add constraint arisa_connect_audit_reason check(reason in ('PREFLIGHT_ONLY','META_READ_ONLY_ELIGIBILITY_UNAVAILABLE','USER_INITIATED','META_CODE_EXCHANGED','GRAPH_VERIFIED','SYNC_REQUESTED','USER_CANCELLED','PROVIDER_ERROR'));

create table private.arisa_coexistence_settings (
  organization_id uuid primary key references public.organizations(id),
  app_id text not null check(app_id ~ '^[0-9]{5,32}$'),
  config_id text check(config_id ~ '^[0-9]{5,32}$'),
  app_secret_id uuid not null references vault.secrets(id),
  verify_secret_id uuid not null references vault.secrets(id),
  webhook_fields_ready boolean not null default false,
  updated_at timestamptz not null default now()
);
create table private.arisa_coexistence_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  owner_user_id uuid not null references auth.users(id),
  connection_id uuid not null references public.arisa_whatsapp_connections(id),
  nonce_hash text not null check(nonce_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'open' check(status in ('open','exchanging','token_ready','finalizing','completed','cancelled','error','expired')),
  token_id uuid references vault.secrets(id),
  token_expires_at timestamptz,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '20 minutes'
);
create index arisa_coexistence_session_owner_idx on private.arisa_coexistence_sessions(organization_id,owner_user_id,created_at desc);
create index arisa_coexistence_session_connection_idx on private.arisa_coexistence_sessions(connection_id);
create table private.arisa_coexistence_credentials (
  connection_id uuid primary key references public.arisa_whatsapp_connections(id),
  token_id uuid not null references vault.secrets(id),
  token_expires_at timestamptz,
  operations jsonb not null default '{}'::jsonb,
  sync_progress integer check(sync_progress between 0 and 100),
  history_shared boolean,
  updated_at timestamptz not null default now()
);
create table private.arisa_coexistence_inbox (
  id bigint generated always as identity primary key,
  connection_id uuid not null references public.arisa_whatsapp_connections(id),
  event_hash text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  unique(connection_id,event_hash)
);
create index arisa_coexistence_inbox_received_idx on private.arisa_coexistence_inbox(received_at);
alter table private.arisa_coexistence_settings enable row level security;
alter table private.arisa_coexistence_sessions enable row level security;
alter table private.arisa_coexistence_credentials enable row level security;
alter table private.arisa_coexistence_inbox enable row level security;
revoke all on private.arisa_coexistence_settings,private.arisa_coexistence_sessions,private.arisa_coexistence_credentials,private.arisa_coexistence_inbox from public,anon,authenticated;

create function private.arisa_coexistence_snapshot(p_org uuid,p_actor uuid) returns jsonb
language sql security definer set search_path='' as $fn$
select jsonb_build_object(
 'connection',(select jsonb_build_object('id',c.id,'label',c.label,'onboarding_status',c.onboarding_status,'coexistence_status',c.coexistence_status,'updated_at',c.updated_at,'phone_number_masked',c.phone_number_masked,'waba_id',c.waba_id,'phone_number_id',c.phone_number_id,'is_on_biz_app',c.is_on_biz_app,'platform_type',c.platform_type,'operations',coalesce(k.operations,'{}'::jsonb),'sync_progress',k.sync_progress,'history_shared',k.history_shared,'token_expires_at',k.token_expires_at) from public.arisa_whatsapp_connections c left join private.arisa_coexistence_credentials k on k.connection_id=c.id where c.organization_id=p_org and c.owner_user_id=p_actor),
 'configuration',(select jsonb_build_object('appId',s.app_id,'configId',s.config_id,'ready',s.config_id is not null and s.webhook_fields_ready) from private.arisa_coexistence_settings s where organization_id=p_org),
 'audit',coalesce((select jsonb_agg(a order by a.created_at desc) from (select id,event,to_state,created_at from public.arisa_whatsapp_connection_audit where organization_id=p_org and owner_user_id=p_actor order by created_at desc limit 20) a),'[]'::jsonb),
 'primary',coalesce((select jsonb_build_object('configured',s.access_token_vault_id is not null and s.app_secret_vault_id is not null and s.phone_number_id is not null,'enabled',coalesce(c.enabled,false)) from crm_private.whatsapp_runtime_settings s left join crm_private.arisa_whatsapp_channel c using(organization_id) where s.organization_id=p_org),'{"configured":false,"enabled":false}'::jsonb)
);
$fn$;
revoke all on function private.arisa_coexistence_snapshot(uuid,uuid) from public,anon,authenticated;

create or replace function private.arisa_whatsapp_connect(p_organization_id uuid,p_action text,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $fn$
begin
 if auth.uid() is null or not private.arisa_is_admin(p_organization_id) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
 -- Legacy diagnostic calls are now read-only; they cannot reset a real connection.
 return private.arisa_coexistence_snapshot(p_organization_id,auth.uid());
end;$fn$;

create function private.arisa_coexistence_service(p_org uuid,p_actor uuid,p_action text,p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $fn$
declare
 cfg private.arisa_coexistence_settings%rowtype;
 sess private.arisa_coexistence_sessions%rowtype;
 conn public.arisa_whatsapp_connections%rowtype;
 creds private.arisa_coexistence_credentials%rowtype;
 evt text; reason_code text; old_state text; operation_name text; operation_state text;
 secret_ref uuid; result jsonb; start_allowed boolean;
begin
 if p_action in ('webhook_config','webhook_ingest') then
  select * into conn from public.arisa_whatsapp_connections where id=(p_args->>'connectionId')::uuid and coexistence_status='verified';
  if conn.id is null then raise exception 'CONNECTION_NOT_FOUND' using errcode='P0002'; end if;
  select * into cfg from private.arisa_coexistence_settings where organization_id=conn.organization_id;
  if p_action='webhook_config' then
   return jsonb_build_object('wabaId',conn.waba_id,'phoneNumberId',conn.phone_number_id,'appSecret',(select decrypted_secret from vault.decrypted_secrets where id=cfg.app_secret_id),'verifyToken',(select decrypted_secret from vault.decrypted_secrets where id=cfg.verify_secret_id));
  end if;
  if octet_length((p_args->'payload')::text)>2097152 or (p_args->>'hash') !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_REQUEST'; end if;
  insert into private.arisa_coexistence_inbox(connection_id,event_hash,payload) values(conn.id,p_args->>'hash',p_args->'payload') on conflict do nothing;
  if p_args ? 'progress' then update private.arisa_coexistence_credentials set sync_progress=greatest(coalesce(sync_progress,0),(p_args->>'progress')::integer),history_shared=true,updated_at=now() where connection_id=conn.id; end if;
  if p_args->>'historyDeclined'='true' then update private.arisa_coexistence_credentials set history_shared=false,updated_at=now() where connection_id=conn.id; end if;
  if p_args->>'disconnected'='true' then update public.arisa_whatsapp_connections set onboarding_status='disconnected',updated_at=now() where id=conn.id; end if;
  delete from private.arisa_coexistence_inbox where connection_id=conn.id and received_at<now()-interval '30 days';
  return '{"ok":true}'::jsonb;
 end if;
 if p_actor is null or not exists(select 1 from public.organization_members m join public.organizations o on o.id=m.organization_id where m.organization_id=p_org and m.user_id=p_actor and m.active and m.role='admin' and o.active) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
 if p_action='status' then return private.arisa_coexistence_snapshot(p_org,p_actor); end if;
 select * into cfg from private.arisa_coexistence_settings where organization_id=p_org;
 if cfg.app_id is null or cfg.config_id is null or not cfg.webhook_fields_ready then raise exception 'META_CONFIGURATION_REQUIRED' using errcode='P0001'; end if;
 if p_action='config' then return jsonb_build_object('appId',cfg.app_id,'configId',cfg.config_id,'appSecret',(select decrypted_secret from vault.decrypted_secrets where id=cfg.app_secret_id),'verifyToken',(select decrypted_secret from vault.decrypted_secrets where id=cfg.verify_secret_id)); end if;
 perform pg_advisory_xact_lock(hashtextextended(p_actor::text||':'||p_org::text||':whatsapp-connect',0));
 select * into conn from public.arisa_whatsapp_connections where organization_id=p_org and owner_user_id=p_actor for update;
 if p_action='begin' then
  if coalesce(conn.onboarding_status,'') in ('authorized','connected') then raise exception 'CONNECTION_EXISTS'; end if;
  if (p_args->>'nonceHash') is null or (p_args->>'nonceHash') !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_REQUEST'; end if;
  if (select count(*) from private.arisa_coexistence_sessions where organization_id=p_org and owner_user_id=p_actor and created_at>now()-interval '1 hour')>=5 then raise exception 'RATE_LIMITED' using errcode='P0429'; end if;
  if exists(select 1 from private.arisa_coexistence_sessions where organization_id=p_org and owner_user_id=p_actor and status in ('exchanging','token_ready','finalizing') and expires_at>now()) then raise exception 'SESSION_IN_PROGRESS'; end if;
  update private.arisa_coexistence_sessions set status='expired' where organization_id=p_org and owner_user_id=p_actor and status='open';
  insert into public.arisa_whatsapp_connections(organization_id,owner_user_id) values(p_org,p_actor) on conflict do nothing;
  select * into conn from public.arisa_whatsapp_connections where organization_id=p_org and owner_user_id=p_actor for update;
  old_state=conn.onboarding_status;
  update public.arisa_whatsapp_connections set onboarding_status='checking',updated_at=now() where id=conn.id;
  insert into private.arisa_coexistence_sessions(organization_id,owner_user_id,connection_id,nonce_hash) values(p_org,p_actor,conn.id,p_args->>'nonceHash') returning * into sess;
  insert into public.arisa_whatsapp_connection_audit(connection_id,organization_id,owner_user_id,request_id,event,from_state,to_state,reason) values(conn.id,p_org,p_actor,sess.id,'onboarding_started',old_state,'checking','USER_INITIATED');
  return jsonb_build_object('sessionId',sess.id,'expiresAt',sess.expires_at,'appId',cfg.app_id,'configId',cfg.config_id);
 end if;
 select * into sess from private.arisa_coexistence_sessions where id=(p_args->>'sessionId')::uuid and organization_id=p_org and owner_user_id=p_actor and nonce_hash=p_args->>'nonceHash' for update;
 if sess.id is null or sess.expires_at<now() then raise exception 'SESSION_INVALID' using errcode='42501'; end if;
 if p_action='claim' then
  if sess.status in ('token_ready','finalizing','completed') then return jsonb_build_object('alreadyExchanged',true); end if;
  if sess.status<>'open' then raise exception 'SESSION_CONSUMED'; end if;
  update private.arisa_coexistence_sessions set status='exchanging' where id=sess.id;
  return '{"alreadyExchanged":false}'::jsonb;
 elsif p_action='token' then
  if sess.status<>'exchanging' or p_args->>'token' is null or length(p_args->>'token') not between 20 and 8192 then raise exception 'SESSION_INVALID'; end if;
  secret_ref=vault.create_secret(p_args->>'token','arisa-coexistence-token-'||sess.id);
  update private.arisa_coexistence_sessions set status='token_ready',token_id=secret_ref,token_expires_at=(p_args->>'expiresAt')::timestamptz where id=sess.id;
  evt='token_received';reason_code='META_CODE_EXCHANGED';
 elsif p_action='claim_complete' then
  if sess.status='completed' then return jsonb_build_object('completed',true); end if;
  if sess.status not in ('token_ready','finalizing') or (sess.status='finalizing' and sess.lease_until>now()) then raise exception 'SESSION_IN_PROGRESS'; end if;
  update private.arisa_coexistence_sessions set status='finalizing',lease_until=now()+interval '120 seconds' where id=sess.id;
  return jsonb_build_object('token',(select decrypted_secret from vault.decrypted_secrets where id=sess.token_id),'connectionId',sess.connection_id);
 elsif p_action='save_assets' then
  if sess.status<>'finalizing' or (p_args->>'isOnBizApp') is distinct from 'true' or (p_args->>'platformType') is distinct from 'CLOUD_API' then raise exception 'COEXISTENCE_NOT_CONFIRMED'; end if;
  if exists(select 1 from crm_private.whatsapp_runtime_settings where phone_number_id=p_args->>'phoneNumberId' or waba_id=p_args->>'wabaId') or exists(select 1 from crm_private.bia_whatsapp_channels where phone_number_id=p_args->>'phoneNumberId' or waba_id=p_args->>'wabaId') then raise exception 'EXISTING_CHANNEL_PROTECTED'; end if;
  if conn.phone_number_id is not null and conn.phone_number_id<>p_args->>'phoneNumberId' then raise exception 'CONNECTION_EXISTS'; end if;
  old_state=conn.onboarding_status;
  update public.arisa_whatsapp_connections set phone_number_masked=p_args->>'maskedPhone',business_portfolio_id=p_args->>'businessId',waba_id=p_args->>'wabaId',phone_number_id=p_args->>'phoneNumberId',is_on_biz_app=true,platform_type='CLOUD_API',coexistence_status='verified',onboarding_status='authorized',updated_at=now() where id=conn.id;
  insert into private.arisa_coexistence_credentials(connection_id,token_id,token_expires_at) values(conn.id,sess.token_id,sess.token_expires_at) on conflict(connection_id) do nothing;
  evt='coexistence_verified';reason_code='GRAPH_VERIFIED';
 elsif p_action='operation' then
  if sess.status<>'finalizing' then raise exception 'SESSION_INVALID'; end if;
  operation_name=p_args->>'name'; operation_state=p_args->>'state';
  if operation_name is null or operation_state is null or operation_name not in ('subscription','contacts','history') or operation_state not in ('start','done','uncertain') then raise exception 'INVALID_REQUEST'; end if;
  select * into creds from private.arisa_coexistence_credentials where connection_id=conn.id for update;
  if creds.connection_id is null then raise exception 'COEXISTENCE_NOT_CONFIRMED'; end if;
  if operation_state='start' then
   start_allowed=not(creds.operations ? operation_name);
   if start_allowed then update private.arisa_coexistence_credentials set operations=jsonb_set(operations,array[operation_name],'"in_progress"'::jsonb),updated_at=now() where connection_id=conn.id; end if;
   return jsonb_build_object('execute',start_allowed,'status',creds.operations->>operation_name);
  end if;
  update private.arisa_coexistence_credentials set operations=jsonb_set(operations,array[operation_name],to_jsonb(operation_state)),updated_at=now() where connection_id=conn.id;
  return '{"ok":true}'::jsonb;
 elsif p_action='finish' then
  select * into creds from private.arisa_coexistence_credentials where connection_id=conn.id;
  if sess.status<>'finalizing' or not coalesce(creds.operations @> '{"subscription":"done","contacts":"done","history":"done"}',false) then raise exception 'SYNC_REVIEW_REQUIRED'; end if;
  old_state=conn.onboarding_status;
  update public.arisa_whatsapp_connections set onboarding_status='connected',updated_at=now() where id=conn.id;
  update private.arisa_coexistence_sessions set status='completed',lease_until=null where id=sess.id;
  evt='onboarding_connected';reason_code='SYNC_REQUESTED';
 elsif p_action='cancel' then
  if sess.status<>'open' then return private.arisa_coexistence_snapshot(p_org,p_actor); end if;
  old_state=conn.onboarding_status;
  update private.arisa_coexistence_sessions set status='cancelled' where id=sess.id;
  update public.arisa_whatsapp_connections set onboarding_status='cancelled',updated_at=now() where id=conn.id;
  evt='onboarding_cancelled';reason_code='USER_CANCELLED';
 elsif p_action='error' then
  old_state=conn.onboarding_status;
  update private.arisa_coexistence_sessions set status=case when token_id is null then 'error' else 'token_ready' end,lease_until=null where id=sess.id and status<>'completed';
  if conn.coexistence_status='unknown' then update public.arisa_whatsapp_connections set onboarding_status='error',updated_at=now() where id=conn.id; end if;
  evt='onboarding_error';reason_code='PROVIDER_ERROR';
 else raise exception 'INVALID_ACTION';
 end if;
 select * into conn from public.arisa_whatsapp_connections where id=sess.connection_id;
 insert into public.arisa_whatsapp_connection_audit(connection_id,organization_id,owner_user_id,request_id,event,from_state,to_state,reason) values(conn.id,p_org,p_actor,sess.id,evt,coalesce(old_state,conn.onboarding_status),conn.onboarding_status,reason_code) on conflict do nothing;
 return private.arisa_coexistence_snapshot(p_org,p_actor);
end;$fn$;
revoke all on function private.arisa_coexistence_service(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant usage on schema private to service_role;
grant execute on function private.arisa_coexistence_service(uuid,uuid,text,jsonb) to service_role;
create function public.arisa_coexistence_service(p_org uuid,p_actor uuid,p_action text,p_args jsonb default '{}'::jsonb) returns jsonb language sql security invoker set search_path='' as $fn$ select private.arisa_coexistence_service(p_org,p_actor,p_action,p_args); $fn$;
revoke all on function public.arisa_coexistence_service(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.arisa_coexistence_service(uuid,uuid,text,jsonb) to service_role;
comment on table private.arisa_coexistence_inbox is 'Signed webhook staging for the personal channel only; no reply worker reads this table. Opportunistic 30-day retention per connection.';
comment on table public.arisa_whatsapp_connections is 'Verified personal coexistence channel; automatic replies remain disabled.';
commit;
