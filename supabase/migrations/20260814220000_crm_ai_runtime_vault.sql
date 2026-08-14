-- Evora Enterprise - runtime seguro da Vitoria por organizacao.
--
-- A chave OpenAI nunca e armazenada em tabela da aplicacao. O binding privado
-- guarda apenas o UUID do segredo no Supabase Vault. A configuracao nasce
-- desabilitada e, nesta etapa, somente o modo shadow pode ser ativado.

set lock_timeout = '5s';
set statement_timeout = '120s';

create schema if not exists crm_private;

create table if not exists crm_private.ai_runtime_settings (
  organization_id uuid primary key
    references public.organizations(id) on delete cascade,
  openai_api_key_vault_id uuid,
  api_key_version integer not null default 0,
  api_key_configured_at timestamptz,
  api_key_changed_at timestamptz,
  enabled boolean not null default false,
  mode text not null default 'shadow',
  agent_model text not null default 'gpt-5.6-sol',
  agent_reasoning text not null default 'medium',
  supervisor_model text not null default 'gpt-5.6-sol',
  supervisor_reasoning text not null default 'high',
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_runtime_key_version_check
    check (api_key_version between 0 and 1000000),
  constraint ai_runtime_mode_check
    check (mode = 'shadow'),
  constraint ai_runtime_agent_model_check
    check (
      char_length(agent_model) between 2 and 120
      and agent_model ~ '^[A-Za-z0-9._:-]+$'
    ),
  constraint ai_runtime_supervisor_model_check
    check (
      char_length(supervisor_model) between 2 and 120
      and supervisor_model ~ '^[A-Za-z0-9._:-]+$'
    ),
  constraint ai_runtime_agent_reasoning_check
    check (agent_reasoning in ('none','low','medium','high','xhigh','max')),
  constraint ai_runtime_supervisor_reasoning_check
    check (supervisor_reasoning in ('none','low','medium','high','xhigh','max')),
  constraint ai_runtime_enabled_requires_key_check
    check (not enabled or openai_api_key_vault_id is not null)
);

alter table crm_private.ai_runtime_settings enable row level security;
revoke all on table crm_private.ai_runtime_settings
  from public, anon, authenticated;
revoke all on schema crm_private from public, anon, authenticated;

grant usage on schema crm_private to service_role;
grant select, insert, update, delete on table crm_private.ai_runtime_settings
  to service_role;

