-- All fixtures and pg_net requests roll back; no provider is contacted.
begin;
set local statement_timeout='120s';
set local lock_timeout='5s';
do $test$
declare org uuid;actor uuid;first_id uuid;second_id uuid;thread_id uuid;job jsonb;result jsonb;refused boolean;phone text:='551199'||lpad(floor(random()*10000000)::bigint::text,7,'0');receiver text:='990000000000099';provider text:='wamid.fixture.'||gen_random_uuid()::text;
begin
  select m.organization_id,m.user_id into org,actor from public.organization_members m join public.organizations o on o.id=m.organization_id where m.active and m.role='admin' and o.active order by m.organization_id,m.user_id limit 1;
  if org is null then raise exception 'Active admin fixture required';end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','service_role')::text,true);
  if has_function_privilege('authenticated','public.arisa_whatsapp_reply_worker(text,jsonb)','EXECUTE') or has_table_privilege('anon','crm_private.arisa_whatsapp_reply_jobs','SELECT') then raise exception 'Private reply queue exposed';end if;
  update crm_private.whatsapp_runtime_settings set enabled=false,phone_number_id=receiver where organization_id=org;
  insert into crm_private.arisa_whatsapp_channel(organization_id,enabled,auto_reply_enabled,updated_by,webhook_verified_at) values(org,true,true,actor,now()) on conflict(organization_id) do update set enabled=true,auto_reply_enabled=true,updated_by=actor,webhook_verified_at=now();
  result=public.arisa_whatsapp_webhook(org,receiver,jsonb_build_object('messages',jsonb_build_array(jsonb_build_object('provider_message_id',provider,'from_phone',phone,'content','Boa noite','message_type','text','occurred_at',now()-interval '3 seconds'))));
  select m.id,m.thread_id into first_id,thread_id from public.arisa_whatsapp_messages m where organization_id=org and provider_message_id=provider;
  if first_id is null or not exists(select 1 from crm_private.arisa_whatsapp_reply_jobs where id=first_id) then raise exception 'First-time inbound not queued';end if;
  perform public.arisa_whatsapp_webhook(org,receiver,jsonb_build_object('messages',jsonb_build_array(jsonb_build_object('provider_message_id',provider,'from_phone',phone,'content','duplicate','occurred_at',now()))));
  if (select count(*) from crm_private.arisa_whatsapp_reply_jobs where id=first_id)<>1 then raise exception 'Duplicate job';end if;
  job=public.arisa_whatsapp_reply_worker('claim');
  if job->>'id'<>first_id::text or jsonb_array_length(job->'history')<>1 or job->'history'->0->>'content'<>'Boa noite' then raise exception 'Wrong or cross-conversation history: %',job;end if;
  if public.arisa_whatsapp_reply_worker('claim')<>'{}'::jsonb then raise exception 'Concurrent claim repeated job';end if;
  result=public.arisa_whatsapp_reply_worker('send',jsonb_build_object('id',first_id,'lease',job->>'lease','content','Boa noite! Como posso ajudar?','model','fixture','usage','{}'::jsonb));
  if result->>'proceed'<>'true' then raise exception 'Valid reply was fenced';end if;
  perform public.arisa_whatsapp_reply_worker('fail',jsonb_build_object('id',first_id,'lease',job->>'lease','error','AMBIGUOUS_NETWORK','sending',true));
  if (select status from crm_private.arisa_whatsapp_reply_jobs where id=first_id)<>'unknown' or public.arisa_whatsapp_reply_worker('claim')<>'{}'::jsonb then raise exception 'Uncertain send retried';end if;
  perform public.arisa_whatsapp_webhook(org,receiver,jsonb_build_object('messages',jsonb_build_array(jsonb_build_object('provider_message_id',provider||'.2','from_phone',phone,'content','Preciso de uma informação','occurred_at',now()-interval '2 seconds'))));
  select id into second_id from public.arisa_whatsapp_messages where organization_id=org and provider_message_id=provider||'.2';
  job=public.arisa_whatsapp_reply_worker('claim');
  if job->>'id'<>second_id::text or jsonb_array_length(job->'history')<>2 then raise exception 'Conversation did not continue';end if;
  perform public.arisa_whatsapp_webhook(org,receiver,jsonb_build_object('messages',jsonb_build_array(jsonb_build_object('provider_message_id',provider||'.3','from_phone',phone,'content','PARAR','occurred_at',now()-interval '1 second'))));
  result=public.arisa_whatsapp_reply_worker('send',jsonb_build_object('id',second_id,'lease',job->>'lease','content','Not allowed'));
  if result->>'proceed'<>'false' or public.arisa_whatsapp_reply_worker('claim')<>'{}'::jsonb then raise exception 'Opt-out sent reply';end if;
  perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
  refused=false;begin perform public.arisa_whatsapp_reply_worker('claim');exception when insufficient_privilege then refused=true;end;
  if not refused then raise exception 'Non-service queue access accepted';end if;
  raise notice 'PASS: first-time inbound, deduplication, private history, lease fencing, uncertain-send suppression, context continuation and opt-out';
end $test$;
rollback;

