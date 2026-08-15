begin;

create or replace function public.convert_public_agent_lead(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_name text,
  p_phone_e164 text,
  p_email text default null,
  p_city text default null,
  p_marketing_consent boolean default false,
  p_profile jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  experience_row crm_private.public_agent_experiences%rowtype;
  session_row crm_private.public_agent_sessions%rowtype;
  source_row public.crm_lead_sources%rowtype;
  stage_row public.crm_stages%rowtype;
  contact_key uuid;
  record_key uuid;
  conversation_key uuid;
  attribution_key uuid;
  owner_key uuid;
  assignment_key uuid;
  match_count integer;
  identity_ambiguous boolean := false;
  contact_blocked boolean := false;
  email_value text;
  city_value text;
  score_value integer := 30;
  temperature_value text := 'morno';
  priority_value text := 'alta';
  budget_min_value numeric;
  budget_max_value numeric;
  area_min_value numeric;
  area_max_value numeric;
  payment_capacity_value numeric;
  financing_interest_value boolean := false;
  transcript_summary text;
  now_value timestamptz := now();
  message_row record;
begin
  perform crm_private.assert_public_agent_service_role();

  if char_length(trim(p_name)) not between 2 and 180
     or p_phone_e164 !~ '^[+][1-9][0-9]{7,14}$'
     or p_profile is null
     or jsonb_typeof(p_profile) <> 'object'
     or pg_column_size(p_profile) > 32768 then
    raise exception 'PUBLIC_AGENT_LEAD_INPUT_INVALID';
  end if;

  email_value := lower(nullif(trim(p_email), ''));
  if email_value is not null and (
    char_length(email_value) > 320
    or email_value !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  ) then
    raise exception 'PUBLIC_AGENT_EMAIL_INVALID';
  end if;
  city_value := left(nullif(trim(p_city), ''), 180);

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

  select experience.* into experience_row
  from crm_private.public_agent_experiences experience
  where experience.id = session_row.experience_id
    and experience.active;

  if not found then
    raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND';
  end if;

  if session_row.crm_record_id is not null then
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'contactId', session_row.contact_id,
      'crmRecordId', session_row.crm_record_id,
      'protocol', upper(left(replace(session_row.crm_record_id::text, '-', ''), 10))
    );
  end if;

  select source.* into source_row
  from public.crm_lead_sources source
  where source.organization_id = experience_row.organization_id
    and source.id = experience_row.lead_source_id
    and source.active
  for share;
  if not found then raise exception 'PUBLIC_AGENT_SOURCE_INACTIVE'; end if;

  select stage.* into stage_row
  from public.crm_stages stage
  where stage.organization_id = experience_row.organization_id
    and stage.id = experience_row.initial_stage_id
    and stage.pipeline_id = experience_row.pipeline_id
    and stage.active
    and not stage.is_won
    and not stage.is_lost
  for share;
  if not found then raise exception 'PUBLIC_AGENT_STAGE_INACTIVE'; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    experience_row.organization_id::text || ':public_agent:phone:' || p_phone_e164,
    0
  ));
  if email_value is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      experience_row.organization_id::text || ':public_agent:email:' || email_value,
      0
    ));
  end if;

  select count(*), (array_agg(candidate.contact_id order by candidate.contact_id))[1]
  into match_count, contact_key
  from (
    select identity.contact_id
    from public.crm_contact_identities identity
    join public.contacts contact
      on contact.organization_id = identity.organization_id
     and contact.id = identity.contact_id
     and contact.active
    where identity.organization_id = experience_row.organization_id
      and identity.active
      and (
        (identity.identity_type in ('phone', 'whatsapp') and identity.normalized_value = p_phone_e164)
        or (email_value is not null and identity.identity_type = 'email' and identity.normalized_value = email_value)
      )
    union
    select contact.id
    from public.contacts contact
    where contact.organization_id = experience_row.organization_id
      and contact.active
      and (
        crm_integration_private.normalize_phone_e164(contact.phone, '55') = p_phone_e164
        or (email_value is not null and lower(nullif(trim(contact.email), '')) = email_value)
      )
  ) candidate;

  if match_count > 1 then
    contact_key := null;
    identity_ambiguous := true;
  end if;

  if contact_key is null then
    insert into public.contacts (
      organization_id,
      contact_type,
      name,
      email,
      phone,
      city,
      preferred_channel,
      marketing_consent_status,
      marketing_consent_at,
      marketing_consent_source,
      data_processing_basis,
      person_type,
      active
    ) values (
      experience_row.organization_id,
      'prospect',
      left(trim(p_name), 180),
      email_value,
      p_phone_e164,
      city_value,
      'telefone',
      case when p_marketing_consent then 'granted' else 'unknown' end,
      case when p_marketing_consent then now_value else null end,
      case when p_marketing_consent then 'site_agent:' || experience_row.slug else null end,
      'pre_contract',
      'fisica',
      true
    ) returning id into contact_key;
  else
    update public.contacts contact
    set name = case
          when nullif(trim(contact.name), '') is null then left(trim(p_name), 180)
          else contact.name
        end,
        email = coalesce(nullif(trim(contact.email), ''), email_value),
        phone = coalesce(nullif(trim(contact.phone), ''), p_phone_e164),
        city = coalesce(nullif(trim(contact.city), ''), city_value),
        preferred_channel = coalesce(contact.preferred_channel, 'telefone'),
        marketing_consent_status = case
          when p_marketing_consent
               and contact.do_not_contact_at is null
               and contact.marketing_consent_status <> 'revoked'
            then 'granted'
          else contact.marketing_consent_status
        end,
        marketing_consent_at = case
          when p_marketing_consent
               and contact.do_not_contact_at is null
               and contact.marketing_consent_status <> 'revoked'
            then now_value
          else contact.marketing_consent_at
        end,
        marketing_consent_source = case
          when p_marketing_consent
               and contact.do_not_contact_at is null
               and contact.marketing_consent_status <> 'revoked'
            then 'site_agent:' || experience_row.slug
          else contact.marketing_consent_source
        end,
        data_processing_basis = coalesce(contact.data_processing_basis, 'pre_contract'),
        updated_at = now_value
    where contact.organization_id = experience_row.organization_id
      and contact.id = contact_key;
  end if;

  select contact.do_not_contact_at is not null
         or contact.marketing_consent_status = 'revoked'
  into contact_blocked
  from public.contacts contact
  where contact.organization_id = experience_row.organization_id
    and contact.id = contact_key;

  if not identity_ambiguous then
    insert into public.crm_contact_identities (
      organization_id, contact_id, identity_type, normalized_value,
      last_seen_at, active, source, metadata
    ) values (
      experience_row.organization_id, contact_key, 'phone', p_phone_e164,
      now_value, true, 'site_agent',
      jsonb_build_object('experience_slug', experience_row.slug, 'session_id', session_row.id)
    )
    on conflict (organization_id, contact_id, identity_type, normalized_value)
    do update set last_seen_at = excluded.last_seen_at,
                  active = true,
                  source = 'site_agent',
                  updated_at = now_value;

    if email_value is not null then
      insert into public.crm_contact_identities (
        organization_id, contact_id, identity_type, normalized_value,
        last_seen_at, active, source, metadata
      ) values (
        experience_row.organization_id, contact_key, 'email', email_value,
        now_value, true, 'site_agent',
        jsonb_build_object('experience_slug', experience_row.slug, 'session_id', session_row.id)
      )
      on conflict (organization_id, contact_id, identity_type, normalized_value)
      do update set last_seen_at = excluded.last_seen_at,
                    active = true,
                    source = 'site_agent',
                    updated_at = now_value;
    end if;
  end if;

  if experience_row.team_id is not null then
    select team_member.user_id into owner_key
    from public.crm_team_members team_member
    join public.organization_members member
      on member.organization_id = team_member.organization_id
     and member.user_id = team_member.user_id
     and member.active
    where team_member.organization_id = experience_row.organization_id
      and team_member.team_id = experience_row.team_id
      and team_member.active
    order by team_member.last_assigned_at nulls first, team_member.user_id::text
    limit 1
    for update of team_member skip locked;
  end if;
  owner_key := coalesce(owner_key, experience_row.fallback_owner_user_id);

  if (p_profile ->> 'lead_score') ~ '^[0-9]{1,3}$' then
    score_value := greatest(0, least(100, (p_profile ->> 'lead_score')::integer));
  end if;
  temperature_value := case
    when score_value >= 70 then 'quente'
    when score_value <= 25 then 'frio'
    else 'morno'
  end;
  priority_value := case when score_value >= 55 then 'alta' else 'normal' end;

  if (p_profile ->> 'budget_min') ~ '^[0-9]+([.][0-9]+)?$' then budget_min_value := (p_profile ->> 'budget_min')::numeric; end if;
  if (p_profile ->> 'budget_max') ~ '^[0-9]+([.][0-9]+)?$' then budget_max_value := (p_profile ->> 'budget_max')::numeric; end if;
  if (p_profile ->> 'preferred_area_min') ~ '^[0-9]+([.][0-9]+)?$' then area_min_value := (p_profile ->> 'preferred_area_min')::numeric; end if;
  if (p_profile ->> 'preferred_area_max') ~ '^[0-9]+([.][0-9]+)?$' then area_max_value := (p_profile ->> 'preferred_area_max')::numeric; end if;
  if (p_profile ->> 'payment_capacity') ~ '^[0-9]+([.][0-9]+)?$' then payment_capacity_value := (p_profile ->> 'payment_capacity')::numeric; end if;
  if jsonb_typeof(p_profile -> 'financing_interest') = 'boolean' then financing_interest_value := (p_profile ->> 'financing_interest')::boolean; end if;

  transcript_summary := left(
    coalesce(nullif(trim(p_profile ->> 'summary'), ''), 'Lead captado pelo Atendimento Inteligente da Vitória.'),
    4000
  );

  perform set_config('app.crm_event_source', 'integration', true);
  perform set_config('app.correlation_id', 'public-agent:' || session_row.id::text, true);

  insert into public.crm_records (
    organization_id, contact_id, person_name, email, phone,
    project_id, product_id, lead_source_id,
    stage, record_status, source, source_channel,
    estimated_value, probability, next_action_at,
    owner_user_id, pipeline_id, stage_id, team_id,
    sdr_user_id, broker_user_id,
    lead_score, temperature, priority,
    utm_source, utm_medium, utm_campaign, utm_content,
    landing_page, budget_min, budget_max,
    preferred_area_min, preferred_area_max, preferred_city,
    financing_interest, payment_capacity,
    sla_due_at, stagnation_at, tags, notes, originated_at
  ) values (
    experience_row.organization_id, contact_key, left(trim(p_name), 180), email_value, p_phone_e164,
    experience_row.project_id, experience_row.product_id, experience_row.lead_source_id,
    stage_row.code, 'aberta', source_row.name, source_row.channel,
    0, stage_row.probability, now_value,
    owner_key, experience_row.pipeline_id, experience_row.initial_stage_id, experience_row.team_id,
    case when experience_row.assignment_role = 'sdr' then owner_key else null end,
    case when experience_row.assignment_role = 'broker' then owner_key else null end,
    score_value, temperature_value, priority_value,
    left(nullif(trim(session_row.utm ->> 'utm_source'), ''), 255),
    left(nullif(trim(session_row.utm ->> 'utm_medium'), ''), 255),
    left(nullif(trim(session_row.utm ->> 'utm_campaign'), ''), 255),
    left(coalesce(nullif(trim(session_row.utm ->> 'utm_content'), ''), nullif(trim(session_row.utm ->> 'ad_id'), '')), 255),
    session_row.landing_page,
    budget_min_value, budget_max_value,
    area_min_value, area_max_value,
    coalesce(city_value, left(nullif(trim(p_profile ->> 'preferred_city'), ''), 180)),
    financing_interest_value, payment_capacity_value,
    case when contact_blocked or identity_ambiguous then null else now_value + make_interval(mins => experience_row.first_contact_sla_minutes) end,
    now_value + make_interval(mins => experience_row.first_contact_sla_minutes),
    array_remove(array[
      'web_agent', 'vitoria', experience_row.slug,
      case when identity_ambiguous then 'identity_review' end,
      case when contact_blocked then 'do_not_contact_review' end,
      left(nullif(trim(p_profile ->> 'intent'), ''), 80)
    ]::text[], null),
    transcript_summary,
    session_row.created_at
  ) returning id into record_key;

  insert into public.crm_opportunity_attributions (
    organization_id, crm_record_id, opportunity_key,
    lead_source_id, project_id, product_id,
    provider, channel, external_lead_id,
    campaign_id, campaign_name, adset_id, ad_name,
    creative_id, placement, publisher_platform,
    attribution_model, captured_at, received_at, is_primary, metadata
  ) values (
    experience_row.organization_id, record_key, record_key,
    experience_row.lead_source_id, experience_row.project_id, experience_row.product_id,
    'website', source_row.channel, session_row.id::text,
    left(nullif(trim(session_row.utm ->> 'campaign_id'), ''), 255),
    left(nullif(trim(session_row.utm ->> 'utm_campaign'), ''), 500),
    left(nullif(trim(session_row.utm ->> 'adset_id'), ''), 255),
    left(nullif(trim(session_row.utm ->> 'ad_name'), ''), 500),
    left(nullif(trim(session_row.utm ->> 'creative_id'), ''), 255),
    left(nullif(trim(session_row.utm ->> 'placement'), ''), 255),
    left(nullif(trim(session_row.utm ->> 'publisher_platform'), ''), 255),
    'source_capture', session_row.created_at, now_value, true,
    jsonb_strip_nulls(jsonb_build_object(
      'public_agent_session_id', session_row.id,
      'experience_slug', experience_row.slug,
      'fbclid', session_row.utm ->> 'fbclid',
      'referrer', session_row.referrer,
      'consent', p_marketing_consent
    ))
  ) returning id into attribution_key;

  insert into public.crm_conversations (
    organization_id, crm_record_id, contact_id,
    channel, status, ai_enabled, assigned_user_id,
    started_at, last_message_at
  ) values (
    experience_row.organization_id, record_key, contact_key,
    'site', 'waiting_lead', true, owner_key,
    session_row.created_at, session_row.last_activity_at
  ) returning id into conversation_key;

  for message_row in
    select message.direction, message.content, message.metadata, message.created_at
    from crm_private.public_agent_messages message
    where message.session_id = session_row.id
    order by message.created_at, message.id
  loop
    insert into public.crm_messages (
      organization_id, conversation_id, crm_record_id,
      direction, actor_type, channel, content,
      delivery_status, metadata, occurred_at
    ) values (
      experience_row.organization_id, conversation_key, record_key,
      case when message_row.direction = 'user' then 'inbound' else 'outbound' end,
      case when message_row.direction = 'user' then 'lead' else 'ai' end,
      'site', message_row.content,
      'delivered',
      jsonb_build_object('public_agent_session_id', session_row.id) || message_row.metadata,
      message_row.created_at
    );
  end loop;

  insert into public.crm_opportunity_events (
    organization_id, crm_record_id, opportunity_key,
    contact_id, project_id, product_id, lead_source_id,
    actor_type, event_type, event_source, channel,
    occurred_at, idempotency_key, correlation_id, data
  ) values (
    experience_row.organization_id, record_key, record_key,
    contact_key, experience_row.project_id, experience_row.product_id, experience_row.lead_source_id,
    'integration', 'lead.ingested', 'integration', source_row.channel,
    now_value, 'public_agent:' || session_row.id::text,
    'public-agent:' || session_row.id::text,
    jsonb_build_object(
      'public_agent_session_id', session_row.id,
      'attribution_id', attribution_key,
      'owner_user_id', owner_key,
      'contact_blocked', contact_blocked,
      'identity_review_required', identity_ambiguous,
      'marketing_consent', p_marketing_consent
    )
  ) on conflict (organization_id, idempotency_key)
    where idempotency_key is not null do nothing;

  if contact_blocked or identity_ambiguous then
    insert into public.crm_actions (
      organization_id, crm_record_id, action_type, subject,
      scheduled_at, action_status, notes,
      channel, assigned_to, metadata
    ) values (
      experience_row.organization_id,
      record_key,
      'tarefa',
      case when contact_blocked then 'Revisão LGPD — contato bloqueado' else 'Revisão de identidade — agente público' end,
      now_value + interval '1 minute',
      'pendente',
      case when contact_blocked
        then 'Não contatar até validar a base legal ou registrar novo consentimento válido.'
        else 'Confirmar a identidade antes de mesclar contatos ou iniciar abordagem externa.'
      end,
      'interno',
      owner_key,
      jsonb_build_object('source', 'web_agent', 'public_agent_session_id', session_row.id, 'no_external_delivery', true)
    );
  else
    assignment_key := private.create_crm_assignment(
      record_key,
      case when experience_row.assignment_role = 'broker' then 'corretor' else 'sdr' end,
      owner_key,
      priority_value,
      now_value + make_interval(mins => experience_row.first_contact_sla_minutes),
      'Lead qualificado pelo Atendimento Inteligente da Vitória. Revisar o resumo e assumir o atendimento dentro do SLA.',
      null,
      'automation',
      true
    );
  end if;

  if experience_row.team_id is not null then
    update public.crm_team_members
    set last_assigned_at = now_value
    where organization_id = experience_row.organization_id
      and team_id = experience_row.team_id
      and user_id = owner_key;
  end if;

  update crm_private.public_agent_sessions
  set status = 'converted',
      stage = 'completed',
      captured_profile = captured_profile || jsonb_strip_nulls(p_profile),
      marketing_consent = p_marketing_consent,
      contact_id = contact_key,
      crm_record_id = record_key,
      conversation_id = conversation_key,
      converted_at = now_value,
      last_activity_at = now_value,
      updated_at = now_value
  where id = session_row.id;

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'contactId', contact_key,
    'crmRecordId', record_key,
    'conversationId', conversation_key,
    'assignmentId', assignment_key,
    'protocol', upper(left(replace(record_key::text, '-', ''), 10))
  );
end
$function$;

revoke all on function public.convert_public_agent_lead(text, text, text, text, text, text, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.convert_public_agent_lead(text, text, text, text, text, text, text, boolean, jsonb) to service_role;

commit;
