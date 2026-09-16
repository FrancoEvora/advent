begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table crm_private.enterprise_meta_onboarding_claims (
  nonce text primary key check (nonce ~ '^[a-f0-9]{48}$'),
  organization_id uuid not null references public.organizations(id),
  actor_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index enterprise_meta_claim_org on crm_private.enterprise_meta_onboarding_claims(organization_id);
create index enterprise_meta_claim_actor on crm_private.enterprise_meta_onboarding_claims(actor_id,created_at);
alter table crm_private.enterprise_meta_onboarding_claims enable row level security;
revoke all on crm_private.enterprise_meta_onboarding_claims from public,anon,authenticated,service_role;

create table crm_private.enterprise_instagram_accounts (
  organization_id uuid primary key references public.organizations(id),
  instagram_user_id text not null unique check (instagram_user_id ~ '^[0-9]{1,64}$'),
  username text not null check (length(username) between 1 and 100),
  access_token_vault_id uuid not null,
  expires_at timestamptz not null,
  authorized_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id)
);
create index enterprise_instagram_actor on crm_private.enterprise_instagram_accounts(updated_by);
alter table crm_private.enterprise_instagram_accounts enable row level security;
revoke all on crm_private.enterprise_instagram_accounts from public,anon,authenticated,service_role;

