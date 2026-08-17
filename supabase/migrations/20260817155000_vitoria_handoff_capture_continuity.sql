begin;

do $migration_preflight$
begin
  if to_regprocedure(
    'public.commit_public_agent_action_message_v6(text,text,text,uuid,uuid,bigint,text,uuid,text,text,jsonb,boolean,boolean,text,text,jsonb,jsonb,jsonb)'
  ) is null then
    raise exception 'VITORIA_HANDOFF_CAPTURE_DEPENDENCY_MISSING';
  end if;
end
$migration_preflight$;

create or replace function crm_private.public_agent_pending_action_is_valid(
  p_pending_action jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select
    p_pending_action is not null
    and jsonb_typeof(p_pending_action) = 'object'
    and pg_column_size(p_pending_action) <= 16384
    and (
      p_pending_action = '{}'::jsonb
      or (
        (
          p_pending_action
            - array[
                'kind',
                'phase',
                'unitCode',
                'requestedAt',
                'handoffRequested'
              ]::text[]
        ) = '{}'::jsonb
        and jsonb_typeof(p_pending_action -> 'kind') = 'string'
        and jsonb_typeof(p_pending_action -> 'phase') = 'string'
        and (
          (
            p_pending_action ->> 'kind' = 'lead'
            and p_pending_action ->> 'phase' in ('name', 'phone', 'consent')
            and (
              not (p_pending_action ? 'unitCode')
              or p_pending_action -> 'unitCode' = 'null'::jsonb
            )
          )
          or (
            p_pending_action ->> 'kind' = 'hold'
            and p_pending_action ->> 'phase' in (
              'name', 'phone', 'consent', 'confirm'
            )
            and jsonb_typeof(p_pending_action -> 'unitCode') = 'string'
            and p_pending_action ->> 'unitCode'
              ~ '^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$'
          )
        )
        and (
          not (p_pending_action ? 'requestedAt')
          or p_pending_action -> 'requestedAt' = 'null'::jsonb
          or (
            jsonb_typeof(p_pending_action -> 'requestedAt') = 'string'
            and char_length(p_pending_action ->> 'requestedAt') between 20 and 40
            and p_pending_action ->> 'requestedAt'
              ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
          )
        )
        and (
          not (p_pending_action ? 'handoffRequested')
          or (
            p_pending_action ->> 'kind' = 'lead'
            and p_pending_action -> 'handoffRequested' = 'true'::jsonb
          )
        )
      )
    );
$function$;

create or replace function crm_private.public_agent_pending_transition_is_valid(
  p_current jsonb,
  p_next jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select
    crm_private.public_agent_pending_action_is_valid(p_current)
    and crm_private.public_agent_pending_action_is_valid(p_next)
    and (
      p_current = '{}'::jsonb
      or p_next = '{}'::jsonb
      or (
        p_current ->> 'kind' = p_next ->> 'kind'
        and case p_current ->> 'phase'
          when 'name' then p_next ->> 'phase' in (
            'name', 'phone', 'consent', 'confirm'
          )
          when 'phone' then p_next ->> 'phase' in (
            'name', 'phone', 'consent', 'confirm'
          )
          when 'consent' then p_next ->> 'phase' in (
            'name', 'phone', 'consent', 'confirm'
          )
          when 'confirm' then p_next ->> 'phase' = 'confirm'
          else false
        end
        and (
          p_current ->> 'kind' = 'lead'
          or p_current ->> 'unitCode' = p_next ->> 'unitCode'
          or (
            p_current ->> 'phase' = 'confirm'
            and p_next ->> 'phase' = 'confirm'
          )
        )
        and (
          p_current ->> 'handoffRequested' is distinct from 'true'
          or p_next ->> 'handoffRequested' = 'true'
        )
      )
    );
$function$;

revoke all on function crm_private.public_agent_pending_action_is_valid(jsonb)
from public, anon, authenticated, service_role;
revoke all on function crm_private.public_agent_pending_transition_is_valid(
  jsonb, jsonb
) from public, anon, authenticated, service_role;

create or replace function public.commit_public_agent_lead_handoff_message_v1(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_client_request_id uuid,
  p_lease_token uuid,
  p_expected_revision bigint,
  p_source text,
  p_client_action_id uuid,
  p_action_kind text,
  p_unit_code text,
  p_contact_patch jsonb,
  p_service_consent boolean,
  p_marketing_consent boolean,
  p_consent_copy_version text,
  p_user_message text,
  p_profile jsonb,
  p_response jsonb,
  p_media_refs jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  result_value jsonb;
  session_row crm_private.public_agent_sessions%rowtype;
  experience_row crm_private.public_agent_experiences%rowtype;
  record_row public.crm_records%rowtype;
  event_key uuid;
  owner_key uuid;
  due_value timestamptz;
  idempotency_value text;
  first_name_value text;
  reply_value text;
begin
  perform crm_private.assert_public_agent_service_role();

  if p_action_kind is distinct from 'lead' or p_unit_code is not null then
    raise exception 'PUBLIC_AGENT_HANDOFF_ACTION_INVALID';
  end if;

  result_value := public.commit_public_agent_action_message_v6(
    p_slug,
    p_session_token_hash,
    p_fingerprint_hash,
    p_client_request_id,
    p_lease_token,
    p_expected_revision,
    p_source,
    p_client_action_id,
    p_action_kind,
    p_unit_code,
    p_contact_patch,
    p_service_consent,
    p_marketing_consent,
    p_consent_copy_version,
    p_user_message,
    p_profile,
    p_response,
    p_media_refs
  );

  if result_value ->> 'status' is distinct from 'completed' then
    return result_value;
  end if;

  select session.* into session_row
  from crm_private.public_agent_sessions session
  join crm_private.public_agent_experiences experience
    on experience.id = session.experience_id
  where experience.slug = lower(trim(p_slug))
    and experience.active
    and session.session_token_hash = p_session_token_hash
    and session.fingerprint_hash = p_fingerprint_hash
  for update of session;

  if not found or session_row.crm_record_id is null then
    raise exception 'PUBLIC_AGENT_HANDOFF_LEAD_REQUIRED';
  end if;

  select experience.* into experience_row
  from crm_private.public_agent_experiences experience
  where experience.id = session_row.experience_id
    and experience.active;

  select record.* into record_row
  from public.crm_records record
  where record.organization_id = session_row.organization_id
    and record.id = session_row.crm_record_id
    and record.record_status <> 'arquivada'
  for update;

  if not found then
    raise exception 'PUBLIC_AGENT_HANDOFF_LEAD_UNAVAILABLE';
  end if;

  owner_key := coalesce(
    record_row.sdr_user_id,
    record_row.broker_user_id,
    record_row.owner_user_id,
    experience_row.fallback_owner_user_id
  );
  due_value := now() + make_interval(
    mins => greatest(
      1,
      least(1440, coalesce(experience_row.first_contact_sla_minutes, 60))
    )
  );

  update public.crm_conversations conversation
  set status = 'human_required',
      assigned_user_id = coalesce(conversation.assigned_user_id, owner_key),
      updated_at = now()
  where conversation.organization_id = session_row.organization_id
    and conversation.crm_record_id = session_row.crm_record_id
    and conversation.channel = 'site'
    and conversation.status <> 'closed';

  idempotency_value := 'public_agent_handoff:' || session_row.id::text
    || ':' || p_client_request_id::text;
  insert into public.crm_opportunity_events (
    organization_id,
    crm_record_id,
    opportunity_key,
    contact_id,
    project_id,
    product_id,
    lead_source_id,
    actor_type,
    event_type,
    event_source,
    channel,
    occurred_at,
    idempotency_key,
    correlation_id,
    data
  ) values (
    session_row.organization_id,
    session_row.crm_record_id,
    session_row.crm_record_id,
    session_row.contact_id,
    record_row.project_id,
    record_row.product_id,
    record_row.lead_source_id,
    'ai',
    'handoff.requested',
    'vitoria',
    'site',
    now(),
    idempotency_value,
    'public-agent:' || session_row.id::text,
    jsonb_build_object(
      'public_agent_session_id', session_row.id,
      'client_request_id', p_client_request_id,
      'assigned_to', owner_key,
      'requested_at', now()
    )
  )
  on conflict (organization_id, idempotency_key)
    where idempotency_key is not null
  do nothing
  returning id into event_key;

  if event_key is not null then
    if not exists (
      select 1
      from public.crm_actions action
      where action.organization_id = session_row.organization_id
        and action.crm_record_id = session_row.crm_record_id
        and action.action_status = 'pendente'
        and action.metadata ->> 'public_agent_session_id' = session_row.id::text
        and action.metadata ->> 'action' = 'human_handoff'
    ) then
      insert into public.crm_actions (
        organization_id,
        crm_record_id,
        action_type,
        channel,
        subject,
        scheduled_at,
        action_status,
        assigned_to,
        notes,
        metadata
      ) values (
        session_row.organization_id,
        session_row.crm_record_id,
        'tarefa',
        'telefone',
        'Retornar contato solicitado à Vitória',
        now(),
        'pendente',
        owner_key,
        'O cliente pediu para falar com um especialista durante o atendimento da Vitória. Consulte o histórico completo antes do contato.',
        jsonb_build_object(
          'source', 'vitoria',
          'action', 'human_handoff',
          'public_agent_session_id', session_row.id,
          'client_request_id', p_client_request_id,
          'no_external_delivery', true
        )
      );
    end if;

    insert into public.crm_alerts (
      organization_id,
      crm_record_id,
      alert_type,
      severity,
      title,
      message,
      assigned_to,
      due_at,
      status
    ) values (
      session_row.organization_id,
      session_row.crm_record_id,
      'public_agent_handoff',
      'alta',
      'Cliente pediu um especialista',
      'A Vitória registrou um pedido de contato humano. Consulte a conversa antes de retornar.',
      owner_key,
      due_value,
      'aberto'
    )
    on conflict (crm_record_id, alert_type, status)
    do update set
      severity = excluded.severity,
      title = excluded.title,
      message = excluded.message,
      assigned_to = coalesce(
        excluded.assigned_to,
        public.crm_alerts.assigned_to
      ),
      due_at = least(
        coalesce(public.crm_alerts.due_at, excluded.due_at),
        excluded.due_at
      );
  end if;

  update crm_private.public_agent_sessions
  set stage = 'handoff',
      last_activity_at = now(),
      updated_at = now()
  where id = session_row.id;

  first_name_value := nullif(
    split_part(
      trim(coalesce(result_value -> 'contactCapture' ->> 'name', '')),
      ' ',
      1
    ),
    ''
  );
  reply_value := case
    when first_name_value is not null then
      'Perfeito, ' || first_name_value
        || '. Já deixei a equipe avisada para falar com você no número cadastrado. Se precisar, sigo por aqui.'
    else
      'Perfeito. Já deixei a equipe avisada para falar com você no número cadastrado. Se precisar, sigo por aqui.'
  end;

  result_value := jsonb_set(result_value, '{reply}', to_jsonb(reply_value), true);
  result_value := jsonb_set(
    result_value,
    '{quickReplies}',
    jsonb_build_array('Continuar por aqui'),
    true
  );
  result_value := jsonb_set(result_value, '{stage}', '"handoff"'::jsonb, true);
  result_value := jsonb_set(
    result_value,
    '{handoffRequested}',
    'true'::jsonb,
    true
  );

  update crm_private.public_agent_messages
  set content = reply_value
  where session_id = session_row.id
    and direction = 'assistant'
    and metadata ->> 'client_request_id' = p_client_request_id::text;

  update public.crm_messages
  set content = reply_value
  where organization_id = session_row.organization_id
    and crm_record_id = session_row.crm_record_id
    and direction = 'outbound'
    and actor_type = 'ai'
    and metadata ->> 'client_request_id' = p_client_request_id::text;

  update crm_private.public_agent_requests
  set response = result_value,
      updated_at = now()
  where session_id = session_row.id
    and client_request_id = p_client_request_id
    and request_kind = 'message'
    and status = 'succeeded';

  return result_value;
end
$function$;

comment on function public.commit_public_agent_lead_handoff_message_v1(
  text, text, text, uuid, uuid, bigint, text, uuid, text, text,
  jsonb, boolean, boolean, text, text, jsonb, jsonb, jsonb
) is
  'Converte o lead e registra o pedido humano na mesma transacao, preservando a intencao durante a captura conversacional.';

revoke all on function public.commit_public_agent_lead_handoff_message_v1(
  text, text, text, uuid, uuid, bigint, text, uuid, text, text,
  jsonb, boolean, boolean, text, text, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role;

grant execute on function public.commit_public_agent_lead_handoff_message_v1(
  text, text, text, uuid, uuid, bigint, text, uuid, text, text,
  jsonb, boolean, boolean, text, text, jsonb, jsonb, jsonb
) to service_role;

commit;
