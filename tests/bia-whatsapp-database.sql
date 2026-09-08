-- Run in a transaction against a configured channel. Every fixture and queued HTTP call is rolled back.
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$
declare c crm_private.bia_whatsapp_channels; result jsonb; payload jsonb; job jsonb; t uuid; n integer;
begin
  select * into c from crm_private.bia_whatsapp_channels limit 1;
  if c.id is null then raise exception 'Configure a channel before running this test'; end if;
  update crm_private.bia_whatsapp_channels set enabled=true,webhook_verified_at=now() where id=c.id;
  payload:=jsonb_build_object('messages',jsonb_build_array(jsonb_build_object('provider_message_id','wamid.bia-rollback-test','from_phone','5534999999901','content','Teste transacional','message_type','text','occurred_at',now(),'metadata','{}'::jsonb)),'statuses','[]'::jsonb);
  perform public.bia_whatsapp_webhook(c.organization_id,c.phone_number_id,payload);
  perform public.bia_whatsapp_webhook(c.organization_id,c.phone_number_id,payload);
  select count(*),min(thread_id::text)::uuid into n,t from crm_private.bia_whatsapp_messages where provider_message_id='wamid.bia-rollback-test';
  if n<>1 then raise exception 'Duplicate inbound was not deduplicated'; end if;
  if (select count(*) from crm_private.bia_whatsapp_reply_jobs where thread_id=t)<>1 then raise exception 'Duplicate reply job'; end if;
  job:=public.bia_whatsapp_reply_worker('claim','{}');
  if job->>'id' is null then raise exception 'Expected one leased job'; end if;
  if public.bia_whatsapp_reply_worker('claim','{}')<>'{}'::jsonb then raise exception 'Concurrent claim bypassed serialization'; end if;
  update crm_private.bia_whatsapp_threads set human_requested=true where id=t;
  result:=public.bia_whatsapp_reply_worker('send',job||jsonb_build_object('content','Test reply'));
  if result->>'proceed'<>'false' then raise exception 'Pause did not stop a pending send'; end if;
  begin
    perform public.bia_whatsapp_webhook(gen_random_uuid(),c.phone_number_id,payload);
    raise exception 'Cross-organization delivery accepted';
  exception when others then if sqlerrm<>'BIA_CHANNEL_NOT_FOUND' then raise; end if; end;
  if has_function_privilege('anon','public.bia_whatsapp_credentials(uuid)','EXECUTE') or has_function_privilege('authenticated','public.bia_whatsapp_reply_worker(text,jsonb)','EXECUTE') then raise exception 'Runtime exposed to browser roles'; end if;
  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  begin
    perform public.bia_whatsapp_inbox(c.organization_id);
    raise exception 'Anonymous inbox access accepted';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
