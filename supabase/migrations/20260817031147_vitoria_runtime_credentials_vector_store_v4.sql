begin;

create or replace function public.get_crm_ai_runtime_credentials(
  p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  result_value jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception
      'RPC restrita ao runtime da Vitoria.'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'organization_id', runtime.organization_id,
    'enabled', runtime.enabled,
    'mode', runtime.mode,
    'agent_model', runtime.agent_model,
    'agent_reasoning', runtime.agent_reasoning,
    'supervisor_model', runtime.supervisor_model,
    'supervisor_reasoning', runtime.supervisor_reasoning,
    'knowledge_vector_store_id', runtime.knowledge_vector_store_id,
    'api_key', case
      when runtime.enabled then secret.decrypted_secret
      else null
    end,
    'api_key_version', runtime.api_key_version,
    'updated_at', runtime.updated_at
  )
  into result_value
  from crm_private.ai_runtime_settings runtime
  left join vault.decrypted_secrets secret
    on secret.id = runtime.openai_api_key_vault_id
  where runtime.organization_id = p_organization_id;

  if result_value is null then
    return jsonb_build_object(
      'organization_id', p_organization_id,
      'enabled', false,
      'mode', 'shadow',
      'agent_model', 'gpt-5.6-sol',
      'agent_reasoning', 'medium',
      'supervisor_model', 'gpt-5.6-sol',
      'supervisor_reasoning', 'high',
      'knowledge_vector_store_id', null,
      'api_key', null,
      'api_key_version', 0,
      'updated_at', null
    );
  end if;

  if (result_value ->> 'enabled')::boolean
     and nullif(result_value ->> 'api_key', '') is null then
    return result_value || jsonb_build_object('enabled', false);
  end if;

  return result_value;
end
$function$;

revoke all on function public.get_crm_ai_runtime_credentials(uuid)
  from public, anon, authenticated;
grant execute on function public.get_crm_ai_runtime_credentials(uuid)
  to service_role;

comment on function public.get_crm_ai_runtime_credentials(uuid) is
  'Retorna ao runtime service-role a credencial OpenAI e o vector store tenant-scoped, sem expor o segredo ao browser.';

commit;
