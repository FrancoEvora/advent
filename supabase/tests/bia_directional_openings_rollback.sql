-- A single rolled-back transaction: no fixture or queued HTTP request survives.
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$
declare ch crm_private.bia_whatsapp_channels; event jsonb; job jsonb; reply jsonb; tid uuid; sid uuid;
  tag text:=gen_random_uuid()::text; receiver text:='5534999997654'; actor uuid; operation uuid:=gen_random_uuid();
begin
  select * into ch from crm_private.bia_whatsapp_channels limit 1;
  select user_id into actor from public.organization_members where organization_id=ch.organization_id and active and role='admin' limit 1;
  update crm_private.bia_whatsapp_channels set enabled=true,webhook_verified_at=now() where id=ch.id;
  -- Isolate claim selection from any real queued work; rolled back before any worker can see it.
  update crm_private.bia_whatsapp_reply_jobs set available_at=now()+interval '1 day' where status='pending';
  event:=jsonb_build_object('provider_message_id','qa-welcome-'||tag,'from_phone',receiver,'content','Olá, gostaria de conhecer os lotes','message_type','text','occurred_at',now(),'metadata','{}'::jsonb);
  perform public.bia_whatsapp_webhook(ch.organization_id,ch.phone_number_id,jsonb_build_object('messages',jsonb_build_array(event),'statuses','[]'::jsonb));
  perform public.bia_whatsapp_webhook(ch.organization_id,ch.phone_number_id,jsonb_build_object('messages',jsonb_build_array(event),'statuses','[]'::jsonb));
  select thread_id into tid from crm_private.bia_whatsapp_messages where provider_message_id='qa-welcome-'||tag;
  select session_id into sid from crm_private.bia_whatsapp_threads where id=tid;
  if (select count(*) from crm_private.bia_whatsapp_reply_jobs where thread_id=tid)<>1 then raise exception 'Duplicated inbound queued twice'; end if;
  job:=public.bia_whatsapp_reply_worker('claim','{}');
  if job->>'openingTemplate' is distinct from 'bia_boas_vindas' or job->>'phone'<>receiver then raise exception 'First inbound did not choose welcome'; end if;
  reply:=jsonb_build_object('id',job->>'id','lease',job->>'lease','content','Boas-vindas do teste transacional.');
  perform public.bia_whatsapp_reply_worker('send',reply);
  perform public.bia_whatsapp_reply_worker('finish',reply||jsonb_build_object('providerMessageId','qa-welcome-reply-'||tag));
  perform public.bia_whatsapp_reply_worker('finish',reply||jsonb_build_object('providerMessageId','qa-welcome-reply-'||tag));
  if (select count(*) from crm_private.public_agent_messages where session_id=sid and metadata->>'bia_welcome_job_id'=job->>'id')<>2 then raise exception 'Welcome context lost or duplicated'; end if;
  event:=event||jsonb_build_object('provider_message_id','qa-followup-'||tag,'content','Quero uma simulação');
  perform public.bia_whatsapp_webhook(ch.organization_id,ch.phone_number_id,jsonb_build_object('messages',jsonb_build_array(event),'statuses','[]'::jsonb));
  job:=public.bia_whatsapp_reply_worker('claim','{}');
  if job->>'openingTemplate' is not null then raise exception 'Followup repeated welcome'; end if;
  update crm_private.bia_whatsapp_reply_jobs set status='skipped' where id=(job->>'id')::uuid;

  -- A response to Bia's referral belongs to the existing conversation and skips welcome.
  receiver:='5534999997543';
  reply:=jsonb_build_object('id',operation,'phone',receiver,'consent',true,'template','bia_indicacao_investimento','hash',repeat('a',64),'body','Olá, tudo bem! Indicação de teste.');
  begin
    perform public.bia_whatsapp_outbound_admin(ch.organization_id,actor,'start',reply||jsonb_build_object('template','bia_boas_vindas'));
    raise exception 'Old outbound template accepted';
  exception when others then if sqlerrm<>'BIA_REQUEST_INVALID' then raise; end if; end;
  perform public.bia_whatsapp_outbound_admin(ch.organization_id,actor,'start',reply);
  perform public.bia_whatsapp_outbound_admin(ch.organization_id,actor,'finish',jsonb_build_object('id',operation,'status','accepted','providerMessageId','qa-referral-'||tag,'recipientPhone',receiver));
  event:=event||jsonb_build_object('provider_message_id','qa-referral-response-'||tag,'from_phone',receiver,'content','Podemos conversar agora');
  perform public.bia_whatsapp_webhook(ch.organization_id,ch.phone_number_id,jsonb_build_object('messages',jsonb_build_array(event),'statuses','[]'::jsonb));
  job:=public.bia_whatsapp_reply_worker('claim','{}');
  if job->>'phone'<>receiver or job->>'openingTemplate' is not null then raise exception 'Referral response repeated welcome'; end if;
  if has_function_privilege('anon','public.bia_whatsapp_outbound_admin(uuid,uuid,text,jsonb)','execute')
    or has_function_privilege('authenticated','public.bia_whatsapp_reply_worker(text,jsonb)','execute')
    or has_function_privilege('anon','crm_private.bia_welcome_context()','execute') then raise exception 'Private routing exposed'; end if;
end $$;
rollback;