create or replace function crm_private.get_crm_ai_runtime_status_internal(
  p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  settings crm_private.ai_runtime_settings%rowtype;
begin
  if auth.uid() is null
     or p_organization_id is null
     or not public.has_app_permission(
       p_organization_id,
       'crm.integrations.manage'
     ) then
    raise exception
      'Seu perfil nao pode gerenciar o runtime da Vitoria.'
      using errcode = '42501';
  end if;

  select runtime.*
    into settings
    from crm_private.ai_runtime_settings runtime
   where runtime.organization_id = p_organization_id;

  if not found then
    return jsonb_build_object(
      'organization_id', p_organization_id,
      'api_key', jsonb_build_object(
        'configured', false,
        'version', 0,
        'configured_at', null,
        'updated_at', null
      ),
      'enabled', false,
      'mode', 'shadow',
      'agent_model', 'gpt-5.6-sol',
      'agent_reasoning', 'medium',
      'supervisor_model', 'gpt-5.6-sol',
      'supervisor_reasoning', 'high',
      'ready', false,
      'updated_at', null
    );
  end if;

  return jsonb_build_object(
    'organization_id', settings.organization_id,
    'api_key', jsonb_build_object(
      'configured', settings.openai_api_key_vault_id is not null,
      'version', settings.api_key_version,
      'configured_at', settings.api_key_configured_at,
      'updated_at', settings.api_key_changed_at
    ),
    'enabled', settings.enabled,
    'mode', settings.mode,
    'agent_model', settings.agent_model,
    'agent_reasoning', settings.agent_reasoning,
    'supervisor_model', settings.supervisor_model,
    'supervisor_reasoning', settings.supervisor_reasoning,
    'ready',
      settings.enabled
      and settings.mode = 'shadow'
      and settings.openai_api_key_vault_id is not null,
    'updated_at', settings.updated_at
  );
end
$function$;

create or replace function crm_private.configure_crm_ai_runtime_internal(
  p_organization_id uuid,
  p_api_key text default null,
  p_enabled boolean default null,
  p_mode text default null,
  p_agent_model text default null,
  p_agent_reasoning text default null,
  p_supervisor_model text default null,
  p_supervisor_reasoning text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
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
  if actor_id is null
     or p_organization_id is null
     or not public.has_app_permission(
       p_organization_id,
       'crm.integrations.manage'
     ) then
    raise exception
      'Seu perfil nao pode gerenciar o runtime da Vitoria.'
      using errcode = '42501';
  end if;

  if p_api_key is not null and (
       p_api_key <> btrim(p_api_key)
       or char_length(p_api_key) not between 32 and 512
       or p_api_key ~ '[[:space:]]'
     ) then
    raise exception 'Chave OpenAI invalida.';
  end if;

  normalized_mode := case
    when p_mode is null then null
    else lower(trim(p_mode))
  end;
  if normalized_mode is not null and normalized_mode <> 'shadow' then
    raise exception 'Somente o modo sombra pode ser ativado nesta etapa.';
  end if;

  normalized_agent_model := case
    when p_agent_model is null then null
    else trim(p_agent_model)
  end;
  normalized_supervisor_model := case
    when p_supervisor_model is null then null
    else trim(p_supervisor_model)
  end;
  if normalized_agent_model is not null and (
       char_length(normalized_agent_model) not between 2 and 120
       or normalized_agent_model !~ '^[A-Za-z0-9._:-]+$'
     ) then
    raise exception 'Modelo do agente invalido.';
  end if;
  if normalized_supervisor_model is not null and (
       char_length(normalized_supervisor_model) not between 2 and 120
       or normalized_supervisor_model !~ '^[A-Za-z0-9._:-]+$'
     ) then
    raise exception 'Modelo do supervisor invalido.';
  end if;

  normalized_agent_reasoning := case
    when p_agent_reasoning is null then null
    else lower(trim(p_agent_reasoning))
  end;
  normalized_supervisor_reasoning := case
    when p_supervisor_reasoning is null then null
    else lower(trim(p_supervisor_reasoning))
  end;
  if normalized_agent_reasoning is not null
     and normalized_agent_reasoning not in (
       'none','low','medium','high','xhigh','max'
     ) then
    raise exception 'Esforco de raciocinio do agente invalido.';
  end if;
  if normalized_supervisor_reasoning is not null
     and normalized_supervisor_reasoning not in (
       'none','low','medium','high','xhigh','max'
     ) then
    raise exception 'Esforco de raciocinio do supervisor invalido.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'evora-crm-ai-runtime:' || p_organization_id::text,
      0
    )
  );

  insert into crm_private.ai_runtime_settings (
    organization_id,
    created_by,
    updated_by
  ) values (
    p_organization_id,
    actor_id,
    actor_id
  ) on conflict (organization_id) do nothing;

  select runtime.*
    into settings
    from crm_private.ai_runtime_settings runtime
   where runtime.organization_id = p_organization_id
   for update;

  if p_api_key is not null then
    if settings.openai_api_key_vault_id is null then
      secret_name :=
        'evora_openai_' || replace(p_organization_id::text, '-', '') ||
        '_api_key_' || encode(extensions.gen_random_bytes(12), 'hex');
      created_secret_id := vault.create_secret(
        new_secret := p_api_key,
        new_name := secret_name,
        new_description :=
          'Evora CRM AI runtime; organization=' ||
          p_organization_id::text || '; kind=openai_api_key',
        new_key_id := null
      );
      update crm_private.ai_runtime_settings runtime
         set openai_api_key_vault_id = created_secret_id,
             api_key_version = runtime.api_key_version + 1,
             api_key_configured_at = now(),
             api_key_changed_at = now(),
             updated_by = actor_id,
             updated_at = now()
       where runtime.organization_id = p_organization_id;
    else
      perform vault.update_secret(
        secret_id := settings.openai_api_key_vault_id,
        new_secret := p_api_key,
        new_name := null,
        new_description := null,
        new_key_id := null
      );
      update crm_private.ai_runtime_settings runtime
         set api_key_version = runtime.api_key_version + 1,
             api_key_changed_at = now(),
             updated_by = actor_id,
             updated_at = now()
       where runtime.organization_id = p_organization_id;
    end if;
  end if;

  update crm_private.ai_runtime_settings runtime
     set enabled = coalesce(p_enabled, runtime.enabled),
         mode = coalesce(normalized_mode, runtime.mode),
         agent_model = coalesce(normalized_agent_model, runtime.agent_model),
         agent_reasoning = coalesce(
           normalized_agent_reasoning,
           runtime.agent_reasoning
         ),
         supervisor_model = coalesce(
           normalized_supervisor_model,
           runtime.supervisor_model
         ),
         supervisor_reasoning = coalesce(
           normalized_supervisor_reasoning,
           runtime.supervisor_reasoning
         ),
         updated_by = actor_id,
         updated_at = now()
   where runtime.organization_id = p_organization_id;

  select runtime.*
    into settings
    from crm_private.ai_runtime_settings runtime
   where runtime.organization_id = p_organization_id;

  if settings.enabled and settings.openai_api_key_vault_id is null then
    raise exception
      'Cadastre uma chave OpenAI antes de ativar a Vitoria.';
  end if;

  return crm_private.get_crm_ai_runtime_status_internal(
    p_organization_id
  );
