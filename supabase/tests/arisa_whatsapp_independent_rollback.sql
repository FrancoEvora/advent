-- Transactional fixture test only: no Vault reads, network calls, or sends.
begin;
set local statement_timeout='120s';
set local lock_timeout='5s';
do $test$
declare
  org uuid;actor uuid;ct uuid;thread uuid;op uuid;result jsonb;again jsonb;args jsonb;before_crm bigint;before_jobs bigint;n bigint;refused boolean;
  v_phone text:='5599'||left(replace(gen_random_uuid()::text,'-',''),8); receiver text:='990000000000001';
  key_a text:=encode(extensions.gen_random_bytes(32),'hex');key_b text:=encode(extensions.gen_random_bytes(32),'hex');hash_a text:=repeat('a',64);hash_b text:=repeat('b',64);
  inbound_id text:='wamid.fixture.'||gen_random_uuid()::text;status_id text:='wamid.fixture.status.'||gen_random_uuid()::text;
begin
  -- Random fixture v_phone stays numeric and no external service is invoked.
  v_phone:='5599'||lpad(floor(random()*100000000)::bigint::text,8,'0');
  select m.organization_id,m.user_id into org,actor from public.organization_members m join public.organizations o on o.id=m.organization_id where m.active and m.role='admin' and o.active order by m.organization_id,m.user_id limit 1;
  if org is null then raise exception 'Fixture needs an active organization administrator';end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','service_role')::text,true);
  if has_table_privilege('authenticated','public.arisa_whatsapp_threads','INSERT,UPDATE,DELETE') or has_table_privilege('authenticated','public.arisa_whatsapp_messages','INSERT,UPDATE,DELETE') or has_table_privilege('anon','public.arisa_whatsapp_messages','SELECT') then raise exception 'Channel direct access exposed';end if;
  if has_function_privilege('authenticated','public.arisa_whatsapp_service(text,uuid,uuid,jsonb)','EXECUTE') or has_function_privilege('anon','public.arisa_whatsapp_webhook(uuid,text,jsonb)','EXECUTE') or has_function_privilege('authenticated','public.arisa_whatsapp_credentials(uuid)','EXECUTE') then raise exception 'Server RPC exposed';end if;
  select count(*) into before_crm from public.crm_records where organization_id=org;
  select count(*) into before_jobs from public.crm_ai_jobs where organization_id=org;
  insert into crm_private.whatsapp_runtime_settings(organization_id,phone_number_id,waba_id,graph_api_version,enabled) values(org,receiver,'990000000000002','v26.0',true) on conflict(organization_id) do update set phone_number_id=receiver,waba_id='990000000000002',graph_api_version='v26.0',enabled=true;
  insert into crm_private.arisa_whatsapp_channel(organization_id,enabled,webhook_verified_at) values(org,false,now()) on conflict(organization_id) do update set enabled=false,webhook_verified_at=now();
  insert into public.contacts(organization_id,contact_type,name,phone,active) values(org,'fornecedor','QA fornecedor WhatsApp rollback',v_phone,true) returning id into ct;

  -- Disabled sending still receives administrative traffic and never falls to Bia.
  result=public.arisa_whatsapp_webhook(org,receiver,jsonb_build_object('messages',jsonb_build_array(jsonb_build_object('provider_message_id',inbound_id,'from_phone',v_phone,'profile_name','QA fornecedor','content','Podemos alinhar a drenagem às 10h.','message_type','text','occurred_at',now()))));
  if not (result->'handled_message_ids' @> jsonb_build_array(inbound_id)) then raise exception 'Disabled Arisa fell through to CRM';end if;
  select id into thread from public.arisa_whatsapp_threads t where t.organization_id=org and t.phone_number_id=receiver and t.phone=v_phone and t.contact_id=ct;
  if thread is null then raise exception 'Administrative thread missing';end if;
  result=public.arisa_whatsapp_webhook(org,receiver,jsonb_build_object('messages',jsonb_build_array(jsonb_build_object('provider_message_id',inbound_id,'from_phone',v_phone,'content','Duplicate','occurred_at',now()))));
  select count(*) into n from public.arisa_whatsapp_messages where organization_id=org and provider_message_id=inbound_id;
  if n<>1 then raise exception 'Inbound duplicate persisted';end if;
  result=public.arisa_whatsapp_service('list',org,actor,jsonb_build_object('thread_id',thread));
  if jsonb_array_length(result->'messages')<>1 then raise exception 'Thread history unavailable';end if;

  result=public.arisa_whatsapp_service('resolve',org,actor,jsonb_build_object('phone',v_phone));
  if result->>'contact_id'<>ct::text then raise exception 'Canonical contact resolution failed';end if;
  again=public.arisa_whatsapp_service('resolve',org,actor,jsonb_build_object('contact_id',ct));
  if again<>result then raise exception 'Canonical destination depends on identifier style';end if;
  refused=false;begin perform public.arisa_whatsapp_service('resolve',org,actor,jsonb_build_object('contact_id',ct,'phone','559900000000'));exception when others then refused=true;end;
  if not refused then raise exception 'Contact v_phone mismatch accepted';end if;

  args=jsonb_build_object('operation_key',key_a,'payload_hash',hash_a,'phone',v_phone,'contact_id',ct,'content','Olá. Reunião sobre drenagem às 10h. Arisa · Évora.');
  refused=false;begin perform public.arisa_whatsapp_service('prepare',org,actor,args);exception when others then refused=true;end;
  if not refused then raise exception 'Disabled administrative sending accepted';end if;
  update crm_private.arisa_whatsapp_channel set enabled=true where organization_id=org;
  result=public.arisa_whatsapp_service('prepare',org,actor,args);op=(result->>'id')::uuid;
  if result->>'phone'<>v_phone or result->>'thread_id'<>thread::text then raise exception 'Resolved send destination wrong';end if;
  again=public.arisa_whatsapp_service('prepare',org,actor,args);
  if again->>'id'<>op::text or (again->>'proceed')::boolean then raise exception 'Duplicate request not fenced';end if;
  refused=false;begin perform public.arisa_whatsapp_service('prepare',org,actor,args||jsonb_build_object('payload_hash',hash_b,'content','Changed content'));exception when others then refused=true;end;
  if not refused then raise exception 'Changed request accepted';end if;
  result=public.arisa_whatsapp_service('claim',org,actor,jsonb_build_object('id',op));
  if not (result->>'proceed')::boolean or result->>'phone'<>v_phone then raise exception 'Claim lacks canonical destination';end if;
  again=public.arisa_whatsapp_service('claim',org,actor,jsonb_build_object('id',op));
  if (again->>'proceed')::boolean then raise exception 'Concurrent claim accepted';end if;
  perform public.arisa_whatsapp_service('fail',org,actor,jsonb_build_object('id',op,'status','unknown','error','WHATSAPP_UNAVAILABLE'));
  again=public.arisa_whatsapp_service('claim',org,actor,jsonb_build_object('id',op));
  if (again->>'proceed')::boolean then raise exception 'Unknown outcome retried';end if;

  result=public.arisa_whatsapp_webhook(org,receiver,jsonb_build_object('statuses',jsonb_build_array(jsonb_build_object('provider_message_id',status_id,'status','read','operation_id',op,'recipient_phone','559900000000','occurred_at',now()))));
  if jsonb_array_length(result->'handled_status_ids')<>0 then raise exception 'Wrong recipient callback reconciled operation';end if;
  result=public.arisa_whatsapp_webhook(org,receiver,jsonb_build_object('statuses',jsonb_build_array(jsonb_build_object('provider_message_id',status_id,'status','read','operation_id',op,'recipient_phone',v_phone,'occurred_at',now()))));
  if not (result->'handled_status_ids' @> jsonb_build_array(status_id)) then raise exception 'Unknown operation not recovered from callback';end if;
  result=public.arisa_whatsapp_service('get',org,actor,jsonb_build_object('id',op));
  if result->>'status'<>'completed' or result->>'delivery_status'<>'read' then raise exception 'Callback result not reflected';end if;
  perform public.arisa_whatsapp_webhook(org,receiver,jsonb_build_object('statuses',jsonb_build_array(jsonb_build_object('provider_message_id',status_id,'status','failed','occurred_at',now(),'error_code','131026'))));
  result=public.arisa_whatsapp_service('get',org,actor,jsonb_build_object('id',op));
  if result->>'delivery_status'<>'read' then raise exception 'Confirmed reading regressed';end if;

  update public.arisa_whatsapp_threads set last_inbound_at=now()-interval '25 hours' where id=thread;
  refused=false;begin perform public.arisa_whatsapp_service('prepare',org,actor,args||jsonb_build_object('operation_key',key_b));exception when others then refused=true;end;
  if not refused then raise exception 'Free text outside window accepted';end if;
  perform public.arisa_whatsapp_webhook(org,receiver,jsonb_build_object('messages',jsonb_build_array(jsonb_build_object('provider_message_id','wamid.fixture.future.'||gen_random_uuid()::text,'from_phone',v_phone,'content','Future spoof','occurred_at',now()+interval '1 year'))));
  if (select last_inbound_at>now()-interval '24 hours' from public.arisa_whatsapp_threads where id=thread) then raise exception 'Future timestamp opened service window';end if;
  result=public.arisa_whatsapp_service('prepare',org,actor,args||jsonb_build_object('operation_key',key_b,'template_name','approved_fixture','template_language','pt_BR','template_components','[]'::jsonb));
  if result->>'send_mode'<>'template' then raise exception 'Template send not prepared';end if;
  update public.contacts set do_not_contact_at=now() where id=ct;
  refused=false;begin perform public.arisa_whatsapp_service('claim',org,actor,jsonb_build_object('id',result->>'id'));exception when others then refused=true;end;
  if not refused then raise exception 'Contact blocked after preparation was claimable';end if;
  result=public.arisa_whatsapp_service('configure',org,actor,jsonb_build_object('enabled',false));
  if (result->>'enabled')::boolean or not (result->>'legacy_crm_enabled')::boolean then raise exception 'Administrative toggle modified Bia';end if;
  if (select count(*) from public.crm_records where organization_id=org)<>before_crm or (select count(*) from public.crm_ai_jobs where organization_id=org)<>before_jobs then raise exception 'Administrative communication created leads or Bia jobs';end if;
  raise notice 'PASS: channel isolation, paused inbound, idempotency, canonical recipient, window/templates, unknown callback recovery, monotonic status, blocked contacts and service-only access';
end $test$;
rollback;
