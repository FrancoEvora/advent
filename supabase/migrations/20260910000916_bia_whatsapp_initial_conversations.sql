-- Business-initiated templates do not open the customer service window.
alter table crm_private.bia_whatsapp_threads alter column last_inbound_at drop not null;

-- Only a matching key: never remove a digit from a number sent to Meta.
create function crm_private.bia_phone_key(phone text) returns text
language sql immutable strict set search_path='' as $$
  select case when phone ~ '^55[1-9][0-9]9[6-9][0-9]{7}$' then left(phone,4)||substring(phone from 6) else phone end
$$;
revoke all on function crm_private.bia_phone_key(text) from public,anon,authenticated;

create table crm_private.bia_whatsapp_outbound (
  id uuid primary key,
  channel_id uuid not null references crm_private.bia_whatsapp_channels(id),
  actor_user_id uuid not null references auth.users(id),
  thread_id uuid not null references crm_private.bia_whatsapp_threads(id),
  message_id uuid not null unique references crm_private.bia_whatsapp_messages(id),
  phone text not null check(phone ~ '^55[1-9][0-9][0-9]{8,9}$'),
  template_name text not null check(template_name='bia_boas_vindas'),
  template_hash text not null check(template_hash ~ '^[a-f0-9]{64}$'),
  consent_copy_version text not null default 'operator_whatsapp_optin_v1',
  status text not null check(status in('sending','accepted','sent','delivered','read','failed','unknown')),
  provider_message_id text unique,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index bia_whatsapp_outbound_channel_created on crm_private.bia_whatsapp_outbound(channel_id,created_at desc);
create index bia_whatsapp_outbound_thread on crm_private.bia_whatsapp_outbound(thread_id);
create index bia_whatsapp_outbound_actor on crm_private.bia_whatsapp_outbound(actor_user_id);
alter table crm_private.bia_whatsapp_outbound enable row level security;
revoke all on crm_private.bia_whatsapp_outbound from public,anon,authenticated;

create function crm_private.bia_outbound_result(op crm_private.bia_whatsapp_outbound) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',op.id,'threadId',op.thread_id,'phone',op.phone,'status',
    case when op.status='sending' and op.created_at<now()-interval '2 minutes' then 'unknown' else op.status end,
    'errorCode',op.error_code,'createdAt',op.created_at)
$$;
revoke all on function crm_private.bia_outbound_result(crm_private.bia_whatsapp_outbound) from public,anon,authenticated;

