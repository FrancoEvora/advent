-- Preserve the existing reservation source enum; record portal origin in metadata.
create or replace function public.submit_broker_proposal(p_record_id uuid,p_unit_id uuid,p_terms jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 lead public.crm_records; unit_row public.crm_inventory_units; policy public.crm_negotiation_parameters; proposal public.crm_proposals;
 policy_id uuid; price numeric; down_amount numeric; down_count integer; months integer; rate numeric; balloons numeric; balloon_count integer;
 first_due date; down_due date; principal numeric; monthly numeric; down_each numeric; plan jsonb:='[]'; i integer; n integer:=0; expiry timestamptz;
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
 price:=(p_terms->>'sale_price')::numeric; down_amount:=(p_terms->>'down_payment')::numeric;
 down_count:=coalesce((p_terms->>'down_count')::integer,1); months:=(p_terms->>'months')::integer;
 rate:=coalesce((p_terms->>'monthly_rate')::numeric,policy.monthly_interest_rate);
 balloons:=coalesce((p_terms->>'balloon_total')::numeric,0); balloon_count:=coalesce((p_terms->>'balloon_count')::integer,0);
 first_due:=(p_terms->>'first_due')::date; down_due:=(p_terms->>'down_due')::date;
 if price is null or price<=0 or price>1000000000 or price::text in ('NaN','Infinity','-Infinity') or down_amount is null or down_amount<0 or down_amount>price or down_amount::text in ('NaN','Infinity','-Infinity')
  or down_count not between 1 and 36 or months is null or months not between 0 and 360 or rate not between 0 and 0.1 or rate::text='NaN'
  or balloons<0 or balloons>price-down_amount or balloons::text='NaN' or balloon_count not between 0 and 30
  or (balloons>0 and balloon_count=0) or (balloons=0 and balloon_count<>0)
  or (price-down_amount-balloons>0 and months=0)
  or first_due is null or down_due is null or first_due<(now() at time zone 'America/Sao_Paulo')::date or down_due<(now() at time zone 'America/Sao_Paulo')::date
  or length(coalesce(p_terms->>'conditions',''))>4000 then raise exception 'Revise valores, datas e parcelamento da proposta.'; end if;
 principal:=price-down_amount-balloons;
 monthly:=case when months=0 then 0 when rate=0 then principal/months else principal*rate/(1-power(1+rate,-months)) end;
 down_each:=case when policy.down_payment_interest_rate>0 then down_amount*policy.down_payment_interest_rate/(1-power(1+policy.down_payment_interest_rate,-down_count)) else down_amount/down_count end;
 if down_amount>0 then for i in 0..down_count-1 loop
  n:=n+1; plan:=plan||jsonb_build_array(jsonb_build_object('installment_number',n,'installment_type','entrada','due_date',down_due+i*greatest(policy.down_payment_frequency_days,1),'amount',round(down_each,2)));
 end loop; end if;
 if months>0 and principal>0 then for i in 0..months-1 loop
  n:=n+1; plan:=plan||jsonb_build_array(jsonb_build_object('installment_number',n,'installment_type','mensal','due_date',(first_due+make_interval(months=>i+policy.grace_months))::date,'amount',round(monthly,2)));
 end loop; end if;
 if balloon_count>0 then for i in 1..balloon_count loop
  n:=n+1; plan:=plan||jsonb_build_array(jsonb_build_object('installment_number',n,'installment_type','balao','due_date',(first_due+make_interval(months=>i*greatest(policy.balloon_frequency_months,1)))::date,'amount',round(balloons/balloon_count,2)));
 end loop; end if;
 insert into public.crm_proposals(id,organization_id,project_id,unit_id,crm_record_id,contact_id,customer_name,customer_document,customer_email,customer_phone,status,approval_status,requires_approval,list_price,sale_price,down_payment,down_payment_installments_count,down_payment_first_due_date,installments_count,monthly_interest_rate,indexer,grace_months,balloon_total,payment_plan,conditions_text,negotiation_policy_id,created_by)
 values(p_request_id,lead.organization_id,unit_row.project_id,unit_row.id,lead.id,lead.contact_id,lead.person_name,lead.cpf_cnpj,lead.email,lead.phone,'submetida','pendente',true,unit_row.list_price,price,down_amount,down_count,down_due,months,rate,policy.indexer,policy.grace_months,balloons,plan,nullif(trim(p_terms->>'conditions'),''),policy.id,auth.uid()) returning * into proposal;
 insert into public.crm_proposal_installments(organization_id,proposal_id,installment_number,installment_type,due_date,amount)
 select lead.organization_id,proposal.id,(x->>'installment_number')::int,x->>'installment_type',(x->>'due_date')::date,(x->>'amount')::numeric from jsonb_array_elements(plan) x;
 insert into public.crm_proposal_approvals(organization_id,proposal_id,requested_by,status,reason,snapshot)
 values(lead.organization_id,proposal.id,auth.uid(),'pendente','Proposta encaminhada pelo corretor para decisão da Diretoria.',jsonb_build_object('unit',unit_row.unit_code,'sale_price',price,'down_payment',down_amount,'installments',months));
 expiry:=now()+make_interval(hours=>greatest(coalesce(policy.reservation_validity_hours,24),1));
 update public.crm_unit_reservations set expires_at=expiry,metadata=metadata||jsonb_build_object('origin','broker_workspace') where proposal_id=proposal.id and status='ativa';
 insert into public.audit_logs(organization_id,user_id,action,entity,entity_id,new_data)
 values(lead.organization_id,auth.uid(),'broker_proposal_submitted','crm_proposals',proposal.id::text,jsonb_build_object('crm_record_id',lead.id,'unit_id',unit_row.id,'approval_status','pendente','reserved_until',expiry));
 return jsonb_build_object('id',proposal.id,'number',proposal.proposal_number,'reserved_until',expiry);
end $$;
revoke all on function public.submit_broker_proposal(uuid,uuid,jsonb,uuid) from public,anon;
grant execute on function public.submit_broker_proposal(uuid,uuid,jsonb,uuid) to authenticated;

