-- Customer-owned conversation navigation. No admin or WhatsApp sessions are exposed.
create or replace function public.get_bia_conversation_workspace_v1(
  p_slug text, p_session_token_hash text, p_fingerprint_hash text, p_before_id bigint default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  s crm_private.public_agent_sessions%rowtype;
  transcript jsonb; conversations jsonb; resources jsonb; oldest bigint; has_older boolean;
begin
  perform crm_private.assert_public_agent_service_role();
  select x.* into s from crm_private.public_agent_sessions x
  join crm_private.public_agent_experiences e on e.id=x.experience_id
  where e.slug=lower(trim(p_slug)) and e.active
    and x.session_token_hash=p_session_token_hash and x.fingerprint_hash=p_fingerprint_hash;
  if not found or s.status in ('closed','blocked') or s.expires_at<=now() then
    raise exception 'PUBLIC_AGENT_SESSION_INACTIVE';
  end if;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]'),min(m.id) into transcript,oldest
  from (
    select id,direction,content,created_at,
      jsonb_strip_nulls(jsonb_build_object('initial_greeting',metadata->'initial_greeting',
        'public_audio',metadata->'public_audio','public_response',metadata->'public_response')) as metadata
    from crm_private.public_agent_messages where session_id=s.id and (p_before_id is null or id<p_before_id)
    order by id desc limit 100
  ) m;
  select exists(select 1 from crm_private.public_agent_messages where session_id=s.id and id<oldest) into has_older;
  select coalesce(jsonb_agg(to_jsonb(c) order by c."updatedAt" desc),'[]') into conversations from (
    select x.id, coalesce((select left(m.content,80) from crm_private.public_agent_messages m
      where m.session_id=x.id and m.direction='user' order by m.id limit 1),'Nova conversa') as title,
      x.last_activity_at as "updatedAt"
    from crm_private.public_agent_sessions x
    where x.experience_id=s.experience_id and x.organization_id=s.organization_id and x.fingerprint_hash=s.fingerprint_hash
      and x.status not in ('closed','blocked') and x.expires_at>now()
      and not exists(select 1 from crm_private.bia_whatsapp_threads w where w.session_id=x.id)
    order by x.last_activity_at desc limit 100
  ) c;
  -- Rich cards remain available even when their messages are on an older page.
  select coalesce(jsonb_agg(m.metadata->'public_response' order by m.id),'[]') into resources
  from crm_private.public_agent_messages m where m.session_id=s.id and m.direction='assistant'
    and (m.metadata->'public_response' ?| array['simulation','attachments']);
  return jsonb_build_object('sessionId',s.id,'stage',s.stage,'profile',s.captured_profile,
    'converted',s.crm_record_id is not null,
    'leadProtocol',case when s.crm_record_id is not null then upper(left(replace(s.crm_record_id::text,'-',''),10)) end,
    'experience',public.get_public_agent_experience(p_slug),'messages',transcript,
    'hasOlderMessages',has_older,'conversations',conversations,'resources',resources);
end $$;

create or replace function public.open_bia_conversation_v1(
  p_slug text,p_session_token_hash text,p_fingerprint_hash text,p_utm jsonb default '{}',
  p_landing_page text default null,p_referrer text default null,p_user_agent text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare s crm_private.public_agent_sessions%rowtype;
begin
  perform crm_private.assert_public_agent_service_role();
  if coalesce(p_session_token_hash,'') !~ '^[a-f0-9]{64}$' or coalesce(p_fingerprint_hash,'') !~ '^[a-f0-9]{64}$' then
    raise exception 'PUBLIC_AGENT_SESSION_INPUT_INVALID';
  end if;
  select * into s from crm_private.public_agent_sessions where session_token_hash=p_session_token_hash;
  if found and (s.fingerprint_hash is distinct from p_fingerprint_hash or s.status in ('closed','blocked') or s.expires_at<=now()) then
    raise exception 'PUBLIC_AGENT_SESSION_INACTIVE';
  end if;
  perform public.open_public_agent_session_v4(p_slug,p_session_token_hash,p_fingerprint_hash,p_utm,p_landing_page,p_referrer,p_user_agent);
  return public.get_bia_conversation_workspace_v1(p_slug,p_session_token_hash,p_fingerprint_hash);
end $$;

create or replace function public.switch_bia_conversation_v1(
  p_slug text,p_session_token_hash text,p_fingerprint_hash text,p_new_token_hash text,p_conversation_id uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare s crm_private.public_agent_sessions%rowtype; target crm_private.public_agent_sessions%rowtype;
begin
  perform crm_private.assert_public_agent_service_role();
  if coalesce(p_new_token_hash,'') !~ '^[a-f0-9]{64}$' or p_new_token_hash=p_session_token_hash then
    raise exception 'PUBLIC_AGENT_SESSION_INPUT_INVALID';
  end if;
  select x.* into s from crm_private.public_agent_sessions x join crm_private.public_agent_experiences e on e.id=x.experience_id
  where e.slug=lower(trim(p_slug)) and e.active and x.session_token_hash=p_session_token_hash and x.fingerprint_hash=p_fingerprint_hash;
  if not found or s.status in ('closed','blocked') or s.expires_at<=now()
    or exists(select 1 from crm_private.bia_whatsapp_threads w where w.session_id=s.id) then
    raise exception 'PUBLIC_AGENT_SESSION_INACTIVE';
  end if;
  if exists(select 1 from crm_private.public_agent_requests r where r.session_id=s.id
    and r.status='processing' and r.lease_expires_at>now()) then raise exception 'PUBLIC_AGENT_CONVERSATION_BUSY'; end if;
  if p_conversation_id is not null then
    select * into target from crm_private.public_agent_sessions x
    where x.id=p_conversation_id and x.experience_id=s.experience_id and x.organization_id=s.organization_id
      and x.fingerprint_hash=s.fingerprint_hash and x.status not in ('closed','blocked') and x.expires_at>now()
      and not exists(select 1 from crm_private.bia_whatsapp_threads w where w.session_id=x.id)
    for update;
    if not found then raise exception 'PUBLIC_AGENT_CONVERSATION_NOT_FOUND'; end if;
    -- Do not invalidate credentials while a turn is being processed in another tab.
    if exists(select 1 from crm_private.public_agent_requests r where r.session_id in (s.id,target.id)
      and r.status='processing' and r.lease_expires_at>now()) then raise exception 'PUBLIC_AGENT_CONVERSATION_BUSY'; end if;
    update crm_private.public_agent_sessions set session_token_hash=p_new_token_hash where id=target.id;
  end if;
  return public.open_bia_conversation_v1(p_slug,p_new_token_hash,p_fingerprint_hash);
end $$;

revoke all on function public.get_bia_conversation_workspace_v1(text,text,text,bigint) from public,anon,authenticated;
revoke all on function public.open_bia_conversation_v1(text,text,text,jsonb,text,text,text) from public,anon,authenticated;
revoke all on function public.switch_bia_conversation_v1(text,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.get_bia_conversation_workspace_v1(text,text,text,bigint) to service_role;
grant execute on function public.open_bia_conversation_v1(text,text,text,jsonb,text,text,text) to service_role;
grant execute on function public.switch_bia_conversation_v1(text,text,text,text,uuid) to service_role;
