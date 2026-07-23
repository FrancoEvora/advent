-- Corrige a tipagem do vínculo opcional de atividade nos alertas comerciais.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef(procedure.oid)
    into definition
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'private'
    and procedure.proname = 'process_evora_automations'
    and pg_get_function_identity_arguments(procedure.oid) = 'p_organization_id uuid';

  if definition is null then
    raise exception 'Função private.process_evora_automations(uuid) não encontrada';
  end if;

  definition := regexp_replace(
    definition,
    'proposal\.created_by,\s*null,',
    'proposal.created_by, null::uuid,',
    'gi'
  );
  definition := regexp_replace(
    definition,
    'contract\.company_signed_by,\s*null,',
    'contract.company_signed_by, null::uuid,',
    'gi'
  );
  execute definition;
end
$migration$;
