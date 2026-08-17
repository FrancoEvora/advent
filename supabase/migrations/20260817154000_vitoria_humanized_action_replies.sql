begin;

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
    reply_value := case
      when first_name_value is not null then
        'Pronto, ' || first_name_value || ' — seu atendimento já ficou registrado e a equipe recebeu tudo o que conversamos. Podemos continuar por aqui também.'
      else
        'Pronto — seu atendimento já ficou registrado e a equipe recebeu tudo o que conversamos. Podemos continuar por aqui também.'
    end;
    result_value := jsonb_set(
      result_value,
      '{quickReplies}',
      jsonb_build_array('Continuar por aqui'),
      true
    );
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
      reply_value := 'Você já tem um lote bloqueado nesta conversa, então não fiz um novo bloqueio. Se quiser, confiro qual é a unidade para você.';
    elsif hold_value ->> 'alreadyActive' = 'true'
          and actual_unit_value is distinct from nullif(requested_unit_value, '') then
      reply_value := 'Você já tem o lote ' || actual_unit_value
        || ' bloqueado nesta conversa, então não bloqueei o ' || requested_unit_value
        || '. Se quiser trocar, eu te ajudo com o próximo passo.';
    elsif actual_unit_value is not null then
      reply_value := case
        when first_name_value is not null then
          'Pronto, ' || first_name_value || ' — deixei o lote ' || actual_unit_value
          || ' bloqueado temporariamente para você. A equipe já recebeu o pedido e eu sigo com você por aqui.'
        else
          'Pronto — deixei o lote ' || actual_unit_value
          || ' bloqueado temporariamente para você. A equipe já recebeu o pedido e eu sigo com você por aqui.'
      end;
    else
      reply_value := 'Pronto — o bloqueio temporário foi registrado e a equipe já recebeu o pedido. Eu sigo com você por aqui.';
    end if;

    result_value := jsonb_set(
      result_value,
      '{quickReplies}',
      jsonb_build_array('Continuar por aqui', 'Ver condições'),
      true
    );
  end if;

  result_value := jsonb_set(
    result_value,
    '{reply}',
    to_jsonb(reply_value),
    true
  );

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

comment on function public.commit_public_agent_action_message_v5(
  text, text, text, uuid, uuid, bigint, text, uuid, text, text,
  jsonb, boolean, boolean, text, text, jsonb, jsonb
) is
  'Finaliza cadastro ou bloqueio de forma atomica e persiste uma resposta comercial natural e idempotente.';

revoke all on function public.commit_public_agent_action_message_v5(
  text, text, text, uuid, uuid, bigint, text, uuid, text, text,
  jsonb, boolean, boolean, text, text, jsonb, jsonb
) from public, anon, authenticated, service_role;

grant execute on function public.commit_public_agent_action_message_v5(
  text, text, text, uuid, uuid, bigint, text, uuid, text, text,
  jsonb, boolean, boolean, text, text, jsonb, jsonb
) to service_role;

commit;
