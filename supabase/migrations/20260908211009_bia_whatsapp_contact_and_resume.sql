create or replace function public.bia_whatsapp_webhook(p_organization_id uuid,p_phone_number_id text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ch crm_private.bia_whatsapp_channels; th crm_private.bia_whatsapp_threads; item jsonb; mid uuid; sid uuid; token text; fingerprint text; slug text; handled jsonb:='[]'; statuses jsonb:='[]'; stamp timestamptz;
begin
  perform crm_private.assert_public_agent_service_role();
  if jsonb_typeof(p_payload)<>'object' or pg_column_size(p_payload)>1048576 then raise exception 'BIA_PAYLOAD_INVALID'; end if;
  select * into ch from crm_private.bia_whatsapp_channels where organization_id=p_organization_id and phone_number_id=p_phone_number_id;
  if ch.id is null then raise exception 'BIA_CHANNEL_NOT_FOUND'; end if;
  select e.slug into slug from crm_private.public_agent_experiences e where e.id=ch.experience_id and e.organization_id=ch.organization_id and e.active;
  if slug is null then raise exception 'BIA_EXPERIENCE_INACTIVE'; end if;
  for item in select value from jsonb_array_elements(coalesce(p_payload->'messages','[]')) loop
    if coalesce(item->>'from_phone','') !~ '^[0-9]{8,20}$' or coalesce(item->>'provider_message_id','')='' then raise exception 'BIA_MESSAGE_INVALID'; end if;
    stamp:=least((item->>'occurred_at')::timestamptz,now());
    perform pg_advisory_xact_lock(hashtextextended('bia:'||ch.id::text||':'||(item->>'from_phone'),0));
    select * into th from crm_private.bia_whatsapp_threads where channel_id=ch.id and peer_phone=item->>'from_phone';
    if th.id is null then
      token:=encode(extensions.gen_random_bytes(32),'hex'); fingerprint:=encode(extensions.gen_random_bytes(32),'hex');
      sid:=(public.open_public_agent_session(slug,token,fingerprint,jsonb_build_object('source','whatsapp'),'whatsapp',null,'Bia WhatsApp Cloud API')->>'sessionId')::uuid;
      insert into crm_private.bia_whatsapp_threads(channel_id,peer_phone,session_id,token_hash,fingerprint_hash,last_inbound_at) values(ch.id,item->>'from_phone',sid,token,fingerprint,stamp) returning * into th;
      -- The transport proves possession of the sender's number; a WhatsApp profile name is not a verified customer name.
      update crm_private.public_agent_sessions set contact_capture=contact_capture||jsonb_build_object('phone','+'||(item->>'from_phone')),contact_consent_at=now(),consent_copy_version='whatsapp_customer_initiated_v1' where id=sid;
    end if;
    insert into crm_private.bia_whatsapp_messages(thread_id,provider_message_id,direction,content,message_type,metadata,occurred_at)
      values(th.id,item->>'provider_message_id','inbound',left(coalesce(item->>'content',''),6000),item->>'message_type',coalesce(item->'metadata','{}'),stamp)
      on conflict(provider_message_id) do nothing returning id into mid;
    handled:=handled||jsonb_build_array(item->>'provider_message_id');
    if mid is null then continue; end if;
    update crm_private.bia_whatsapp_threads set last_inbound_at=greatest(last_inbound_at,stamp),opted_out_at=case when trim(lower(item->>'content'))~'^(sair|parar|pare|stop|cancelar mensagens|n[aã]o me (chame|contate|mande mensagens))[.! ]*$' then now() else opted_out_at end where id=th.id;
    update crm_private.public_agent_sessions set expires_at=greatest(expires_at,now()+interval '14 days'),last_activity_at=now() where id=th.session_id and status not in('closed','blocked');
    insert into crm_private.bia_whatsapp_reply_jobs(id,thread_id) values(mid,th.id);
  end loop;
  for item in select value from jsonb_array_elements(coalesce(p_payload->'statuses','[]')) loop
    -- Correlate a Meta delivery callback even when the HTTP send response was lost.
    if coalesce(item->>'operation_id','') ~ '^[0-9a-f-]{36}$' then
      select q.id into mid from crm_private.bia_whatsapp_reply_jobs q join crm_private.bia_whatsapp_threads t on t.id=q.thread_id
        where q.id::text=item->>'operation_id' and t.channel_id=ch.id and t.peer_phone=coalesce(item->>'recipient_phone',t.peer_phone) and q.status in('sending','unknown','sent');
      if mid is not null then
        insert into crm_private.bia_whatsapp_messages(thread_id,provider_message_id,direction,content,delivery_status,occurred_at,metadata)
          select q.thread_id,item->>'provider_message_id','outbound',q.generated_content,item->>'status',(item->>'occurred_at')::timestamptz,jsonb_build_object('reply_to',q.id)
          from crm_private.bia_whatsapp_reply_jobs q where q.id=mid on conflict(provider_message_id) do nothing;
        update crm_private.bia_whatsapp_reply_jobs set status=case when item->>'status'='failed' and status<>'sent' then 'failed' else 'sent' end,updated_at=now() where id=mid;
        update crm_private.bia_whatsapp_threads set human_requested=true where id=(select thread_id from crm_private.bia_whatsapp_reply_jobs where id=mid and human_requested);
      end if;
    end if;
    update crm_private.bia_whatsapp_messages m set delivery_status=item->>'status'
    from crm_private.bia_whatsapp_threads t where m.thread_id=t.id and t.channel_id=ch.id and m.provider_message_id=item->>'provider_message_id' and m.direction='outbound'
      and (case item->>'status' when 'read' then 4 when 'delivered' then 3 when 'sent' then 2 when 'failed' then 1 else 0 end) >= (case m.delivery_status when 'read' then 4 when 'delivered' then 3 when 'sent' then 2 when 'failed' then 1 else 0 end);
    statuses:=statuses||jsonb_build_array(item->>'provider_message_id');
  end loop;
  perform private.bia_dispatch_whatsapp_replies();
  return jsonb_build_object('handled_message_ids',handled,'handled_status_ids',statuses);
end $$;

create or replace function public.bia_whatsapp_inbox(p_organization_id uuid,p_thread_id uuid default null,p_action text default 'read') returns jsonb
language plpgsql security definer set search_path='' as $$
declare ch crm_private.bia_whatsapp_channels; threads jsonb; messages jsonb;
begin
  if auth.uid() is null or not exists(select 1 from public.organization_members m join public.organizations o on o.id=m.organization_id where m.organization_id=p_organization_id and m.user_id=auth.uid() and m.active and m.role='admin' and o.active) then raise exception 'BIA_INBOX_FORBIDDEN' using errcode='42501'; end if;
  select * into ch from crm_private.bia_whatsapp_channels where organization_id=p_organization_id;
  if p_thread_id is not null and not exists(select 1 from crm_private.bia_whatsapp_threads where id=p_thread_id and channel_id=ch.id) then raise exception 'BIA_THREAD_NOT_FOUND'; end if;
  if p_action in('pause','resume') then
    if p_thread_id is null then raise exception 'BIA_THREAD_REQUIRED'; end if;
    -- Resuming never revokes an explicit customer opt-out or sends an old queued reply.
    update crm_private.bia_whatsapp_reply_jobs set status='skipped',error_code='OPERATOR_CHANGED_MODE',updated_at=now() where thread_id=p_thread_id and status='pending';
    update crm_private.bia_whatsapp_threads set human_requested=(p_action='pause') where id=p_thread_id and channel_id=ch.id;
  elsif p_action<>'read' then raise exception 'BIA_INBOX_ACTION_INVALID'; end if;
  select coalesce(jsonb_agg(row order by row.last_inbound_at desc),'[]') into threads from (
    select t.id,t.peer_phone,t.human_requested,t.opted_out_at,t.last_inbound_at,s.contact_capture->>'name' as customer_name,s.crm_record_id,
      (select count(*) from crm_private.bia_whatsapp_reply_jobs j where j.thread_id=t.id and j.status in('failed','unknown')) as errors
    from crm_private.bia_whatsapp_threads t join crm_private.public_agent_sessions s on s.id=t.session_id where t.channel_id=ch.id order by t.last_inbound_at desc limit 100
  ) row;
  select coalesce(jsonb_agg(row order by row.occurred_at,row.id),'[]') into messages from (
    select m.id,m.direction,m.content,m.message_type,m.delivery_status,m.occurred_at from crm_private.bia_whatsapp_messages m join crm_private.bia_whatsapp_threads t on t.id=m.thread_id where t.channel_id=ch.id and t.id=p_thread_id order by m.occurred_at desc,m.id desc limit 100
  ) row;
  return jsonb_build_object('enabled',coalesce(ch.enabled,false),'verified',ch.webhook_verified_at is not null,'phone',ch.display_phone_number,'threads',threads,'messages',messages);
end $$;
