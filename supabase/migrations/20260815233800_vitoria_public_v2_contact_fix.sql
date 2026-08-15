begin;
create or replace function public.update_public_agent_contact_capture(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_patch jsonb,
  p_consent boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare session_row crm_private.public_agent_sessions%rowtype;
begin
  if p_patch is null or jsonb_typeof(p_patch)<>'object' or pg_column_size(p_patch)>8192 then
    raise exception 'PUBLIC_AGENT_CONTACT_INVALID';
  end if;
  select session.* into session_row
  from crm_private.public_agent_sessions session
  join crm_private.public_agent_experiences experience on experience.id=session.experience_id
  where experience.slug=lower(trim(p_slug)) and experience.active
    and session.session_token_hash=p_session_token_hash
    and session.fingerprint_hash=p_fingerprint_hash
  for update of session;
  if not found then raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND'; end if;
  update crm_private.public_agent_sessions
  set contact_capture=contact_capture||jsonb_strip_nulls(p_patch),
      contact_consent_at=case when p_consent=true then now() when p_consent=false then null else contact_consent_at end,
      marketing_consent=case when p_consent=true then true when p_consent=false then false else marketing_consent end,
      stage=case
        when coalesce((p_patch->>'collecting')::boolean,false) then 'contact'
        when p_consent=false and coalesce((p_patch->>'collecting')::boolean,true)=false then 'discovery'
        else stage
      end,
      updated_at=now(),last_activity_at=now()
  where id=session_row.id
  returning * into session_row;
  return jsonb_build_object(
    'contactCapture',session_row.contact_capture,
    'consented',session_row.contact_consent_at is not null,
    'converted',session_row.crm_record_id is not null
  );
end
$function$;
revoke all on function public.update_public_agent_contact_capture(text,text,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.update_public_agent_contact_capture(text,text,text,jsonb,boolean) to service_role;
commit;
