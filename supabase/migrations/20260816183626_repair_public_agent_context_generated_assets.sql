create or replace function public.get_public_agent_context(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  experience_row crm_private.public_agent_experiences%rowtype;
  session_row crm_private.public_agent_sessions%rowtype;
  minute_count integer;
  hour_count integer;
  transcript jsonb;
  commercial jsonb;
  generated jsonb;
begin
  perform crm_private.assert_public_agent_service_role();

  select session.* into session_row
  from crm_private.public_agent_sessions session
  join crm_private.public_agent_experiences experience on experience.id=session.experience_id
  where experience.slug=lower(trim(p_slug))
    and experience.active
    and session.session_token_hash=p_session_token_hash
    and session.fingerprint_hash=p_fingerprint_hash
  for update of session;

  if not found then
    raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND';
  end if;

  select * into experience_row
  from crm_private.public_agent_experiences
  where id=session_row.experience_id and active;

  if not found then
    raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND';
  end if;

  if session_row.status in ('closed','blocked') or session_row.expires_at<=now() then
    raise exception 'PUBLIC_AGENT_SESSION_INACTIVE';
  end if;

  select
    count(*) filter(where message.created_at>=now()-interval '1 minute'),
    count(*) filter(where message.created_at>=now()-interval '1 hour')
  into minute_count,hour_count
  from crm_private.public_agent_messages message
  where message.session_id=session_row.id and message.direction='user';

  if minute_count>=6 or hour_count>=40 or session_row.message_count>=140 then
    raise exception 'PUBLIC_AGENT_MESSAGE_RATE_LIMIT';
  end if;

  update crm_private.public_agent_sessions
  set last_activity_at=now(),updated_at=now()
  where id=session_row.id;

  select coalesce(jsonb_agg(row_data order by row_data.created_at,row_data.id),'[]'::jsonb)
  into transcript
  from (
    select message.id,message.direction,message.content,message.metadata,message.created_at
    from crm_private.public_agent_messages message
    where message.session_id=session_row.id
    order by message.created_at desc,message.id desc
    limit 30
  ) row_data;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',asset.id,
    'type',asset.asset_type,
    'title',asset.title,
    'storagePath',asset.storage_path,
    'mimeType',asset.mime_type,
    'metadata',asset.metadata,
    'createdAt',asset.created_at,
    'expiresAt',asset.expires_at
  ) order by asset.created_at desc),'[]'::jsonb)
  into generated
  from crm_private.public_agent_generated_assets asset
  where asset.session_id=session_row.id
    and (asset.expires_at is null or asset.expires_at>now());

  commercial := public.get_public_agent_commercial_snapshot(experience_row.slug);

  return jsonb_build_object(
    'organizationId',experience_row.organization_id,
    'sessionId',session_row.id,
    'stage',session_row.stage,
    'profile',session_row.captured_profile,
    'converted',session_row.crm_record_id is not null,
    'crmRecordId',session_row.crm_record_id,
    'commercial',commercial,
    'generatedAssets',generated,
    'experience',jsonb_build_object(
      'slug',experience_row.slug,
      'name',experience_row.name,
      'agentName',experience_row.agent_name,
      'title',experience_row.title,
      'subtitle',experience_row.subtitle,
      'eyebrow',experience_row.eyebrow,
      'greetingText',experience_row.greeting_text,
      'avatar',experience_row.avatar,
      'capabilities',experience_row.capabilities,
      'theme',experience_row.theme
    ),
    'messages',transcript
  );
end
$function$;

revoke all on function public.get_public_agent_context(text,text,text) from public,anon,authenticated;
grant execute on function public.get_public_agent_context(text,text,text) to service_role;
