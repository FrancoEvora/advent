-- Atomic integration regression. Every temporary policy/business change is rolled back.
-- May be appended to the migration: a failure aborts the migration as well.
do $test$
declare
 actor uuid; org uuid; lead_id uuid; other_lead uuid; unit_id uuid; policy_id uuid;
 p public.crm_negotiation_parameters; proposal_key uuid; terms jsonb; answer jsonb; doc jsonb;
 saved public.crm_proposals; method text; variant jsonb; rate_pair numeric[];
 before_proposals bigint; before_reservations bigint; first_monthly numeric; last_monthly numeric;
begin
 select m.user_id,m.organization_id into actor,org from public.organization_members m
 join public.profiles u on u.id=m.user_id where m.active and m.role='corretor' and u.email='marcos@evoraurbanismo.com.br';
 select r.id into lead_id from public.crm_records r where r.organization_id=org and r.broker_user_id=actor and r.record_status='aberta' and r.project_id is not null order by r.id limit 1;
 select u.id into unit_id from public.crm_inventory_units u where u.organization_id=org and u.project_id=(select project_id from public.crm_records where id=lead_id) and u.active and u.status='disponivel'
 and not exists(select 1 from public.crm_contracts c where c.unit_id=u.id and c.status<>'cancelado')
 and not exists(select 1 from public.crm_unit_reservations r where r.unit_id=u.id and r.status='ativa') order by u.id limit 1;
 select n.id into policy_id from public.crm_negotiation_parameters n where n.organization_id=org and n.project_id=(select project_id from public.crm_records where id=lead_id) and n.active and n.is_default;
 assert actor is not null and lead_id is not null and unit_id is not null and policy_id is not null,'Missing scoped integration fixtures';
 select count(*) into before_proposals from public.crm_proposals;
 select count(*) into before_reservations from public.crm_unit_reservations;
 foreach method in array array['price','sacoc'] loop
  begin
   update public.crm_negotiation_parameters set max_installments=180,min_down_payment_pct=0.1,max_down_payment_installments=6,allow_down_payment_installments=true,balloon_limit_pct=0.4,balloon_frequency_months=12,grace_months=0,
    parameters=parameters||'{"interest_rate_tiers":[{"max_installments":96,"monthly_interest_rate":0.0033},{"max_installments":120,"monthly_interest_rate":0.005},{"max_installments":180,"monthly_interest_rate":0.006}],"annual_balloon_max_count":4,"down_payment_options":[{"installments":3,"monthly_interest_rate":0},{"installments":6,"monthly_interest_rate":0.0033}]}'::jsonb
   where id=policy_id returning * into p;
   foreach rate_pair slice 1 in array array[[96,0.0033],[97,0.005],[120,0.005],[121,0.006],[180,0.006]]::numeric[] loop
    assert private.commercial_monthly_rate(p,rate_pair[1]::integer)=rate_pair[2],'Tier boundary mismatch';
   end loop;
   assert private.commercial_entry_rate(p,1)=0 and private.commercial_entry_rate(p,2)=0 and private.commercial_entry_rate(p,3)=0 and private.commercial_entry_rate(p,6)=0.0033,'Entry rate mismatch';
   perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
   select r.id into other_lead from public.crm_records r where r.organization_id=org and not private.broker_can_read_record(org,r.id) and r.record_status='aberta' limit 1;
   proposal_key:=gen_random_uuid();
   terms:=jsonb_build_object('sale_price',400000,'down_payment',40000,'down_count',3,'months',180,'monthly_rate',0.006,'amortization_method',method,'balloon_total',160000,'balloon_count',4,'first_due','2027-04-30','down_due','2027-01-31','conditions','ROLLBACK ONLY: release regression');
   set local role authenticated;
   assert not exists(select 1 from public.crm_inventory_units),'Broker raw inventory leak';
   answer:=public.get_broker_commercial_context(org);
   assert exists(select 1 from jsonb_array_elements(answer->'policies') x where x->>'id'=policy_id::text and jsonb_array_length(x->'parameters'->'interest_rate_tiers')=3 and not x?'max_discount_pct'),'Safe commercial context mismatch';
   if other_lead is not null then
    begin perform public.submit_broker_proposal(other_lead,unit_id,terms,gen_random_uuid()); raise exception 'Foreign lead accepted' using errcode='XX000'; exception when insufficient_privilege then null; end;
   end if;
   for variant in select value from jsonb_array_elements('[{"monthly_rate":0},{"months":181},{"down_count":7},{"down_payment":36000},{"balloon_count":5},{"balloon_total":160001},{"first_due":"2027-02-28"}]'::jsonb) loop
    begin perform public.submit_broker_proposal(lead_id,unit_id,terms||variant,gen_random_uuid()); raise exception 'Invalid terms accepted: %',variant using errcode='XX000'; exception when raise_exception then null; end;
   end loop;
   answer:=public.submit_broker_proposal(lead_id,unit_id,terms,proposal_key);
   assert (answer->>'id')::uuid=proposal_key,'Proposal not created';
   assert (public.submit_broker_proposal(lead_id,unit_id,terms,proposal_key)->>'id')::uuid=proposal_key,'Idempotency mismatch';
   doc:=public.get_broker_proposal_document(proposal_key);
   assert not doc?'public_token','Conference document exposes acceptance token';
   reset role;
   select * into saved from public.crm_proposals where id=proposal_key;
   assert saved.approval_status='pendente' and saved.requires_approval and saved.amortization_method=method,'Broker proposal bypassed approval';
   assert exists(select 1 from public.crm_unit_reservations r where r.proposal_id=proposal_key and r.unit_id=saved.unit_id and r.status='ativa'),'Reservation missing';
   assert jsonb_array_length(saved.payment_plan)=187,'Schedule row count mismatch';
   assert (saved.payment_plan->0->>'amount')::numeric=13333.33 and (saved.payment_plan->1->>'amount')::numeric=13333.34,'Entry rounding mismatch';
   assert saved.payment_plan->1->>'due_date'='2027-02-28' and saved.payment_plan->2->>'due_date'='2027-03-31','Calendar dates mismatch';
   select (x->>'amount')::numeric into first_monthly from jsonb_array_elements(saved.payment_plan) x where x->>'installment_type'='mensal' order by (x->>'installment_number')::int limit 1;
   select (x->>'amount')::numeric into last_monthly from jsonb_array_elements(saved.payment_plan) x where x->>'installment_type'='mensal' order by (x->>'installment_number')::int desc limit 1;
   if method='price' then
    assert first_monthly=round(200000*0.006/(1-power(1.006,-180)),2) and first_monthly=last_monthly,'Price mismatch';
   else
    assert first_monthly=round(200000.0/180*1.006,2) and last_monthly=round(200000.0/180*power(1.006,180),2),'SACOC mismatch';
   end if;
   assert exists(select 1 from jsonb_array_elements(saved.payment_plan) x where x->>'installment_type'='balao' and x->>'due_date'='2028-03-30' and (x->>'amount')::numeric=40000),'Annual balloon mismatch';
   assert doc->'payment_plan'=saved.payment_plan,'PDF and saved schedule differ';
   raise exception 'Successful regression; rollback fixtures' using errcode='ZP001';
  exception when sqlstate 'ZP001' then null;
  end;
 end loop;
 assert (select count(*) from public.crm_proposals)=before_proposals,'Proposal fixtures not rolled back';
 assert (select count(*) from public.crm_unit_reservations)=before_reservations,'Reservation fixtures not rolled back';
end $test$;
