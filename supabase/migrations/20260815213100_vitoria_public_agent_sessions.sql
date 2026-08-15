begin;

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

  select experience, session
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

  select experience, session
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

revoke all on function public.get_public_agent_experience(text) from public, anon, authenticated;
revoke all on function public.open_public_agent_session(text, text, text, jsonb, text, text, text) from public, anon, authenticated;
revoke all on function public.get_public_agent_context(text, text, text) from public, anon, authenticated;
revoke all on function public.append_public_agent_turn(text, text, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;

grant execute on function public.get_public_agent_experience(text) to service_role;
grant execute on function public.open_public_agent_session(text, text, text, jsonb, text, text, text) to service_role;
grant execute on function public.get_public_agent_context(text, text, text) to service_role;
grant execute on function public.append_public_agent_turn(text, text, text, text, text, text, jsonb, jsonb) to service_role;

commit;
