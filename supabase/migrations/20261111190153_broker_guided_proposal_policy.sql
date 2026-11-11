-- Guided broker proposals. Deploy together with the matching broker form.
-- This migration does NOT activate new commercial policy values or rewrite existing proposals.
create or replace function private.commercial_monthly_rate(policy public.crm_negotiation_parameters, months integer)
returns numeric language plpgsql immutable set search_path='' as $$
declare selected_rate numeric;
begin
 if months is null or months not between 1 and policy.max_installments then
  raise exception 'Prazo fora da política comercial vigente.';
 end if;
 select (tier->>'monthly_interest_rate')::numeric into selected_rate
 from jsonb_array_elements(case when jsonb_typeof(policy.parameters->'interest_rate_tiers')='array' then policy.parameters->'interest_rate_tiers' else '[]'::jsonb end) tier
 where (tier->>'max_installments')::integer>=months
 order by (tier->>'max_installments')::integer limit 1;
 selected_rate:=coalesce(selected_rate,policy.monthly_interest_rate);
 if selected_rate is null or selected_rate::text in ('NaN','Infinity','-Infinity') or selected_rate not between 0 and 0.1 then
  raise exception 'Taxa comercial inválida. Solicite revisão à Diretoria.';
 end if;
 return selected_rate;
end $$;
revoke all on function private.commercial_monthly_rate(public.crm_negotiation_parameters,integer) from public,anon,authenticated;

create or replace function private.commercial_entry_rate(policy public.crm_negotiation_parameters, entry_count integer)
returns numeric language plpgsql immutable set search_path='' as $$
declare selected_rate numeric;
begin
 if entry_count=1 then return 0; end if;
 select (option->>'monthly_interest_rate')::numeric into selected_rate
 from jsonb_array_elements(case when jsonb_typeof(policy.parameters->'down_payment_options')='array' then policy.parameters->'down_payment_options' else '[]'::jsonb end) option
 where (option->>'installments')::integer>=entry_count
 order by (option->>'installments')::integer limit 1;
 selected_rate:=coalesce(selected_rate,policy.down_payment_interest_rate,0);
 if selected_rate::text in ('NaN','Infinity','-Infinity') or selected_rate not between 0 and 0.1 then
  raise exception 'Taxa da entrada inválida. Solicite revisão à Diretoria.';
 end if;
 return selected_rate;
end $$;
revoke all on function private.commercial_entry_rate(public.crm_negotiation_parameters,integer) from public,anon,authenticated;

