begin;

create table if not exists crm_private.public_agent_gateway_requests (
  session_id uuid not null references crm_private.public_agent_sessions(id) on delete cascade,
  client_request_id uuid not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (session_id, client_request_id),
  constraint public_agent_gateway_requests_response_object_check
    check (jsonb_typeof(response) = 'object'),
  constraint public_agent_gateway_requests_response_size_check
    check (pg_column_size(response) <= 16384)
);

create index if not exists public_agent_gateway_requests_created_idx
  on crm_private.public_agent_gateway_requests (created_at desc);

create table if not exists crm_private.public_agent_visit_state (
  session_id uuid primary key references crm_private.public_agent_sessions(id) on delete cascade,
  phase text not null,
  unit_code text,
  local_date date,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint public_agent_visit_state_phase_check
    check (phase in ('name', 'phone', 'consent', 'when', 'time')),
  constraint public_agent_visit_state_unit_check
    check (unit_code is null or unit_code ~ '^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$')
);

revoke all on crm_private.public_agent_gateway_requests from public, anon, authenticated;
revoke all on crm_private.public_agent_visit_state from public, anon, authenticated;

create or replace function public.get_public_agent_gateway_context_v1(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  session_row crm_private.public_agent_sessions%rowtype;
  visit_row crm_private.public_agent_visit_state%rowtype;
  hold_value jsonb;
begin
  perform crm_private.assert_public_agent_service_role();

  select session.*
    into session_row
  from crm_private.public_agent_sessions session
  join crm_private.public_agent_experiences experience
    on experience.id = session.experience_id
  where experience.slug = lower(trim(p_slug))
    and experience.active
    and session.session_token_hash = p_session_token_hash
    and session.fingerprint_hash = p_fingerprint_hash;

  if not found then
    raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND';
  end if;

  select visit.*
    into visit_row
  from crm_private.public_agent_visit_state visit
  where visit.session_id = session_row.id;

  if to_regprocedure('public.get_public_agent_hold_status(text,text,text)') is not null then
    begin
      hold_value := public.get_public_agent_hold_status(
        p_slug,
        p_session_token_hash,
        p_fingerprint_hash
      );
    exception when others then
      hold_value := null;
    end;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'sessionId', session_row.id,
    'organizationId', session_row.organization_id,
    'crmRecordId', session_row.crm_record_id,
    'converted', session_row.crm_record_id is not null,
    'stage', session_row.stage,
    'profile', session_row.captured_profile,
    'contactCapture', session_row.contact_capture,
    'serviceConsented', session_row.contact_consent_at is not null,
    'marketingConsented', session_row.marketing_consent,
    'leadProtocol', case when session_row.crm_record_id is not null
      then upper(left(replace(session_row.crm_record_id::text, '-', ''), 10))
      else null end,
    'visitState', case when visit_row.session_id is not null then jsonb_strip_nulls(jsonb_build_object(
      'phase', visit_row.phase,
      'unitCode', visit_row.unit_code,
      'localDate', visit_row.local_date,
      'requestedAt', visit_row.requested_at,
      'updatedAt', visit_row.updated_at
    )) else null end,
    'holdStatus', hold_value
  ));
end
$function$;

revoke all on function public.get_public_agent_gateway_context_v1(text,text,text)
  from public, anon, authenticated;
grant execute on function public.get_public_agent_gateway_context_v1(text,text,text)
  to service_role;

