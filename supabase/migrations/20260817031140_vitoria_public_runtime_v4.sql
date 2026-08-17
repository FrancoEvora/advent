
begin;

do $preflight$
begin
  if to_regclass('crm_private.public_agent_sessions') is null
     or to_regclass('crm_private.public_agent_experiences') is null
     or to_regprocedure('crm_private.assert_public_agent_service_role()') is null
     or to_regprocedure('public.append_public_agent_turn(text,text,text,text,text,text,jsonb,jsonb)') is null
     or to_regprocedure('public.update_public_agent_contact_capture_v3(text,text,text,jsonb,boolean,boolean,text)') is null
     or to_regprocedure('public.convert_public_agent_lead(text,text,text,text,text,text,text,boolean,jsonb)') is null
     or to_regprocedure('public.request_public_agent_unit_hold(text,text,text,text,text)') is null then
    raise exception 'VITORIA_RUNTIME_V4_DEPENDENCY_MISSING';
  end if;
end
$preflight$;

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
        (p_pending_action - array['kind', 'phase', 'unitCode', 'requestedAt']::text[]) = '{}'::jsonb
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
            and p_pending_action ->> 'phase' in ('name', 'phone', 'consent', 'confirm')
            and jsonb_typeof(p_pending_action -> 'unitCode') = 'string'
            and p_pending_action ->> 'unitCode' ~ '^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$'
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
          when 'name' then p_next ->> 'phase' in ('name', 'phone', 'consent', 'confirm')
          when 'phone' then p_next ->> 'phase' in ('name', 'phone', 'consent', 'confirm')
          when 'consent' then p_next ->> 'phase' in ('name', 'phone', 'consent', 'confirm')
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
      )
    );
$function$;

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

  if jsonb_typeof(p_response -> 'attachments') = 'array' then
    for attachment_item in
      select item.value
      from jsonb_array_elements(p_response -> 'attachments') with ordinality as item(value, position)
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
          'title', coalesce(left(nullif(trim(attachment_item ->> 'title'), ''), 180), 'Arquivo'),
          'description', left(nullif(trim(attachment_item ->> 'description'), ''), 500),
          'url', attachment_url,
          'mimeType', left(nullif(trim(attachment_item ->> 'mimeType'), ''), 120),
          'badge', left(nullif(trim(attachment_item ->> 'badge'), ''), 80),
          'disclaimer', left(nullif(trim(attachment_item ->> 'disclaimer'), ''), 800)
        ))
      );
    end loop;
  end if;

  simulation_input := p_response -> 'simulation';
  if jsonb_typeof(simulation_input) = 'object' then
    if jsonb_typeof(simulation_input -> 'scenarios') = 'array' then
      for scenario_item in
        select item.value
        from jsonb_array_elements(simulation_input -> 'scenarios') with ordinality as item(value, position)
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
                when jsonb_typeof(scenario_item -> 'balloonPresentValue') = 'number'
                  then scenario_item -> 'balloonPresentValue'
                else null
              end
            ))
          );
        end if;
      end loop;
    end if;

    simulation_value := jsonb_strip_nulls(jsonb_build_object(
      'projectName', left(nullif(trim(simulation_input ->> 'projectName'), ''), 180),
      'unitCode', case
        when upper(coalesce(simulation_input ->> 'unitCode', '')) ~ '^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$'
          then upper(simulation_input ->> 'unitCode')
        else null
      end,
      'area', case when jsonb_typeof(simulation_input -> 'area') = 'number' then simulation_input -> 'area' else null end,
      'price', case when jsonb_typeof(simulation_input -> 'price') = 'number' then simulation_input -> 'price' else null end,
      'minimumDownPaymentPct', case when jsonb_typeof(simulation_input -> 'minimumDownPaymentPct') = 'number' then simulation_input -> 'minimumDownPaymentPct' else null end,
      'minimumDownPaymentApplied', case when jsonb_typeof(simulation_input -> 'minimumDownPaymentApplied') = 'boolean' then simulation_input -> 'minimumDownPaymentApplied' else null end,
      'downPaymentPct', case when jsonb_typeof(simulation_input -> 'downPaymentPct') = 'number' then simulation_input -> 'downPaymentPct' else null end,
      'downPayment', case when jsonb_typeof(simulation_input -> 'downPayment') = 'number' then simulation_input -> 'downPayment' else null end,
      'downPaymentInstallments', case when jsonb_typeof(simulation_input -> 'downPaymentInstallments') = 'number' then simulation_input -> 'downPaymentInstallments' else null end,
      'downPaymentInstallmentAmount', case when jsonb_typeof(simulation_input -> 'downPaymentInstallmentAmount') = 'number' then simulation_input -> 'downPaymentInstallmentAmount' else null end,
      'downPaymentInterestRate', case when jsonb_typeof(simulation_input -> 'downPaymentInterestRate') = 'number' then simulation_input -> 'downPaymentInterestRate' else null end,
      'balloonCount', case when jsonb_typeof(simulation_input -> 'balloonCount') = 'number' then simulation_input -> 'balloonCount' else null end,
      'balloonAmount', case when jsonb_typeof(simulation_input -> 'balloonAmount') = 'number' then simulation_input -> 'balloonAmount' else null end,
      'balloonFrequencyMonths', case when jsonb_typeof(simulation_input -> 'balloonFrequencyMonths') = 'number' then simulation_input -> 'balloonFrequencyMonths' else null end,
      'monthlyInterestRate', case when jsonb_typeof(simulation_input -> 'monthlyInterestRate') = 'number' then simulation_input -> 'monthlyInterestRate' else null end,
      'indexer', left(nullif(trim(simulation_input ->> 'indexer'), ''), 40),
      'calculationMethod', left(nullif(trim(simulation_input ->> 'calculationMethod'), ''), 40),
      'scenarios', scenarios_value,
      'generatedAt', left(nullif(trim(simulation_input ->> 'generatedAt'), ''), 40),
      'disclaimer', left(nullif(trim(simulation_input ->> 'disclaimer'), ''), 800)
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
          and (payment_draft_input ->> 'downPaymentPct')::numeric between 0 and 0.90
          then payment_draft_input -> 'downPaymentPct'
        else null
      end,
      'downPaymentInstallments', case
        when jsonb_typeof(payment_draft_input -> 'downPaymentInstallments') = 'number'
          and (payment_draft_input ->> 'downPaymentInstallments')::numeric between 1 and 24
          and mod((payment_draft_input ->> 'downPaymentInstallments')::numeric, 1) = 0
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
          and (payment_draft_input ->> 'balloonCount')::numeric between 0 and 24
          and mod((payment_draft_input ->> 'balloonCount')::numeric, 1) = 0
          then payment_draft_input -> 'balloonCount'
        else null
      end,
      'balloonAmount', case
        when jsonb_typeof(payment_draft_input -> 'balloonAmount') = 'number'
          and (payment_draft_input ->> 'balloonAmount')::numeric between 0 and 1000000000
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
    'selectedUnitCode', unit_code_value
  ));

  while pg_column_size(result_value) > 4096
        and jsonb_array_length(attachments_value) > 0 loop
    attachments_value := attachments_value - (jsonb_array_length(attachments_value) - 1);
    result_value := jsonb_strip_nulls(jsonb_build_object(
      'attachments', attachments_value,
      'simulation', simulation_value,
      'paymentDraft', payment_draft_value,
      'action', action_value,
      'selectedUnitCode', unit_code_value
    ));
  end loop;

  if pg_column_size(result_value) > 4096 and simulation_value is not null then
    simulation_value := simulation_value - 'disclaimer';
    result_value := jsonb_strip_nulls(jsonb_build_object(
      'attachments', attachments_value,
      'simulation', simulation_value,
      'paymentDraft', payment_draft_value,
      'action', action_value,
      'selectedUnitCode', unit_code_value
    ));
  end if;

  if pg_column_size(result_value) > 4096 then
    result_value := jsonb_strip_nulls(jsonb_build_object(
      'attachments', attachments_value,
      'paymentDraft', payment_draft_value,
      'action', action_value,
      'selectedUnitCode', unit_code_value
    ));
  end if;

  return result_value;
