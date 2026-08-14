-- Leitura server-side do estado da Vitoria sem materializar segredo do Vault.

create or replace function public.get_crm_ai_runtime_readiness(
  p_organization_id uuid
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select jsonb_build_object(
    'organization_id', p_organization_id,
    'enabled', coalesce(runtime.enabled, false),
    'mode', coalesce(runtime.mode, 'shadow'),
    'ready', coalesce(
      runtime.enabled
      and runtime.mode = 'shadow'
      and runtime.openai_api_key_vault_id is not null,
      false
    ),
    'updated_at', runtime.updated_at
  )
  from (select 1) anchor
  left join crm_private.ai_runtime_settings runtime
    on runtime.organization_id = p_organization_id;
$function$;

revoke all on function public.get_crm_ai_runtime_readiness(uuid)
  from public, anon, authenticated;
grant execute on function public.get_crm_ai_runtime_readiness(uuid)
  to service_role;