CREATE OR REPLACE FUNCTION public.submit_broker_proposal(p_record_id uuid, p_unit_id uuid, p_terms jsonb, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 lead public.crm_records; unit_row public.crm_inventory_units; policy public.crm_negotiation_parameters; proposal public.crm_proposals;
 policy_id uuid; price numeric; down_amount numeric; down_count integer; months integer; rate numeric; balloons numeric; balloon_count integer;
 first_due date; down_due date; principal numeric; monthly numeric; down_each numeric; plan jsonb:='[]'; i integer; n integer:=0; expiry timestamptz; method text; amount numeric; entry_rate numeric; max_balloons integer; earliest_monthly date;
begin
 lead:=private.require_broker_record(p_record_id,true);
 if p_request_id is null or jsonb_typeof(p_terms) is distinct from 'object' then raise exception 'Dados da proposta inválidos.'; end if;
 -- Lock serializes concurrent reservations, then re-check availability and idempotency.
 select * into unit_row from public.crm_inventory_units where id=p_unit_id and organization_id=lead.organization_id for update;
 select * into proposal from public.crm_proposals where id=p_request_id;
 if proposal.id is not null then
  if proposal.created_by=auth.uid() and proposal.crm_record_id=lead.id and proposal.unit_id=p_unit_id then return jsonb_build_object('id',proposal.id,'number',proposal.proposal_number); end if;
  raise exception 'Identificador da solicitação indisponível.' using errcode='42501';
 end if;
 if unit_row.id is null or not unit_row.active or unit_row.status<>'disponivel'
  or exists(select 1 from public.crm_contracts where unit_id=p_unit_id and status<>'cancelado')
  or exists(select 1 from public.crm_unit_reservations where unit_id=p_unit_id and status='ativa') then
  raise exception 'Este lote não está mais disponível. Atualize o mapa.';
 end if;
 if lead.project_id is not null and lead.project_id<>unit_row.project_id then raise exception 'Escolha um lote do empreendimento deste atendimento.'; end if;
 select negotiation_policy_id into policy_id from public.crm_campaigns where id=lead.campaign_id and organization_id=lead.organization_id;
 select * into policy from public.crm_negotiation_parameters where organization_id=lead.organization_id and project_id=unit_row.project_id and active and (valid_from is null or valid_from<=current_date) and (valid_until is null or valid_until>=current_date) and (policy_id is null or id=policy_id) order by is_default desc,created_at desc limit 1;
 if policy.id is null then raise exception 'Solicite à diretoria uma política comercial vigente para este empreendimento.'; end if;
 method:=coalesce(p_terms->>'amortization_method','price');
 if method not in ('price','sacoc') then raise exception 'Sistema de amortização inválido.'; end if;
 price:=(p_terms->>'sale_price')::numeric; down_amount:=(p_terms->>'down_payment')::numeric;
 down_count:=coalesce((p_terms->>'down_count')::integer,1); months:=(p_terms->>'months')::integer;
 rate:=private.commercial_monthly_rate(policy,months);
 if p_terms ? 'monthly_rate' and (p_terms->>'monthly_rate')::numeric is distinct from rate then
  raise exception 'A taxa mudou ou não corresponde ao prazo. Atualize a tela para recalcular a proposta.';
 end if;
 entry_rate:=private.commercial_entry_rate(policy,down_count);
 balloons:=coalesce((p_terms->>'balloon_total')::numeric,0); balloon_count:=coalesce((p_terms->>'balloon_count')::integer,0);
 down_due:=(p_terms->>'down_due')::date;
 first_due:=coalesce((p_terms->>'first_due')::date,((case when policy.down_payment_frequency_days=30 then (down_due+make_interval(months=>down_count-1))::date else down_due+(down_count-1)*greatest(policy.down_payment_frequency_days,1) end)+interval '1 month')::date);
 if price is null or price<=0 or price>1000000000 or price::text in ('NaN','Infinity','-Infinity') or down_amount is null or down_amount<0 or down_amount>price or down_amount::text in ('NaN','Infinity','-Infinity')
  or down_count not between 1 and 36 or months is null or months not between 0 and 360 or rate not between 0 and 0.1 or rate::text='NaN'
  or balloons<0 or balloons>price-down_amount or balloons::text='NaN' or balloon_count not between 0 and 30
  or (balloons>0 and balloon_count=0) or (balloons=0 and balloon_count<>0)
  or (price-down_amount-balloons>0 and months=0)
  or first_due is null or down_due is null or first_due<(now() at time zone 'America/Sao_Paulo')::date or down_due<(now() at time zone 'America/Sao_Paulo')::date
  or length(coalesce(p_terms->>'conditions',''))>4000 then raise exception 'Revise valores, datas e parcelamento da proposta.'; end if;
 price:=round(price,2); down_amount:=round(down_amount,2); balloons:=round(balloons,2);
 if down_count>greatest(1,policy.max_down_payment_installments) or (down_count>1 and not policy.allow_down_payment_installments) then
  raise exception 'Parcelamento da entrada fora da política comercial.';
 end if;
 if down_amount<round(price*policy.min_down_payment_pct,2) then
  raise exception 'Entrada inferior ao percentual mínimo da política comercial.';
 end if;
 max_balloons:=least(30,coalesce((policy.parameters->>'annual_balloon_max_count')::integer,4),months/greatest(policy.balloon_frequency_months,1));
 if balloon_count>max_balloons or balloons>round(price*coalesce(policy.balloon_limit_pct,0),2) then
  raise exception 'Balões acima do limite de valor ou quantidade da política comercial.';
 end if;
 earliest_monthly:=((case when policy.down_payment_frequency_days=30 then (down_due+make_interval(months=>down_count-1))::date else down_due+(down_count-1)*greatest(policy.down_payment_frequency_days,1) end)+interval '1 month')::date;
 if first_due<earliest_monthly then raise exception 'As parcelas mensais devem começar no mês seguinte à última entrada.'; end if;
 principal:=price-down_amount-balloons;
 monthly:=case when months=0 then 0 when rate=0 then principal/months else principal*rate/(1-power(1+rate,-months)) end;
 down_each:=case when entry_rate>0 then down_amount*entry_rate/(1-power(1+entry_rate,-down_count)) else down_amount/down_count end;
 if down_amount>0 then for i in 0..down_count-1 loop
  amount:=case when entry_rate=0 then round(down_amount*(i+1)/down_count,2)-round(down_amount*i/down_count,2) else round(down_each,2) end;
  n:=n+1; plan:=plan||jsonb_build_array(jsonb_build_object('installment_number',n,'installment_type','entrada','due_date',case when policy.down_payment_frequency_days=30 then (down_due+make_interval(months=>i))::date else down_due+i*greatest(policy.down_payment_frequency_days,1) end,'amount',amount));
 end loop; end if;
 if months>0 and principal>0 then for i in 0..months-1 loop
  amount:=case when rate=0 then round(principal*(i+1)/months,2)-round(principal*i/months,2) when method='sacoc' then round((principal/months)*power(1+rate,i+1),2) else round(monthly,2) end;
  if amount>1000000000000 or amount<0 then raise exception 'O parcelamento gera valores fora do limite de cálculo. Revise taxa e prazo.'; end if;
  n:=n+1; plan:=plan||jsonb_build_array(jsonb_build_object('installment_number',n,'installment_type','mensal','due_date',(first_due+make_interval(months=>i+policy.grace_months))::date,'amount',amount));
 end loop; end if;
 if balloon_count>0 then for i in 1..balloon_count loop
  n:=n+1; plan:=plan||jsonb_build_array(jsonb_build_object('installment_number',n,'installment_type','balao','due_date',(first_due+make_interval(months=>i*greatest(policy.balloon_frequency_months,1)-1+policy.grace_months))::date,'amount',round(balloons*i/balloon_count,2)-round(balloons*(i-1)/balloon_count,2)));
 end loop; end if;
 insert into public.crm_proposals(id,organization_id,project_id,unit_id,crm_record_id,contact_id,customer_name,customer_document,customer_email,customer_phone,status,approval_status,requires_approval,list_price,sale_price,down_payment,down_payment_installments_count,down_payment_first_due_date,installments_count,monthly_interest_rate,indexer,grace_months,balloon_total,payment_plan,conditions_text,negotiation_policy_id,created_by,amortization_method)
 values(p_request_id,lead.organization_id,unit_row.project_id,unit_row.id,lead.id,lead.contact_id,lead.person_name,lead.cpf_cnpj,lead.email,lead.phone,'submetida','pendente',true,unit_row.list_price,price,down_amount,down_count,down_due,months,rate,policy.indexer,policy.grace_months,balloons,plan,nullif(trim(p_terms->>'conditions'),''),policy.id,auth.uid(),method) returning * into proposal;
 insert into public.crm_proposal_installments(organization_id,proposal_id,installment_number,installment_type,due_date,amount)
 select lead.organization_id,proposal.id,(x->>'installment_number')::int,x->>'installment_type',(x->>'due_date')::date,(x->>'amount')::numeric from jsonb_array_elements(plan) x;
 insert into public.crm_proposal_approvals(organization_id,proposal_id,requested_by,status,reason,snapshot)
 values(lead.organization_id,proposal.id,auth.uid(),'pendente','Proposta encaminhada pelo corretor para decisão da Diretoria.',jsonb_build_object('unit',unit_row.unit_code,'sale_price',price,'down_payment',down_amount,'installments',months,'amortization_method',method));
 expiry:=now()+make_interval(hours=>greatest(coalesce(policy.reservation_validity_hours,24),1));
 update public.crm_unit_reservations set expires_at=expiry,metadata=metadata||jsonb_build_object('origin','broker_workspace') where proposal_id=proposal.id and status='ativa';
 insert into public.audit_logs(organization_id,user_id,action,entity,entity_id,new_data)
 values(lead.organization_id,auth.uid(),'broker_proposal_submitted','crm_proposals',proposal.id::text,jsonb_build_object('crm_record_id',lead.id,'unit_id',unit_row.id,'approval_status','pendente','reserved_until',expiry));
 return jsonb_build_object('id',proposal.id,'number',proposal.proposal_number,'reserved_until',expiry);
end $function$
;
revoke all on function public.submit_broker_proposal(uuid,uuid,jsonb,uuid) from public,anon;
grant execute on function public.submit_broker_proposal(uuid,uuid,jsonb,uuid) to authenticated;

CREATE OR REPLACE FUNCTION public.get_broker_commercial_context(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=auth.uid() and role='corretor' and active) then
  raise exception 'Acesso restrito ao corretor ativo.' using errcode='42501';
 end if;
 return jsonb_build_object(
  'pipelines',(select coalesce(jsonb_agg(to_jsonb(p)),'[]') from public.crm_pipelines p where p.organization_id=p_organization_id and p.active),
  'stages',(select coalesce(jsonb_agg(to_jsonb(s) order by s.position),'[]') from public.crm_stages s where s.organization_id=p_organization_id and s.active),
  'responsibles',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'full_name',p.full_name)),'[]') from public.profiles p where exists(select 1 from public.crm_records r where r.organization_id=p_organization_id and private.broker_can_read_record(r.organization_id,r.id) and p.id in (r.broker_user_id,r.sdr_user_id,r.owner_user_id))),
  'policies',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'project_id',p.project_id,'name',p.name,'is_default',p.is_default,'min_down_payment_pct',p.min_down_payment_pct,'max_installments',p.max_installments,'monthly_interest_rate',p.monthly_interest_rate,'indexer',p.indexer,'grace_months',p.grace_months,'balloon_frequency_months',p.balloon_frequency_months,'reservation_validity_hours',p.reservation_validity_hours,'proposal_validity_days',p.proposal_validity_days,'max_down_payment_installments',p.max_down_payment_installments,'down_payment_frequency_days',p.down_payment_frequency_days,'down_payment_interest_rate',p.down_payment_interest_rate,'balloon_limit_pct',p.balloon_limit_pct,'allow_down_payment_installments',p.allow_down_payment_installments,'parameters',jsonb_build_object('interest_rate_tiers',p.parameters->'interest_rate_tiers','down_payment_options',p.parameters->'down_payment_options','annual_balloon_max_count',coalesce(p.parameters->'annual_balloon_max_count','4'::jsonb))) order by p.is_default desc,p.created_at desc),'[]') from public.crm_negotiation_parameters p where p.organization_id=p_organization_id and p.active and (p.valid_from is null or p.valid_from<=current_date) and (p.valid_until is null or p.valid_until>=current_date)),
  'lead_policies',(select coalesce(jsonb_agg(jsonb_build_object('record_id',r.id,'policy_id',c.negotiation_policy_id)),'[]') from public.crm_records r join public.crm_campaigns c on c.id=r.campaign_id and c.organization_id=r.organization_id where r.organization_id=p_organization_id and private.broker_can_read_record(r.organization_id,r.id) and c.negotiation_policy_id is not null),
  'proposals',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'crm_record_id',p.crm_record_id,'project_id',p.project_id,'unit_code',u.unit_code,'proposal_number',p.proposal_number,'status',p.status,'approval_status',p.approval_status,'sale_price',p.sale_price,'down_payment',p.down_payment,'installments_count',p.installments_count,'monthly_interest_rate',p.monthly_interest_rate,'indexer',p.indexer,'balloon_total',p.balloon_total,'conditions_text',p.conditions_text,'created_at',p.created_at,'rejection_reason',p.rejection_reason,'reservation_status',r.status,'reserved_until',r.expires_at) order by p.created_at desc),'[]') from public.crm_proposals p join public.crm_inventory_units u on u.id=p.unit_id and u.organization_id=p.organization_id left join public.crm_unit_reservations r on r.id=p.reservation_id and r.organization_id=p.organization_id where p.organization_id=p_organization_id and p.created_by=auth.uid() and private.broker_can_read_record(p.organization_id,p.crm_record_id))
 );
end $function$
;
revoke all on function public.get_broker_commercial_context(uuid) from public,anon;
grant execute on function public.get_broker_commercial_context(uuid) to authenticated;
notify pgrst,'reload schema';
