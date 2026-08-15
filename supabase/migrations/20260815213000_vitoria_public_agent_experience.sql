begin;

create schema if not exists crm_private;

create table if not exists crm_private.public_agent_experiences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  slug text not null,
  project_id uuid not null,
  product_id uuid,
  pipeline_id uuid not null,
  initial_stage_id uuid not null,
  lead_source_id uuid not null,
  team_id uuid,
  fallback_owner_user_id uuid not null,
  assignment_role text not null default 'sdr',
  active boolean not null default true,
  name text not null,
  agent_name text not null default 'Vitória',
  title text not null,
  subtitle text not null,
  eyebrow text not null default 'Atendimento inteligente',
  hero_image_url text,
  first_contact_sla_minutes integer not null default 60,
  knowledge jsonb not null default '{}'::jsonb,
  theme jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint public_agent_experiences_slug_key unique (slug),
  constraint public_agent_experiences_slug_check check (
    slug = lower(trim(slug))
    and slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'
  ),
  constraint public_agent_experiences_assignment_role_check check (
    assignment_role in ('sdr', 'broker')
  ),
  constraint public_agent_experiences_sla_check check (
    first_contact_sla_minutes between 5 and 1440
  ),
  constraint public_agent_experiences_knowledge_check check (
    jsonb_typeof(knowledge) = 'object' and pg_column_size(knowledge) <= 65536
  ),
  constraint public_agent_experiences_theme_check check (
    jsonb_typeof(theme) = 'object' and pg_column_size(theme) <= 32768
  ),
  constraint public_agent_experiences_org_project_fk foreign key (
    organization_id, project_id
  ) references public.projects(organization_id, id) on delete restrict,
  constraint public_agent_experiences_org_product_fk foreign key (
    organization_id, project_id, product_id
  ) references public.crm_products(organization_id, project_id, id) on delete restrict,
  constraint public_agent_experiences_org_pipeline_fk foreign key (
    organization_id, pipeline_id
  ) references public.crm_pipelines(organization_id, id) on delete restrict,
  constraint public_agent_experiences_org_stage_fk foreign key (
    organization_id, initial_stage_id
  ) references public.crm_stages(organization_id, id) on delete restrict,
  constraint public_agent_experiences_org_source_fk foreign key (
    organization_id, lead_source_id
  ) references public.crm_lead_sources(organization_id, id) on delete restrict,
  constraint public_agent_experiences_org_team_fk foreign key (
    organization_id, team_id
  ) references public.crm_teams(organization_id, id) on delete restrict,
  constraint public_agent_experiences_org_owner_fk foreign key (
    organization_id, fallback_owner_user_id
  ) references public.organization_members(organization_id, user_id) on delete restrict
);

