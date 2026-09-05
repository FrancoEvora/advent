begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $test$
declare
  org_id uuid;
  admin_id uuid;
  contact_id uuid;
  lead_id uuid;
  conversation_id uuid;
  message_id uuid;
  pending_id uuid;
  pending_second_id uuid;
  event_count integer;
  initial_stage text;
  initial_status text;
  original_attempts integer;
  expected_sent_at timestamptz := now() - interval '1 minute';
  expected_next_at timestamptz := now() + interval '3 days';
  manual_date timestamptz := now() + interval '200 days';
  current_value timestamptz;
  result jsonb;
  denied boolean;
  fake_id uuid := gen_random_uuid();
begin
  select m.organization_id,m.user_id into org_id,admin_id
  from public.organization_members m join public.organizations o on o.id=m.organization_id
  where m.active and m.role='admin' and o.active
  order by m.organization_id,m.user_id limit 1;
  if org_id is null then raise exception 'Test requires active organization administrator'; end if;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);

  -- This change is transaction-local to this test and always rolled back.
  -- It prevents the existing lead-created trigger from dispatching the Bia worker.
  update crm_private.ai_runtime_settings set enabled=false where organization_id=org_id;

  insert into public.contacts(organization_id,contact_type,name,active)
  values(org_id,'prospect','ARISA QA SYNTHETIC - ROLLBACK',true) returning id into contact_id;
  insert into public.crm_records(organization_id,contact_id,person_name,stage,record_status,created_by)
  values(org_id,contact_id,'ARISA QA SYNTHETIC - ROLLBACK','novo','aberta',admin_id)
  returning id,stage,record_status,attempts into lead_id,initial_stage,initial_status,original_attempts;
  if exists(select 1 from public.crm_ai_jobs where crm_record_id=lead_id) then
    raise exception 'Fixture must not create AI jobs';
  end if;

  -- Internal completed tasks and unsuccessful attempts are not contact evidence.
  insert into public.crm_actions(organization_id,crm_record_id,action_type,subject,action_status,completed_at,outcome)
  values(org_id,lead_id,'tarefa','QA internal task','concluida',now()-interval '2 minutes','atendeu'),
        (org_id,lead_id,'ligacao','QA unanswered call','concluida',now()-interval '2 minutes','nao_atendeu');
  select last_contact_at into current_value from public.crm_records where id=lead_id;
  if current_value is not null then raise exception 'Tasks or unanswered calls became contact evidence'; end if;

  -- Exercise the exact RPC used by the UI. Its post-insert UPDATE must not
  -- overwrite the evidence trigger with a false contact timestamp.
  result:=public.create_crm_activity_with_broker(
    lead_id,'tarefa','interno','QA real RPC internal task',null,true,'atendeu',null,admin_id,null,null);
  if nullif(result->>'action_id','') is null then raise exception 'Activity RPC did not return action confirmation'; end if;
  select last_contact_at into current_value from public.crm_records where id=lead_id;
  if current_value is not null then raise exception 'Real activity RPC counted internal task as contact'; end if;
  result:=public.create_crm_activity_with_broker(
    lead_id,'contato','telefone','QA real RPC no response',null,true,'nao_atendeu',null,admin_id,null,null);
  select last_contact_at into current_value from public.crm_records where id=lead_id;
  if current_value is not null then raise exception 'Real activity RPC counted unanswered contact as contact'; end if;
  -- Keep the existing RPC attempt-count behavior; reconciliation itself must
  -- not increment it again or change commercial state.
  original_attempts:=coalesce(original_attempts,0)+2;

  insert into public.crm_conversations(organization_id,crm_record_id,contact_id,channel,status,ai_enabled)
  values(org_id,lead_id,contact_id,'whatsapp','paused',false) returning id into conversation_id;
  insert into public.crm_messages(organization_id,conversation_id,crm_record_id,direction,actor_type,channel,content,delivery_status,occurred_at)
  values(org_id,conversation_id,lead_id,'outbound','human','whatsapp','QA synthetic draft','draft',now()-interval '1 day')
  returning id into message_id;
  select last_contact_at into current_value from public.crm_records where id=lead_id;
  if current_value is not null then raise exception 'Draft was counted as sent contact'; end if;

  -- Only the recorded sending evidence is updated; no sending RPC is invoked.
  update public.crm_messages set delivery_status='sent',
    metadata=jsonb_build_object('cloud_sent_at',expected_sent_at),provider_message_id='QA-ROLLBACK-'||message_id::text
  where id=message_id;
  select last_contact_at into current_value from public.crm_records where id=lead_id;
  if current_value is distinct from expected_sent_at then raise exception 'WhatsApp send timestamp did not use cloud_sent_at'; end if;
  if crm_private.arisa_evidence_timestamp('now') is not null
    or crm_private.arisa_evidence_timestamp('2026-99-32T25:99:99Z') is not null
    or crm_private.arisa_evidence_timestamp('2026-09-05T12:00:00') is not null then
    raise exception 'Unsafe or malformed timestamp accepted';
  end if;

  insert into public.crm_actions(organization_id,crm_record_id,action_type,subject,action_status,scheduled_at)
  values(org_id,lead_id,'contato','QA next activity','pendente',expected_next_at) returning id into pending_id;
  select next_action_at into current_value from public.crm_records where id=lead_id;
  if current_value is distinct from expected_next_at then raise exception 'Pending activity was not synchronized'; end if;

  insert into public.crm_actions(organization_id,crm_record_id,action_type,subject,action_status,scheduled_at)
  values(org_id,lead_id,'contato','QA next activity 2','pendente',expected_next_at+interval '1 day') returning id into pending_second_id;
  update public.crm_actions set action_status='cancelada' where id=pending_id;
  select next_action_at into current_value from public.crm_records where id=lead_id;
  if current_value is distinct from expected_next_at+interval '1 day' then raise exception 'Cancelled activity did not advance to next pending activity'; end if;
  update public.crm_actions set action_status='cancelada' where id=pending_second_id;
  select next_action_at into current_value from public.crm_records where id=lead_id;
  if current_value is not null then raise exception 'Last cancelled agenda activity left stale next_action_at'; end if;

  update public.crm_records set next_action_at=manual_date where id=lead_id;
  perform crm_private.sync_arisa_crm_record(org_id,lead_id);
  select next_action_at into current_value from public.crm_records where id=lead_id;
  if current_value is distinct from manual_date then raise exception 'Unlinked manual date was removed'; end if;
  select count(*) into event_count from public.crm_opportunity_events where crm_record_id=lead_id and event_type='arisa.crm_synchronized';
  result:=crm_private.sync_arisa_crm_record(org_id,lead_id);
  if (result->>'changed')::boolean or event_count<>(select count(*) from public.crm_opportunity_events where crm_record_id=lead_id and event_type='arisa.crm_synchronized') then
    raise exception 'Repeated reconciliation was not idempotent';
  end if;
  result:=public.create_crm_activity_with_broker(
    lead_id,'contato','telefone','QA real RPC successful contact',null,true,'atendeu',null,admin_id,null,null);
  select last_contact_at into current_value from public.crm_records where id=lead_id;
  if current_value is distinct from now() then raise exception 'Effective contact through UI RPC was not synchronized'; end if;
  original_attempts:=original_attempts+1;
  if exists(select 1 from public.crm_records where id=lead_id and (stage is distinct from initial_stage or record_status is distinct from initial_status or attempts is distinct from original_attempts)) then
    raise exception 'CRM synchronization modified commercial stage, sale status or attempts';
  end if;

  result:=public.get_arisa_crm_operations(org_id);
  if not (result ? 'summary' and result ? 'items') then raise exception 'Operations read contract invalid'; end if;

  denied:=false;
  begin
    perform public.get_arisa_crm_operations(fake_id);
  exception when insufficient_privilege then denied:=true;
  end;
  if not denied then raise exception 'Cross-organization read was not rejected'; end if;

  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{}',true);
  denied:=false;
  begin
    perform public.reconcile_arisa_crm_operations(org_id,null,1);
  exception when insufficient_privilege then denied:=true;
  end;
  if not denied then raise exception 'Unauthenticated synchronization was not rejected'; end if;
  perform set_config('request.jwt.claim.sub',fake_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',fake_id,'role','authenticated')::text,true);
  denied:=false;
  begin
    perform public.reconcile_arisa_crm_operations(org_id,null,1);
  exception when insufficient_privilege then denied:=true;
  end;
  if not denied then raise exception 'Non-member synchronization was not rejected'; end if;
end
$test$;

select 'CRM evidence, schedule, idempotency and permissions: passed; all test writes rolled back' as verification;
rollback;
