-- Additive preflight only. No Meta request, credential, webhook or worker change.
begin;

create table public.arisa_whatsapp_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  owner_user_id uuid not null references auth.users(id),
  label text not null default 'franco_personal' check (label = 'franco_personal'),
  phone_number_masked text,
  business_portfolio_id text,
  waba_id text,
  phone_number_id text,
  is_on_biz_app boolean,
  platform_type text,
  coexistence_status text not null default 'unknown' check (coexistence_status = 'unknown'),
  onboarding_status text not null default 'not_started' check (onboarding_status in ('not_started','checking','blocked','error')),
  automation_enabled boolean not null default false check (not automation_enabled),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, owner_user_id, label),
  -- Removing this guard is a future, separately authorized migration.
  constraint arisa_connect_no_unverified_assets check (
    phone_number_masked is null and business_portfolio_id is null and waba_id is null
    and phone_number_id is null and is_on_biz_app is null and platform_type is null
  )
);
create index arisa_connect_owner_idx on public.arisa_whatsapp_connections(owner_user_id);
alter table public.arisa_whatsapp_connections enable row level security;
revoke all on public.arisa_whatsapp_connections from public, anon, authenticated;
grant select on public.arisa_whatsapp_connections to authenticated;
create policy arisa_connect_owner_read on public.arisa_whatsapp_connections for select to authenticated
  using (owner_user_id = (select auth.uid()) and private.arisa_is_admin(organization_id));

create table public.arisa_whatsapp_connection_audit (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.arisa_whatsapp_connections(id),
  organization_id uuid not null references public.organizations(id),
  owner_user_id uuid not null references auth.users(id),
  request_id uuid not null,
  event text not null check (event in ('preflight_started','onboarding_blocked')),
  from_state text not null check (from_state in ('not_started','checking','blocked','error')),
  to_state text not null check (to_state in ('checking','blocked')),
  reason text not null check (reason in ('PREFLIGHT_ONLY','META_READ_ONLY_ELIGIBILITY_UNAVAILABLE')),
  created_at timestamptz not null default clock_timestamp(),
  unique (organization_id,owner_user_id,request_id,event)
);
create index arisa_connect_audit_connection_idx on public.arisa_whatsapp_connection_audit(connection_id);
create index arisa_connect_audit_owner_time_idx on public.arisa_whatsapp_connection_audit(owner_user_id,organization_id,created_at desc);
alter table public.arisa_whatsapp_connection_audit enable row level security;
revoke all on public.arisa_whatsapp_connection_audit from public, anon, authenticated;
grant select on public.arisa_whatsapp_connection_audit to authenticated;
create policy arisa_connect_audit_owner_read on public.arisa_whatsapp_connection_audit for select to authenticated
  using (owner_user_id = (select auth.uid()) and private.arisa_is_admin(organization_id));