create function crm_private.enterprise_meta_claim_onboarding(p_organization_id uuid,p_nonce text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not public.has_app_permission(p_organization_id,'crm.integrations.manage') then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
  if p_nonce is null or p_nonce !~ '^[a-f0-9]{48}$' then raise exception 'INVALID_NONCE'; end if;
  delete from crm_private.enterprise_meta_onboarding_claims where actor_id=auth.uid() and created_at<now()-interval '1 day';
  insert into crm_private.enterprise_meta_onboarding_claims(nonce,organization_id,actor_id) values(p_nonce,p_organization_id,auth.uid()) on conflict do nothing;
  return found;
end $$;
create function public.enterprise_meta_claim_onboarding(p_organization_id uuid,p_nonce text)
returns boolean language sql security invoker set search_path='' as $$ select crm_private.enterprise_meta_claim_onboarding(p_organization_id,p_nonce) $$;

create function crm_private.enterprise_instagram_status(p_organization_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare account crm_private.enterprise_instagram_accounts;
begin
  if auth.uid() is null or not public.has_app_permission(p_organization_id,'crm.integrations.manage') then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
  select * into account from crm_private.enterprise_instagram_accounts where organization_id=p_organization_id;
  if not found then return jsonb_build_object('authorized',false,'messaging_ready',false); end if;
  return jsonb_build_object('authorized',account.expires_at>now(),'username',account.username,'instagram_user_id',account.instagram_user_id,'expires_at',account.expires_at,'authorized_at',account.authorized_at,'messaging_ready',false);
end $$;
create function public.enterprise_instagram_status(p_organization_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select crm_private.enterprise_instagram_status(p_organization_id) $$;

create function crm_private.enterprise_connect_instagram(p_organization_id uuid,p_instagram_user_id text,p_username text,p_access_token text,p_expires_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare account crm_private.enterprise_instagram_accounts; token_id uuid;
begin
  if auth.uid() is null or not public.has_app_permission(p_organization_id,'crm.integrations.manage') then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
  if p_instagram_user_id is null or p_instagram_user_id !~ '^[0-9]{1,64}$' or p_username is null or length(p_username) not between 1 and 100 or p_access_token is null or length(p_access_token) not between 20 and 8192 or p_access_token ~ '[[:space:]]' or p_expires_at is null or p_expires_at<=now() or p_expires_at>now()+interval '90 days' then raise exception 'INVALID_INSTAGRAM_ACCOUNT'; end if;
  perform pg_advisory_xact_lock(hashtextextended('enterprise-instagram:'||p_organization_id::text,0));
  select * into account from crm_private.enterprise_instagram_accounts where organization_id=p_organization_id for update;
  if found and account.instagram_user_id<>p_instagram_user_id then raise exception 'INSTAGRAM_ACCOUNT_CHANGE_REQUIRES_MIGRATION'; end if;
  token_id=account.access_token_vault_id;
  if token_id is null then select vault.create_secret(p_access_token) into token_id;
  else perform vault.update_secret(token_id,p_access_token); end if;
  insert into crm_private.enterprise_instagram_accounts(organization_id,instagram_user_id,username,access_token_vault_id,expires_at,updated_by)
  values(p_organization_id,p_instagram_user_id,p_username,token_id,p_expires_at,auth.uid())
  on conflict(organization_id) do update set username=excluded.username,access_token_vault_id=excluded.access_token_vault_id,expires_at=excluded.expires_at,authorized_at=now(),updated_by=auth.uid();
  return crm_private.enterprise_instagram_status(p_organization_id);
end $$;
create function public.enterprise_connect_instagram(p_organization_id uuid,p_instagram_user_id text,p_username text,p_access_token text,p_expires_at timestamptz)
returns jsonb language sql security invoker set search_path='' as $$ select crm_private.enterprise_connect_instagram(p_organization_id,p_instagram_user_id,p_username,p_access_token,p_expires_at) $$;

-- Serialize using the same lock as the existing runtime. No change to Bia's
-- enabled/mode switches, Arisa's independent channel, or either history.
create function crm_private.enterprise_connect_whatsapp(p_organization_id uuid,p_waba_id text,p_phone_number_id text,p_graph_api_version text,p_display_phone_number text,p_access_token text,p_app_secret text,p_verify_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare current_channel crm_private.whatsapp_runtime_settings;
begin
  if auth.uid() is null or not public.has_app_permission(p_organization_id,'crm.integrations.manage') then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('evora-whatsapp-runtime:'||p_organization_id::text,0));
  select * into current_channel from crm_private.whatsapp_runtime_settings where organization_id=p_organization_id for update;
  if (current_channel.phone_number_id is not null and current_channel.phone_number_id is distinct from p_phone_number_id) or (current_channel.waba_id is not null and current_channel.waba_id is distinct from p_waba_id) then raise exception 'CHANNEL_CHANGE_REQUIRES_MIGRATION'; end if;
  return crm_private.configure_whatsapp_runtime_internal(p_organization_id,p_waba_id,p_phone_number_id,p_graph_api_version,p_display_phone_number,p_access_token,p_app_secret,p_verify_token,null,null);
end $$;
create function public.enterprise_connect_whatsapp(p_organization_id uuid,p_waba_id text,p_phone_number_id text,p_graph_api_version text,p_display_phone_number text,p_access_token text,p_app_secret text,p_verify_token text)
returns jsonb language sql security invoker set search_path='' as $$ select crm_private.enterprise_connect_whatsapp(p_organization_id,p_waba_id,p_phone_number_id,p_graph_api_version,p_display_phone_number,p_access_token,p_app_secret,p_verify_token) $$;

revoke all on function crm_private.enterprise_meta_claim_onboarding(uuid,text), public.enterprise_meta_claim_onboarding(uuid,text), crm_private.enterprise_instagram_status(uuid), public.enterprise_instagram_status(uuid), crm_private.enterprise_connect_instagram(uuid,text,text,text,timestamptz), public.enterprise_connect_instagram(uuid,text,text,text,timestamptz), crm_private.enterprise_connect_whatsapp(uuid,text,text,text,text,text,text,text), public.enterprise_connect_whatsapp(uuid,text,text,text,text,text,text,text) from public,anon,service_role;
grant usage on schema crm_private to authenticated;
grant execute on function crm_private.enterprise_meta_claim_onboarding(uuid,text), public.enterprise_meta_claim_onboarding(uuid,text), crm_private.enterprise_instagram_status(uuid), public.enterprise_instagram_status(uuid), crm_private.enterprise_connect_instagram(uuid,text,text,text,timestamptz), public.enterprise_connect_instagram(uuid,text,text,text,timestamptz), crm_private.enterprise_connect_whatsapp(uuid,text,text,text,text,text,text,text), public.enterprise_connect_whatsapp(uuid,text,text,text,text,text,text,text) to authenticated;
commit;