-- Called only after the signed Meta webhook has verified this Bia channel.
create function crm_private.bia_outbound_status(p_channel uuid,p_item jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare op crm_private.bia_whatsapp_outbound; next_status text:=p_item->>'status'; mid text:=p_item->>'provider_message_id';
begin
  if next_status not in('accepted','sent','delivered','read','failed') or coalesce(mid,'')='' then return false; end if;
  select * into op from crm_private.bia_whatsapp_outbound q where q.channel_id=p_channel
    and (q.id::text=p_item->>'operation_id' or q.provider_message_id=mid)
    and crm_private.bia_phone_key(q.phone)=crm_private.bia_phone_key(p_item->>'recipient_phone') for update;
  if op.id is null then return false; end if;
  if op.provider_message_id is not null and op.provider_message_id<>mid then return false; end if;
  if (case next_status when 'read' then 5 when 'delivered' then 4 when 'failed' then 3 when 'sent' then 2 else 1 end)
    < (case op.status when 'read' then 5 when 'delivered' then 4 when 'failed' then 3 when 'sent' then 2 when 'accepted' then 1 else 0 end) then return true; end if;
  update crm_private.bia_whatsapp_outbound set status=next_status,provider_message_id=mid,
    error_code=case when next_status='failed' then left(p_item->>'error_code',80) end,updated_at=now() where id=op.id;
  update crm_private.bia_whatsapp_messages set provider_message_id=mid,delivery_status=next_status,
    metadata=metadata||jsonb_build_object('error_code',case when next_status='failed' then left(p_item->>'error_code',80) end) where id=op.message_id;
  -- Give the commercial agent the actual opening message, without fabricating a customer turn.
  if next_status in('accepted','sent','delivered','read') and not exists(
    select 1 from crm_private.public_agent_messages m join crm_private.bia_whatsapp_threads t on t.session_id=m.session_id
    where t.id=op.thread_id and m.metadata->>'bia_outbound_id'=op.id::text
  ) then
    insert into crm_private.public_agent_messages(session_id,direction,content,metadata)
      select t.session_id,'assistant',m.content,jsonb_build_object('bia_outbound_id',op.id,'source','whatsapp_template')
      from crm_private.bia_whatsapp_threads t join crm_private.bia_whatsapp_messages m on m.id=op.message_id where t.id=op.thread_id;
  end if;
  return true;
end $$;
revoke all on function crm_private.bia_outbound_status(uuid,jsonb) from public,anon,authenticated;

-- Service-only API: actor comes from Auth getUser(), never from the browser payload.
create function public.bia_whatsapp_outbound_admin(p_organization_id uuid,p_actor uuid,p_action text,p_args jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare ch crm_private.bia_whatsapp_channels; op crm_private.bia_whatsapp_outbound; th crm_private.bia_whatsapp_threads;
  rid uuid; phone text; body text; token text; fingerprint text; sid uuid; msg uuid; slug text;
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
    phone:=p_args->>'phone';body:=p_args->>'body';
    if coalesce(phone,'') !~ '^55[1-9][0-9][0-9]{8,9}$' or coalesce(length(body),0) not between 1 and 4000
      or p_args->>'template' is distinct from 'bia_boas_vindas' or coalesce(p_args->>'hash','') !~ '^[a-f0-9]{64}$'
      or p_args->'consent' is distinct from 'true'::jsonb then raise exception 'BIA_REQUEST_INVALID'; end if;
    if op.id is not null then
      if op.phone<>phone or op.template_hash<>p_args->>'hash' then raise exception 'BIA_REQUEST_CHANGED'; end if;
      return crm_private.bia_outbound_result(op)||jsonb_build_object('proceed',false);
    end if;
    if not ch.enabled or ch.webhook_verified_at is null then raise exception 'BIA_CHANNEL_DISABLED'; end if;
    if crm_private.bia_phone_key(phone)=crm_private.bia_phone_key(regexp_replace(ch.display_phone_number,'[^0-9]','','g')) then raise exception 'BIA_SELF_RECIPIENT'; end if;
    if exists(select 1 from crm_private.bia_whatsapp_outbound q where q.channel_id=ch.id
      and crm_private.bia_phone_key(q.phone)=crm_private.bia_phone_key(phone) and q.created_at>now()-interval '24 hours'
      and q.status<>'failed') then raise exception 'BIA_CONTACT_RECENTLY_SENT'; end if;
    if (select count(*) from crm_private.bia_whatsapp_outbound q where q.channel_id=ch.id and q.created_at>now()-interval '1 minute')>=5 then raise exception 'BIA_SEND_RATE_LIMIT'; end if;
    perform pg_advisory_xact_lock(hashtextextended('bia:'||ch.id::text||':'||crm_private.bia_phone_key(phone),0));
    if exists(select 1 from crm_private.bia_whatsapp_threads t where t.channel_id=ch.id
      and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(phone) and (t.opted_out_at is not null or t.human_requested)) then raise exception 'BIA_CONTACT_PAUSED'; end if;
    select * into th from crm_private.bia_whatsapp_threads t where t.channel_id=ch.id
      and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(phone) order by (t.peer_phone=phone) desc,t.created_at limit 1;
    if th.id is null then
      select e.slug into slug from crm_private.public_agent_experiences e where e.id=ch.experience_id and e.active;
      if slug is null then raise exception 'BIA_EXPERIENCE_INACTIVE'; end if;
      token:=encode(extensions.gen_random_bytes(32),'hex');fingerprint:=encode(extensions.gen_random_bytes(32),'hex');
      sid:=(public.open_public_agent_session(slug,token,fingerprint,jsonb_build_object('source','whatsapp'),'whatsapp',null,'Bia WhatsApp Cloud API')->>'sessionId')::uuid;
      insert into crm_private.bia_whatsapp_threads(channel_id,peer_phone,session_id,token_hash,fingerprint_hash)
        values(ch.id,phone,sid,token,fingerprint) returning * into th;
      -- Operator confirms existing WhatsApp opt-in; no fictitious customer reply or CRM conversion.
      update crm_private.public_agent_sessions set contact_capture=contact_capture||jsonb_build_object('phone','+'||phone),
        contact_consent_at=now(),consent_copy_version='operator_whatsapp_optin_v1' where id=sid;
    end if;
    if exists(select 1 from crm_private.public_agent_sessions where id=th.session_id and status in('closed','blocked')) then raise exception 'BIA_SESSION_INACTIVE'; end if;
    update crm_private.public_agent_sessions set expires_at=greatest(expires_at,now()+interval '14 days') where id=th.session_id;
    insert into crm_private.bia_whatsapp_messages(thread_id,provider_message_id,direction,content,message_type,delivery_status,metadata,occurred_at)
      values(th.id,'bia-template:'||rid,'outbound',body,'template','sending',jsonb_build_object('outbound_id',rid,'template','bia_boas_vindas'),now()) returning id into msg;
    insert into crm_private.bia_whatsapp_outbound(id,channel_id,actor_user_id,thread_id,message_id,phone,template_name,template_hash,status)
      values(rid,ch.id,p_actor,th.id,msg,phone,'bia_boas_vindas',p_args->>'hash','sending') returning * into op;
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
revoke all on function public.bia_whatsapp_outbound_admin(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.bia_whatsapp_outbound_admin(uuid,uuid,text,jsonb) to service_role;


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
    perform pg_advisory_xact_lock(hashtextextended('bia:'||ch.id::text||':'||crm_private.bia_phone_key(item->>'from_phone'),0));
    select * into th from crm_private.bia_whatsapp_threads where channel_id=ch.id and crm_private.bia_phone_key(peer_phone)=crm_private.bia_phone_key(item->>'from_phone') order by (peer_phone=item->>'from_phone') desc,created_at limit 1;
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
    update crm_private.bia_whatsapp_threads set peer_phone=item->>'from_phone',last_inbound_at=greatest(last_inbound_at,stamp),opted_out_at=case when trim(lower(item->>'content'))~'^(sair|parar|pare|stop|cancelar mensagens|n[aã]o me (chame|contate|mande mensagens))[.! ]*$' then now() else opted_out_at end where id=th.id;
    update crm_private.public_agent_sessions set expires_at=greatest(expires_at,now()+interval '14 days'),last_activity_at=now() where id=th.session_id and status not in('closed','blocked');
    insert into crm_private.bia_whatsapp_reply_jobs(id,thread_id) values(mid,th.id);
  end loop;
  for item in select value from jsonb_array_elements(coalesce(p_payload->'statuses','[]')) loop
    if crm_private.bia_outbound_status(ch.id,item) then
      statuses:=statuses||jsonb_build_array(item->>'provider_message_id');continue;
    end if;
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
    from crm_private.bia_whatsapp_threads t where m.thread_id=t.id and t.channel_id=ch.id and m.provider_message_id=item->>'provider_message_id' and m.direction='outbound' and m.message_type<>'template'
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
  select coalesce(jsonb_agg(row order by row.last_activity_at desc),'[]') into threads from (
    select t.id,t.peer_phone,t.human_requested,t.opted_out_at,t.last_inbound_at,greatest(t.created_at,t.last_inbound_at,(select max(m.occurred_at) from crm_private.bia_whatsapp_messages m where m.thread_id=t.id)) as last_activity_at,s.contact_capture->>'name' as customer_name,s.crm_record_id,
      (select count(*) from crm_private.bia_whatsapp_reply_jobs j where j.thread_id=t.id and j.status in('failed','unknown'))+
      (select count(*) from crm_private.bia_whatsapp_outbound q where q.thread_id=t.id and (q.status in('failed','unknown') or (q.status='sending' and q.created_at<now()-interval '2 minutes'))) as errors
    from crm_private.bia_whatsapp_threads t join crm_private.public_agent_sessions s on s.id=t.session_id where t.channel_id=ch.id order by last_activity_at desc limit 100
  ) row;
  select coalesce(jsonb_agg(row order by row.occurred_at,row.id),'[]') into messages from (
    select m.id,m.direction,m.content,m.message_type,case when m.delivery_status='sending' and m.created_at<now()-interval '2 minutes' then 'unknown' else m.delivery_status end as delivery_status,m.metadata->>'error_code' as error_code,m.occurred_at from crm_private.bia_whatsapp_messages m join crm_private.bia_whatsapp_threads t on t.id=m.thread_id where t.channel_id=ch.id and t.id=p_thread_id order by m.occurred_at desc,m.id desc limit 100
  ) row;
  return jsonb_build_object('enabled',coalesce(ch.enabled,false),'verified',ch.webhook_verified_at is not null,'phone',ch.display_phone_number,'threads',threads,'messages',messages);
end $$;


create or replace function public.bia_whatsapp_reply_worker(p_action text,p_args jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare j crm_private.bia_whatsapp_reply_jobs; t crm_private.bia_whatsapp_threads; c crm_private.bia_whatsapp_channels; m crm_private.bia_whatsapp_messages; slug text; why text; sid uuid;
begin
  perform crm_private.assert_public_agent_service_role();
  if p_action='claim' then
    update crm_private.bia_whatsapp_reply_jobs set status='unknown',error_code='SEND_INTERRUPTED',updated_at=now() where status='sending' and lease_until<now();
    update crm_private.bia_whatsapp_reply_jobs set status=case when attempts<3 then 'pending' else 'failed' end,lease=null,lease_until=null,updated_at=now() where status='processing' and lease_until<now();
    for j in select * from crm_private.bia_whatsapp_reply_jobs q where q.status='pending' and q.available_at<=now() order by q.created_at,q.id limit 30 for update skip locked loop
      if not pg_try_advisory_xact_lock(hashtextextended('bia-reply:'||j.thread_id::text,0)) then continue; end if;
      if exists(select 1 from crm_private.bia_whatsapp_reply_jobs other where other.thread_id=j.thread_id and other.id<>j.id and (other.status in('processing','sending') or (other.status='pending' and (other.created_at,other.id)<(j.created_at,j.id)))) then continue; end if;
      select * into t from crm_private.bia_whatsapp_threads where id=j.thread_id;
      select * into c from crm_private.bia_whatsapp_channels where id=t.channel_id;
      select * into m from crm_private.bia_whatsapp_messages where id=j.id;
      why:=null;
      if not c.enabled or c.webhook_verified_at is null then why:='CHANNEL_DISABLED';
      elsif t.opted_out_at is not null then why:='CONTACT_OPTED_OUT';
      elsif t.human_requested then why:='HUMAN_ATTENDING';
      elsif (t.last_inbound_at is null or t.last_inbound_at<=now()-interval '23 hours 55 minutes') then why:='WINDOW_EXPIRED';
      elsif not exists(select 1 from crm_private.public_agent_sessions s where s.id=t.session_id and s.status not in('closed','blocked')) then why:='SESSION_INACTIVE'; end if;
      if why is not null then update crm_private.bia_whatsapp_reply_jobs set status='skipped',error_code=why where id=j.id; continue; end if;
      update crm_private.bia_whatsapp_reply_jobs set status='processing',attempts=attempts+1,lease=gen_random_uuid(),lease_until=now()+interval '3 minutes',updated_at=now() where id=j.id returning * into j;
      select e.slug into slug from crm_private.public_agent_experiences e where e.id=c.experience_id and e.active;
      return jsonb_build_object('id',j.id,'lease',j.lease,'organizationId',c.organization_id,'phone',t.peer_phone,'slug',slug,'tokenHash',t.token_hash,'fingerprintHash',t.fingerprint_hash,'message',m.content,'messageType',m.message_type,'metadata',m.metadata,'generatedContent',j.generated_content,'humanRequested',j.human_requested);
    end loop;
    return '{}';
  end if;
  select * into j from crm_private.bia_whatsapp_reply_jobs where id=(p_args->>'id')::uuid for update;
  if j.id is null or j.lease is distinct from (p_args->>'lease')::uuid or j.lease_until<=now() then raise exception 'BIA_LEASE_CHANGED'; end if;
  select * into t from crm_private.bia_whatsapp_threads where id=j.thread_id;
  select * into c from crm_private.bia_whatsapp_channels where id=t.channel_id;
  if p_action='send' and j.status='processing' then
    if not c.enabled or t.opted_out_at is not null or t.human_requested or (t.last_inbound_at is null or t.last_inbound_at<=now()-interval '23 hours 55 minutes') then
      update crm_private.bia_whatsapp_reply_jobs set status='skipped',error_code='CONTEXT_CHANGED' where id=j.id;
      return jsonb_build_object('proceed',false);
    end if;
    if length(trim(coalesce(p_args->>'content',''))) not between 1 and 4096 then raise exception 'BIA_REPLY_INVALID'; end if;
    update crm_private.bia_whatsapp_reply_jobs set status='sending',generated_content=p_args->>'content',human_requested=coalesce((p_args->>'humanRequested')::boolean,false),updated_at=now() where id=j.id;
    return jsonb_build_object('proceed',true);
  elsif p_action='finish' and j.status in('sending','sent') then
    if coalesce(p_args->>'providerMessageId','')='' then raise exception 'BIA_SEND_RESULT_INVALID'; end if;
    insert into crm_private.bia_whatsapp_messages(thread_id,provider_message_id,direction,content,delivery_status,occurred_at,metadata) values(j.thread_id,p_args->>'providerMessageId','outbound',j.generated_content,'accepted',now(),jsonb_build_object('reply_to',j.id)) on conflict(provider_message_id) do nothing;
    update crm_private.bia_whatsapp_reply_jobs set status='sent',updated_at=now() where id=j.id;
    if j.human_requested then update crm_private.bia_whatsapp_threads set human_requested=true where id=t.id; end if;
    -- Existing sales commits keep CRM links. Tag those records with the actual channel.
    update public.crm_messages set channel='whatsapp',metadata=metadata||jsonb_build_object('bia_whatsapp_thread_id',t.id) where organization_id=c.organization_id and metadata->>'public_agent_session_id'=t.session_id::text and channel='site';
    return jsonb_build_object('ok',true);
  elsif p_action='fail' and j.status in('processing','sending') then
    update crm_private.bia_whatsapp_reply_jobs set status=case when j.status='sending' then 'unknown' when attempts>=3 then 'failed' else 'pending' end,available_at=now()+interval '1 minute'*greatest(attempts,1),error_code=left(p_args->>'error',120),updated_at=now() where id=j.id;
    return jsonb_build_object('ok',true);
  end if;
  raise exception 'BIA_WORKER_ACTION_INVALID';
end $$;
