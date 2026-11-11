-- Run after activating the eight-balloon policy. All proposal/reservation fixtures roll back.
do $test$
declare
 org uuid; broker uuid; administrator uuid; lead_id uuid; unit_row public.crm_inventory_units;
 policy public.crm_negotiation_parameters; request_id uuid; terms jsonb; result jsonb;
 saved public.crm_proposals; document jsonb; method text; invalid jsonb;
begin
 select * into strict policy from public.crm_negotiation_parameters
 where id='ce10598f-90f4-4c73-80b2-2176ce84d5c2' and active and is_default;
 org:=policy.organization_id;
 assert policy.indexer='IPCA' and policy.balloon_limit_pct=0.4
  and (policy.parameters->>'annual_balloon_max_count')::integer=8,'Incorrect active policy';
 select m.user_id into broker from public.organization_members m join public.profiles p on p.id=m.user_id
 where m.organization_id=org and m.active and m.role='corretor' and p.email='marcos@evoraurbanismo.com.br';
 select user_id into administrator from public.organization_members where organization_id=org and active and role='admin' order by created_at limit 1;
 select id into lead_id from public.crm_records where organization_id=org and project_id=policy.project_id and broker_user_id=broker and record_status='aberta' order by id limit 1;
 select u.* into unit_row from public.crm_inventory_units u where u.organization_id=org and u.project_id=policy.project_id and u.active and u.status='disponivel'
  and not exists(select 1 from public.crm_unit_reservations r where r.unit_id=u.id and r.status='ativa')
  and not exists(select 1 from public.crm_contracts c where c.unit_id=u.id and c.status<>'cancelado') order by u.id limit 1;
 assert broker is not null and administrator is not null and lead_id is not null and unit_row.id is not null,'Missing scoped fixtures';
 foreach method in array array['price','sacoc'] loop
  begin
   perform set_config('request.jwt.claims',jsonb_build_object('sub',administrator,'role','authenticated')::text,true);
   set local role authenticated;
   result:=public.bia_manager_simulate(org,unit_row.unit_code,unit_row.project_id,0.1,96,1,8,round(unit_row.list_price*0.4/8,2));
   assert (result->>'balloonCount')::integer=8 and (result->>'indexer')='IPCA','Bia did not expose eight balloons/IPCA';
   reset role;
   perform set_config('request.jwt.claims',jsonb_build_object('sub',broker,'role','authenticated')::text,true);
   request_id:=gen_random_uuid();
   terms:=jsonb_build_object('sale_price',400000,'down_payment',40000,'down_count',3,'months',180,'monthly_rate',0.006,'amortization_method',method,'balloon_total',160000,'balloon_count',8,'first_due','2027-04-30','down_due','2027-01-31','conditions','ROLLBACK ONLY: eight-balloon IPCA regression');
   set local role authenticated;
   for invalid in select value from jsonb_array_elements('[{"balloon_count":9},{"balloon_total":160001},{"months":84,"monthly_rate":0.0033}]'::jsonb) loop
    begin perform public.submit_broker_proposal(lead_id,unit_row.id,terms||invalid,gen_random_uuid()); raise exception 'Invalid eight-balloon terms accepted' using errcode='XX000'; exception when raise_exception then null; end;
   end loop;
   result:=public.submit_broker_proposal(lead_id,unit_row.id,terms,request_id);
   document:=public.get_broker_proposal_document(request_id);
   reset role;
   select * into strict saved from public.crm_proposals where id=request_id;
   assert saved.indexer='IPCA' and document->>'indexer'='IPCA','Proposal/PDF lost the correction index';
   assert saved.approval_status='pendente' and saved.requires_approval,'Approval bypassed';
   assert (select count(*) from jsonb_array_elements(saved.payment_plan) r where r->>'installment_type'='balao')=8,'Incorrect balloon count';
   assert (select sum((r->>'amount')::numeric) from jsonb_array_elements(saved.payment_plan) r where r->>'installment_type'='balao')=160000,'Incorrect balloon sum';
   assert (select max(r->>'due_date') from jsonb_array_elements(saved.payment_plan) r where r->>'installment_type'='balao')='2035-03-30','Eighth annual balloon date mismatch';
   assert exists(select 1 from public.crm_unit_reservations r where r.proposal_id=saved.id and r.status='ativa'),'Linked reservation missing';
   raise exception 'Successful regression; roll back fixtures' using errcode='ZP008';
  exception when sqlstate 'ZP008' then null;
  end;
  assert not exists(select 1 from public.crm_proposals p where p.id=request_id),'Test proposal remains';
  assert not exists(select 1 from public.crm_unit_reservations r where r.proposal_id=request_id),'Test reservation remains';
 end loop;
end $test$;
