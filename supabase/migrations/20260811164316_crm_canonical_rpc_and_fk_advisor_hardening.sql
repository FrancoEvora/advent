-- Evora Enterprise - boundary privado da limpeza e cobertura exata das FKs.

set lock_timeout = '5s';
set statement_timeout = '120s';

do $preflight$
begin
  if to_regprocedure(
       'public.purge_crm_canonical_data(uuid,boolean)'
     ) is null
     or to_regclass('public.crm_opportunity_attributions') is null
     or to_regclass('public.crm_loss_reasons') is null
     or to_regprocedure('private.seed_crm_loss_reasons(uuid)') is null
     or not exists (
       select 1
       from pg_constraint constraint_row
       where constraint_row.conname = 'crm_records_loss_reason_fk'
         and constraint_row.conrelid = 'public.crm_records'::regclass
         and constraint_row.convalidated
     ) then
    raise exception 'Hardening canonico anterior nao encontrado.';
  end if;
end
$preflight$;

create schema crm_private authorization postgres;
revoke all on schema crm_private from public, anon, authenticated, service_role;
grant usage on schema crm_private to authenticated;

-- A Data API enxerga apenas o wrapper SECURITY INVOKER. A elevacao necessaria
-- para apagar ledgers fica no schema private, fora da superficie REST, e so e
-- alcancada depois que o proprio boundary valida platform.manage.
alter function public.purge_crm_canonical_data(uuid, boolean)
  set schema crm_private;
alter function crm_private.purge_crm_canonical_data(uuid, boolean)
  rename to purge_crm_canonical_data_internal;

revoke all on function crm_private.purge_crm_canonical_data_internal(uuid, boolean)
  from public, anon, service_role;
grant execute on function crm_private.purge_crm_canonical_data_internal(uuid, boolean)
  to authenticated;

create or replace function public.purge_crm_canonical_data(
  p_organization_id uuid,
  p_include_catalogs boolean default false
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select crm_private.purge_crm_canonical_data_internal(
    p_organization_id,
    p_include_catalogs
  );
$function$;

revoke all on function public.purge_crm_canonical_data(uuid, boolean)
  from public, anon, service_role;
grant execute on function public.purge_crm_canonical_data(uuid, boolean)
  to authenticated;

-- Os indices anteriores favorecem consultas por campanha. Estes dois seguem
-- exatamente a ordem das FKs compostas e eliminam scans em delete/update.
create index if not exists crm_opportunity_attributions_crm_campaign_fk_idx
  on public.crm_opportunity_attributions (
    organization_id, project_id, crm_campaign_id
  ) where crm_campaign_id is not null;

create index if not exists crm_opportunity_attributions_control_campaign_fk_idx
  on public.crm_opportunity_attributions (
    organization_id, project_id, campaign_control_campaign_id
  ) where campaign_control_campaign_id is not null;

do $boundary_assertion$
declare
  public_definer boolean;
  private_definer boolean;
  private_function_owner text;
  private_function_config text[];
  private_schema_owner text;
  private_function_count integer;
begin
  select procedure.prosecdef into public_definer
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.oid = 'public.purge_crm_canonical_data(uuid,boolean)'::regprocedure;

  select
    procedure.prosecdef,
    pg_get_userbyid(procedure.proowner),
    procedure.proconfig
  into
    private_definer,
    private_function_owner,
    private_function_config
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'crm_private'
    and procedure.oid =
      'crm_private.purge_crm_canonical_data_internal(uuid,boolean)'::regprocedure;

  if public_definer
     or not private_definer
     or private_function_owner <> 'postgres'
     or not (
       coalesce(private_function_config, array[]::text[])
       @> array['search_path=""']::text[]
     ) then
    raise exception 'Boundary de limpeza possui modo de seguranca divergente.';
  end if;

  select pg_get_userbyid(namespace.nspowner) into private_schema_owner
  from pg_namespace namespace
  where namespace.nspname = 'crm_private';
  select count(*) into private_function_count
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'crm_private';

  if private_schema_owner <> 'postgres' or private_function_count <> 1 then
    raise exception 'Schema crm_private possui owner ou objetos inesperados.';
  end if;

  if not has_schema_privilege('authenticated', 'crm_private', 'USAGE')
     or has_schema_privilege('authenticated', 'crm_private', 'CREATE')
     or has_schema_privilege('anon', 'crm_private', 'USAGE')
     or has_schema_privilege('service_role', 'crm_private', 'USAGE') then
    raise exception 'ACL do schema crm_private diverge do contrato.';
  end if;

  if has_function_privilege(
       'service_role',
       'public.purge_crm_canonical_data(uuid,boolean)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'crm_private.purge_crm_canonical_data_internal(uuid,boolean)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'authenticated',
       'public.purge_crm_canonical_data(uuid,boolean)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'authenticated',
       'crm_private.purge_crm_canonical_data_internal(uuid,boolean)',
       'EXECUTE'
     ) then
    raise exception 'ACL do boundary privado de limpeza diverge do contrato.';
  end if;
end
$boundary_assertion$;

comment on function public.purge_crm_canonical_data(uuid, boolean) is
  'Wrapper invoker: valida o JWT pelo boundary privado antes da limpeza canonica.';
comment on function crm_private.purge_crm_canonical_data_internal(uuid, boolean) is
  'Implementacao SECURITY DEFINER fora da superficie da Data API.';
