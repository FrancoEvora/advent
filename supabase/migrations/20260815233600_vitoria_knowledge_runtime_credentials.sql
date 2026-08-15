begin;
create or replace function public.get_vitoria_knowledge_runtime_credentials(p_organization_id uuid)
returns jsonb
language sql
security definer
set search_path=''
as $function$
  select jsonb_build_object(
    'api_key',secret.decrypted_secret,
    'vector_store_id',runtime.knowledge_vector_store_id,
    'agent_model',runtime.agent_model,
    'supervisor_model',runtime.supervisor_model
  )
  from crm_private.ai_runtime_settings runtime
  left join vault.decrypted_secrets secret on secret.id=runtime.openai_api_key_vault_id
  where runtime.organization_id=p_organization_id;
$function$;
revoke all on function public.get_vitoria_knowledge_runtime_credentials(uuid) from public,anon,authenticated;
grant execute on function public.get_vitoria_knowledge_runtime_credentials(uuid) to service_role;
commit;