create or replace function public.commit_public_agent_gateway_turn_v1(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_client_request_id uuid,
  p_user_message text,
  p_response jsonb,
  p_visit_state jsonb default null,
  p_contact_patch jsonb default '{}'::jsonb,
  p_service_consent boolean default null,
  p_marketing_consent boolean default null,
  p_consent_copy_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  session_row crm_private.public_agent_sessions%rowtype;
  stored_response jsonb;
  response_value jsonb;
  reply_value text;
  stage_value text;
  profile_value jsonb;
  turn_value jsonb;
  metadata_value jsonb;
  visit_phase text;
  visit_unit text;
  visit_date date;
begin
  perform crm_private.assert_public_agent_service_role();

  if p_client_request_id is null
     or char_length(trim(p_user_message)) not between 1 and 800
     or p_response is null
     or jsonb_typeof(p_response) <> 'object'
     or pg_column_size(p_response) > 16384
     or p_contact_patch is null
     or jsonb_typeof(p_contact_patch) <> 'object'
     or pg_column_size(p_contact_patch) > 8192 then
    raise exception 'PUBLIC_AGENT_GATEWAY_TURN_INVALID';
  end if;

  select session.*
    into session_row
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

  select request.response
    into stored_response
  from crm_private.public_agent_gateway_requests request
  where request.session_id = session_row.id
    and request.client_request_id = p_client_request_id;

  if found then
    return stored_response;
  end if;

  if p_contact_patch <> '{}'::jsonb
     or p_service_consent is not null
     or p_marketing_consent is not null then
    perform public.update_public_agent_contact_capture_v3(
      p_slug,
      p_session_token_hash,
      p_fingerprint_hash,
      p_contact_patch,
      p_service_consent,
      p_marketing_consent,
      p_consent_copy_version
    );
  end if;

  if p_visit_state is not null then
    if jsonb_typeof(p_visit_state) <> 'object' or pg_column_size(p_visit_state) > 2048 then
      raise exception 'PUBLIC_AGENT_VISIT_STATE_INVALID';
    end if;

    if coalesce((p_visit_state ->> 'clear')::boolean, false) then
      delete from crm_private.public_agent_visit_state
      where session_id = session_row.id;
    else
      visit_phase := nullif(trim(p_visit_state ->> 'phase'), '');
      visit_unit := upper(nullif(trim(p_visit_state ->> 'unitCode'), ''));
      visit_date := nullif(trim(p_visit_state ->> 'localDate'), '')::date;

      if visit_phase not in ('name','phone','consent','when','time')
         or (visit_unit is not null and visit_unit !~ '^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$') then
        raise exception 'PUBLIC_AGENT_VISIT_STATE_INVALID';
      end if;

      insert into crm_private.public_agent_visit_state(
        session_id, phase, unit_code, local_date, requested_at, updated_at
      ) values (
        session_row.id,
        visit_phase,
        visit_unit,
        visit_date,
        now(),
        now()
      )
      on conflict (session_id) do update
      set phase = excluded.phase,
          unit_code = excluded.unit_code,
          local_date = excluded.local_date,
          updated_at = now();
    end if;
  end if;

  reply_value := left(nullif(trim(p_response ->> 'reply'), ''), 1200);
  stage_value := coalesce(nullif(trim(p_response ->> 'stage'), ''), session_row.stage);
  profile_value := case
    when jsonb_typeof(p_response -> 'profile') = 'object'
      then p_response -> 'profile'
    else session_row.captured_profile
  end;

  if reply_value is null
     or stage_value not in ('welcome','discovery','qualification','contact','handoff','completed') then
    raise exception 'PUBLIC_AGENT_GATEWAY_RESPONSE_INVALID';
  end if;

  metadata_value := jsonb_strip_nulls(jsonb_build_object(
    'public_response', jsonb_strip_nulls(jsonb_build_object(
      'quickReplies', case when jsonb_typeof(p_response -> 'quickReplies') = 'array'
        then p_response -> 'quickReplies' else null end,
      'action', left(nullif(trim(p_response ->> 'action'), ''), 80),
      'selectedUnitCode', left(nullif(trim(p_response ->> 'selectedUnitCode'), ''), 80),
      'commercial', case when jsonb_typeof(p_response -> 'commercial') = 'object'
        then p_response -> 'commercial' else null end
    )),
    'gateway_deterministic', true
  ));

  if pg_column_size(metadata_value) > 8192 then
    metadata_value := jsonb_strip_nulls(jsonb_build_object(
      'public_response', jsonb_strip_nulls(jsonb_build_object(
        'quickReplies', case when jsonb_typeof(p_response -> 'quickReplies') = 'array'
          then p_response -> 'quickReplies' else null end,
        'action', left(nullif(trim(p_response ->> 'action'), ''), 80),
        'selectedUnitCode', left(nullif(trim(p_response ->> 'selectedUnitCode'), ''), 80)
      )),
      'gateway_deterministic', true
    ));
  end if;

  turn_value := public.append_public_agent_turn(
    p_slug,
    p_session_token_hash,
    p_fingerprint_hash,
    trim(p_user_message),
    reply_value,
    stage_value,
    profile_value,
    metadata_value
  );

  response_value := p_response || jsonb_build_object(
    'status', 'completed',
    'stage', turn_value ->> 'stage',
    'profile', turn_value -> 'profile',
    'converted', coalesce((turn_value ->> 'converted')::boolean, false)
  );

  insert into crm_private.public_agent_gateway_requests(
    session_id, client_request_id, response
  ) values (
    session_row.id, p_client_request_id, response_value
  );

  return response_value;
end
$function$;

revoke all on function public.commit_public_agent_gateway_turn_v1(
  text,text,text,uuid,text,jsonb,jsonb,jsonb,boolean,boolean,text
) from public, anon, authenticated;
grant execute on function public.commit_public_agent_gateway_turn_v1(
  text,text,text,uuid,text,jsonb,jsonb,jsonb,boolean,boolean,text
) to service_role;

create or replace function public.schedule_public_agent_visit_v1(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_client_action_id uuid,
  p_scheduled_at timestamptz,
  p_unit_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  session_row crm_private.public_agent_sessions%rowtype;
  experience_row crm_private.public_agent_experiences%rowtype;
  record_row public.crm_records%rowtype;
  action_row public.crm_actions%rowtype;
  unit_value text;
  owner_value uuid;
  subject_value text;
begin
  perform crm_private.assert_public_agent_service_role();

  unit_value := upper(nullif(trim(p_unit_code), ''));
  if p_client_action_id is null
     or p_scheduled_at is null
     or p_scheduled_at < now() + interval '10 minutes'
     or p_scheduled_at > now() + interval '180 days'
     or (unit_value is not null and unit_value !~ '^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$') then
    raise exception 'PUBLIC_AGENT_VISIT_INPUT_INVALID';
  end if;

  select session.*, experience.*
    into session_row, experience_row
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

  if session_row.crm_record_id is null then
    raise exception 'PUBLIC_AGENT_VISIT_CONTACT_REQUIRED';
  end if;

  select action.*
    into action_row
  from public.crm_actions action
  where action.organization_id = session_row.organization_id
    and action.crm_record_id = session_row.crm_record_id
    and action.metadata ->> 'public_agent_visit_action_id' = p_client_action_id::text
  order by action.created_at desc
  limit 1;

  if found then
    return jsonb_build_object(
      'id', action_row.id,
      'scheduledAt', action_row.scheduled_at,
      'unitCode', action_row.metadata ->> 'unit_code',
      'idempotent', true
    );
  end if;

  select record.*
    into record_row
  from public.crm_records record
  where record.organization_id = session_row.organization_id
    and record.id = session_row.crm_record_id
  for update;

  if not found then
    raise exception 'PUBLIC_AGENT_VISIT_CRM_NOT_FOUND';
  end if;

  owner_value := coalesce(
    record_row.broker_user_id,
    record_row.sdr_user_id,
    record_row.owner_user_id,
    experience_row.fallback_owner_user_id
  );
  subject_value := case when unit_value is not null
    then 'Visita comercial · ' || unit_value
    else 'Visita comercial · ' || experience_row.name
  end;

  insert into public.crm_actions(
    organization_id,
    crm_record_id,
    action_type,
    subject,
    scheduled_at,
    action_status,
    notes,
    channel,
    duration_minutes,
    assigned_to,
    metadata
  ) values (
    session_row.organization_id,
    session_row.crm_record_id,
    'visita',
    subject_value,
    p_scheduled_at,
    'pendente',
    'Visita agendada pela Bia no atendimento digital da Évora.',
    'site',
    60,
    owner_value,
    jsonb_strip_nulls(jsonb_build_object(
      'source', 'public_agent',
      'experience_slug', lower(trim(p_slug)),
      'public_agent_session_id', session_row.id,
      'public_agent_visit_action_id', p_client_action_id,
      'unit_code', unit_value
    ))
  ) returning * into action_row;

  update public.crm_records record
  set next_action_at = case
        when record.next_action_at is null then p_scheduled_at
        else least(record.next_action_at, p_scheduled_at)
      end,
      updated_at = now()
  where record.organization_id = session_row.organization_id
    and record.id = session_row.crm_record_id;

  delete from crm_private.public_agent_visit_state
  where session_id = session_row.id;

  return jsonb_build_object(
    'id', action_row.id,
    'scheduledAt', action_row.scheduled_at,
    'unitCode', unit_value,
    'assignedTo', owner_value,
    'idempotent', false
  );
end
$function$;

revoke all on function public.schedule_public_agent_visit_v1(text,text,text,uuid,timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.schedule_public_agent_visit_v1(text,text,text,uuid,timestamptz,text)
  to service_role;

commit;
