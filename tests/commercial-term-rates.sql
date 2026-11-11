-- No lasting business writes; safe to append to the function migration.
do $test$
declare actor uuid; org uuid; unit_row public.crm_inventory_units; policy_id uuid; answer jsonb; pair numeric[];
begin
 begin
  select u.* into unit_row from public.crm_inventory_units u join public.projects p on p.id=u.project_id where u.active and u.status='disponivel' and p.id='85799c1b-e14a-5120-bf3d-976928d5dec3' order by u.id limit 1;
  org:=unit_row.organization_id;
  select user_id into actor from public.organization_members where organization_id=org and active and role='admin' order by created_at limit 1;
  select id into policy_id from public.crm_negotiation_parameters where project_id=unit_row.project_id and organization_id=org and active and is_default;
  assert actor is not null and policy_id is not null and unit_row.id is not null,'Missing commercial fixtures';
  update public.crm_negotiation_parameters set max_installments=180,parameters=parameters||'{"plan_options":[96,120,180],"annual_balloon_max_count":4,"interest_rate_tiers":[{"max_installments":96,"monthly_interest_rate":0.0033},{"max_installments":120,"monthly_interest_rate":0.005},{"max_installments":180,"monthly_interest_rate":0.006}]}'::jsonb where id=policy_id;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  set local role authenticated;
  foreach pair slice 1 in array array[[12,0.0033],[96,0.0033],[97,0.005],[120,0.005],[121,0.006],[180,0.006]]::numeric[] loop
   answer:=public.bia_manager_simulate(org,unit_row.unit_code,unit_row.project_id,0.1,pair[1]::integer,2,0,0);
   assert (answer->'scenarios'->0->>'monthlyInterestRate')::numeric=pair[2],'Bia per-scenario interest mismatch';
   assert (answer->>'monthlyInterestRate')::numeric=pair[2],'Bia summary interest mismatch';
   assert (answer->>'downPaymentInterestRate')::numeric=0,'Interest-free entry option mismatch';
   assert (answer->'scenarios'->0->>'monthlyPayment')::numeric=round((unit_row.list_price-round(unit_row.list_price*0.1,2))*pair[2]/(1-power(1+pair[2],-pair[1])),2),'Bia payment mismatch';
  end loop;
  answer:=public.bia_manager_simulate(org,unit_row.unit_code,unit_row.project_id,0.1,null,1,0,0);
  assert jsonb_array_length(answer->'scenarios')=3,'Missing plan scenarios';
  assert (answer->'scenarios'->0->>'monthlyInterestRate')::numeric=0.0033 and (answer->'scenarios'->1->>'monthlyInterestRate')::numeric=0.005 and (answer->'scenarios'->2->>'monthlyInterestRate')::numeric=0.006,'Mixed-term scenario rates incorrect';
  begin perform public.bia_manager_simulate(org,unit_row.unit_code,unit_row.project_id,0.1,181,1,0,0); raise exception 'Term 181 accepted' using errcode='XX000'; exception when raise_exception then null; end;
  begin perform public.bia_manager_simulate(org,unit_row.unit_code,unit_row.project_id,0.1,180,1,5,100); raise exception 'Five balloons accepted' using errcode='XX000'; exception when raise_exception then null; end;
  reset role;
  raise exception 'Successful regression; rollback policy fixture' using errcode='ZP002';
 exception when sqlstate 'ZP002' then null;
 end;
end $test$;
