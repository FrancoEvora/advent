-- Evora Enterprise - Stage 2 postflight security/performance hardening.
-- Public RPCs stay stable for PostgREST, but privileged implementations live
-- in the non-exposed crm_private boundary. This removes public SECURITY
-- DEFINER entry points without granting browser access to the private inbox.

do $preflight$
begin
  if to_regclass('public.crm_meta_lead_routes') is null
     or to_regnamespace('crm_private') is null
     or to_regprocedure(
       'public.get_meta_lead_integration_status(uuid)'
     ) is null
     or to_regprocedure(
       'public.requeue_meta_lead_failures(uuid)'
     ) is null
     or to_regprocedure(
       'public.pause_meta_lead_ingress(uuid)'
     ) is null
     or to_regprocedure(
       'public.prepare_meta_lead_restore(uuid)'
     ) is null then
    raise exception
      'Stage 2 Meta ingress must be applied before RPC hardening.';
  end if;

  if to_regprocedure(
       'crm_private.get_meta_lead_integration_status_internal(uuid)'
     ) is not null
     or to_regprocedure(
       'crm_private.requeue_meta_lead_failures_internal(uuid)'
     ) is not null
     or to_regprocedure(
       'crm_private.pause_meta_lead_ingress_internal(uuid)'
     ) is not null
     or to_regprocedure(
       'crm_private.prepare_meta_lead_restore_internal(uuid)'
     ) is not null then
    raise exception 'Meta RPC private boundary already exists.';
  end if;
end
$preflight$;

alter function public.get_meta_lead_integration_status(uuid)
  set schema crm_private;
alter function crm_private.get_meta_lead_integration_status(uuid)
  rename to get_meta_lead_integration_status_internal;

alter function public.requeue_meta_lead_failures(uuid)
  set schema crm_private;
alter function crm_private.requeue_meta_lead_failures(uuid)
  rename to requeue_meta_lead_failures_internal;

alter function public.pause_meta_lead_ingress(uuid)
  set schema crm_private;
alter function crm_private.pause_meta_lead_ingress(uuid)
  rename to pause_meta_lead_ingress_internal;

alter function public.prepare_meta_lead_restore(uuid)
  set schema crm_private;
alter function crm_private.prepare_meta_lead_restore(uuid)
  rename to prepare_meta_lead_restore_internal;

revoke all on schema crm_private from public, anon, service_role;
revoke create on schema crm_private from authenticated;
grant usage on schema crm_private to authenticated;

