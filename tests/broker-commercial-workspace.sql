-- Production-safe integration regression: every business mutation rolls back.
begin;
do $test$
declare
 actor uuid; manager uuid; org uuid; lead uuid; other_lead uuid; unit_id uuid; sold_id uuid; target_stage uuid;
 proposal_key uuid:=gen_random_uuid(); activity_id uuid; personal_id uuid; assigned_activity uuid; result jsonb; terms jsonb; rid uuid; original_owner uuid;
begin
 select organization_id,user_id into org,actor from public.organization_members where active and role='corretor' order by created_at limit 1;
 select user_id into manager from public.organization_members where organization_id=org and role='admin' and active limit 1;
 select r.id into lead from public.crm_records r where r.organization_id=org and r.broker_user_id=actor and r.record_status='aberta' and exists(select 1 from public.crm_inventory_units u where u.organization_id=org and u.project_id=r.project_id and u.active and u.status='disponivel' and not exists(select 1 from public.crm_contracts c where c.unit_id=u.id and c.status<>'cancelado')) order by r.id limit 1;
 select id into unit_id from public.crm_inventory_units where organization_id=org and project_id=(select project_id from public.crm_records where id=lead) and active and status='disponivel' and not exists(select 1 from public.crm_contracts c where c.unit_id=crm_inventory_units.id and c.status<>'cancelado') and not exists(select 1 from public.crm_unit_reservations r where r.unit_id=crm_inventory_units.id and r.status='ativa') limit 1;
 select id into sold_id from public.crm_inventory_units where organization_id=org and status='vendido' limit 1;
 select id into target_stage from public.crm_stages where organization_id=org and active and not is_won and not is_lost and code='contato' limit 1;
 assert lead is not null and unit_id is not null and target_stage is not null,'Missing broker fixtures';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 select id into other_lead from public.crm_records where organization_id=org and not private.broker_can_read_record(org,id) and record_status='aberta' limit 1;
 terms:=jsonb_build_object('sale_price',450000,'down_payment',45000,'down_count',3,'months',120,'monthly_rate',0.0033,'balloon_total',0,'balloon_count',0,'first_due',current_date+30,'down_due',current_date+1,'conditions','ROLLBACK integration test');
 set local role authenticated;
 assert not exists(select 1 from public.crm_proposals),'Raw proposals exposed';
 assert not exists(select 1 from public.crm_inventory_units),'Raw inventory exposed';
 result:=public.get_broker_commercial_context(org);
 assert jsonb_array_length(result->'stages')>0,'Pipeline missing';
 assert jsonb_array_length(result->'policies')>0,'Commercial policy missing';
 result:=public.get_broker_lead_insights(lead);
 begin perform public.get_broker_lead_insights(other_lead); raise exception 'Foreign Bia context exposed'; exception when insufficient_privilege then null; end;
 begin perform public.submit_broker_proposal(other_lead,unit_id,terms,gen_random_uuid()); raise exception 'Foreign proposal accepted'; exception when insufficient_privilege then null; end;
 begin perform public.move_broker_lead_stage(other_lead,target_stage); raise exception 'Foreign funnel changed'; exception when insufficient_privilege then null; end;
 -- Personal and customer-linked appointments, rescheduling, completion and owner boundaries.
 personal_id:=public.save_broker_appointment(org,null,null,'Personal rollback',now(),now()+interval '1 hour','pendente',null);
 activity_id:=public.save_broker_appointment(org,null,lead,'Visit rollback',now()+interval '2 days',now()+interval '2 days 1 hour','pendente','Visit');
 perform public.save_broker_appointment(org,activity_id,lead,'Rescheduled visit',now()+interval '3 days',now()+interval '3 days 1 hour','em_andamento','Updated');
 assert exists(select 1 from public.user_activities where id=activity_id and status='em_andamento' and owner_user_id=actor),'Own rescheduling failed';
 perform public.save_broker_appointment(org,activity_id,lead,'Completed visit',now()+interval '3 days',now()+interval '3 days 1 hour','concluida','Completed');
 assert exists(select 1 from public.user_activities where id=activity_id and completed_at is not null),'Completion failed';
 begin perform public.save_broker_appointment(org,null,other_lead,'Foreign appointment',now(),now(),'pendente',null); raise exception 'Foreign appointment accepted'; exception when insufficient_privilege then null; end;
 perform public.move_broker_lead_stage(lead,target_stage);
 assert exists(select 1 from public.crm_records where id=lead and crm_records.stage_id=target_stage),'Stage update failed';
 result:=public.submit_broker_proposal(lead,unit_id,terms,proposal_key);
 assert (result->>'id')::uuid=proposal_key,'Proposal not created';
 result:=public.submit_broker_proposal(lead,unit_id,terms,proposal_key);
 assert (result->>'id')::uuid=proposal_key,'Retry not idempotent';
 result:=public.get_broker_commercial_context(org);
 assert exists(select 1 from jsonb_array_elements(result->'proposals') p where p->>'id'=proposal_key::text and p->>'approval_status'='pendente' and p->>'reservation_status'='ativa'),'Broker cannot see pending proposal and reservation';
 result:=public.get_broker_attendance_context(org);
 assert not exists(select 1 from jsonb_array_elements(result->'units') u where u->>'id'=unit_id::text),'Reserved lot still available';
 begin
  perform public.submit_broker_proposal(lead,unit_id,terms,gen_random_uuid());
  raise exception 'DOUBLE_RESERVATION_ALLOWED';
 exception when raise_exception then if sqlerrm='DOUBLE_RESERVATION_ALLOWED' then raise; end if; end;
 begin
  perform public.submit_broker_proposal(lead,sold_id,terms,gen_random_uuid());
  raise exception 'SOLD_LOT_ALLOWED';
 exception when raise_exception then if sqlerrm='SOLD_LOT_ALLOWED' then raise; end if; end;
 begin update public.crm_proposals set status='aprovada',approval_status='aprovada' where id=proposal_key; exception when insufficient_privilege then null; end;
 reset role;
 assert (select status='submetida' and approval_status='pendente' and requires_approval and approved_by is null from public.crm_proposals where id=proposal_key),'Broker self-approved proposal';
 select reservation_id into rid from public.crm_proposals where id=proposal_key;
 assert exists(select 1 from public.crm_unit_reservations where id=rid and proposal_id=proposal_key and status='ativa'),'Reservation link missing';
 assert (select count(*) from public.crm_proposal_approvals a where a.proposal_id=proposal_key and a.status='pendente')=1,'Approval missing or duplicated';
 assert (select count(*) from public.crm_proposal_installments i where i.proposal_id=proposal_key)=123,'Installment schedule incomplete';
 -- Existing formal assignment can be rescheduled and concluded from the agenda.
 select a.user_activity_id into assigned_activity from public.crm_lead_assignments a where a.organization_id=org and a.assigned_user_id=actor and a.status='atribuida' and a.user_activity_id is not null limit 1;
 if assigned_activity is not null then
  select related_id into lead from public.user_activities where id=assigned_activity;
  set local role authenticated;
  perform public.save_broker_appointment(org,assigned_activity,lead,'Attend client',now(),now()+interval '1 day','concluida',null);
  reset role;
  assert exists(select 1 from public.crm_lead_assignments where user_activity_id=assigned_activity and status='concluida'),'Formal assignment not completed';
 end if;
 -- Board approval remains available; broker cannot read foreign proposals.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
 set local role authenticated;
 assert exists(select 1 from public.crm_proposals where id=proposal_key and approval_status='pendente'),'Board cannot see broker submission';
 update public.crm_proposals set status='aprovada',approval_status='aprovada',approved_by=manager,approved_at=now() where id=proposal_key;
 reset role;
 assert (select status='aprovada' and approved_by=manager from public.crm_proposals where id=proposal_key),'Board approval failed';
end $test$;
rollback;
select 'Broker commercial integration passed; all fixtures rolled back' as result;
