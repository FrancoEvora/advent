-- Separate sales channel. Existing Arisa credentials, conversations and CRM records are preserved.
create table crm_private.bia_whatsapp_channels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id),
  experience_id uuid not null references crm_private.public_agent_experiences(id),
  phone_number_id text not null unique check (phone_number_id ~ '^[0-9]{1,64}$'),
  waba_id text not null check (waba_id ~ '^[0-9]{1,64}$'),
  display_phone_number text not null,
  graph_api_version text not null check (graph_api_version ~ '^v[0-9]+[.][0-9]+$'),
  access_token_vault_id uuid not null references vault.secrets(id),
  app_secret_vault_id uuid not null references vault.secrets(id),
  verify_token_vault_id uuid not null references vault.secrets(id),
  enabled boolean not null default false,
  webhook_verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique(organization_id,experience_id)
);
create table crm_private.bia_whatsapp_threads (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references crm_private.bia_whatsapp_channels(id),
  peer_phone text not null check (peer_phone ~ '^[0-9]{8,20}$'),
  session_id uuid not null unique references crm_private.public_agent_sessions(id),
  token_hash text not null,
  fingerprint_hash text not null,
  human_requested boolean not null default false,
  opted_out_at timestamptz,
  last_inbound_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique(channel_id,peer_phone)
);
create table crm_private.bia_whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references crm_private.bia_whatsapp_threads(id),
  provider_message_id text not null unique,
  direction text not null check(direction in ('inbound','outbound')),
  content text not null,
  message_type text not null default 'text',
  metadata jsonb not null default '{}',
  delivery_status text,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index bia_whatsapp_messages_thread on crm_private.bia_whatsapp_messages(thread_id,occurred_at);
