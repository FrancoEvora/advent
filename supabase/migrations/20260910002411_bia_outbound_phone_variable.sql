create or replace function public.bia_whatsapp_outbound_admin(p_organization_id uuid,p_actor uuid,p_action text,p_args jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare ch crm_private.bia_whatsapp_channels; op crm_private.bia_whatsapp_outbound; th crm_private.bia_whatsapp_threads;
  rid uuid; v_phone text; body text; token text; fingerprint text; sid uuid; msg uuid; slug text;
begin
  perform crm_private.assert_public_agent_service_role();
  if p_actor is null or not exists(select 1 from public.organization_members m join public.organizations o on o.id=m.organization_id
    where m.user_id=p_actor and m.organization_id=p_organization_id and m.active and m.role='admin' and o.active) then
    raise exception 'BIA_OUTBOUND_FORBIDDEN' using errcode='42501'; end if;
  select * into ch from crm_private.bia_whatsapp_channels where organization_id=p_organization_id;
  if ch.id is null then raise exception 'BIA_CHANNEL_NOT_FOUND'; end if;
  if p_action='access' then return jsonb_build_object('enabled',ch.enabled and ch.webhook_verified_at is not null); end if;
  rid:=(p_args->>'id')::uuid;
  if rid is null then raise exception 'BIA_REQUEST_INVALID'; end if;
  -- A channel lock serializes reservation and prevents simultaneous duplicate outreach.
  perform pg_advisory_xact_lock(hashtextextended('bia-outbound:'||ch.id::text,0));
  select * into op from crm_private.bia_whatsapp_outbound where id=rid for update;
  if op.id is not null and op.channel_id<>ch.id then raise exception 'BIA_OUTBOUND_FORBIDDEN' using errcode='42501'; end if;
  if p_action='status' then
    if op.id is null then return jsonb_build_object('id',rid,'status','not_found'); end if;
    return crm_private.bia_outbound_result(op);
  elsif p_action='start' then
    v_phone:=p_args->>'phone';body:=p_args->>'body';
    if coalesce(v_phone,'') !~ '^55[1-9][0-9][0-9]{8,9}$' or coalesce(length(body),0) not between 1 and 4000
      or p_args->>'template' is distinct from 'bia_boas_vindas' or coalesce(p_args->>'hash','') !~ '^[a-f0-9]{64}$'
      or p_args->'consent' is distinct from 'true'::jsonb then raise exception 'BIA_REQUEST_INVALID'; end if;
    if op.id is not null then
      if op.phone<>v_phone or op.template_hash<>p_args->>'hash' then raise exception 'BIA_REQUEST_CHANGED'; end if;
      return crm_private.bia_outbound_result(op)||jsonb_build_object('proceed',false);
    end if;
    if not ch.enabled or ch.webhook_verified_at is null then raise exception 'BIA_CHANNEL_DISABLED'; end if;
    if crm_private.bia_phone_key(v_phone)=crm_private.bia_phone_key(regexp_replace(ch.display_phone_number,'[^0-9]','','g')) then raise exception 'BIA_SELF_RECIPIENT'; end if;
    if exists(select 1 from crm_private.bia_whatsapp_outbound q where q.channel_id=ch.id
      and crm_private.bia_phone_key(q.phone)=crm_private.bia_phone_key(v_phone) and q.created_at>now()-interval '24 hours'
      and q.status<>'failed') then raise exception 'BIA_CONTACT_RECENTLY_SENT'; end if;
    if (select count(*) from crm_private.bia_whatsapp_outbound q where q.channel_id=ch.id and q.created_at>now()-interval '1 minute')>=5 then raise exception 'BIA_SEND_RATE_LIMIT'; end if;
    perform pg_advisory_xact_lock(hashtextextended('bia:'||ch.id::text||':'||crm_private.bia_phone_key(v_phone),0));
    if exists(select 1 from crm_private.bia_whatsapp_threads t where t.channel_id=ch.id
      and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(v_phone) and (t.opted_out_at is not null or t.human_requested)) then raise exception 'BIA_CONTACT_PAUSED'; end if;
    select * into th from crm_private.bia_whatsapp_threads t where t.channel_id=ch.id
      and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(v_phone) order by (t.peer_phone=v_phone) desc,t.created_at limit 1;
    if th.id is null then
      select e.slug into slug from crm_private.public_agent_experiences e where e.id=ch.experience_id and e.active;
      if slug is null then raise exception 'BIA_EXPERIENCE_INACTIVE'; end if;
      token:=encode(extensions.gen_random_bytes(32),'hex');fingerprint:=encode(extensions.gen_random_bytes(32),'hex');
      sid:=(public.open_public_agent_session(slug,token,fingerprint,jsonb_build_object('source','whatsapp'),'whatsapp',null,'Bia WhatsApp Cloud API')->>'sessionId')::uuid;
      insert into crm_private.bia_whatsapp_threads(channel_id,peer_phone,session_id,token_hash,fingerprint_hash)
        values(ch.id,v_phone,sid,token,fingerprint) returning * into th;
      -- Operator confirms existing WhatsApp opt-in; no fictitious customer reply or CRM conversion.
      update crm_private.public_agent_sessions set contact_capture=contact_capture||jsonb_build_object('phone','+'||v_phone),
        contact_consent_at=now(),consent_copy_version='operator_whatsapp_optin_v1' where id=sid;
    end if;
    if exists(select 1 from crm_private.public_agent_sessions where id=th.session_id and status in('closed','blocked')) then raise exception 'BIA_SESSION_INACTIVE'; end if;
    update crm_private.public_agent_sessions set expires_at=greatest(expires_at,now()+interval '14 days') where id=th.session_id;
    insert into crm_private.bia_whatsapp_messages(thread_id,provider_message_id,direction,content,message_type,delivery_status,metadata,occurred_at)
      values(th.id,'bia-template:'||rid,'outbound',body,'template','sending',jsonb_build_object('outbound_id',rid,'template','bia_boas_vindas'),now()) returning id into msg;
    insert into crm_private.bia_whatsapp_outbound(id,channel_id,actor_user_id,thread_id,message_id,phone,template_name,template_hash,status)
      values(rid,ch.id,p_actor,th.id,msg,v_phone,'bia_boas_vindas',p_args->>'hash','sending') returning * into op;
    return crm_private.bia_outbound_result(op)||jsonb_build_object('proceed',true);
  elsif p_action='finish' and op.id is not null then
    if p_args->>'status'='accepted' then
      if not crm_private.bia_outbound_status(ch.id,jsonb_build_object('operation_id',rid,'provider_message_id',p_args->>'providerMessageId',
        'recipient_phone',p_args->>'recipientPhone','status','accepted')) then raise exception 'BIA_SEND_RESULT_INVALID'; end if;
    elsif p_args->>'status' in('failed','unknown') and op.status='sending' then
      update crm_private.bia_whatsapp_outbound set status=p_args->>'status',error_code=left(p_args->>'errorCode',80),updated_at=now() where id=rid;
      update crm_private.bia_whatsapp_messages set delivery_status=p_args->>'status',metadata=metadata||jsonb_build_object('error_code',left(p_args->>'errorCode',80)) where id=op.message_id;
    end if;
    select * into op from crm_private.bia_whatsapp_outbound where id=rid;
    return crm_private.bia_outbound_result(op);
  end if;
  raise exception 'BIA_ACTION_INVALID';
end $$;
