-- Evora Enterprise - hardening de ACL do runtime Vault da Vitoria.
-- Os wrappers administrativos precisam executar com o owner porque o schema
-- crm_private e deliberadamente invisivel para authenticated.

set lock_timeout = '5s';
set statement_timeout = '120s';

alter function public.get_crm_ai_runtime_status(uuid)
  security definer;
alter function public.configure_crm_ai_runtime(
  uuid, text, boolean, text, text, text, text, text
) security definer;
alter function public.revoke_crm_ai_runtime_api_key(uuid)
  security definer;

revoke all on function crm_private.get_crm_ai_runtime_status_internal(uuid)
  from public, anon, authenticated;
revoke all on function crm_private.configure_crm_ai_runtime_internal(
  uuid, text, boolean, text, text, text, text, text
) from public, anon, authenticated;
revoke all on function crm_private.revoke_crm_ai_runtime_api_key_internal(uuid)
  from public, anon, authenticated;

-- O service_role nao precisa invocar os internals; o runtime usa somente a RPC
-- publica get_crm_ai_runtime_credentials, que valida explicitamente o JWT role.
revoke all on function crm_private.get_crm_ai_runtime_status_internal(uuid)
  from service_role;
revoke all on function crm_private.configure_crm_ai_runtime_internal(
  uuid, text, boolean, text, text, text, text, text
) from service_role;
revoke all on function crm_private.revoke_crm_ai_runtime_api_key_internal(uuid)
  from service_role;

-- Reafirma a superficie publica minima.
revoke all on function public.get_crm_ai_runtime_status(uuid)
  from public, anon;
revoke all on function public.configure_crm_ai_runtime(
  uuid, text, boolean, text, text, text, text, text
) from public, anon;
revoke all on function public.revoke_crm_ai_runtime_api_key(uuid)
  from public, anon;

grant execute on function public.get_crm_ai_runtime_status(uuid)
  to authenticated;
grant execute on function public.configure_crm_ai_runtime(
  uuid, text, boolean, text, text, text, text, text
) to authenticated;
grant execute on function public.revoke_crm_ai_runtime_api_key(uuid)
  to authenticated;