create table if not exists crm_private.public_agent_sessions (
  id uuid primary key default gen_random_uuid(),
  experience_id uuid not null references crm_private.public_agent_experiences(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  session_token_hash text not null unique,
  fingerprint_hash text not null,
  status text not null default 'active',
  stage text not null default 'welcome',
  utm jsonb not null default '{}'::jsonb,
  landing_page text,
  referrer text,
  user_agent text,
  captured_profile jsonb not null default '{}'::jsonb,
  marketing_consent boolean not null default false,
  contact_id uuid,
  crm_record_id uuid,
  conversation_id uuid,
  message_count integer not null default 0,
  last_activity_at timestamptz not null default now(),
  converted_at timestamptz,
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint public_agent_sessions_token_hash_check check (
    session_token_hash ~ '^[a-f0-9]{64}$'
  ),
  constraint public_agent_sessions_fingerprint_hash_check check (
    fingerprint_hash ~ '^[a-f0-9]{64}$'
  ),
  constraint public_agent_sessions_status_check check (
    status in ('active', 'converted', 'closed', 'blocked')
  ),
  constraint public_agent_sessions_stage_check check (
    stage in ('welcome', 'discovery', 'qualification', 'contact', 'handoff', 'completed')
  ),
  constraint public_agent_sessions_utm_check check (
    jsonb_typeof(utm) = 'object' and pg_column_size(utm) <= 16384
  ),
  constraint public_agent_sessions_profile_check check (
    jsonb_typeof(captured_profile) = 'object'
    and pg_column_size(captured_profile) <= 32768
  ),
  constraint public_agent_sessions_message_count_check check (
    message_count between 0 and 200
  ),
  constraint public_agent_sessions_org_contact_fk foreign key (
    organization_id, contact_id
  ) references public.contacts(organization_id, id) on delete set null,
  constraint public_agent_sessions_org_record_fk foreign key (
    organization_id, crm_record_id
  ) references public.crm_records(organization_id, id) on delete set null,
  constraint public_agent_sessions_org_conversation_fk foreign key (
    organization_id, conversation_id
  ) references public.crm_conversations(organization_id, id) on delete set null
);

create table if not exists crm_private.public_agent_messages (
  id bigint generated always as identity primary key,
  session_id uuid not null references crm_private.public_agent_sessions(id) on delete cascade,
  direction text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint public_agent_messages_direction_check check (
    direction in ('user', 'assistant', 'system')
  ),
  constraint public_agent_messages_content_check check (
    char_length(content) between 1 and 4000
  ),
  constraint public_agent_messages_metadata_check check (
    jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 16384
  )
);

create index if not exists public_agent_sessions_experience_activity_idx
  on crm_private.public_agent_sessions(experience_id, last_activity_at desc);
create index if not exists public_agent_sessions_fingerprint_created_idx
  on crm_private.public_agent_sessions(fingerprint_hash, created_at desc);
create index if not exists public_agent_sessions_record_idx
  on crm_private.public_agent_sessions(organization_id, crm_record_id)
  where crm_record_id is not null;
create index if not exists public_agent_messages_session_created_idx
  on crm_private.public_agent_messages(session_id, created_at, id);

alter table crm_private.public_agent_experiences enable row level security;
alter table crm_private.public_agent_sessions enable row level security;
alter table crm_private.public_agent_messages enable row level security;

revoke all on crm_private.public_agent_experiences from public, anon, authenticated;
revoke all on crm_private.public_agent_sessions from public, anon, authenticated;
revoke all on crm_private.public_agent_messages from public, anon, authenticated;

create or replace function crm_private.assert_public_agent_service_role()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'PUBLIC_AGENT_FORBIDDEN';
  end if;
end
$function$;

create or replace function public.get_public_agent_experience(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  experience_row crm_private.public_agent_experiences%rowtype;
begin
  perform crm_private.assert_public_agent_service_role();

  select experience.* into experience_row
  from crm_private.public_agent_experiences experience
  where experience.slug = lower(trim(p_slug))
    and experience.active;

  if not found then
    raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND';
  end if;

  return jsonb_build_object(
    'slug', experience_row.slug,
    'name', experience_row.name,
    'agentName', experience_row.agent_name,
    'title', experience_row.title,
    'subtitle', experience_row.subtitle,
    'eyebrow', experience_row.eyebrow,
    'heroImageUrl', experience_row.hero_image_url,
    'theme', experience_row.theme
  );
end
$function$;

create or replace function public.open_public_agent_session(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_utm jsonb default '{}'::jsonb,
  p_landing_page text default null,
  p_referrer text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  experience_row crm_private.public_agent_experiences%rowtype;
  session_row crm_private.public_agent_sessions%rowtype;
  recent_session_count integer;
  transcript jsonb;
begin
  perform crm_private.assert_public_agent_service_role();

  if p_session_token_hash !~ '^[a-f0-9]{64}$'
     or p_fingerprint_hash !~ '^[a-f0-9]{64}$'
     or p_utm is null
     or jsonb_typeof(p_utm) <> 'object'
     or pg_column_size(p_utm) > 16384 then
    raise exception 'PUBLIC_AGENT_SESSION_INPUT_INVALID';
  end if;

  select experience.* into experience_row
  from crm_private.public_agent_experiences experience
  where experience.slug = lower(trim(p_slug))
    and experience.active
  for share;

  if not found then
    raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND';
  end if;

  select session.* into session_row
  from crm_private.public_agent_sessions session
  where session.experience_id = experience_row.id
    and session.session_token_hash = p_session_token_hash;

  if not found then
    select count(*) into recent_session_count
    from crm_private.public_agent_sessions session
    where session.fingerprint_hash = p_fingerprint_hash
      and session.created_at >= now() - interval '24 hours';

    if recent_session_count >= 12 then
      raise exception 'PUBLIC_AGENT_SESSION_RATE_LIMIT';
    end if;

    insert into crm_private.public_agent_sessions (
      experience_id,
      organization_id,
      session_token_hash,
      fingerprint_hash,
      utm,
      landing_page,
      referrer,
      user_agent
    ) values (
      experience_row.id,
      experience_row.organization_id,
      p_session_token_hash,
      p_fingerprint_hash,
      jsonb_strip_nulls(p_utm),
      left(nullif(trim(p_landing_page), ''), 1000),
      left(nullif(trim(p_referrer), ''), 1000),
      left(nullif(trim(p_user_agent), ''), 1000)
    ) returning * into session_row;
  else
    update crm_private.public_agent_sessions
    set last_activity_at = now(),
        updated_at = now(),
        utm = case
          when session_row.utm = '{}'::jsonb then jsonb_strip_nulls(p_utm)
          else session_row.utm
        end
    where id = session_row.id
    returning * into session_row;
  end if;

  select coalesce(jsonb_agg(message_row order by message_row.created_at, message_row.id), '[]'::jsonb)
  into transcript
  from (
    select message.id,
           message.direction,
           message.content,
           message.created_at
    from crm_private.public_agent_messages message
    where message.session_id = session_row.id
    order by message.created_at desc, message.id desc
    limit 30
  ) message_row;

  return jsonb_build_object(
    'sessionId', session_row.id,
    'stage', session_row.stage,
    'profile', session_row.captured_profile,
    'converted', session_row.crm_record_id is not null,
    'leadProtocol', case
      when session_row.crm_record_id is null then null
      else upper(left(replace(session_row.crm_record_id::text, '-', ''), 10))
    end,
    'experience', jsonb_build_object(
      'slug', experience_row.slug,
      'name', experience_row.name,
      'agentName', experience_row.agent_name,
      'title', experience_row.title,
      'subtitle', experience_row.subtitle,
      'eyebrow', experience_row.eyebrow,
      'heroImageUrl', experience_row.hero_image_url,
      'theme', experience_row.theme
    ),
    'messages', transcript
  );
end
$function$;

create or replace function public.get_public_agent_context(
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
  experience_row crm_private.public_agent_experiences%rowtype;
  session_row crm_private.public_agent_sessions%rowtype;
  minute_count integer;
  hour_count integer;
  transcript jsonb;
begin
  perform crm_private.assert_public_agent_service_role();

  select experience.*, session.*
  into experience_row, session_row
  from crm_private.public_agent_experiences experience
  join crm_private.public_agent_sessions session
    on session.experience_id = experience.id
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

  select count(*) filter (where message.created_at >= now() - interval '1 minute'),
         count(*) filter (where message.created_at >= now() - interval '1 hour')
  into minute_count, hour_count
  from crm_private.public_agent_messages message
  where message.session_id = session_row.id
    and message.direction = 'user';

  if minute_count >= 5 or hour_count >= 30 or session_row.message_count >= 100 then
    raise exception 'PUBLIC_AGENT_MESSAGE_RATE_LIMIT';
  end if;

  update crm_private.public_agent_sessions
  set last_activity_at = now(), updated_at = now()
  where id = session_row.id;

  select coalesce(jsonb_agg(message_row order by message_row.created_at, message_row.id), '[]'::jsonb)
  into transcript
  from (
    select message.id,
           message.direction,
           message.content,
           message.created_at
    from crm_private.public_agent_messages message
    where message.session_id = session_row.id
    order by message.created_at desc, message.id desc
    limit 24
  ) message_row;

  return jsonb_build_object(
    'organizationId', experience_row.organization_id,
    'sessionId', session_row.id,
    'stage', session_row.stage,
    'profile', session_row.captured_profile,
    'converted', session_row.crm_record_id is not null,
    'knowledge', experience_row.knowledge,
    'experience', jsonb_build_object(
      'slug', experience_row.slug,
      'name', experience_row.name,
      'agentName', experience_row.agent_name,
      'title', experience_row.title,
      'subtitle', experience_row.subtitle,
      'theme', experience_row.theme
    ),
    'messages', transcript
  );
end
$function$;

create or replace function public.append_public_agent_turn(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_user_message text,
  p_assistant_message text,
  p_stage text,
  p_profile jsonb default '{}'::jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  experience_row crm_private.public_agent_experiences%rowtype;
  session_row crm_private.public_agent_sessions%rowtype;
  conversation_key uuid;
  now_value timestamptz := now();
begin
  perform crm_private.assert_public_agent_service_role();

  if char_length(trim(p_user_message)) not between 1 and 800
     or char_length(trim(p_assistant_message)) not between 1 and 1200
     or p_stage not in ('welcome', 'discovery', 'qualification', 'contact', 'handoff', 'completed')
     or p_profile is null
     or jsonb_typeof(p_profile) <> 'object'
     or pg_column_size(p_profile) > 16384
     or p_metadata is null
     or jsonb_typeof(p_metadata) <> 'object'
     or pg_column_size(p_metadata) > 8192 then
    raise exception 'PUBLIC_AGENT_TURN_INPUT_INVALID';
  end if;

  select experience.*, session.*
  into experience_row, session_row
  from crm_private.public_agent_experiences experience
  join crm_private.public_agent_sessions session
    on session.experience_id = experience.id
  where experience.slug = lower(trim(p_slug))
    and experience.active
    and session.session_token_hash = p_session_token_hash
    and session.fingerprint_hash = p_fingerprint_hash
  for update of session;

  if not found then
    raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND';
  end if;

  if session_row.status in ('closed', 'blocked')
     or session_row.expires_at <= now_value
     or session_row.message_count > 98 then
    raise exception 'PUBLIC_AGENT_SESSION_INACTIVE';
  end if;

  insert into crm_private.public_agent_messages (
    session_id, direction, content, metadata, created_at
  ) values
    (session_row.id, 'user', trim(p_user_message), '{}'::jsonb, now_value),
    (session_row.id, 'assistant', trim(p_assistant_message), p_metadata, now_value + interval '1 millisecond');

  update crm_private.public_agent_sessions
  set stage = p_stage,
      captured_profile = captured_profile || jsonb_strip_nulls(p_profile),
      message_count = message_count + 2,
      last_activity_at = now_value,
      updated_at = now_value
  where id = session_row.id
  returning * into session_row;

  if session_row.crm_record_id is not null then
    select conversation.id into conversation_key
    from public.crm_conversations conversation
    where conversation.organization_id = session_row.organization_id
      and conversation.crm_record_id = session_row.crm_record_id
      and conversation.channel = 'site';

    if conversation_key is not null then
      insert into public.crm_messages (
        organization_id,
        conversation_id,
        crm_record_id,
        direction,
        actor_type,
        channel,
        content,
        delivery_status,
        metadata,
        occurred_at
      ) values
        (
          session_row.organization_id,
          conversation_key,
          session_row.crm_record_id,
          'inbound',
          'lead',
          'site',
          trim(p_user_message),
          'delivered',
          jsonb_build_object('public_agent_session_id', session_row.id),
          now_value
        ),
        (
          session_row.organization_id,
          conversation_key,
          session_row.crm_record_id,
          'outbound',
          'ai',
          'site',
          trim(p_assistant_message),
          'delivered',
          jsonb_build_object('public_agent_session_id', session_row.id) || p_metadata,
          now_value + interval '1 millisecond'
        );

      update public.crm_conversations
      set last_message_at = now_value + interval '1 millisecond',
          updated_at = now_value
      where organization_id = session_row.organization_id
        and id = conversation_key;
    end if;
  end if;

  return jsonb_build_object(
    'stage', session_row.stage,
    'profile', session_row.captured_profile,
    'converted', session_row.crm_record_id is not null
  );
end
$function$;

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

  select experience.*, session.*
  into experience_row, session_row
  from crm_private.public_agent_experiences experience
  join crm_private.public_agent_sessions session
    on session.experience_id = experience.id
  where experience.slug = lower(trim(p_slug))
    and experience.active
    and session.session_token_hash = p_session_token_hash
    and session.fingerprint_hash = p_fingerprint_hash
  for update of session;

  if not found then
    raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND';
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
      'phone',
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
        preferred_channel = coalesce(contact.preferred_channel, 'phone'),
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

  perform set_config('app.crm_event_source', 'web_agent', true);
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
    jsonb_build_object(
      'public_agent_session_id', session_row.id,
      'experience_slug', experience_row.slug,
      'fbclid', session_row.utm ->> 'fbclid',
      'referrer', session_row.referrer,
      'consent', p_marketing_consent
    )
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
    'integration', 'lead.ingested', 'web_agent', source_row.channel,
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

revoke all on function public.get_public_agent_experience(text) from public, anon, authenticated;
revoke all on function public.open_public_agent_session(text, text, text, jsonb, text, text, text) from public, anon, authenticated;
revoke all on function public.get_public_agent_context(text, text, text) from public, anon, authenticated;
revoke all on function public.append_public_agent_turn(text, text, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.convert_public_agent_lead(text, text, text, text, text, text, text, boolean, jsonb) from public, anon, authenticated;

grant execute on function public.get_public_agent_experience(text) to service_role;
grant execute on function public.open_public_agent_session(text, text, text, jsonb, text, text, text) to service_role;
grant execute on function public.get_public_agent_context(text, text, text) to service_role;
grant execute on function public.append_public_agent_turn(text, text, text, text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.convert_public_agent_lead(text, text, text, text, text, text, text, boolean, jsonb) to service_role;

do $seed$
declare
  organization_key uuid;
  project_key uuid;
  product_key uuid;
  pipeline_key uuid;
  stage_key uuid;
  source_key uuid;
  team_key uuid;
  owner_key uuid;
begin
  select id into organization_key
  from public.organizations
  where name = 'Évora Urbanismo' and active
  order by created_at
  limit 1;

  if organization_key is null then return; end if;

  select id into project_key
  from public.projects
  where organization_id = organization_key
    and name = 'Residencial Solaris Home & Resort'
    and active
  limit 1;

  select id into product_key
  from public.crm_products
  where organization_id = organization_key
    and project_id = project_key
    and name = 'Lotes residenciais'
    and active
  limit 1;

  select id into pipeline_key
  from public.crm_pipelines
  where organization_id = organization_key
    and name = 'Funil Comercial Évora'
    and active
  limit 1;

  select id into stage_key
  from public.crm_stages
  where organization_id = organization_key
    and pipeline_id = pipeline_key
    and code = 'novo'
    and active
  limit 1;

  insert into public.crm_lead_sources (
    organization_id, code, name, provider, channel,
    manual_selectable, active, metadata
  ) values (
    organization_key,
    'WEB_AGENT_VITORIA',
    'Site — Atendimento Inteligente Vitória',
    'first_party',
    'web_agent',
    false,
    true,
    jsonb_build_object('managed_by', 'enterprise', 'public_agent', true)
  )
  on conflict (organization_id, code) do update
  set name = excluded.name,
      provider = excluded.provider,
      channel = excluded.channel,
      manual_selectable = false,
      active = true,
      metadata = excluded.metadata,
      updated_at = now()
  returning id into source_key;

  select id into team_key
  from public.crm_teams
  where organization_id = organization_key
    and name = 'SDR'
    and active
  limit 1;

  select member.user_id into owner_key
  from public.organization_members member
  join public.profiles profile on profile.id = member.user_id
  where member.organization_id = organization_key
    and member.active
    and lower(profile.email) = 'anacarolina@evoraurbanismo.com.br'
  limit 1;

  owner_key := coalesce(
    owner_key,
    (select user_id from public.organization_members where organization_id = organization_key and active order by role = 'admin' desc, user_id limit 1)
  );

  if project_key is null or product_key is null or pipeline_key is null
     or stage_key is null or source_key is null or owner_key is null then
    raise exception 'PUBLIC_AGENT_SEED_DEPENDENCY_MISSING';
  end if;

  insert into crm_private.public_agent_experiences (
    organization_id, slug, project_id, product_id,
    pipeline_id, initial_stage_id, lead_source_id,
    team_id, fallback_owner_user_id, assignment_role,
    active, name, agent_name, title, subtitle, eyebrow,
    first_contact_sla_minutes, knowledge, theme
  ) values (
    organization_key,
    'solaris',
    project_key,
    product_key,
    pipeline_key,
    stage_key,
    source_key,
    team_key,
    owner_key,
    'sdr',
    true,
    'Solaris Residencial',
    'Vitória',
    'Encontre o terreno certo para o seu próximo capítulo.',
    'Converse com a Vitória, conheça o Solaris e receba um atendimento personalizado para morar ou investir.',
    'Solaris Residencial • Monte Carmelo/MG',
    60,
    jsonb_build_object(
      'approvedFacts', jsonb_build_array(
        'O Solaris Residencial é um empreendimento fechado inserido no Bairro Parque das Árvores, em Monte Carmelo/MG.',
        'Os terrenos começam a partir de 360 m².',
        'As obras estão em andamento.',
        'O conceito combina a experiência de morar próxima à natureza com segurança e conforto urbano.',
        'O projeto prevê redes subterrâneas, iluminação em LED, represa com deck e pesca, trilhas, academia, yoga, beach tennis, tênis, basquete, campo society, piscina, playground, pet place, bosque e quiosques.',
        'A disponibilidade, os valores e as condições comerciais podem mudar e devem ser confirmados pela equipe comercial.'
      ),
      'guardrails', jsonb_build_array(
        'Não inventar preço, parcela, disponibilidade, desconto, prazo de entrega ou condição financeira.',
        'Não prometer valorização ou rentabilidade.',
        'Não solicitar CPF, RG, renda detalhada, documentos ou dados sensíveis.',
        'Fazer uma pergunta por vez e no máximo duas em uma resposta.',
        'Quando faltar informação factual, oferecer atendimento humano.',
        'Apresentar-se claramente como assistente virtual da Évora Urbanismo.'
      ),
      'qualificationFields', jsonb_build_array(
        'intent', 'budget_max', 'preferred_area_min', 'purchase_horizon',
        'preferred_city', 'financing_interest', 'visit_interest'
      )
    ),
    jsonb_build_object(
      'accent', '#2f6d4f',
      'accentStrong', '#1f4f3a',
      'navy', '#173f59',
      'background', '#f4f1e8',
      'quickReplies', jsonb_build_array('Quero morar', 'Quero investir', 'Quero conhecer o Solaris'),
      'trustItems', jsonb_build_array('Lotes a partir de 360 m²', 'Obras em andamento', 'Atendimento humano disponível'),
      'privacyNotice', 'Seus dados serão usados pela Évora Urbanismo para este atendimento e para o contato comercial solicitado.'
    )
  )
  on conflict (slug) do update
  set organization_id = excluded.organization_id,
      project_id = excluded.project_id,
      product_id = excluded.product_id,
      pipeline_id = excluded.pipeline_id,
      initial_stage_id = excluded.initial_stage_id,
      lead_source_id = excluded.lead_source_id,
      team_id = excluded.team_id,
      fallback_owner_user_id = excluded.fallback_owner_user_id,
      assignment_role = excluded.assignment_role,
      active = true,
      name = excluded.name,
      agent_name = excluded.agent_name,
      title = excluded.title,
      subtitle = excluded.subtitle,
      eyebrow = excluded.eyebrow,
      first_contact_sla_minutes = excluded.first_contact_sla_minutes,
      knowledge = excluded.knowledge,
      theme = excluded.theme,
      updated_at = now();
end
$seed$;

commit;
