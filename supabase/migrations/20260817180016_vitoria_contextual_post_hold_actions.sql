begin;

do $migration_preflight$
begin
  if to_regprocedure(
    'crm_private.public_agent_public_response_metadata(jsonb)'
  ) is null
     or to_regprocedure(
       'public.commit_public_agent_action_message_v4(text,text,text,uuid,uuid,bigint,text,uuid,text,text,jsonb,boolean,boolean,text,text,jsonb,jsonb)'
     ) is null
     or to_regprocedure(
       'public.commit_public_agent_action_message_v6(text,text,text,uuid,uuid,bigint,text,uuid,text,text,jsonb,boolean,boolean,text,text,jsonb,jsonb,jsonb)'
     ) is null then
    raise exception 'VITORIA_CONTEXTUAL_POST_HOLD_DEPENDENCY_MISSING';
  end if;
end
$migration_preflight$;

create or replace function crm_private.public_agent_public_response_metadata(
  p_response jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  attachment_item jsonb;
  attachment_type text;
  attachment_url text;
  attachments_value jsonb := '[]'::jsonb;
  scenario_item jsonb;
  scenarios_value jsonb := '[]'::jsonb;
  simulation_input jsonb;
  simulation_value jsonb;
  payment_draft_input jsonb;
  payment_draft_value jsonb;
  quick_reply_item jsonb;
  quick_reply_value text;
  quick_replies_value jsonb := '[]'::jsonb;
  action_value text;
  unit_code_value text;
  result_value jsonb;
begin
  if p_response is null or jsonb_typeof(p_response) <> 'object' then
    return '{}'::jsonb;
  end if;

  action_value := nullif(trim(p_response ->> 'action'), '');
  if action_value not in (
    'none',
    'show_enterprise',
    'show_inventory',
    'show_policy',
    'show_documents',
    'request_visit',
    'request_hold',
    'hold_status',
    'generate_home_simulation'
  ) then
    action_value := null;
  end if;

  unit_code_value := upper(nullif(trim(p_response ->> 'selectedUnitCode'), ''));
  if unit_code_value !~ '^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$' then
    unit_code_value := null;
  end if;

  if jsonb_typeof(p_response -> 'quickReplies') = 'array' then
    for quick_reply_item in
      select item.value
      from jsonb_array_elements(p_response -> 'quickReplies')
        with ordinality as item(value, position)
      where item.position <= 5
    loop
      if jsonb_typeof(quick_reply_item) <> 'string' then
        continue;
      end if;
      quick_reply_value := nullif(trim(quick_reply_item #>> '{}'), '');
      if quick_reply_value is null
         or char_length(quick_reply_value) > 96
         or quick_reply_value ~ '[[:cntrl:]]' then
        continue;
      end if;
      if not (
        quick_replies_value @> jsonb_build_array(quick_reply_value)
      ) then
        quick_replies_value := quick_replies_value
          || jsonb_build_array(quick_reply_value);
      end if;
    end loop;
  end if;

  if jsonb_typeof(p_response -> 'attachments') = 'array' then
    for attachment_item in
      select item.value
      from jsonb_array_elements(p_response -> 'attachments')
        with ordinality as item(value, position)
      where item.position <= 8
    loop
      if jsonb_typeof(attachment_item) <> 'object' then
        continue;
      end if;
      attachment_type := nullif(trim(attachment_item ->> 'type'), '');
      if attachment_type is null
         or attachment_type not in ('document', 'image', 'project') then
        continue;
      end if;
      attachment_url := nullif(trim(attachment_item ->> 'url'), '');
      if attachment_url is not null
         and (
           char_length(attachment_url) > 2048
           or attachment_url !~ '^https://[^[:space:]]+$'
         ) then
        attachment_url := null;
      end if;
      attachments_value := attachments_value || jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
          'type', attachment_type,
          'id', left(nullif(trim(attachment_item ->> 'id'), ''), 180),
          'title', coalesce(
            left(nullif(trim(attachment_item ->> 'title'), ''), 180),
            'Arquivo'
          ),
          'description', left(
            nullif(trim(attachment_item ->> 'description'), ''),
            500
          ),
          'url', attachment_url,
          'mimeType', left(
            nullif(trim(attachment_item ->> 'mimeType'), ''),
            120
          ),
          'badge', left(
            nullif(trim(attachment_item ->> 'badge'), ''),
            80
          ),
          'disclaimer', left(
            nullif(trim(attachment_item ->> 'disclaimer'), ''),
            800
          )
        ))
      );
    end loop;
  end if;

  simulation_input := p_response -> 'simulation';
  if jsonb_typeof(simulation_input) = 'object' then
    if jsonb_typeof(simulation_input -> 'scenarios') = 'array' then
      for scenario_item in
        select item.value
        from jsonb_array_elements(simulation_input -> 'scenarios')
          with ordinality as item(value, position)
        where item.position <= 5
      loop
        if jsonb_typeof(scenario_item) = 'object'
           and jsonb_typeof(scenario_item -> 'months') = 'number'
           and jsonb_typeof(scenario_item -> 'monthlyPayment') = 'number'
           and jsonb_typeof(scenario_item -> 'financedAmount') = 'number' then
          scenarios_value := scenarios_value || jsonb_build_array(
            jsonb_strip_nulls(jsonb_build_object(
              'months', scenario_item -> 'months',
              'monthlyPayment', scenario_item -> 'monthlyPayment',
              'financedAmount', scenario_item -> 'financedAmount',
              'balloonTotal', case
                when jsonb_typeof(scenario_item -> 'balloonTotal') = 'number'
                  then scenario_item -> 'balloonTotal'
                when jsonb_typeof(
                  scenario_item -> 'balloonPresentValue'
                ) = 'number'
                  then scenario_item -> 'balloonPresentValue'
                else null
              end
            ))
          );
        end if;
      end loop;
    end if;

    simulation_value := jsonb_strip_nulls(jsonb_build_object(
      'projectName', left(
        nullif(trim(simulation_input ->> 'projectName'), ''),
        180
      ),
      'unitCode', case
        when upper(coalesce(simulation_input ->> 'unitCode', ''))
          ~ '^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$'
          then upper(simulation_input ->> 'unitCode')
        else null
      end,
      'area', case
        when jsonb_typeof(simulation_input -> 'area') = 'number'
          then simulation_input -> 'area'
        else null
      end,
      'price', case
        when jsonb_typeof(simulation_input -> 'price') = 'number'
          then simulation_input -> 'price'
        else null
      end,
      'minimumDownPaymentPct', case
        when jsonb_typeof(
          simulation_input -> 'minimumDownPaymentPct'
        ) = 'number'
          then simulation_input -> 'minimumDownPaymentPct'
        else null
      end,
      'minimumDownPaymentApplied', case
        when jsonb_typeof(
          simulation_input -> 'minimumDownPaymentApplied'
        ) = 'boolean'
          then simulation_input -> 'minimumDownPaymentApplied'
        else null
      end,
      'downPaymentPct', case
        when jsonb_typeof(simulation_input -> 'downPaymentPct') = 'number'
          then simulation_input -> 'downPaymentPct'
        else null
      end,
      'downPayment', case
        when jsonb_typeof(simulation_input -> 'downPayment') = 'number'
          then simulation_input -> 'downPayment'
        else null
      end,
      'downPaymentInstallments', case
        when jsonb_typeof(
          simulation_input -> 'downPaymentInstallments'
        ) = 'number'
          then simulation_input -> 'downPaymentInstallments'
        else null
      end,
      'downPaymentInstallmentAmount', case
        when jsonb_typeof(
          simulation_input -> 'downPaymentInstallmentAmount'
        ) = 'number'
          then simulation_input -> 'downPaymentInstallmentAmount'
        else null
      end,
      'downPaymentInterestRate', case
        when jsonb_typeof(
          simulation_input -> 'downPaymentInterestRate'
        ) = 'number'
          then simulation_input -> 'downPaymentInterestRate'
        else null
      end,
      'balloonCount', case
        when jsonb_typeof(simulation_input -> 'balloonCount') = 'number'
          then simulation_input -> 'balloonCount'
        else null
      end,
      'balloonAmount', case
        when jsonb_typeof(simulation_input -> 'balloonAmount') = 'number'
          then simulation_input -> 'balloonAmount'
        else null
      end,
      'balloonFrequencyMonths', case
        when jsonb_typeof(
          simulation_input -> 'balloonFrequencyMonths'
        ) = 'number'
          then simulation_input -> 'balloonFrequencyMonths'
        else null
      end,
      'monthlyInterestRate', case
        when jsonb_typeof(
          simulation_input -> 'monthlyInterestRate'
        ) = 'number'
          then simulation_input -> 'monthlyInterestRate'
        else null
      end,
      'indexer', left(
        nullif(trim(simulation_input ->> 'indexer'), ''),
        40
      ),
      'calculationMethod', left(
        nullif(trim(simulation_input ->> 'calculationMethod'), ''),
        40
      ),
      'scenarios', scenarios_value,
      'generatedAt', left(
        nullif(trim(simulation_input ->> 'generatedAt'), ''),
        40
      ),
      'disclaimer', left(
        nullif(trim(simulation_input ->> 'disclaimer'), ''),
        800
      )
    ));
  end if;

  payment_draft_input := p_response -> 'paymentDraft';
  if jsonb_typeof(payment_draft_input) = 'object'
     and upper(coalesce(payment_draft_input ->> 'unitCode', ''))
       ~ '^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$' then
    payment_draft_value := jsonb_strip_nulls(jsonb_build_object(
      'unitCode', upper(payment_draft_input ->> 'unitCode'),
      'downPaymentPct', case
        when jsonb_typeof(payment_draft_input -> 'downPaymentPct') = 'number'
          and (payment_draft_input ->> 'downPaymentPct')::numeric
            between 0 and 0.90
          then payment_draft_input -> 'downPaymentPct'
        else null
      end,
      'downPaymentInstallments', case
        when jsonb_typeof(
          payment_draft_input -> 'downPaymentInstallments'
        ) = 'number'
          and (payment_draft_input ->> 'downPaymentInstallments')::numeric
            between 1 and 24
          and mod(
            (payment_draft_input ->> 'downPaymentInstallments')::numeric,
            1
          ) = 0
          then payment_draft_input -> 'downPaymentInstallments'
        else null
      end,
      'months', case
        when jsonb_typeof(payment_draft_input -> 'months') = 'number'
          and (payment_draft_input ->> 'months')::numeric between 12 and 600
          and mod((payment_draft_input ->> 'months')::numeric, 1) = 0
          then payment_draft_input -> 'months'
        else null
      end,
      'balloonCount', case
        when jsonb_typeof(payment_draft_input -> 'balloonCount') = 'number'
          and (payment_draft_input ->> 'balloonCount')::numeric
            between 0 and 24
          and mod(
            (payment_draft_input ->> 'balloonCount')::numeric,
            1
          ) = 0
          then payment_draft_input -> 'balloonCount'
        else null
      end,
      'balloonAmount', case
        when jsonb_typeof(payment_draft_input -> 'balloonAmount') = 'number'
          and (payment_draft_input ->> 'balloonAmount')::numeric
            between 0 and 1000000000
          then payment_draft_input -> 'balloonAmount'
        else null
      end
    ));
  end if;

  result_value := jsonb_strip_nulls(jsonb_build_object(
    'attachments', attachments_value,
    'simulation', simulation_value,
    'paymentDraft', payment_draft_value,
    'action', action_value,
    'selectedUnitCode', unit_code_value,
    'quickReplies', case
      when jsonb_array_length(quick_replies_value) > 0
        then quick_replies_value
      else null
    end
  ));

  while pg_column_size(result_value) > 4096
        and jsonb_array_length(attachments_value) > 0 loop
    attachments_value := attachments_value
      - (jsonb_array_length(attachments_value) - 1);
    result_value := jsonb_strip_nulls(jsonb_build_object(
      'attachments', attachments_value,
      'simulation', simulation_value,
      'paymentDraft', payment_draft_value,
      'action', action_value,
      'selectedUnitCode', unit_code_value,
      'quickReplies', case
        when jsonb_array_length(quick_replies_value) > 0
          then quick_replies_value
        else null
      end
    ));
  end loop;

  if pg_column_size(result_value) > 4096 and simulation_value is not null then
    simulation_value := simulation_value - 'disclaimer';
    result_value := jsonb_strip_nulls(jsonb_build_object(
      'attachments', attachments_value,
      'simulation', simulation_value,
      'paymentDraft', payment_draft_value,
      'action', action_value,
      'selectedUnitCode', unit_code_value,
      'quickReplies', case
        when jsonb_array_length(quick_replies_value) > 0
          then quick_replies_value
        else null
      end
    ));
  end if;

  if pg_column_size(result_value) > 4096 then
    result_value := jsonb_strip_nulls(jsonb_build_object(
      'attachments', attachments_value,
      'paymentDraft', payment_draft_value,
      'action', action_value,
      'selectedUnitCode', unit_code_value,
      'quickReplies', case
        when jsonb_array_length(quick_replies_value) > 0
          then quick_replies_value
        else null
      end
    ));
  end if;

  return result_value;