create table crm_private.bia_whatsapp_reply_jobs (
  id uuid primary key references crm_private.bia_whatsapp_messages(id),
  thread_id uuid not null references crm_private.bia_whatsapp_threads(id),
  status text not null default 'pending' check(status in('pending','processing','sending','sent','skipped','failed','unknown')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease uuid,
  lease_until timestamptz,
  generated_content text,
  human_requested boolean not null default false,
  error_code text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index bia_whatsapp_reply_jobs_pending on crm_private.bia_whatsapp_reply_jobs(available_at,created_at) where status='pending';
create index bia_whatsapp_reply_jobs_thread on crm_private.bia_whatsapp_reply_jobs(thread_id,status,lease_until);
alter table crm_private.bia_whatsapp_channels enable row level security;
alter table crm_private.bia_whatsapp_threads enable row level security;
alter table crm_private.bia_whatsapp_messages enable row level security;
alter table crm_private.bia_whatsapp_reply_jobs enable row level security;
revoke all on crm_private.bia_whatsapp_channels,crm_private.bia_whatsapp_threads,crm_private.bia_whatsapp_messages,crm_private.bia_whatsapp_reply_jobs from public,anon,authenticated;

create function public.bia_whatsapp_credentials(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform crm_private.assert_public_agent_service_role();
  select jsonb_build_object('organization_id',c.organization_id,'enabled',c.enabled,'waba_id',c.waba_id,'phone_number_id',c.phone_number_id,'graph_api_version',c.graph_api_version,'display_phone_number',c.display_phone_number,'access_token',a.decrypted_secret,'app_secret',s.decrypted_secret,'verify_token',v.decrypted_secret)
    into result from crm_private.bia_whatsapp_channels c
    join vault.decrypted_secrets a on a.id=c.access_token_vault_id
    join vault.decrypted_secrets s on s.id=c.app_secret_vault_id
    join vault.decrypted_secrets v on v.id=c.verify_token_vault_id
    where c.organization_id=p_organization_id;
  return result;
end $$;
revoke all on function public.bia_whatsapp_credentials(uuid) from public,anon,authenticated;
grant execute on function public.bia_whatsapp_credentials(uuid) to service_role;

create function public.bia_whatsapp_verify_webhook(p_organization_id uuid,p_phone_number_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform crm_private.assert_public_agent_service_role();
  update crm_private.bia_whatsapp_channels set webhook_verified_at=now() where organization_id=p_organization_id and phone_number_id=p_phone_number_id;
  if not found then raise exception 'BIA_CHANNEL_NOT_FOUND'; end if;
  return jsonb_build_object('ok',true);
end $$;
revoke all on function public.bia_whatsapp_verify_webhook(uuid,text) from public,anon,authenticated;
grant execute on function public.bia_whatsapp_verify_webhook(uuid,text) to service_role;

-- Separate secret for the scheduled worker; credentials never reach a browser or a job payload.
select vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'bia_whatsapp_worker_secret');
create function public.bia_whatsapp_worker_secret() returns text
language plpgsql security definer set search_path='' as $$
begin
  perform crm_private.assert_public_agent_service_role();
  return (select decrypted_secret from vault.decrypted_secrets where name='bia_whatsapp_worker_secret');
end $$;
revoke all on function public.bia_whatsapp_worker_secret() from public,anon,authenticated;
grant execute on function public.bia_whatsapp_worker_secret() to service_role;

create function private.bia_dispatch_whatsapp_replies() returns bigint
language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from crm_private.bia_whatsapp_reply_jobs where (status='pending' and available_at<=now()) or (status in('processing','sending') and lease_until<now())) then return null; end if;
  return net.http_post(url:='https://qsdffayasuzsmngteika.supabase.co/functions/v1/bia-whatsapp-replies',headers:=jsonb_build_object('content-type','application/json','x-bia-worker-secret',(select decrypted_secret from vault.decrypted_secrets where name='bia_whatsapp_worker_secret')),body:='{}',timeout_milliseconds:=150000);
end $$;
revoke all on function private.bia_dispatch_whatsapp_replies() from public,anon,authenticated;
grant execute on function private.bia_dispatch_whatsapp_replies() to service_role;

create function public.bia_whatsapp_webhook(p_organization_id uuid,p_phone_number_id text,p_payload jsonb) returns jsonb
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
      perform public.update_public_agent_contact_capture_v3(slug,token,fingerprint,jsonb_build_object('phone','+'||(item->>'from_phone')),true,null,'whatsapp_customer_initiated_v1');
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
revoke all on function public.bia_whatsapp_webhook(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.bia_whatsapp_webhook(uuid,text,jsonb) to service_role;

create function public.bia_session_channel(p_slug text,p_session_token_hash text,p_fingerprint_hash text) returns text
language plpgsql security definer set search_path='' as $$
begin
  perform crm_private.assert_public_agent_service_role();
  return case when exists(select 1 from crm_private.bia_whatsapp_threads t join crm_private.bia_whatsapp_channels c on c.id=t.channel_id join crm_private.public_agent_experiences e on e.id=c.experience_id where e.slug=p_slug and t.token_hash=p_session_token_hash and t.fingerprint_hash=p_fingerprint_hash) then 'whatsapp' else 'site' end;
end $$;
revoke all on function public.bia_session_channel(text,text,text) from public,anon,authenticated;
grant execute on function public.bia_session_channel(text,text,text) to service_role;

create function public.bia_whatsapp_reply_worker(p_action text,p_args jsonb default '{}') returns jsonb
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
      elsif t.last_inbound_at<=now()-interval '23 hours 55 minutes' then why:='WINDOW_EXPIRED';
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
    if not c.enabled or t.opted_out_at is not null or t.human_requested or t.last_inbound_at<=now()-interval '23 hours 55 minutes' then
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
revoke all on function public.bia_whatsapp_reply_worker(text,jsonb) from public,anon,authenticated;
grant execute on function public.bia_whatsapp_reply_worker(text,jsonb) to service_role;

select cron.schedule('evora-bia-whatsapp-replies-1m','* * * * *','select private.bia_dispatch_whatsapp_replies();');

-- Human operators receive only the selected organization's commercial conversations, never runtime secrets.
create function public.bia_whatsapp_inbox(p_organization_id uuid,p_thread_id uuid default null,p_action text default 'read') returns jsonb
language plpgsql security definer set search_path='' as $$
declare ch crm_private.bia_whatsapp_channels; threads jsonb; messages jsonb;
begin
  if auth.uid() is null or not exists(select 1 from public.organization_members m join public.organizations o on o.id=m.organization_id where m.organization_id=p_organization_id and m.user_id=auth.uid() and m.active and m.role='admin' and o.active) then raise exception 'BIA_INBOX_FORBIDDEN' using errcode='42501'; end if;
  select * into ch from crm_private.bia_whatsapp_channels where organization_id=p_organization_id;
  if p_thread_id is not null and not exists(select 1 from crm_private.bia_whatsapp_threads where id=p_thread_id and channel_id=ch.id) then raise exception 'BIA_THREAD_NOT_FOUND'; end if;
  if p_action in('pause','resume') then
    if p_thread_id is null then raise exception 'BIA_THREAD_REQUIRED'; end if;
    -- Resuming never revokes an explicit customer opt-out or sends an old queued reply.
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
revoke all on function public.bia_whatsapp_inbox(uuid,uuid,text) from public,anon;
grant execute on function public.bia_whatsapp_inbox(uuid,uuid,text) to authenticated;
