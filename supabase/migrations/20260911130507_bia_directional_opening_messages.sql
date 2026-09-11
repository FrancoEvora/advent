-- Preserve historical welcome outreach while routing all new initiations to referral.
alter table crm_private.bia_whatsapp_outbound drop constraint bia_whatsapp_outbound_template_name_check;
alter table crm_private.bia_whatsapp_outbound add constraint bia_whatsapp_outbound_template_name_check
  check(template_name in ('bia_boas_vindas','bia_indicacao_investimento'));
alter table crm_private.bia_whatsapp_reply_jobs add column opening_template text
  check(opening_template is null or opening_template='bia_boas_vindas');

CREATE OR REPLACE FUNCTION public.bia_whatsapp_outbound_admin(p_organization_id uuid, p_actor uuid, p_action text, p_args jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if p_action='recipient' then
    if coalesce(p_args->>'phone','') !~ '^55[1-9][0-9][0-9]{8,9}$' then raise exception 'BIA_PHONE_INVALID'; end if;
    -- Only a unique CRM name for this organization and phone can personalize outreach.
    return jsonb_build_object('name',(select case when count(distinct trim(r.person_name))=1 then min(trim(r.person_name)) end
      from public.crm_records r where r.organization_id=p_organization_id
      and nullif(trim(r.person_name),'') is not null
      and crm_private.bia_phone_key(case when length(regexp_replace(r.phone,'[^0-9]','','g')) in(10,11)
        then '55'||regexp_replace(r.phone,'[^0-9]','','g') else regexp_replace(r.phone,'[^0-9]','','g') end)
        =crm_private.bia_phone_key(p_args->>'phone')));
  end if;
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
      or p_args->>'template' is distinct from 'bia_indicacao_investimento' or coalesce(p_args->>'hash','') !~ '^[a-f0-9]{64}$'
      or p_args->'consent' is distinct from 'true'::jsonb then raise exception 'BIA_REQUEST_INVALID'; end if;
    if op.id is not null then
      if op.phone<>v_phone or op.template_hash<>p_args->>'hash' or (select content from crm_private.bia_whatsapp_messages where id=op.message_id) is distinct from body then raise exception 'BIA_REQUEST_CHANGED'; end if;
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
      values(th.id,'bia-template:'||rid,'outbound',body,'template','sending',jsonb_build_object('outbound_id',rid,'template','bia_indicacao_investimento'),now()) returning id into msg;
    insert into crm_private.bia_whatsapp_outbound(id,channel_id,actor_user_id,thread_id,message_id,phone,template_name,template_hash,status)
      values(rid,ch.id,p_actor,th.id,msg,v_phone,'bia_indicacao_investimento',p_args->>'hash','sending') returning * into op;
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
end $function$
;
revoke all on function public.bia_whatsapp_outbound_admin(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.bia_whatsapp_outbound_admin(uuid,uuid,text,jsonb) to service_role;

CREATE OR REPLACE FUNCTION public.bia_whatsapp_reply_worker(p_action text, p_args jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      update crm_private.bia_whatsapp_reply_jobs set opening_template=case when opening_template is not null then opening_template
        when coalesce(generated_content,'')='' and not exists(select 1 from crm_private.bia_whatsapp_messages prior where prior.thread_id=j.thread_id
          and prior.direction='outbound' and coalesce(prior.delivery_status,'accepted')<>'failed')
        and not exists(select 1 from crm_private.bia_whatsapp_reply_jobs prior where prior.thread_id=j.thread_id
          and prior.id<>j.id and prior.status in('sending','unknown','sent'))
        then 'bia_boas_vindas' end,
        status='processing',attempts=attempts+1,lease=gen_random_uuid(),lease_until=now()+interval '3 minutes',updated_at=now() where id=j.id returning * into j;
      select e.slug into slug from crm_private.public_agent_experiences e where e.id=c.experience_id and e.active;
      return jsonb_build_object('id',j.id,'lease',j.lease,'organizationId',c.organization_id,'phone',t.peer_phone,'slug',slug,'tokenHash',t.token_hash,'fingerprintHash',t.fingerprint_hash,'message',m.content,'messageType',m.message_type,'metadata',m.metadata,'generatedContent',j.generated_content,'humanRequested',j.human_requested,'openingTemplate',j.opening_template);
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
end $function$
;

-- Persist the actual welcome exchange after the send is accepted or reconciled.
-- The existing service-only worker/webhook also runs this invoker trigger.
create function crm_private.bia_welcome_context() returns trigger
language plpgsql set search_path='' as $$
declare sid uuid; incoming text;
begin
  if new.opening_template='bia_boas_vindas' and new.status='sent' and old.status is distinct from 'sent' then
    select t.session_id,m.content into sid,incoming from crm_private.bia_whatsapp_threads t
      join crm_private.bia_whatsapp_messages m on m.id=new.id where t.id=new.thread_id;
    if not exists(select 1 from crm_private.public_agent_messages where session_id=sid and metadata->>'bia_welcome_job_id'=new.id::text) then
      insert into crm_private.public_agent_messages(session_id,direction,content,metadata) values
        (sid,'user',coalesce(nullif(incoming,''),'[Arquivo recebido pelo WhatsApp]'),jsonb_build_object('bia_welcome_job_id',new.id,'source','whatsapp')),
        (sid,'assistant',new.generated_content,jsonb_build_object('bia_welcome_job_id',new.id,'source','whatsapp','template','bia_boas_vindas'));
      update crm_private.public_agent_sessions set stage=case when stage='welcome' then 'discovery' else stage end,
        message_count=message_count+1,last_activity_at=now() where id=sid;
    end if;
  end if;
  return new;
end $$;
revoke all on function crm_private.bia_welcome_context() from public,anon,authenticated;
create trigger bia_welcome_context after update of status on crm_private.bia_whatsapp_reply_jobs
  for each row execute function crm_private.bia_welcome_context();