-- Privileged implementation stays outside exposed schemas. The caller identity is
-- never accepted as an argument, and must be an active administrator on every call.
create function private.arisa_whatsapp_connect(p_organization_id uuid,p_action text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  actor uuid := auth.uid();
  connection public.arisa_whatsapp_connections%rowtype;
  prior_state text;
  audit_entries jsonb;
  primary_status jsonb;
begin
  if actor is null or not private.arisa_is_admin(p_organization_id) then
    raise exception 'ADMIN_REQUIRED' using errcode='42501';
  end if;
  if p_action is null or p_action not in ('status','preflight') or (p_action='preflight' and p_request_id is null) then
    raise exception 'INVALID_REQUEST' using errcode='22023';
  end if;
  if p_action='preflight' then
    -- Serializes retries and rate checks across all Vercel instances for this owner.
    perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_organization_id::text||':whatsapp-connect',0));
    if not exists(select 1 from public.arisa_whatsapp_connection_audit a where a.organization_id=p_organization_id and a.owner_user_id=actor and a.request_id=p_request_id) then
      if (select count(*) from public.arisa_whatsapp_connection_audit a
          where a.organization_id=p_organization_id and a.owner_user_id=actor
          and a.event='preflight_started' and a.created_at > now()-interval '1 hour') >= 5 then
        raise exception 'RATE_LIMITED' using errcode='P0429';
      end if;
      insert into public.arisa_whatsapp_connections(organization_id,owner_user_id)
      values(p_organization_id,actor) on conflict(organization_id,owner_user_id,label) do nothing;
      select * into connection from public.arisa_whatsapp_connections c
        where c.organization_id=p_organization_id and c.owner_user_id=actor and c.label='franco_personal' for update;
      prior_state := connection.onboarding_status;
      update public.arisa_whatsapp_connections set onboarding_status='checking',updated_at=clock_timestamp() where id=connection.id;
      insert into public.arisa_whatsapp_connection_audit(connection_id,organization_id,owner_user_id,request_id,event,from_state,to_state,reason)
        values(connection.id,p_organization_id,actor,p_request_id,'preflight_started',prior_state,'checking','PREFLIGHT_ONLY');
      update public.arisa_whatsapp_connections set onboarding_status='blocked',updated_at=clock_timestamp() where id=connection.id;
      insert into public.arisa_whatsapp_connection_audit(connection_id,organization_id,owner_user_id,request_id,event,from_state,to_state,reason)
        values(connection.id,p_organization_id,actor,p_request_id,'onboarding_blocked','checking','blocked','META_READ_ONLY_ELIGIBILITY_UNAVAILABLE');
    end if;
  end if;
  select * into connection from public.arisa_whatsapp_connections c
    where c.organization_id=p_organization_id and c.owner_user_id=actor and c.label='franco_personal';
  select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc),'[]'::jsonb) into audit_entries from (
    select id,event,to_state,created_at from public.arisa_whatsapp_connection_audit
    where organization_id=p_organization_id and owner_user_id=actor order by created_at desc limit 20
  ) a;
  -- Metadata only: never decrypt a Vault secret during preflight.
  select jsonb_build_object('configured',s.access_token_vault_id is not null and s.app_secret_vault_id is not null
      and s.verify_token_vault_id is not null and nullif(s.waba_id,'') is not null and nullif(s.phone_number_id,'') is not null,
      'enabled',coalesce(c.enabled,false)) into primary_status
    from crm_private.whatsapp_runtime_settings s left join crm_private.arisa_whatsapp_channel c using (organization_id)
    where s.organization_id=p_organization_id;
  return jsonb_build_object('connection',case when connection.id is null then null else jsonb_build_object(
    'id',connection.id,'label',connection.label,'onboarding_status',connection.onboarding_status,
    'coexistence_status',connection.coexistence_status,'updated_at',connection.updated_at) end,
    'audit',audit_entries,'primary',coalesce(primary_status,'{"configured":false,"enabled":false}'::jsonb));
end;
$function$;
revoke all on function private.arisa_whatsapp_connect(uuid,text,uuid) from public,anon,authenticated;
grant usage on schema private to authenticated;
grant execute on function private.arisa_whatsapp_connect(uuid,text,uuid) to authenticated;

create function public.arisa_whatsapp_connect(p_organization_id uuid,p_action text default 'status',p_request_id uuid default null)
returns jsonb language sql security invoker set search_path = '' as $function$
  select private.arisa_whatsapp_connect(p_organization_id,p_action,p_request_id);
$function$;
revoke all on function public.arisa_whatsapp_connect(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.arisa_whatsapp_connect(uuid,text,uuid) to authenticated;

comment on table public.arisa_whatsapp_connections is 'Preflight-only connection intents; no tokens, no unverified Meta assets, no active channel registration.';
comment on table public.arisa_whatsapp_connection_audit is 'Append-only typed preflight audit; no raw event payload, auth code, token or phone content.';
commit;