end
$function$;

create or replace function crm_private.public_agent_public_audio_metadata(
  p_audio jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  url_value text;
  mime_value text;
  duration_value numeric;
begin
  if p_audio is null or jsonb_typeof(p_audio) <> 'object' then
    return '{}'::jsonb;
  end if;
  url_value := nullif(trim(p_audio ->> 'url'), '');
  mime_value := lower(nullif(trim(p_audio ->> 'mimeType'), ''));
  duration_value := case
    when jsonb_typeof(p_audio -> 'durationSeconds') = 'number'
      then (p_audio ->> 'durationSeconds')::numeric
    else null
  end;
  if url_value is null
     or char_length(url_value) > 2048
     or url_value !~ '^https://[^[:space:]]+$'
     or mime_value not in (
       'audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg',
       'audio/wav', 'audio/x-wav'
     )
     or duration_value is null
     or duration_value <= 0
     or duration_value > 90 then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object(
    'url', url_value,
    'mimeType', mime_value,
    'durationSeconds', round(duration_value, 2)
  );
end
$function$;

revoke all on function crm_private.public_agent_pending_action_is_valid(jsonb)
  from public, anon, authenticated;
revoke all on function crm_private.public_agent_pending_transition_is_valid(jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function crm_private.public_agent_public_response_metadata(jsonb)
  from public, anon, authenticated;
revoke all on function crm_private.public_agent_public_audio_metadata(jsonb)
  from public, anon, authenticated, service_role;

create table crm_private.public_agent_requests (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references crm_private.public_agent_sessions(id) on delete cascade,
  client_request_id uuid not null,
  request_kind text not null
    check (request_kind in ('message', 'lead', 'hold', 'simulation', 'pdf', 'asset', 'transcribe')),
  payload_hash text not null
    check (payload_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'processing'
    check (status in ('processing', 'succeeded', 'failed')),
  attempts integer not null default 1
    check (attempts between 1 and 20),
  lease_token uuid not null default gen_random_uuid(),
  lease_expires_at timestamptz not null default (now() + interval '150 seconds'),
  response jsonb not null default '{}'::jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint public_agent_requests_response_check
    check (
      jsonb_typeof(response) = 'object'
      and pg_column_size(response) <= 131072
    ),
  constraint public_agent_requests_idempotency_key
    unique (session_id, client_request_id)
);

create index public_agent_requests_processing_idx
  on crm_private.public_agent_requests (lease_expires_at, session_id)
  where status = 'processing';

create index public_agent_requests_session_kind_created_idx
  on crm_private.public_agent_requests (session_id, request_kind, created_at desc);

create table crm_private.public_agent_dialog_states (
  session_id uuid primary key references crm_private.public_agent_sessions(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  pending_action jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint public_agent_dialog_states_pending_action_check
    check (
      crm_private.public_agent_pending_action_is_valid(pending_action)
    )
);

alter table crm_private.public_agent_requests enable row level security;
alter table crm_private.public_agent_dialog_states enable row level security;

revoke all on table crm_private.public_agent_requests
  from public, anon, authenticated, service_role;
revoke all on table crm_private.public_agent_dialog_states
  from public, anon, authenticated, service_role;

create or replace function public.claim_public_agent_request_v4(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_client_request_id uuid,
  p_request_kind text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  session_row crm_private.public_agent_sessions%rowtype;
  request_row crm_private.public_agent_requests%rowtype;
  dialog_row crm_private.public_agent_dialog_states%rowtype;
  payload_hash_value text;
  created_new boolean := false;
begin
  perform crm_private.assert_public_agent_service_role();

  if p_session_token_hash !~ '^[a-f0-9]{64}$'
     or p_fingerprint_hash !~ '^[a-f0-9]{64}$'
     or p_client_request_id is null
     or p_request_kind not in ('message', 'lead', 'hold', 'simulation', 'pdf', 'asset', 'transcribe')
     or p_payload is null
     or jsonb_typeof(p_payload) <> 'object'
     or pg_column_size(p_payload) > 65536 then
    raise exception 'PUBLIC_AGENT_REQUEST_INVALID';
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

  if not found then
    raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND';
  end if;
  if session_row.status in ('closed', 'blocked')
     or session_row.expires_at <= now() then
    raise exception 'PUBLIC_AGENT_SESSION_INACTIVE';
  end if;

  if not exists (
    select 1
    from crm_private.public_agent_requests
    where session_id = session_row.id
      and client_request_id = p_client_request_id
  ) then
    if p_request_kind = 'message'
       and coalesce(session_row.message_count, 0) >= 98 then
      raise exception 'PUBLIC_AGENT_RATE_LIMIT';
    end if;
    if p_request_kind = 'message' and exists (
      select 1
      from crm_private.public_agent_requests
      where session_id = session_row.id
        and request_kind = 'message'
        and status = 'processing'
        and lease_expires_at > now()
        and client_request_id <> p_client_request_id
    ) then
      raise exception 'PUBLIC_AGENT_REQUEST_IN_PROGRESS';
    end if;
    if (
      select count(*)
      from crm_private.public_agent_requests
      where session_id = session_row.id
        and request_kind = 'message'
        and created_at >= now() - interval '1 minute'
    ) >= 8 or (
      select count(*)
      from crm_private.public_agent_requests
      where session_id = session_row.id
        and request_kind = 'message'
        and created_at >= now() - interval '1 hour'
    ) >= 80 then
      raise exception 'PUBLIC_AGENT_RATE_LIMIT';
    end if;
  end if;

  insert into crm_private.public_agent_dialog_states (session_id)
  values (session_row.id)
  on conflict (session_id) do nothing;

  select * into dialog_row
  from crm_private.public_agent_dialog_states
  where session_id = session_row.id
  for update;

  payload_hash_value := encode(
    extensions.digest(convert_to(p_payload::text, 'UTF8'), 'sha256'),
    'hex'
  );

  insert into crm_private.public_agent_requests (
    session_id,
    client_request_id,
    request_kind,
    payload_hash,
    lease_expires_at
  ) values (
    session_row.id,
    p_client_request_id,
    p_request_kind,
    payload_hash_value,
    now() + case
      when p_request_kind = 'transcribe' then interval '65 seconds'
      else interval '150 seconds'
    end
  )
  on conflict (session_id, client_request_id) do nothing
  returning * into request_row;
  created_new := found;

  if not created_new then
    select * into request_row
    from crm_private.public_agent_requests
    where session_id = session_row.id
      and client_request_id = p_client_request_id
    for update;

    if request_row.request_kind <> p_request_kind
       or request_row.payload_hash <> payload_hash_value then
      raise exception 'PUBLIC_AGENT_IDEMPOTENCY_CONFLICT';
    end if;

    if request_row.status = 'succeeded' then
      return jsonb_build_object(
        'state', 'succeeded',
        'requestId', request_row.id,
        'sessionId', session_row.id,
        'revision', dialog_row.revision,
        'pendingAction', dialog_row.pending_action,
        'response', request_row.response
      );
    end if;

    if request_row.status = 'processing'
       and request_row.lease_expires_at > now() then
      return jsonb_build_object(
        'state', 'inProgress',
        'requestId', request_row.id,
        'sessionId', session_row.id,
        'revision', dialog_row.revision,
        'pendingAction', dialog_row.pending_action,
        'retryAfterMs', 1200
      );
    end if;

    if request_row.attempts >= 20 then
      raise exception 'PUBLIC_AGENT_REQUEST_RETRY_LIMIT';
    end if;

    update crm_private.public_agent_requests
    set status = 'processing',
        attempts = attempts + 1,
        lease_token = gen_random_uuid(),
        lease_expires_at = now() + case
          when p_request_kind = 'transcribe' then interval '65 seconds'
          else interval '150 seconds'
        end,
        error_code = null,
        updated_at = now()
    where id = request_row.id
    returning * into request_row;
  end if;

  return jsonb_build_object(
    'state', 'claimed',
    'requestId', request_row.id,
    'leaseToken', request_row.lease_token,
    'sessionId', session_row.id,
    'revision', dialog_row.revision,
    'pendingAction', dialog_row.pending_action
  );
end
$function$;

create or replace function public.finalize_public_agent_message_v4(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_client_request_id uuid,
  p_lease_token uuid,
  p_expected_revision bigint,
  p_source text,
  p_user_message text,
  p_response jsonb,
  p_pending_action jsonb,
  p_contact_patch jsonb,
  p_service_consent boolean,
  p_marketing_consent boolean,
  p_consent_copy_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  session_row crm_private.public_agent_sessions%rowtype;
  request_row crm_private.public_agent_requests%rowtype;
  dialog_row crm_private.public_agent_dialog_states%rowtype;
  persisted_row jsonb;
  final_response jsonb;
  reply_value text;
  stage_value text;
  profile_value jsonb;
  metadata_value jsonb;
  user_audio_value jsonb;
  public_response_value jsonb;
  persisted_metadata_value jsonb;
  payload_hash_value text;
  source_value text;
begin
  perform crm_private.assert_public_agent_service_role();

  source_value := lower(trim(coalesce(p_source, '')));

  if p_client_request_id is null
     or p_lease_token is null
     or p_expected_revision is null
     or p_expected_revision < 0
     or source_value not in ('text', 'audio')
     or char_length(trim(p_user_message)) not between 1 and 800
     or p_response is null
     or jsonb_typeof(p_response) <> 'object'
     or pg_column_size(p_response) > 98304
     or not crm_private.public_agent_pending_action_is_valid(p_pending_action)
     or p_contact_patch is null
     or jsonb_typeof(p_contact_patch) <> 'object'
     or pg_column_size(p_contact_patch) > 8192 then
    raise exception 'PUBLIC_AGENT_FINALIZE_INVALID';
  end if;

  reply_value := nullif(trim(p_response ->> 'reply'), '');
  stage_value := coalesce(nullif(trim(p_response ->> 'stage'), ''), 'discovery');
  profile_value := coalesce(p_response -> 'profile', '{}'::jsonb);
  metadata_value := coalesce(p_response -> 'metadata', '{}'::jsonb);
  user_audio_value := crm_private.public_agent_public_audio_metadata(
    metadata_value -> 'userAudio'
  );
  metadata_value := metadata_value - 'userAudio';

  if reply_value is null
     or char_length(reply_value) > 1200
     or stage_value not in ('welcome', 'discovery', 'qualification', 'contact', 'handoff', 'completed')
     or jsonb_typeof(profile_value) <> 'object'
     or jsonb_typeof(metadata_value) <> 'object'
     or pg_column_size(metadata_value) > 3072 then
    raise exception 'PUBLIC_AGENT_FINALIZE_INVALID';
  end if;

  payload_hash_value := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'message', trim(p_user_message),
          'source', source_value
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
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

  select * into request_row
  from crm_private.public_agent_requests
  where session_id = session_row.id
    and client_request_id = p_client_request_id
  for update;

  if not found or request_row.request_kind <> 'message' then
    raise exception 'PUBLIC_AGENT_REQUEST_NOT_FOUND';
  end if;

  if request_row.payload_hash <> payload_hash_value then
    raise exception 'PUBLIC_AGENT_IDEMPOTENCY_CONFLICT';
  end if;

  if request_row.status = 'succeeded' then
    return request_row.response;
  end if;
  if request_row.status <> 'processing'
     or request_row.lease_token <> p_lease_token
     or request_row.lease_expires_at <= now() then
    raise exception 'PUBLIC_AGENT_STALE_LEASE';
  end if;

  select * into dialog_row
  from crm_private.public_agent_dialog_states
  where session_id = session_row.id
  for update;

  if not found or dialog_row.revision <> p_expected_revision then
    raise exception 'PUBLIC_AGENT_REVISION_CONFLICT';
  end if;
  if not crm_private.public_agent_pending_transition_is_valid(
    dialog_row.pending_action,
    p_pending_action
  ) then
    raise exception 'PUBLIC_AGENT_PENDING_STATE_CONFLICT';
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

    select session.* into session_row
    from crm_private.public_agent_sessions session
    where session.id = session_row.id
    for update;
  end if;

  public_response_value := crm_private.public_agent_public_response_metadata(p_response);
  persisted_metadata_value := metadata_value || jsonb_build_object(
    'client_request_id', p_client_request_id,
    'runtime_contract', 'v4',
    'message_source', source_value,
    'public_response', public_response_value
  );
  if pg_column_size(persisted_metadata_value) > 8192 then
    raise exception 'PUBLIC_AGENT_FINALIZE_METADATA_INVALID';
  end if;

  persisted_row := public.append_public_agent_turn(
    p_slug,
    p_session_token_hash,
    p_fingerprint_hash,
    p_user_message,
    reply_value,
    stage_value,
    profile_value,
    persisted_metadata_value
  );

  if user_audio_value <> '{}'::jsonb then
    update crm_private.public_agent_messages
    set metadata = metadata || jsonb_build_object('public_audio', user_audio_value)
    where id = (
      select message.id
      from crm_private.public_agent_messages message
      where message.session_id = session_row.id
        and message.direction = 'user'
      order by message.created_at desc
      limit 1
    );
  end if;

  update crm_private.public_agent_dialog_states
  set revision = revision + 1,
      pending_action = p_pending_action,
      updated_at = now()
  where session_id = session_row.id
    and revision = p_expected_revision
  returning * into dialog_row;

  if not found then
    raise exception 'PUBLIC_AGENT_REVISION_CONFLICT';
  end if;

  final_response := (p_response - array['metadata', 'commercialAction']::text[]) || jsonb_build_object(
    'requestId', request_row.id,
    'clientMessageId', p_client_request_id,
    'status', 'completed',
    'revision', dialog_row.revision,
    'contactCapture', coalesce(session_row.contact_capture, '{}'::jsonb),
    'serviceConsented', session_row.contact_consent_at is not null,
    'marketingConsented', coalesce(session_row.marketing_consent, false),
    'converted', coalesce((persisted_row ->> 'converted')::boolean, false)
  );

  update crm_private.public_agent_requests
  set status = 'succeeded',
      response = final_response,
      completed_at = now(),
      lease_expires_at = now(),
      error_code = null,
      updated_at = now()
  where id = request_row.id;

  return final_response;
end
$function$;

create or replace function public.commit_public_agent_action_v4(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_client_action_id uuid,
  p_action_kind text,
  p_unit_code text,
  p_contact_patch jsonb,
  p_service_consent boolean,
  p_marketing_consent boolean,
  p_consent_copy_version text,
  p_evidence_message text,
  p_profile jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  session_row crm_private.public_agent_sessions%rowtype;
  request_row crm_private.public_agent_requests%rowtype;
  payload_value jsonb;
  payload_hash_value text;
  contact_value jsonb;
  name_value text;
  phone_value text;
  email_value text;
  city_value text;
  lead_value jsonb;
  hold_value jsonb;
  response_value jsonb;
  created_new boolean := false;
begin
  perform crm_private.assert_public_agent_service_role();

  if p_client_action_id is null
     or p_action_kind not in ('lead', 'hold')
     or (p_action_kind = 'hold' and upper(trim(coalesce(p_unit_code, ''))) !~ '^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$')
     or p_contact_patch is null
     or jsonb_typeof(p_contact_patch) <> 'object'
     or pg_column_size(p_contact_patch) > 8192
     or char_length(trim(coalesce(p_evidence_message, ''))) not between 1 and 800
     or p_profile is null
     or jsonb_typeof(p_profile) <> 'object'
     or pg_column_size(p_profile) > 32768 then
    raise exception 'PUBLIC_AGENT_ACTION_INVALID';
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

  if not found then
    raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND';
  end if;
  if session_row.status in ('closed', 'blocked')
     or session_row.expires_at <= now() then
    raise exception 'PUBLIC_AGENT_SESSION_INACTIVE';
  end if;

  payload_value := jsonb_strip_nulls(jsonb_build_object(
    'actionKind', p_action_kind,
    'unitCode', case when p_action_kind = 'hold' then upper(trim(p_unit_code)) else null end,
    'contactPatch', p_contact_patch,
    'serviceConsent', p_service_consent,
    'marketingConsent', p_marketing_consent,
    'consentCopyVersion', p_consent_copy_version,
    'evidenceHash', encode(
      extensions.digest(convert_to(trim(p_evidence_message), 'UTF8'), 'sha256'),
      'hex'
    ),
    'profile', p_profile
  ));
  payload_hash_value := encode(
    extensions.digest(convert_to(payload_value::text, 'UTF8'), 'sha256'),
    'hex'
  );

  insert into crm_private.public_agent_requests (
    session_id,
    client_request_id,
    request_kind,
    payload_hash
  ) values (
    session_row.id,
    p_client_action_id,
    p_action_kind,
    payload_hash_value
  )
  on conflict (session_id, client_request_id) do nothing
  returning * into request_row;
  created_new := found;

  if not created_new then
    select * into request_row
    from crm_private.public_agent_requests
    where session_id = session_row.id
      and client_request_id = p_client_action_id
    for update;

    if request_row.request_kind <> p_action_kind
       or request_row.payload_hash <> payload_hash_value then
      raise exception 'PUBLIC_AGENT_IDEMPOTENCY_CONFLICT';
    end if;
    if request_row.status = 'succeeded' then
      return request_row.response;
    end if;
    if request_row.status = 'processing'
       and request_row.lease_expires_at > now() then
      return jsonb_build_object(
        'status', 'processing',
        'requestId', request_row.id,
        'retryAfterMs', 1200
      );
    end if;
    if request_row.attempts >= 20 then
      raise exception 'PUBLIC_AGENT_REQUEST_RETRY_LIMIT';
    end if;
    update crm_private.public_agent_requests
    set status = 'processing',
        attempts = attempts + 1,
        lease_token = gen_random_uuid(),
        lease_expires_at = now() + interval '150 seconds',
        error_code = null,
        updated_at = now()
    where id = request_row.id
    returning * into request_row;
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

    select session.* into session_row
    from crm_private.public_agent_sessions session
    where session.id = session_row.id
    for update;
  end if;

  contact_value := coalesce(session_row.contact_capture, '{}'::jsonb);
  name_value := nullif(trim(contact_value ->> 'name'), '');
  phone_value := nullif(trim(contact_value ->> 'phone'), '');
  email_value := nullif(trim(contact_value ->> 'email'), '');
  city_value := nullif(trim(contact_value ->> 'city'), '');

  if session_row.contact_consent_at is null
     or nullif(trim(session_row.consent_copy_version), '') is null then
    raise exception 'PUBLIC_AGENT_CONSENT_REQUIRED';
  end if;
  if name_value is null
     or char_length(name_value) < 2
     or phone_value !~ '^[+][1-9][0-9]{7,14}$' then
    raise exception 'PUBLIC_AGENT_CONTACT_REQUIRED';
  end if;

  lead_value := public.convert_public_agent_lead(
    p_slug,
    p_session_token_hash,
    p_fingerprint_hash,
    name_value,
    phone_value,
    email_value,
    city_value,
    coalesce(session_row.marketing_consent, false),
    p_profile
  );

  if p_action_kind = 'hold' then
    hold_value := public.request_public_agent_unit_hold(
      p_slug,
      p_session_token_hash,
      p_fingerprint_hash,
      upper(trim(p_unit_code)),
      name_value
    );
  end if;

  response_value := jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'status', 'completed',
    'requestId', request_row.id,
    'actionKind', p_action_kind,
    'lead', lead_value,
    'hold', hold_value
  ));

  update crm_private.public_agent_requests
  set status = 'succeeded',
      response = response_value,
      completed_at = now(),
      lease_expires_at = now(),
      error_code = null,
      updated_at = now()
  where id = request_row.id;

  return response_value;
end
$function$;

create or replace function public.commit_public_agent_action_message_v4(
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
  message_request crm_private.public_agent_requests%rowtype;
  dialog_row crm_private.public_agent_dialog_states%rowtype;
  operation_value jsonb;
  lead_value jsonb;
  hold_value jsonb;
  hold_unit jsonb;
  contact_value jsonb;
  name_value text;
  first_name_value text;
  protocol_value text;
  requested_unit_value text;
  snapshot_unit_value text;
  actual_unit_value text;
  expires_value text;
  reply_value text;
  stage_value text;
  action_value text;
  final_response jsonb;
  metadata_value jsonb;
  user_audio_value jsonb;
  public_response_value jsonb;
  persisted_metadata_value jsonb;
  payload_hash_value text;
  source_value text;
begin
  perform crm_private.assert_public_agent_service_role();

  source_value := lower(trim(coalesce(p_source, '')));
  metadata_value := coalesce(p_response -> 'metadata', '{}'::jsonb);
  user_audio_value := crm_private.public_agent_public_audio_metadata(
    metadata_value -> 'userAudio'
  );
  metadata_value := metadata_value - 'userAudio';

  if p_client_request_id is null
     or p_lease_token is null
     or p_expected_revision is null
     or p_expected_revision < 0
     or source_value not in ('text', 'audio')
     or p_client_action_id is null
     or p_action_kind not in ('lead', 'hold')
     or (
       p_action_kind = 'lead'
       and nullif(trim(coalesce(p_unit_code, '')), '') is not null
     )
     or char_length(trim(coalesce(p_user_message, ''))) not between 1 and 800
     or p_response is null
     or jsonb_typeof(p_response) <> 'object'
     or pg_column_size(p_response) > 98304
     or jsonb_typeof(metadata_value) <> 'object'
     or pg_column_size(metadata_value) > 3072 then
    raise exception 'PUBLIC_AGENT_ACTION_MESSAGE_INVALID';
  end if;

  payload_hash_value := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'message', trim(p_user_message),
          'source', source_value
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
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

  select * into message_request
  from crm_private.public_agent_requests
  where session_id = session_row.id
    and client_request_id = p_client_request_id
  for update;

  if not found or message_request.request_kind <> 'message' then
    raise exception 'PUBLIC_AGENT_REQUEST_NOT_FOUND';
  end if;
  if message_request.payload_hash <> payload_hash_value then
    raise exception 'PUBLIC_AGENT_IDEMPOTENCY_CONFLICT';
  end if;
  if message_request.status = 'succeeded' then
    return message_request.response;
  end if;
  if message_request.status <> 'processing'
     or message_request.lease_token <> p_lease_token
     or message_request.lease_expires_at <= now() then
    raise exception 'PUBLIC_AGENT_STALE_LEASE';
  end if;

  select * into dialog_row
  from crm_private.public_agent_dialog_states
  where session_id = session_row.id
  for update;

  if not found or dialog_row.revision <> p_expected_revision then
    raise exception 'PUBLIC_AGENT_REVISION_CONFLICT';
  end if;

  if p_action_kind = 'hold' then
    if dialog_row.pending_action ->> 'kind' is distinct from 'hold'
       or dialog_row.pending_action ->> 'phase' is distinct from 'confirm'
       or dialog_row.pending_action ->> 'unitCode' is distinct from upper(trim(p_unit_code)) then
      raise exception 'PUBLIC_AGENT_PENDING_STATE_CONFLICT';
    end if;
  elsif dialog_row.pending_action <> '{}'::jsonb
        and (
          dialog_row.pending_action ->> 'kind' <> 'lead'
          or dialog_row.pending_action ->> 'phase' not in ('name', 'phone', 'consent')
          or (
            dialog_row.pending_action ? 'unitCode'
            and dialog_row.pending_action -> 'unitCode' <> 'null'::jsonb
          )
        ) then
    raise exception 'PUBLIC_AGENT_PENDING_STATE_CONFLICT';
  end if;

  operation_value := public.commit_public_agent_action_v4(
    p_slug,
    p_session_token_hash,
    p_fingerprint_hash,
    p_client_action_id,
    p_action_kind,
    p_unit_code,
    p_contact_patch,
    p_service_consent,
    p_marketing_consent,
    p_consent_copy_version,
    p_user_message,
    p_profile
  );

  if operation_value ->> 'status' = 'processing' then
    raise exception 'PUBLIC_AGENT_ACTION_IN_PROGRESS';
  end if;

  lead_value := coalesce(operation_value -> 'lead', '{}'::jsonb);
  hold_value := coalesce(operation_value -> 'hold', '{}'::jsonb);
  hold_unit := coalesce(hold_value -> 'unit', '{}'::jsonb);

  select session.* into session_row
  from crm_private.public_agent_sessions session
  where session.id = session_row.id
  for update;

  contact_value := coalesce(session_row.contact_capture, '{}'::jsonb);
  name_value := coalesce(nullif(trim(contact_value ->> 'name'), ''), 'Cliente');
  first_name_value := split_part(name_value, ' ', 1);
  protocol_value := nullif(trim(lead_value ->> 'protocol'), '');

  if p_action_kind = 'lead' then
    reply_value := 'Pronto, ' || first_name_value || '. Seu atendimento foi registrado'
      || case when protocol_value is not null then ' com o protocolo ' || protocol_value else '' end
      || '. A equipe receberá o contexto da conversa.';
    stage_value := 'completed';
    action_value := 'none';
  else
    requested_unit_value := upper(trim(p_unit_code));
    snapshot_unit_value := coalesce(
      nullif(upper(trim(hold_unit ->> 'unitCode')), ''),
      nullif(upper(trim(hold_unit ->> 'unit_code')), '')
    );
    if snapshot_unit_value !~ '^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$' then
      snapshot_unit_value := null;
    end if;
    actual_unit_value := coalesce(snapshot_unit_value, requested_unit_value);
    expires_value := nullif(trim(hold_value ->> 'expiresAt'), '');
    if coalesce((hold_value ->> 'alreadyActive')::boolean, false)
       and snapshot_unit_value is null then
      reply_value := 'Você já possui um bloqueio ativo nesta conversa. Não executei um novo bloqueio. Consulte o status para confirmar a unidade e o protocolo.';
      actual_unit_value := null;
    elsif coalesce((hold_value ->> 'alreadyActive')::boolean, false)
       and actual_unit_value <> requested_unit_value then
      reply_value := 'Você já possui um bloqueio ativo no lote ' || actual_unit_value
        || '. Não bloqueei o lote ' || requested_unit_value
        || case when nullif(trim(hold_value ->> 'protocol'), '') is not null
          then '. O protocolo atual é ' || trim(hold_value ->> 'protocol')
          else '' end || '.';
    else
      reply_value := 'Pronto. Bloqueei temporariamente o lote ' || actual_unit_value
        || case when nullif(trim(hold_value ->> 'protocol'), '') is not null
          then ' com o protocolo ' || trim(hold_value ->> 'protocol')
          else '' end
        || '. O pedido está pendente de aprovação administrativa'
        || case when expires_value is not null then ' e vale até ' || expires_value else '' end
        || '.';
    end if;
    stage_value := 'handoff';
    action_value := 'hold_status';
  end if;

  public_response_value := crm_private.public_agent_public_response_metadata(
    (p_response - array['commercialAction', 'action', 'selectedUnitCode']::text[])
    || jsonb_build_object(
      'action', action_value,
      'selectedUnitCode', case
        when p_action_kind = 'hold' then actual_unit_value
        else null
      end
    )
  );
  persisted_metadata_value := metadata_value || jsonb_build_object(
    'client_request_id', p_client_request_id,
    'client_action_id', p_client_action_id,
    'runtime_contract', 'v4',
    'commercial_action', p_action_kind,
    'message_source', source_value,
    'public_response', public_response_value
  );
  if pg_column_size(persisted_metadata_value) > 8192 then
    raise exception 'PUBLIC_AGENT_ACTION_MESSAGE_METADATA_INVALID';
  end if;

  perform public.append_public_agent_turn(
    p_slug,
    p_session_token_hash,
    p_fingerprint_hash,
    trim(p_user_message),
    reply_value,
    stage_value,
    p_profile,
    persisted_metadata_value
  );

  if user_audio_value <> '{}'::jsonb then
    update crm_private.public_agent_messages
    set metadata = metadata || jsonb_build_object('public_audio', user_audio_value)
    where id = (
      select message.id
      from crm_private.public_agent_messages message
      where message.session_id = session_row.id
        and message.direction = 'user'
      order by message.created_at desc
      limit 1
    );
  end if;

  update crm_private.public_agent_dialog_states
  set revision = revision + 1,
      pending_action = '{}'::jsonb,
      updated_at = now()
  where session_id = session_row.id
    and revision = p_expected_revision
  returning * into dialog_row;

  if not found then
    raise exception 'PUBLIC_AGENT_REVISION_CONFLICT';
  end if;

  final_response := (p_response - array['metadata', 'commercialAction']::text[]) || jsonb_strip_nulls(jsonb_build_object(
    'reply', reply_value,
    'stage', stage_value,
    'action', action_value,
    'selectedUnitCode', case when p_action_kind = 'hold' then actual_unit_value else null end,
    'contactCapture', contact_value,
    'serviceConsented', session_row.contact_consent_at is not null,
    'marketingConsented', coalesce(session_row.marketing_consent, false),
    'requestContact', false,
    'handoffRequested', p_action_kind = 'hold',
    'quickReplies', case when p_action_kind = 'hold'
      then jsonb_build_array('Consultar status', 'Continuar conversando')
      else jsonb_build_array('Continuar conversando') end,
    'holdStatus', case when p_action_kind = 'hold' then hold_value else null end,
    'converted', true,
    'leadProtocol', protocol_value,
    'requestId', message_request.id,
    'clientMessageId', p_client_request_id,
    'status', 'completed',
    'revision', dialog_row.revision
  ));

  update crm_private.public_agent_requests
  set status = 'succeeded',
      response = final_response,
      completed_at = now(),
      lease_expires_at = now(),
      error_code = null,
      updated_at = now()
  where id = message_request.id;

  return final_response;
end
$function$;

create or replace function public.complete_public_agent_request_v4(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_client_request_id uuid,
  p_lease_token uuid,
  p_request_kind text,
  p_payload jsonb,
  p_response jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  session_row crm_private.public_agent_sessions%rowtype;
  request_row crm_private.public_agent_requests%rowtype;
  payload_hash_value text;
  final_response jsonb;
begin
  perform crm_private.assert_public_agent_service_role();

  if p_client_request_id is null
     or p_lease_token is null
     or p_request_kind not in ('transcribe', 'simulation', 'pdf', 'asset')
     or p_payload is null
     or jsonb_typeof(p_payload) <> 'object'
     or pg_column_size(p_payload) > 65536
     or p_response is null
     or jsonb_typeof(p_response) <> 'object'
     or pg_column_size(p_response) > 98304 then
    raise exception 'PUBLIC_AGENT_REQUEST_COMPLETE_INVALID';
  end if;

  payload_hash_value := encode(
    extensions.digest(convert_to(p_payload::text, 'UTF8'), 'sha256'),
    'hex'
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

  select * into request_row
  from crm_private.public_agent_requests
  where session_id = session_row.id
    and client_request_id = p_client_request_id
  for update;

  if not found or request_row.request_kind <> p_request_kind then
    raise exception 'PUBLIC_AGENT_REQUEST_NOT_FOUND';
  end if;
  if request_row.payload_hash <> payload_hash_value then
    raise exception 'PUBLIC_AGENT_IDEMPOTENCY_CONFLICT';
  end if;
  if request_row.status = 'succeeded' then
    return request_row.response;
  end if;
  if request_row.status <> 'processing'
     or request_row.lease_token <> p_lease_token
     or request_row.lease_expires_at <= now() then
    raise exception 'PUBLIC_AGENT_STALE_LEASE';
  end if;

  final_response := p_response || jsonb_build_object(
    'requestId', request_row.id,
    'clientRequestId', p_client_request_id,
    'requestKind', p_request_kind,
    'status', 'completed'
  );
  if pg_column_size(final_response) > 131072 then
    raise exception 'PUBLIC_AGENT_REQUEST_COMPLETE_INVALID';
  end if;

  update crm_private.public_agent_requests
  set status = 'succeeded',
      response = final_response,
      completed_at = now(),
      lease_expires_at = now(),
      error_code = null,
      updated_at = now()
  where id = request_row.id;

  return final_response;
end
$function$;

create or replace function public.fail_public_agent_request_v4(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_client_request_id uuid,
  p_lease_token uuid,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  session_row crm_private.public_agent_sessions%rowtype;
  request_row crm_private.public_agent_requests%rowtype;
begin
  perform crm_private.assert_public_agent_service_role();

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

  select * into request_row
  from crm_private.public_agent_requests
  where session_id = session_row.id
    and client_request_id = p_client_request_id
  for update;

  if not found then
    raise exception 'PUBLIC_AGENT_REQUEST_NOT_FOUND';
  end if;

  if request_row.status <> 'succeeded'
     and request_row.status = 'processing'
     and request_row.lease_token = p_lease_token then
    update crm_private.public_agent_requests
    set status = 'failed',
        error_code = left(
          regexp_replace(
            upper(coalesce(p_error_code, 'PUBLIC_AGENT_REQUEST_FAILED')),
            '[^A-Z0-9_]',
            '',
            'g'
          ),
          120
        ),
        lease_expires_at = now(),
        updated_at = now()
    where id = request_row.id
    returning * into request_row;
  end if;

  return jsonb_build_object(
    'requestId', request_row.id,
    'status', request_row.status
  );
end
$function$;

create or replace function public.get_public_agent_request_response_v4(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_client_request_id uuid,
  p_request_kind text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  session_row crm_private.public_agent_sessions%rowtype;
  request_row crm_private.public_agent_requests%rowtype;
begin
  perform crm_private.assert_public_agent_service_role();
  if p_client_request_id is null or p_request_kind <> 'transcribe' then
    raise exception 'PUBLIC_AGENT_REQUEST_INVALID';
  end if;
  select session.* into session_row
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
  select request.* into request_row
  from crm_private.public_agent_requests request
  where request.session_id = session_row.id
    and request.client_request_id = p_client_request_id
    and request.request_kind = p_request_kind;
  if not found or request_row.status <> 'succeeded' then
    raise exception 'PUBLIC_AGENT_REQUEST_NOT_FOUND';
  end if;
  return request_row.response;
end
$function$;

revoke all on function public.claim_public_agent_request_v4(text, text, text, uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.finalize_public_agent_message_v4(text, text, text, uuid, uuid, bigint, text, text, jsonb, jsonb, jsonb, boolean, boolean, text)
  from public, anon, authenticated;
revoke all on function public.commit_public_agent_action_v4(text, text, text, uuid, text, text, jsonb, boolean, boolean, text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.commit_public_agent_action_message_v4(text, text, text, uuid, uuid, bigint, text, uuid, text, text, jsonb, boolean, boolean, text, text, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.complete_public_agent_request_v4(text, text, text, uuid, uuid, text, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.fail_public_agent_request_v4(text, text, text, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.get_public_agent_request_response_v4(text, text, text, uuid, text)
  from public, anon, authenticated;

grant execute on function public.claim_public_agent_request_v4(text, text, text, uuid, text, jsonb)
  to service_role;
grant execute on function public.finalize_public_agent_message_v4(text, text, text, uuid, uuid, bigint, text, text, jsonb, jsonb, jsonb, boolean, boolean, text)
  to service_role;
grant execute on function public.commit_public_agent_action_message_v4(text, text, text, uuid, uuid, bigint, text, uuid, text, text, jsonb, boolean, boolean, text, text, jsonb, jsonb)
  to service_role;
grant execute on function public.complete_public_agent_request_v4(text, text, text, uuid, uuid, text, jsonb, jsonb)
  to service_role;
grant execute on function public.fail_public_agent_request_v4(text, text, text, uuid, uuid, text)
  to service_role;
grant execute on function public.get_public_agent_request_response_v4(text, text, text, uuid, text)
  to service_role;

comment on table crm_private.public_agent_requests is
  'Recibos idempotentes do runtime público da Vitória; acesso somente por RPC service-role.';
comment on table crm_private.public_agent_dialog_states is
  'Estado conversacional canônico e pendências comerciais da Vitória por sessão pública.';

commit;