end
$function$;

create or replace function crm_private.revoke_crm_ai_runtime_api_key_internal(
  p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is null
     or p_organization_id is null
     or not public.has_app_permission(
       p_organization_id,
       'crm.integrations.manage'
     ) then
    raise exception
      'Seu perfil nao pode gerenciar o runtime da Vitoria.'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'evora-crm-ai-runtime:' || p_organization_id::text,
      0
    )
  );

  update crm_private.ai_runtime_settings runtime
     set enabled = false,
         openai_api_key_vault_id = null,
         api_key_version = runtime.api_key_version + 1,
         api_key_configured_at = null,
         api_key_changed_at = now(),
         updated_by = actor_id,
         updated_at = now()
   where runtime.organization_id = p_organization_id;

  return crm_private.get_crm_ai_runtime_status_internal(
    p_organization_id
  );
end
$function$;

create or replace function public.get_crm_ai_runtime_status(
  p_organization_id uuid
)
returns jsonb
language sql
set search_path = ''
as $function$
  select crm_private.get_crm_ai_runtime_status_internal(
    p_organization_id
  );
$function$;

create or replace function public.configure_crm_ai_runtime(
  p_organization_id uuid,
  p_api_key text default null,
  p_enabled boolean default null,
  p_mode text default null,
  p_agent_model text default null,
  p_agent_reasoning text default null,
  p_supervisor_model text default null,
  p_supervisor_reasoning text default null
)
returns jsonb
language sql
set search_path = ''
as $function$
  select crm_private.configure_crm_ai_runtime_internal(
    p_organization_id,
    p_api_key,
    p_enabled,
    p_mode,
    p_agent_model,
    p_agent_reasoning,
    p_supervisor_model,
    p_supervisor_reasoning
  );
$function$;

create or replace function public.revoke_crm_ai_runtime_api_key(
  p_organization_id uuid
)
returns jsonb
language sql
set search_path = ''
as $function$
  select crm_private.revoke_crm_ai_runtime_api_key_internal(
    p_organization_id
  );
$function$;

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

create or replace function public.cancel_crm_ai_job(
  p_job_id uuid,
  p_lock_token uuid,
  p_reason text default 'CRM_AI_RUNTIME_DISABLED'
)
returns table(job_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  job public.crm_ai_jobs%rowtype;
  reason_value text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception
      'RPC restrita ao runtime da Vitoria.'
      using errcode = '42501';
  end if;

  reason_value := left(
    trim(coalesce(p_reason, 'CRM_AI_RUNTIME_DISABLED')),
    128
  );

  select current_job.*
    into job
    from public.crm_ai_jobs current_job
   where current_job.id = p_job_id
     and current_job.status = 'processing'
     and current_job.lock_token = p_lock_token
   for update;

  if not found then
    raise exception 'Lease do job IA ausente, expirado ou divergente.';
  end if;

  update public.crm_ai_jobs current_job
     set status = 'cancelled',
         locked_at = null,
         lock_token = null,
         worker_id = null,
         last_error_code = reason_value,
         last_error_message =
           'Job cancelado antes de chamar o provedor de IA.',
         updated_at = now()
   where current_job.id = job.id;

  return query select job.id, 'cancelled'::text;
end
$function$;

revoke all on function public.get_crm_ai_runtime_status(uuid)
  from public, anon;
revoke all on function public.configure_crm_ai_runtime(
  uuid, text, boolean, text, text, text, text, text
) from public, anon;
revoke all on function public.revoke_crm_ai_runtime_api_key(uuid)
  from public, anon;
revoke all on function public.get_crm_ai_runtime_credentials(uuid)
  from public, anon, authenticated;
revoke all on function public.cancel_crm_ai_job(uuid, uuid, text)
  from public, anon, authenticated;

grant execute on function public.get_crm_ai_runtime_status(uuid)
  to authenticated;
grant execute on function public.configure_crm_ai_runtime(
  uuid, text, boolean, text, text, text, text, text
) to authenticated;
grant execute on function public.revoke_crm_ai_runtime_api_key(uuid)
  to authenticated;
grant execute on function public.get_crm_ai_runtime_credentials(uuid)
  to service_role;
grant execute on function public.cancel_crm_ai_job(uuid, uuid, text)
  to service_role;

comment on table crm_private.ai_runtime_settings is
  'Configuracao tenant-scoped da Vitoria; o segredo OpenAI permanece no Vault.';
comment on function public.get_crm_ai_runtime_credentials(uuid) is
  'Retorna credencial OpenAI apenas ao service_role e somente quando a organizacao esta habilitada.';
