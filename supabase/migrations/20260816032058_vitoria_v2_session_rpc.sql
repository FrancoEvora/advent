create or replace function public.open_public_agent_session_v2(
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
set search_path=''
as $function$
declare
  base_payload jsonb;
  experience_row crm_private.public_agent_experiences%rowtype;
  session_row crm_private.public_agent_sessions%rowtype;
  transcript jsonb;
  generated jsonb;
begin
  perform crm_private.assert_public_agent_service_role();
  base_payload := public.open_public_agent_session(p_slug,p_session_token_hash,p_fingerprint_hash,p_utm,p_landing_page,p_referrer,p_user_agent);
  select experience.* into experience_row from crm_private.public_agent_experiences experience where experience.slug=lower(trim(p_slug)) and experience.active;
  select session.* into session_row from crm_private.public_agent_sessions session where session.experience_id=experience_row.id and session.session_token_hash=p_session_token_hash;
  if not found then raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',message.id,'direction',message.direction,'content',message.content,
    'resources',coalesce(message.metadata->'resources','[]'::jsonb),
    'metadata',message.metadata,'createdAt',message.created_at
  ) order by message.created_at,message.id),'[]'::jsonb)
  into transcript
  from (
    select * from crm_private.public_agent_messages
    where session_id=session_row.id
    order by created_at desc,id desc limit 40
  ) message;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',asset.id,'type',asset.asset_type,'title',asset.title,'url',asset.public_url,
    'mimeType',asset.mime_type,'metadata',asset.metadata,'createdAt',asset.created_at,
    'disclaimer',case when asset.asset_type='house_simulation' then 'Estudo conceitual gerado por inteligência artificial. Não constitui projeto arquitetônico, aprovação ou promessa de execução.' else null end
  ) order by asset.created_at desc),'[]'::jsonb)
  into generated from crm_private.public_agent_generated_assets asset where asset.session_id=session_row.id and asset.status='ready';

  return jsonb_build_object(
    'sessionId',session_row.id,'stage',session_row.stage,'profile',session_row.captured_profile,
    'converted',session_row.crm_record_id is not null,
    'leadProtocol',case when session_row.crm_record_id is null then null else upper(left(replace(session_row.crm_record_id::text,'-',''),10)) end,
    'experience',public.get_public_agent_experience(p_slug),
    'messages',transcript,
    'generatedAssets',generated
  );
end
$function$;
revoke all on function public.open_public_agent_session_v2(text,text,text,jsonb,text,text,text) from public,anon,authenticated;
grant execute on function public.open_public_agent_session_v2(text,text,text,jsonb,text,text,text) to service_role;