revoke all on function
  crm_private.get_meta_lead_integration_status_internal(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  crm_private.requeue_meta_lead_failures_internal(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  crm_private.pause_meta_lead_ingress_internal(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  crm_private.prepare_meta_lead_restore_internal(uuid)
  from public, anon, authenticated, service_role;

grant execute on function
  crm_private.get_meta_lead_integration_status_internal(uuid)
  to authenticated;
grant execute on function
  crm_private.requeue_meta_lead_failures_internal(uuid)
  to authenticated;
grant execute on function
  crm_private.pause_meta_lead_ingress_internal(uuid)
  to authenticated;
grant execute on function
  crm_private.prepare_meta_lead_restore_internal(uuid)
  to authenticated;

create function public.get_meta_lead_integration_status(
  p_organization_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select crm_private.get_meta_lead_integration_status_internal(
    p_organization_id
  );
$function$;

create function public.requeue_meta_lead_failures(
  p_organization_id uuid
)
returns integer
language sql
security invoker
set search_path = ''
as $function$
  select crm_private.requeue_meta_lead_failures_internal(
    p_organization_id
  );
$function$;

create function public.pause_meta_lead_ingress(
  p_organization_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select crm_private.pause_meta_lead_ingress_internal(
    p_organization_id
  );
$function$;

create function public.prepare_meta_lead_restore(
  p_organization_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select crm_private.prepare_meta_lead_restore_internal(
    p_organization_id
  );
$function$;

revoke all on function public.get_meta_lead_integration_status(uuid)
  from public, anon, service_role;
revoke all on function public.requeue_meta_lead_failures(uuid)
  from public, anon, service_role;
revoke all on function public.pause_meta_lead_ingress(uuid)
  from public, anon, service_role;
revoke all on function public.prepare_meta_lead_restore(uuid)
  from public, anon, service_role;

grant execute on function public.get_meta_lead_integration_status(uuid)
  to authenticated;
grant execute on function public.requeue_meta_lead_failures(uuid)
  to authenticated;
grant execute on function public.pause_meta_lead_ingress(uuid)
  to authenticated;
grant execute on function public.prepare_meta_lead_restore(uuid)
  to authenticated;

comment on function public.get_meta_lead_integration_status(uuid) is
  'SECURITY INVOKER facade for the permission-checked private Meta status RPC.';
comment on function public.requeue_meta_lead_failures(uuid) is
  'SECURITY INVOKER facade for the permission-checked private Meta requeue RPC.';
comment on function public.pause_meta_lead_ingress(uuid) is
  'SECURITY INVOKER facade for the permission-checked private Meta pause RPC.';
comment on function public.prepare_meta_lead_restore(uuid) is
  'SECURITY INVOKER facade for the permission-checked private Meta restore boundary.';

-- Cover nullable FK columns used by deletes, restores and assignment lookup.
create index crm_meta_lead_routes_created_by_fk_idx
  on public.crm_meta_lead_routes (created_by)
  where created_by is not null;
create index crm_meta_lead_routes_updated_by_fk_idx
  on public.crm_meta_lead_routes (updated_by)
  where updated_by is not null;
create index crm_lead_assignments_assigned_by_fk_idx
  on public.crm_lead_assignments (assigned_by)
  where assigned_by is not null;
create index crm_lead_assignments_assigned_user_fk_idx
  on public.crm_lead_assignments (assigned_user_id)
  where assigned_user_id is not null;
create index crm_lead_assignments_crm_action_fk_idx
  on public.crm_lead_assignments (crm_action_id)
  where crm_action_id is not null;
create index crm_lead_assignments_status_updated_by_fk_idx
  on public.crm_lead_assignments (status_updated_by)
  where status_updated_by is not null;
create index crm_lead_assignments_user_activity_fk_idx
  on public.crm_lead_assignments (user_activity_id)
  where user_activity_id is not null;
create index crm_lead_assignment_events_actor_user_fk_idx
  on public.crm_lead_assignment_events (actor_user_id)
  where actor_user_id is not null;

do $postflight$
declare
  public_status oid := to_regprocedure(
    'public.get_meta_lead_integration_status(uuid)'
  );
  public_requeue oid := to_regprocedure(
    'public.requeue_meta_lead_failures(uuid)'
  );
  public_pause oid := to_regprocedure(
    'public.pause_meta_lead_ingress(uuid)'
  );
  public_restore oid := to_regprocedure(
    'public.prepare_meta_lead_restore(uuid)'
  );
  private_status oid := to_regprocedure(
    'crm_private.get_meta_lead_integration_status_internal(uuid)'
  );
  private_requeue oid := to_regprocedure(
    'crm_private.requeue_meta_lead_failures_internal(uuid)'
  );
  private_pause oid := to_regprocedure(
    'crm_private.pause_meta_lead_ingress_internal(uuid)'
  );
  private_restore oid := to_regprocedure(
    'crm_private.prepare_meta_lead_restore_internal(uuid)'
  );
begin
  if public_status is null or public_requeue is null
     or public_pause is null or public_restore is null
     or private_status is null or private_requeue is null
     or private_pause is null or private_restore is null then
    raise exception 'Meta RPC boundary is incomplete.';
  end if;

  if exists (
    select 1 from pg_proc
    where oid in (public_status, public_requeue, public_pause, public_restore)
      and (
        prosecdef
        or not coalesce(proconfig, '{}'::text[])
          @> array['search_path=""']::text[]
      )
  ) then
    raise exception 'A public Meta RPC lost invoker/search_path hardening.';
  end if;

  if exists (
    select 1 from pg_proc
    where oid in (
      private_status, private_requeue, private_pause, private_restore
    )
      and (
        not prosecdef
        or not coalesce(proconfig, '{}'::text[])
          @> array['search_path=""']::text[]
      )
  ) then
    raise exception 'A private Meta implementation lost definer hardening.';
  end if;

  if not has_schema_privilege('authenticated', 'crm_private', 'USAGE')
     or has_schema_privilege('authenticated', 'crm_private', 'CREATE')
     or has_schema_privilege('anon', 'crm_private', 'USAGE')
     or has_schema_privilege('service_role', 'crm_private', 'USAGE') then
    raise exception 'crm_private schema ACL is broader than intended.';
  end if;

  if not has_function_privilege('authenticated', public_status, 'EXECUTE')
     or not has_function_privilege('authenticated', public_requeue, 'EXECUTE')
     or not has_function_privilege('authenticated', public_pause, 'EXECUTE')
     or not has_function_privilege('authenticated', public_restore, 'EXECUTE')
     or not has_function_privilege('authenticated', private_status, 'EXECUTE')
     or not has_function_privilege('authenticated', private_requeue, 'EXECUTE')
     or not has_function_privilege('authenticated', private_pause, 'EXECUTE')
     or not has_function_privilege('authenticated', private_restore, 'EXECUTE')
     or has_function_privilege('anon', public_status, 'EXECUTE')
     or has_function_privilege('anon', public_requeue, 'EXECUTE')
     or has_function_privilege('anon', public_pause, 'EXECUTE')
     or has_function_privilege('anon', public_restore, 'EXECUTE')
     or has_function_privilege('service_role', public_status, 'EXECUTE')
     or has_function_privilege('service_role', public_requeue, 'EXECUTE')
     or has_function_privilege('service_role', public_pause, 'EXECUTE')
     or has_function_privilege('service_role', public_restore, 'EXECUTE')
     or has_function_privilege('anon', private_status, 'EXECUTE')
     or has_function_privilege('anon', private_requeue, 'EXECUTE')
     or has_function_privilege('anon', private_pause, 'EXECUTE')
     or has_function_privilege('anon', private_restore, 'EXECUTE')
     or has_function_privilege('service_role', private_status, 'EXECUTE')
     or has_function_privilege('service_role', private_requeue, 'EXECUTE')
     or has_function_privilege('service_role', private_pause, 'EXECUTE')
     or has_function_privilege('service_role', private_restore, 'EXECUTE') then
    raise exception 'Meta RPC execute ACL is broader than intended.';
  end if;

  if to_regclass('public.crm_meta_lead_routes_created_by_fk_idx') is null
     or to_regclass('public.crm_meta_lead_routes_updated_by_fk_idx') is null
     or to_regclass(
       'public.crm_lead_assignments_assigned_by_fk_idx'
     ) is null
     or to_regclass(
       'public.crm_lead_assignments_assigned_user_fk_idx'
     ) is null
     or to_regclass(
       'public.crm_lead_assignments_crm_action_fk_idx'
     ) is null
     or to_regclass(
       'public.crm_lead_assignments_status_updated_by_fk_idx'
     ) is null
     or to_regclass(
       'public.crm_lead_assignments_user_activity_fk_idx'
     ) is null
     or to_regclass(
       'public.crm_lead_assignment_events_actor_user_fk_idx'
     ) is null then
    raise exception 'Meta/assignment FK index hardening is incomplete.';
  end if;
end
$postflight$;
