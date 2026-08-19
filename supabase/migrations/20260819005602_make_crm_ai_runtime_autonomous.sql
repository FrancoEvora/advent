create or replace function crm_private.configure_crm_ai_runtime_internal(
  p_organization_id uuid,
  p_api_key text default null::text,
  p_enabled boolean default null::boolean,
  p_mode text default null::text,
  p_agent_model text default null::text,
  p_agent_reasoning text default null::text,
  p_supervisor_model text default null::text,
  p_supervisor_reasoning text default null::text
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  actor_id uuid := auth.uid();
  settings crm_private.ai_runtime_settings%rowtype;
  created_secret_id uuid;
  secret_name text;
  normalized_mode text;
  normalized_agent_model text;
  normalized_agent_reasoning text;
  normalized_supervisor_model text;
  normalized_supervisor_reasoning text;
begin
  if actor_id is null or p_organization_id is null or not public.has_app_permission(p_organization_id,'crm.integrations.manage') then
    raise exception 'Seu perfil nao pode gerenciar o runtime da Bia.' using errcode='42501';
  end if;
  if p_api_key is not null and (p_api_key<>btrim(p_api_key) or char_length(p_api_key) not between 32 and 512 or p_api_key ~ '[[:space:]]') then
    raise exception 'Chave OpenAI invalida.';
  end if;
  normalized_mode := case when p_mode is null then null else lower(trim(p_mode)) end;
  if normalized_mode is not null and normalized_mode <> 'autonomous' then
    raise exception 'O atendimento da Bia opera em modo autonomo.';
  end if;
  normalized_agent_model := case when p_agent_model is null then null else trim(p_agent_model) end;
  normalized_supervisor_model := case when p_supervisor_model is null then null else trim(p_supervisor_model) end;
  if normalized_agent_model is not null and (char_length(normalized_agent_model) not between 2 and 120 or normalized_agent_model !~ '^[A-Za-z0-9._:-]+$') then raise exception 'Modelo do agente invalido.'; end if;
  if normalized_supervisor_model is not null and (char_length(normalized_supervisor_model) not between 2 and 120 or normalized_supervisor_model !~ '^[A-Za-z0-9._:-]+$') then raise exception 'Modelo do supervisor invalido.'; end if;
  normalized_agent_reasoning := case when p_agent_reasoning is null then null else lower(trim(p_agent_reasoning)) end;
  normalized_supervisor_reasoning := case when p_supervisor_reasoning is null then null else lower(trim(p_supervisor_reasoning)) end;
  if normalized_agent_reasoning is not null and normalized_agent_reasoning not in('none','low','medium','high','xhigh','max') then raise exception 'Esforco de raciocinio do agente invalido.'; end if;
  if normalized_supervisor_reasoning is not null and normalized_supervisor_reasoning not in('none','low','medium','high','xhigh','max') then raise exception 'Esforco de raciocinio do supervisor invalido.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('evora-crm-ai-runtime:'||p_organization_id::text,0));
  insert into crm_private.ai_runtime_settings(organization_id,created_by,updated_by) values(p_organization_id,actor_id,actor_id) on conflict(organization_id) do nothing;
  select runtime.* into settings from crm_private.ai_runtime_settings runtime where runtime.organization_id=p_organization_id for update;
  if p_api_key is not null then
    if settings.openai_api_key_vault_id is null then
      secret_name := 'evora_openai_'||replace(p_organization_id::text,'-','')||'_api_key_'||encode(extensions.gen_random_bytes(12),'hex');
      created_secret_id := vault.create_secret(new_secret:=p_api_key,new_name:=secret_name,new_description:='Evora CRM AI runtime; organization='||p_organization_id::text||'; kind=openai_api_key',new_key_id:=null);
      update crm_private.ai_runtime_settings runtime set openai_api_key_vault_id=created_secret_id,api_key_version=runtime.api_key_version+1,api_key_configured_at=now(),api_key_changed_at=now(),updated_by=actor_id,updated_at=now() where runtime.organization_id=p_organization_id;
    else
      perform vault.update_secret(secret_id:=settings.openai_api_key_vault_id,new_secret:=p_api_key,new_name:=null,new_description:=null,new_key_id:=null);
      update crm_private.ai_runtime_settings runtime set api_key_version=runtime.api_key_version+1,api_key_changed_at=now(),updated_by=actor_id,updated_at=now() where runtime.organization_id=p_organization_id;
    end if;
  end if;
  update crm_private.ai_runtime_settings runtime set enabled=coalesce(p_enabled,runtime.enabled),mode=coalesce(normalized_mode,runtime.mode),agent_model=coalesce(normalized_agent_model,runtime.agent_model),agent_reasoning=coalesce(normalized_agent_reasoning,runtime.agent_reasoning),supervisor_model=coalesce(normalized_supervisor_model,runtime.supervisor_model),supervisor_reasoning=coalesce(normalized_supervisor_reasoning,runtime.supervisor_reasoning),updated_by=actor_id,updated_at=now() where runtime.organization_id=p_organization_id;
  select runtime.* into settings from crm_private.ai_runtime_settings runtime where runtime.organization_id=p_organization_id;
  if settings.enabled and settings.openai_api_key_vault_id is null then raise exception 'Cadastre uma chave OpenAI antes de ativar a Bia.'; end if;
  return crm_private.get_crm_ai_runtime_status_internal(p_organization_id);
end
$function$;

create or replace function crm_private.get_crm_ai_runtime_status_internal(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare settings crm_private.ai_runtime_settings%rowtype;
begin
  if auth.uid() is null or p_organization_id is null or not public.has_app_permission(p_organization_id,'crm.integrations.manage') then raise exception 'Seu perfil nao pode gerenciar o runtime da Bia.' using errcode='42501'; end if;
  select runtime.* into settings from crm_private.ai_runtime_settings runtime where runtime.organization_id=p_organization_id;
  if not found then
    return jsonb_build_object('organization_id',p_organization_id,'api_key',jsonb_build_object('configured',false,'version',0,'configured_at',null,'updated_at',null),'enabled',false,'mode','autonomous','agent_model','gpt-5.6-sol','agent_reasoning','medium','supervisor_model','gpt-5.6-sol','supervisor_reasoning','high','ready',false,'updated_at',null);
  end if;
  return jsonb_build_object('organization_id',settings.organization_id,'api_key',jsonb_build_object('configured',settings.openai_api_key_vault_id is not null,'version',settings.api_key_version,'configured_at',settings.api_key_configured_at,'updated_at',settings.api_key_changed_at),'enabled',settings.enabled,'mode',settings.mode,'agent_model',settings.agent_model,'agent_reasoning',settings.agent_reasoning,'supervisor_model',settings.supervisor_model,'supervisor_reasoning',settings.supervisor_reasoning,'ready',settings.enabled and settings.mode='autonomous' and settings.openai_api_key_vault_id is not null,'updated_at',settings.updated_at);
end
$function$;

create or replace function public.get_crm_ai_runtime_credentials(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare result_value jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then raise exception 'RPC restrita ao runtime da Bia.' using errcode = '42501'; end if;
  select jsonb_build_object('organization_id',runtime.organization_id,'enabled',runtime.enabled,'mode',runtime.mode,'agent_model',runtime.agent_model,'agent_reasoning',runtime.agent_reasoning,'supervisor_model',runtime.supervisor_model,'supervisor_reasoning',runtime.supervisor_reasoning,'knowledge_vector_store_id',runtime.knowledge_vector_store_id,'api_key',case when runtime.enabled then secret.decrypted_secret else null end,'api_key_version',runtime.api_key_version,'updated_at',runtime.updated_at)
  into result_value
  from crm_private.ai_runtime_settings runtime left join vault.decrypted_secrets secret on secret.id=runtime.openai_api_key_vault_id
  where runtime.organization_id=p_organization_id;
  if result_value is null then
    return jsonb_build_object('organization_id',p_organization_id,'enabled',false,'mode','autonomous','agent_model','gpt-5.6-sol','agent_reasoning','medium','supervisor_model','gpt-5.6-sol','supervisor_reasoning','high','knowledge_vector_store_id',null,'api_key',null,'api_key_version',0,'updated_at',null);
  end if;
  if (result_value ->> 'enabled')::boolean and nullif(result_value ->> 'api_key','') is null then return result_value || jsonb_build_object('enabled',false); end if;
  return result_value;
end
$function$;
