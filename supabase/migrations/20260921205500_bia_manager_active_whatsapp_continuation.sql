create or replace function crm_private.bia_outbound_status(p_channel uuid,p_item jsonb) returns boolean
language plpgsql security definer set search_path='' as $function$
declare
  op crm_private.bia_whatsapp_outbound;
  next_status text:=p_item->>'status';
  mid text:=p_item->>'provider_message_id';
begin
  if next_status not in('accepted','sent','delivered','read','failed') or coalesce(mid,'')='' then
    return false;
  end if;
  select * into op
  from crm_private.bia_whatsapp_outbound q
  where q.channel_id=p_channel
    and (q.id::text=p_item->>'operation_id' or q.provider_message_id=mid)
    and crm_private.bia_phone_key(q.phone)=crm_private.bia_phone_key(p_item->>'recipient_phone')
  for update;
  if op.id is null then return false; end if;
  if op.provider_message_id is not null and op.provider_message_id<>mid then return false; end if;
  if (case next_status when 'read' then 5 when 'delivered' then 4 when 'failed' then 3 when 'sent' then 2 else 1 end)
    < (case op.status when 'read' then 5 when 'delivered' then 4 when 'failed' then 3 when 'sent' then 2 when 'accepted' then 1 else 0 end) then
    return true;
  end if;
  update crm_private.bia_whatsapp_outbound
  set status=next_status,
      provider_message_id=mid,
      error_code=case when next_status='failed' then left(p_item->>'error_code',80) end,
      updated_at=now()
  where id=op.id;
  update crm_private.bia_whatsapp_messages
  set provider_message_id=mid,
      delivery_status=next_status,
      metadata=metadata||jsonb_build_object(
        'error_code',
        case when next_status='failed' then left(p_item->>'error_code',80) end
      )
  where id=op.message_id;

  if next_status in('accepted','sent','delivered','read') and not exists(
    select 1
    from crm_private.public_agent_messages m
    join crm_private.bia_whatsapp_threads t on t.session_id=m.session_id
    where t.id=op.thread_id
      and m.metadata->>'bia_outbound_id'=op.id::text
  ) then
    insert into crm_private.public_agent_messages(session_id,direction,content,metadata)
    select
      t.session_id,
      'assistant',
      m.content,
      jsonb_build_object(
        'bia_outbound_id',op.id,
        'source',case when m.message_type='template' then 'whatsapp_template' else 'whatsapp_manager_text' end
      )
    from crm_private.bia_whatsapp_threads t
    join crm_private.bia_whatsapp_messages m on m.id=op.message_id
    where t.id=op.thread_id;
  end if;
  return true;
end
$function$;