end
$function$;

comment on function crm_private.public_agent_public_response_metadata(jsonb)
is
  'Sanitiza metadados publicos da resposta, inclusive ate cinco acoes contextuais, sem persistir campos privados.';

revoke all on function crm_private.public_agent_public_response_metadata(jsonb)
from public, anon, authenticated;

create or replace function public.commit_public_agent_action_message_v5(
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
  p_response jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  session_row crm_private.public_agent_sessions%rowtype;
  result_value jsonb;
  contact_value jsonb;
  hold_value jsonb;
  hold_unit jsonb;
  first_name_value text;
  requested_unit_value text;
  actual_unit_value text;
  reply_value text;
  quick_replies_value jsonb;
  public_response_value jsonb;
begin
  perform crm_private.assert_public_agent_service_role();

  result_value := public.commit_public_agent_action_message_v4(
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
    p_response
  );

  if result_value ->> 'status' is distinct from 'completed' then
    return result_value;
  end if;

  contact_value := coalesce(result_value -> 'contactCapture', '{}'::jsonb);
  first_name_value := nullif(
    split_part(trim(coalesce(contact_value ->> 'name', '')), ' ', 1),
    ''
  );

  if p_action_kind = 'lead' then
    actual_unit_value := coalesce(
      nullif(upper(trim(p_profile ->> 'selected_unit_code')), ''),
      nullif(upper(trim(p_profile ->> 'selectedUnitCode')), '')
    );
    if actual_unit_value is not null
       and actual_unit_value !~ '^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$' then
      actual_unit_value := null;
    end if;

    reply_value := case
      when first_name_value is not null and actual_unit_value is not null then
        'Perfeito, ' || first_name_value || '. Já guardei seu contato e tudo '
          || 'o que vimos sobre o ' || actual_unit_value || '. Quer que eu '
          || 'calcule as condições, mostre as fotos e materiais ou combine '
          || 'uma visita?'
      when actual_unit_value is not null then
        'Perfeito. Já guardei seu contato e tudo o que vimos sobre o '
          || actual_unit_value || '. Quer que eu calcule as condições, '
          || 'mostre as fotos e materiais ou combine uma visita?'
      when first_name_value is not null then
        'Perfeito, ' || first_name_value || '. Já tenho seu contato e não vou '
          || 'fazer você repetir o que me contou. Quer começar pelos lotes, '
          || 'por uma simulação ou pelo empreendimento?'
      else
        'Perfeito. Já tenho seu contato e não vou fazer você repetir o que me '
          || 'contou. Quer começar pelos lotes, por uma simulação ou pelo '
          || 'empreendimento?'
    end;
    quick_replies_value := case
      when actual_unit_value is not null then jsonb_build_array(
        'Calcular condições do ' || actual_unit_value,
        'Ver fotos e materiais do ' || actual_unit_value,
        'Agendar uma visita'
      )
      else jsonb_build_array(
        'Ver lotes disponíveis',
        'Calcular condições de pagamento',
        'Conhecer o empreendimento'
      )
    end;
  else
    requested_unit_value := upper(trim(coalesce(p_unit_code, '')));
    hold_value := coalesce(result_value -> 'holdStatus', '{}'::jsonb);
    hold_unit := coalesce(hold_value -> 'unit', '{}'::jsonb);
    actual_unit_value := coalesce(
      nullif(upper(trim(hold_unit ->> 'unitCode')), ''),
      nullif(upper(trim(hold_unit ->> 'unit_code')), ''),
      nullif(upper(trim(result_value ->> 'selectedUnitCode')), ''),
      nullif(requested_unit_value, '')
    );

    if actual_unit_value is not null
       and actual_unit_value !~ '^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$' then
      actual_unit_value := null;
    end if;

    if hold_value ->> 'alreadyActive' = 'true'
       and actual_unit_value is null then
      reply_value := 'Você já tinha um lote bloqueado, então mantive esse '
        || 'mesmo. Quer revisar as condições, ver os materiais ou combinar '
        || 'uma visita?';
    elsif hold_value ->> 'alreadyActive' = 'true'
          and actual_unit_value is distinct from nullif(requested_unit_value, '') then
      reply_value := 'O ' || actual_unit_value
        || ' continua bloqueado para você. Por isso, não bloqueei também o '
        || requested_unit_value || '. Quer comparar os dois ou seguir com '
        || 'as condições do lote que já está separado?';
    elsif actual_unit_value is not null then
      reply_value := case
        when first_name_value is not null then
          'Pronto, ' || first_name_value || '. Deixei o '
            || actual_unit_value || ' bloqueado temporariamente para você. '
            || 'Quer ajustar o pagamento, ver as fotos e materiais ou '
            || 'combinar uma visita?'
        else
          'Pronto. Deixei o ' || actual_unit_value
            || ' bloqueado temporariamente para você. Quer ajustar o '
            || 'pagamento, ver as fotos e materiais ou combinar uma visita?'
      end;
    else
      reply_value := 'Pronto. O lote ficou bloqueado temporariamente para '
        || 'você. Quer ajustar o pagamento, ver as fotos e materiais ou '
        || 'combinar uma visita?';
    end if;

    quick_replies_value := case
      when actual_unit_value is not null then jsonb_build_array(
        'Calcular condições do ' || actual_unit_value,
        'Ver fotos e materiais do ' || actual_unit_value,
        'Agendar visita ao ' || actual_unit_value
      )
      else jsonb_build_array(
        'Calcular condições de pagamento',
        'Ver fotos e materiais',
        'Agendar uma visita'
      )
    end;

    result_value := jsonb_set(
      result_value,
      '{stage}',
      '"qualification"'::jsonb,
      true
    );
    result_value := jsonb_set(
      result_value,
      '{handoffRequested}',
      'false'::jsonb,
      true
    );
  end if;

  result_value := jsonb_set(
    result_value,
    '{quickReplies}',
    quick_replies_value,
    true
  );
  result_value := jsonb_set(
    result_value,
    '{reply}',
    to_jsonb(reply_value),
    true
  );
  public_response_value :=
    crm_private.public_agent_public_response_metadata(result_value);

  select session.* into session_row
  from crm_private.public_agent_sessions session
  join crm_private.public_agent_experiences experience
    on experience.id = session.experience_id
  where experience.slug = lower(trim(p_slug))
    and experience.active
    and session.session_token_hash = p_session_token_hash
    and session.fingerprint_hash = p_fingerprint_hash
  for update of session;

  if not found then
    raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND';
  end if;

  if p_action_kind = 'hold' then
    update crm_private.public_agent_sessions session
    set stage = 'qualification',
        updated_at = now()
    where session.id = session_row.id
      and session.stage = 'handoff'
      and not exists (
        select 1
        from public.crm_conversations conversation
        where conversation.organization_id = session.organization_id
          and conversation.crm_record_id = session.crm_record_id
          and conversation.channel = 'site'
          and conversation.status = 'human_required'
      )
      and not exists (
        select 1
        from public.crm_opportunity_events event
        where event.organization_id = session.organization_id
          and event.crm_record_id = session.crm_record_id
          and event.event_type = 'handoff.requested'
      );
  end if;

  update crm_private.public_agent_messages
  set content = reply_value,
      metadata = jsonb_set(
        coalesce(metadata, '{}'::jsonb),
        '{public_response}',
        public_response_value,
        true
      )
  where session_id = session_row.id
    and direction = 'assistant'
    and metadata ->> 'client_request_id' = p_client_request_id::text;

  update public.crm_messages
  set content = reply_value,
      metadata = jsonb_set(
        coalesce(metadata, '{}'::jsonb),
        '{public_response}',
        public_response_value,
        true
      )
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

comment on function public.commit_public_agent_action_message_v5(
  text, text, text, uuid, uuid, bigint, text, uuid, text, text,
  jsonb, boolean, boolean, text, text, jsonb, jsonb
) is
  'Finaliza cadastro ou bloqueio de forma atomica; depois do bloqueio mantem a negociacao ativa, sem simular handoff, e persiste proximas acoes contextuais.';

revoke all on function public.commit_public_agent_action_message_v5(
  text, text, text, uuid, uuid, bigint, text, uuid, text, text,
  jsonb, boolean, boolean, text, text, jsonb, jsonb
) from public, anon, authenticated, service_role;

grant execute on function public.commit_public_agent_action_message_v5(
  text, text, text, uuid, uuid, bigint, text, uuid, text, text,
  jsonb, boolean, boolean, text, text, jsonb, jsonb
) to service_role;

commit;
