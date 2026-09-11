-- Fixtures, notifications and pg_net requests all roll back. No recipient is contacted.
begin;
set local statement_timeout='120s';
set local lock_timeout='5s';
do $test$
declare org uuid;actor uuid;chat uuid;source_id uuid;source_lease uuid:=gen_random_uuid();phone text:='551198'||lpad(floor(random()*10000000)::bigint::text,7,'0');receiver text:='990000000000099';
  op jsonb;job jsonb;r jsonb;inbound uuid;other_thread uuid;opening uuid;thread uuid;refused boolean;expected text:='Jaqueline, o Franco pediu um retorno sobre o lead que encaminhou. Já tem alguma atualização?';
begin
  select m.organization_id,m.user_id into org,actor from public.organization_members m join public.organizations o on o.id=m.organization_id where m.active and m.role='admin' and o.active order by m.organization_id,m.user_id limit 1;
  if org is null then raise exception 'Active admin fixture required';end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','service_role')::text,true);
  if has_function_privilege('authenticated','private.arisa_whatsapp_pending_follow_up(uuid,uuid,uuid)','EXECUTE') or has_function_privilege('anon','private.arisa_whatsapp_pending_follow_up(uuid,uuid,uuid)','EXECUTE') then raise exception 'Follow-up helper exposed';end if;
  -- Isolate queue claims from real pending work for this rollback transaction only.
  update crm_private.arisa_whatsapp_reply_jobs set available_at=now()+interval '1 day' where status='pending';
  update crm_private.whatsapp_runtime_settings set enabled=false,phone_number_id=receiver where organization_id=org;
  insert into crm_private.arisa_whatsapp_channel(organization_id,enabled,auto_reply_enabled,updated_by,webhook_verified_at) values(org,true,true,actor,now()) on conflict(organization_id) do update set enabled=true,auto_reply_enabled=true,updated_by=actor,webhook_verified_at=now();
  insert into public.arisa_chat_threads(organization_id,owner_user_id,title) values(org,actor,'Rollback continuation fixture') returning id into chat;
  insert into public.arisa_chat_messages(organization_id,owner_user_id,thread_id,role,content,status,lease_token,lease_expires_at) values(org,actor,chat,'user','PRIVATE CHAT MUST NOT BE EXPOSED','processing',source_lease,now()+interval '3 minutes') returning id into source_id;
  op=public.arisa_whatsapp_service('prepare',org,actor,jsonb_build_object('operation_key',repeat('a',64),'payload_hash',repeat('b',64),'message_id',source_id,'lease',source_lease,'phone',phone,'content','Pode conversar comigo?','template_name','arisa','follow_up',expected));
  opening=(op->>'channel_message_id')::uuid;thread=(op->>'thread_id')::uuid;
  update public.arisa_whatsapp_messages set occurred_at=now()-interval '10 minutes' where id=opening;
  perform public.arisa_whatsapp_service('claim',org,actor,jsonb_build_object('id',op->>'id'));
  perform public.arisa_whatsapp_service('finish',org,actor,jsonb_build_object('id',op->>'id','provider_message_id','wamid.fixture.'||gen_random_uuid()::text));
  insert into public.arisa_whatsapp_messages(organization_id,thread_id,direction,content,occurred_at) values(org,thread,'inbound','Sim, podemos conversar.',now()-interval '2 minutes') returning id into inbound;
  update public.arisa_whatsapp_threads set last_inbound_at=now()-interval '2 minutes' where id=thread;
  insert into crm_private.arisa_whatsapp_reply_jobs(id,organization_id,thread_id,actor_user_id) values(inbound,org,thread,actor) on conflict do nothing;
  r=private.arisa_whatsapp_pending_follow_up(org,thread,inbound);
  if r->>'content' is distinct from expected or r->>'message_id' is distinct from opening::text or r::text like '%PRIVATE CHAT%' then raise exception 'Purpose missing or private source exposed: %',r;end if;
  insert into public.arisa_whatsapp_threads(organization_id,phone_number_id,phone,created_by) values(org,receiver,phone||'1',actor) returning id into other_thread;
  if private.arisa_whatsapp_pending_follow_up(org,other_thread,inbound) is not null or private.arisa_whatsapp_pending_follow_up(gen_random_uuid(),thread,inbound) is not null then raise exception 'Cross-thread or cross-org continuation';end if;
  update public.arisa_whatsapp_messages set delivery_status='failed' where id=opening;
  if private.arisa_whatsapp_pending_follow_up(org,thread,inbound) is not null then raise exception 'Failed opening used';end if;
  update public.arisa_whatsapp_messages set delivery_status='delivered',occurred_at=now()-interval '8 days' where id=opening;
  if private.arisa_whatsapp_pending_follow_up(org,thread,inbound) is not null then raise exception 'Expired opening used';end if;
  update public.arisa_whatsapp_messages set occurred_at=now()-interval '10 minutes' where id=opening;
  job=public.arisa_whatsapp_reply_worker('claim');
  if job->>'id' is distinct from inbound::text or job->'follow_up'->>'content' is distinct from expected then raise exception 'Queue did not carry purpose';end if;
  refused=false;begin
    perform public.arisa_whatsapp_reply_worker('send',jsonb_build_object('id',inbound,'lease',job->>'lease','content','Como posso ajudar?','follow_up_resolution','continue'));
  exception when raise_exception then refused=true;end;
  if not refused then raise exception 'Acceptance did not enforce exact authorized text';end if;
  r=public.arisa_whatsapp_reply_worker('send',jsonb_build_object('id',inbound,'lease',job->>'lease','content','Tudo bem, falamos depois.','follow_up_resolution','wait'));
  if r->>'proceed' is distinct from 'true' then raise exception 'Postponement blocked';end if;
  perform public.arisa_whatsapp_reply_worker('finish',jsonb_build_object('id',inbound,'lease',job->>'lease','result',jsonb_build_object('accepted_by_meta',true)));
  if private.arisa_whatsapp_pending_follow_up(org,thread,inbound) is null then raise exception 'Postponement lost purpose';end if;
  insert into public.arisa_whatsapp_messages(organization_id,thread_id,direction,content,occurred_at) values(org,thread,'inbound','Agora pode falar.',now()-interval '1 minute') returning id into inbound;
  insert into crm_private.arisa_whatsapp_reply_jobs(id,organization_id,thread_id,actor_user_id) values(inbound,org,thread,actor) on conflict do nothing;
  job=public.arisa_whatsapp_reply_worker('claim');
  r=public.arisa_whatsapp_reply_worker('send',jsonb_build_object('id',inbound,'lease',job->>'lease','content',expected,'follow_up_resolution','continue'));
  if r->>'proceed' is distinct from 'true' then raise exception 'Prepared question not sent';end if;
  if private.arisa_whatsapp_pending_follow_up(org,thread,inbound) is not null then raise exception 'In-flight continuation duplicated';end if;
  perform public.arisa_whatsapp_reply_worker('fail',jsonb_build_object('id',inbound,'lease',job->>'lease','error','AMBIGUOUS_NETWORK','sending',true));
  if private.arisa_whatsapp_pending_follow_up(org,thread,inbound) is not null then raise exception 'Uncertain continuation repeated';end if;
  -- Rearm only this fixture to exercise a changed manual purpose between claim and send.
  update crm_private.arisa_whatsapp_reply_jobs set status='pending',follow_up_completed=false,available_at=now() where id=inbound;
  job=public.arisa_whatsapp_reply_worker('claim');
  update public.arisa_whatsapp_messages set metadata=metadata||jsonb_build_object('follow_up','') where id=opening;
  r=public.arisa_whatsapp_reply_worker('send',jsonb_build_object('id',inbound,'lease',job->>'lease','content',expected,'follow_up_resolution','continue'));
  if r->>'proceed' is distinct from 'false' then raise exception 'Changed purpose not fenced';end if;
  raise notice 'PASS: persistence, queue context, exact question, privacy isolation, expiry, failed opening, postponement, deduplication and stale-context fencing';
end $test$;
rollback;