create or replace function public.bia_whatsapp_outbound_admin(
  p_organization_id uuid,
  p_actor uuid,
  p_action text,
  p_args jsonb default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  ch crm_private.bia_whatsapp_channels;
  op crm_private.bia_whatsapp_outbound;
  th crm_private.bia_whatsapp_threads;
  rid uuid;
  v_phone text;
  body text;
  token text;
  fingerprint text;
  sid uuid;
  msg uuid;
  slug text;
begin
  perform crm_private.assert_public_agent_service_role();
  if p_actor is null or not exists(
    select 1
    from public.organization_members m
    join public.organizations o on o.id=m.organization_id
    where m.user_id=p_actor
      and m.organization_id=p_organization_id
      and m.active
      and lower(m.role)='admin'
      and o.active
  ) then
    raise exception 'BIA_OUTBOUND_FORBIDDEN' using errcode='42501';
  end if;

  select * into ch
  from crm_private.bia_whatsapp_channels
  where organization_id=p_organization_id;
  if ch.id is null then raise exception 'BIA_CHANNEL_NOT_FOUND'; end if;

  if p_action='access' then
    return jsonb_build_object('enabled',ch.enabled and ch.webhook_verified_at is not null);
  end if;

  if p_action='recipient' then
    if coalesce(p_args->>'phone','') !~ '^55[1-9][0-9][0-9]{8,9}$' then
      raise exception 'BIA_PHONE_INVALID';
    end if;
    return jsonb_build_object(
      'name',
      (
        select case when count(distinct trim(r.person_name))=1 then min(trim(r.person_name)) end
        from public.crm_records r
        where r.organization_id=p_organization_id
          and nullif(trim(r.person_name),'') is not null
          and crm_private.bia_phone_key(
            case
              when length(regexp_replace(r.phone,'[^0-9]','','g')) in(10,11)
                then '55'||regexp_replace(r.phone,'[^0-9]','','g')
              else regexp_replace(r.phone,'[^0-9]','','g')
            end
          )=crm_private.bia_phone_key(p_args->>'phone')
      )
    );
  end if;

  begin
    rid:=(p_args->>'id')::uuid;
  exception when others then
    raise exception 'BIA_REQUEST_INVALID';
  end;
  if rid is null then raise exception 'BIA_REQUEST_INVALID'; end if;

  perform pg_advisory_xact_lock(hashtextextended('bia-outbound:'||ch.id::text,0));
  select * into op
  from crm_private.bia_whatsapp_outbound
  where id=rid
  for update;
  if op.id is not null and op.channel_id<>ch.id then
    raise exception 'BIA_OUTBOUND_FORBIDDEN' using errcode='42501';
  end if;

  if p_action='status' then
    if op.id is null then return jsonb_build_object('id',rid,'status','not_found'); end if;
    return crm_private.bia_outbound_result(op);

  elsif p_action='start' then
    v_phone:=p_args->>'phone';
    body:=p_args->>'body';
    if coalesce(v_phone,'') !~ '^55[1-9][0-9][0-9]{8,9}$'
      or coalesce(length(body),0) not between 1 and 4000
      or (
        (
          p_args->>'template' is distinct from 'bia_indicacao_investimento'
          or exists(select 1 from crm_private.bia_campaign_outreach_jobs where id=rid)
        )
        and not crm_private.bia_campaign_reservation_valid(
          rid,
          (p_args->>'campaignLease')::uuid,
          p_args->>'template',
          v_phone,
          p_actor,
          p_organization_id
        )
      )
      or coalesce(p_args->>'hash','') !~ '^[a-f0-9]{64}$'
      or p_args->'consent' is distinct from 'true'::jsonb
    then
      raise exception 'BIA_REQUEST_INVALID';
    end if;

    if op.id is not null then
      if crm_private.bia_phone_key(op.phone)<>crm_private.bia_phone_key(v_phone)
        or op.template_hash<>p_args->>'hash'
        or (select content from crm_private.bia_whatsapp_messages where id=op.message_id) is distinct from body
      then
        raise exception 'BIA_REQUEST_CHANGED';
      end if;
      return crm_private.bia_outbound_result(op)||jsonb_build_object('proceed',false);
    end if;

    if not ch.enabled or ch.webhook_verified_at is null then raise exception 'BIA_CHANNEL_DISABLED'; end if;
    if crm_private.bia_phone_key(v_phone)=crm_private.bia_phone_key(regexp_replace(ch.display_phone_number,'[^0-9]','','g')) then
      raise exception 'BIA_SELF_RECIPIENT';
    end if;
    if exists(
      select 1
      from crm_private.bia_whatsapp_outbound q
      where q.channel_id=ch.id
        and crm_private.bia_phone_key(q.phone)=crm_private.bia_phone_key(v_phone)
        and q.created_at>now()-interval '24 hours'
        and q.status<>'failed'
    ) then
      raise exception 'BIA_CONTACT_RECENTLY_SENT';
    end if;
    if (
      select count(*)
      from crm_private.bia_whatsapp_outbound q
      where q.channel_id=ch.id
        and q.created_at>now()-interval '1 minute'
    )>=5 then
      raise exception 'BIA_SEND_RATE_LIMIT';
    end if;

    perform pg_advisory_xact_lock(hashtextextended('bia:'||ch.id::text||':'||crm_private.bia_phone_key(v_phone),0));
    if exists(
      select 1
      from crm_private.bia_whatsapp_threads t
      where t.channel_id=ch.id
        and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(v_phone)
        and (t.opted_out_at is not null or t.human_requested)
    ) then
      raise exception 'BIA_CONTACT_PAUSED';
    end if;

    select * into th
    from crm_private.bia_whatsapp_threads t
    where t.channel_id=ch.id
      and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(v_phone)
    order by (t.peer_phone=v_phone) desc,t.last_inbound_at desc nulls last,t.created_at desc
    limit 1;

    if th.id is null then
      select e.slug into slug
      from crm_private.public_agent_experiences e
      where e.id=ch.experience_id and e.active;
      if slug is null then raise exception 'BIA_EXPERIENCE_INACTIVE'; end if;

      token:=encode(extensions.gen_random_bytes(32),'hex');
      fingerprint:=encode(extensions.gen_random_bytes(32),'hex');
      sid:=(
        public.open_public_agent_session(
          slug,
          token,
          fingerprint,
          jsonb_build_object('source','whatsapp'),
          'whatsapp',
          null,
          'Bia WhatsApp Cloud API'
        )->>'sessionId'
      )::uuid;
      insert into crm_private.bia_whatsapp_threads(
        channel_id,peer_phone,session_id,token_hash,fingerprint_hash
      )
      values(ch.id,v_phone,sid,token,fingerprint)
      returning * into th;

      update crm_private.public_agent_sessions
      set contact_capture=contact_capture||jsonb_build_object('phone','+'||v_phone),
          contact_consent_at=now(),
          consent_copy_version='operator_whatsapp_optin_v1'
      where id=sid;
    else
      v_phone:=th.peer_phone;
    end if;

    if exists(
      select 1
      from crm_private.public_agent_sessions
      where id=th.session_id and status in('closed','blocked')
    ) then
      raise exception 'BIA_SESSION_INACTIVE';
    end if;

    update crm_private.public_agent_sessions
    set expires_at=greatest(expires_at,now()+interval '14 days')
    where id=th.session_id;

    insert into crm_private.bia_whatsapp_messages(
      thread_id,provider_message_id,direction,content,message_type,delivery_status,metadata,occurred_at
    )
    values(
      th.id,
      'bia-template:'||rid,
      'outbound',
      body,
      'template',
      'sending',
      jsonb_build_object('outbound_id',rid,'template',p_args->>'template'),
      now()
    )
    returning id into msg;

    insert into crm_private.bia_whatsapp_outbound(
      id,channel_id,actor_user_id,thread_id,message_id,phone,template_name,template_hash,status
    )
    values(
      rid,ch.id,p_actor,th.id,msg,v_phone,p_args->>'template',p_args->>'hash','sending'
    )
    returning * into op;

    return crm_private.bia_outbound_result(op)||jsonb_build_object('proceed',true);

  elsif p_action='start_text' then
    v_phone:=p_args->>'phone';
    body:=trim(coalesce(p_args->>'body',''));

    if coalesce(v_phone,'') !~ '^55[1-9][0-9][0-9]{8,9}$'
      or length(body) not between 1 and 4096
      or coalesce(p_args->>'hash','') !~ '^[a-f0-9]{64}$'
    then
      raise exception 'BIA_REQUEST_INVALID';
    end if;

    if op.id is not null then
      if op.template_name<>'bia_manager_text'
        or crm_private.bia_phone_key(op.phone)<>crm_private.bia_phone_key(v_phone)
        or op.template_hash<>p_args->>'hash'
        or (select content from crm_private.bia_whatsapp_messages where id=op.message_id) is distinct from body
      then
        raise exception 'BIA_REQUEST_CHANGED';
      end if;
      return crm_private.bia_outbound_result(op)||jsonb_build_object('proceed',false);
    end if;

    if not ch.enabled or ch.webhook_verified_at is null then
      raise exception 'BIA_CHANNEL_DISABLED';
    end if;
    if crm_private.bia_phone_key(v_phone)=crm_private.bia_phone_key(regexp_replace(ch.display_phone_number,'[^0-9]','','g')) then
      raise exception 'BIA_SELF_RECIPIENT';
    end if;

    perform pg_advisory_xact_lock(hashtextextended('bia:'||ch.id::text||':'||crm_private.bia_phone_key(v_phone),0));

    select * into th
    from crm_private.bia_whatsapp_threads t
    where t.channel_id=ch.id
      and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(v_phone)
    order by (t.peer_phone=v_phone) desc,t.last_inbound_at desc nulls last,t.created_at desc
    limit 1
    for update;

    if th.id is null then raise exception 'BIA_TEXT_THREAD_REQUIRED'; end if;
    if th.opted_out_at is not null or th.human_requested then raise exception 'BIA_CONTACT_PAUSED'; end if;
    if th.last_inbound_at is null or th.last_inbound_at<=now()-interval '23 hours 55 minutes' then
      raise exception 'BIA_TEXT_WINDOW_CLOSED';
    end if;
    if exists(
      select 1 from crm_private.public_agent_sessions
      where id=th.session_id and status in('closed','blocked')
    ) then
      raise exception 'BIA_SESSION_INACTIVE';
    end if;

    if (
      select count(*)
      from crm_private.bia_whatsapp_outbound q
      where q.channel_id=ch.id
        and q.created_at>now()-interval '1 minute'
    )>=5 then
      raise exception 'BIA_SEND_RATE_LIMIT';
    end if;

    v_phone:=th.peer_phone;
    update crm_private.public_agent_sessions
    set expires_at=greatest(expires_at,now()+interval '14 days'),
        last_activity_at=now(),
        updated_at=now()
    where id=th.session_id;

    insert into crm_private.bia_whatsapp_messages(
      thread_id,provider_message_id,direction,content,message_type,delivery_status,metadata,occurred_at
    )
    values(
      th.id,
      'bia-text:'||rid,
      'outbound',
      body,
      'text',
      'sending',
      jsonb_build_object('outbound_id',rid,'source','manager'),
      now()
    )
    returning id into msg;

    insert into crm_private.bia_whatsapp_outbound(
      id,channel_id,actor_user_id,thread_id,message_id,phone,template_name,template_hash,
      consent_copy_version,status
    )
    values(
      rid,ch.id,p_actor,th.id,msg,v_phone,'bia_manager_text',p_args->>'hash',
      'customer_service_window_v1','sending'
    )
    returning * into op;

    return crm_private.bia_outbound_result(op)||jsonb_build_object(
      'proceed',true,
      'sendMode','text',
      'serviceWindowOpen',true
    );

  elsif p_action='finish' and op.id is not null then
    if p_args->>'status'='accepted' then
      if not crm_private.bia_outbound_status(
        ch.id,
        jsonb_build_object(
          'operation_id',rid,
          'provider_message_id',p_args->>'providerMessageId',
          'recipient_phone',p_args->>'recipientPhone',
          'status','accepted'
        )
      ) then
        raise exception 'BIA_SEND_RESULT_INVALID';
      end if;
    elsif p_args->>'status' in('failed','unknown') and op.status='sending' then
      update crm_private.bia_whatsapp_outbound
      set status=p_args->>'status',
          error_code=left(p_args->>'errorCode',80),
          updated_at=now()
      where id=rid;

      update crm_private.bia_whatsapp_messages
      set delivery_status=p_args->>'status',
          metadata=metadata||jsonb_build_object('error_code',left(p_args->>'errorCode',80))
      where id=op.message_id;
    end if;

    select * into op
    from crm_private.bia_whatsapp_outbound
    where id=rid;

    return crm_private.bia_outbound_result(op);
  end if;

  raise exception 'BIA_ACTION_INVALID';
end
$function$;

revoke all on function public.bia_whatsapp_outbound_admin(uuid,uuid,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.bia_whatsapp_outbound_admin(uuid,uuid,text,jsonb)
  to service_role;
