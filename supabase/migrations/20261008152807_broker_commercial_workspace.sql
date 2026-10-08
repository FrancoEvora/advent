-- Narrow broker operations; raw corporate tables remain protected by restrictive RLS.
create or replace function private.require_broker_record(p_record uuid, p_open boolean default false)
returns public.crm_records language plpgsql security definer set search_path='' as $$
declare r public.crm_records;
begin
 select * into r from public.crm_records where id=p_record for update;
 if r.id is null or not private.broker_can_read_record(r.organization_id,r.id) then
  raise exception 'Atendimento não disponível para sua carteira.' using errcode='42501';
 end if;
 if p_open and r.record_status<>'aberta' then raise exception 'O atendimento precisa estar em aberto.'; end if;
 return r;
end $$;
revoke all on function private.require_broker_record(uuid,boolean) from public,anon,authenticated;

create or replace function public.get_broker_commercial_context(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=auth.uid() and role='corretor' and active) then
  raise exception 'Acesso restrito ao corretor ativo.' using errcode='42501';
 end if;
 return jsonb_build_object(
  'pipelines',(select coalesce(jsonb_agg(to_jsonb(p)),'[]') from public.crm_pipelines p where p.organization_id=p_organization_id and p.active),
  'stages',(select coalesce(jsonb_agg(to_jsonb(s) order by s.position),'[]') from public.crm_stages s where s.organization_id=p_organization_id and s.active),
  'responsibles',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'full_name',p.full_name)),'[]') from public.profiles p where exists(select 1 from public.crm_records r where r.organization_id=p_organization_id and private.broker_can_read_record(r.organization_id,r.id) and p.id in (r.broker_user_id,r.sdr_user_id,r.owner_user_id))),
  'policies',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'project_id',p.project_id,'name',p.name,'is_default',p.is_default,'min_down_payment_pct',p.min_down_payment_pct,'max_installments',p.max_installments,'monthly_interest_rate',p.monthly_interest_rate,'indexer',p.indexer,'grace_months',p.grace_months,'balloon_frequency_months',p.balloon_frequency_months,'reservation_validity_hours',p.reservation_validity_hours,'proposal_validity_days',p.proposal_validity_days,'max_down_payment_installments',p.max_down_payment_installments,'down_payment_frequency_days',p.down_payment_frequency_days,'down_payment_interest_rate',p.down_payment_interest_rate) order by p.is_default desc,p.created_at desc),'[]') from public.crm_negotiation_parameters p where p.organization_id=p_organization_id and p.active and (p.valid_from is null or p.valid_from<=current_date) and (p.valid_until is null or p.valid_until>=current_date)),
  'lead_policies',(select coalesce(jsonb_agg(jsonb_build_object('record_id',r.id,'policy_id',c.negotiation_policy_id)),'[]') from public.crm_records r join public.crm_campaigns c on c.id=r.campaign_id and c.organization_id=r.organization_id where r.organization_id=p_organization_id and private.broker_can_read_record(r.organization_id,r.id) and c.negotiation_policy_id is not null),
  'proposals',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'crm_record_id',p.crm_record_id,'project_id',p.project_id,'unit_code',u.unit_code,'proposal_number',p.proposal_number,'status',p.status,'approval_status',p.approval_status,'sale_price',p.sale_price,'down_payment',p.down_payment,'installments_count',p.installments_count,'monthly_interest_rate',p.monthly_interest_rate,'indexer',p.indexer,'balloon_total',p.balloon_total,'conditions_text',p.conditions_text,'created_at',p.created_at,'rejection_reason',p.rejection_reason,'reservation_status',r.status,'reserved_until',r.expires_at) order by p.created_at desc),'[]') from public.crm_proposals p join public.crm_inventory_units u on u.id=p.unit_id and u.organization_id=p.organization_id left join public.crm_unit_reservations r on r.id=p.reservation_id and r.organization_id=p.organization_id where p.organization_id=p_organization_id and p.created_by=auth.uid() and private.broker_can_read_record(p.organization_id,p.crm_record_id))
 );
end $$;
revoke all on function public.get_broker_commercial_context(uuid) from public,anon;
grant execute on function public.get_broker_commercial_context(uuid) to authenticated;

-- Runs after crm_prepare_proposal: even a proposal within policy awaits the board.
create or replace function private.force_broker_proposal_review()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.organization_members where organization_id=new.organization_id and user_id=auth.uid() and role='corretor' and active) then
  new.requires_approval:=true;
  new.approval_status:='pendente';
  new.status:='submetida';
  new.approved_by:=null; new.approved_at:=null;
 end if;
 return new;
end $$;
revoke all on function private.force_broker_proposal_review() from public,anon,authenticated;
create trigger zz_broker_proposal_review before insert on public.crm_proposals for each row execute function private.force_broker_proposal_review();

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
 update public.crm_unit_reservations set expires_at=expiry,source='broker_workspace' where proposal_id=proposal.id and status='ativa';
 insert into public.audit_logs(organization_id,user_id,action,entity,entity_id,new_data)
 values(lead.organization_id,auth.uid(),'broker_proposal_submitted','crm_proposals',proposal.id::text,jsonb_build_object('crm_record_id',lead.id,'unit_id',unit_row.id,'approval_status','pendente','reserved_until',expiry));
 return jsonb_build_object('id',proposal.id,'number',proposal.proposal_number,'reserved_until',expiry);
end $$;
revoke all on function public.submit_broker_proposal(uuid,uuid,jsonb,uuid) from public,anon;
grant execute on function public.submit_broker_proposal(uuid,uuid,jsonb,uuid) to authenticated;

create or replace function public.move_broker_lead_stage(p_record_id uuid,p_stage_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare lead public.crm_records; target public.crm_stages;
begin
 lead:=private.require_broker_record(p_record_id,true);
 if lead.broker_user_id is distinct from auth.uid() and not (lead.broker_user_id is null and lead.owner_user_id=auth.uid()) then raise exception 'Movimente apenas seus próprios atendimentos.' using errcode='42501'; end if;
 select * into target from public.crm_stages where id=p_stage_id and organization_id=lead.organization_id and active;
 if target.id is null or target.is_won or target.is_lost or (lead.pipeline_id is not null and target.pipeline_id<>lead.pipeline_id) then raise exception 'Escolha uma etapa de atendimento do mesmo funil. O fechamento depende da formalização da venda.'; end if;
 update public.crm_records set pipeline_id=target.pipeline_id,stage_id=target.id,stage=target.code,probability=target.probability,updated_at=now() where id=lead.id;
 insert into public.audit_logs(organization_id,user_id,action,entity,entity_id,new_data) values(lead.organization_id,auth.uid(),'broker_stage_changed','crm_records',lead.id::text,jsonb_build_object('previous_stage_id',lead.stage_id,'stage_id',target.id));
end $$;
revoke all on function public.move_broker_lead_stage(uuid,uuid) from public,anon;
grant execute on function public.move_broker_lead_stage(uuid,uuid) to authenticated;

create or replace function public.save_broker_appointment(p_organization_id uuid,p_activity_id uuid,p_record_id uuid,p_title text,p_starts_at timestamptz,p_due_at timestamptz,p_status text,p_notes text default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare activity public.user_activities; lead public.crm_records; record_id uuid; action_id uuid; assignment_id uuid; assignment_status text;
begin
 if not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=auth.uid() and active and role='corretor') then raise exception 'Acesso restrito.' using errcode='42501'; end if;
 if p_status is null or p_status not in ('pendente','em_andamento','concluida','cancelada') or nullif(trim(p_title),'') is null or length(p_title)>180 or length(coalesce(p_notes,''))>4000 or p_starts_at is null or p_due_at is null or p_due_at<p_starts_at then raise exception 'Revise título, datas e situação do compromisso.'; end if;
 if p_activity_id is not null then
  select * into activity from public.user_activities where id=p_activity_id and organization_id=p_organization_id and owner_user_id=auth.uid() for update;
  if activity.id is null or (activity.related_id is not null and not private.broker_can_read_entity(p_organization_id,activity.related_type,activity.related_id)) then raise exception 'Compromisso indisponível.' using errcode='42501'; end if;
  if activity.related_type in ('crm_actions','crm_action') then
   select crm_record_id,id into record_id,action_id from public.crm_actions where id=activity.related_id and organization_id=p_organization_id;
  elsif activity.related_type in ('crm_records','crm_record') then record_id:=activity.related_id;
  end if;
  if record_id is distinct from p_record_id then raise exception 'O vínculo original do compromisso deve ser preservado.'; end if;
  select id,crm_action_id,status into assignment_id,action_id,assignment_status from public.crm_lead_assignments where user_activity_id=activity.id and assigned_user_id=auth.uid() and organization_id=p_organization_id;
  if assignment_id is not null and p_status='cancelada' then raise exception 'Reagende este atendimento ou conclua-o; a designação permanece ativa.'; end if;
  if assignment_id is not null and assignment_status in ('concluida','recusada','cancelada','substituida') then raise exception 'Este atendimento já foi encerrado. Crie um novo compromisso.'; end if;
  action_id:=coalesce(action_id,case when activity.related_type in ('crm_actions','crm_action') then activity.related_id end);
 else record_id:=p_record_id;
 end if;
 if record_id is not null then
  lead:=private.require_broker_record(record_id,false);
  if lead.organization_id<>p_organization_id then raise exception 'Conta de outra organização.' using errcode='42501'; end if;
 end if;
 if p_activity_id is null then
  insert into public.user_activities(organization_id,owner_user_id,assigned_by,title,description,activity_type,status,starts_at,due_at,completed_at,related_type,related_id,project_id,board_status)
  values(p_organization_id,auth.uid(),auth.uid(),trim(p_title),nullif(trim(p_notes),''),'crm',p_status,p_starts_at,p_due_at,case when p_status='concluida' then now() end,case when record_id is not null then 'crm_records' end,record_id,lead.project_id,case when p_status='concluida' then 'concluida' when p_status='em_andamento' then 'em_andamento' else 'backlog' end) returning * into activity;
 else
  update public.user_activities set title=trim(p_title),description=case when assignment_id is null then nullif(trim(p_notes),'') else description end,starts_at=p_starts_at,due_at=p_due_at,status=p_status,board_status=case when p_status='concluida' then 'concluida' when p_status='em_andamento' then 'em_andamento' else 'backlog' end,completed_at=case when p_status='concluida' then coalesce(completed_at,now()) end,updated_at=now() where id=activity.id;
  if action_id is not null then update public.crm_actions set scheduled_at=p_starts_at,action_status=case when p_status='concluida' then 'concluida' when p_status='cancelada' then 'cancelada' else 'pendente' end,completed_at=case when p_status='concluida' then now() end where id=action_id and organization_id=p_organization_id and assigned_to=auth.uid(); end if;
  if assignment_id is not null then
   update public.crm_lead_assignments set due_at=p_due_at where id=assignment_id;
   if p_status in ('concluida','em_andamento') then
    if assignment_status='atribuida' then perform public.set_crm_assignment_status(assignment_id,'aceita'); end if;
    if p_status='concluida' then perform public.set_crm_assignment_status(assignment_id,'concluida');
    elsif assignment_status<>'em_atendimento' then perform public.set_crm_assignment_status(assignment_id,'em_atendimento'); end if;
   end if;
  end if;
 end if;
 if record_id is not null then
  update public.crm_records r set next_action_at=(select min(a.starts_at) from public.user_activities a where a.organization_id=p_organization_id and a.owner_user_id=auth.uid() and a.related_type in ('crm_record','crm_records') and a.related_id=record_id and a.status in ('pendente','em_andamento')),updated_at=now() where r.id=record_id and r.broker_user_id=auth.uid();
 end if;
 insert into public.audit_logs(organization_id,user_id,action,entity,entity_id,new_data) values(p_organization_id,auth.uid(),'broker_appointment_saved','user_activities',activity.id::text,jsonb_build_object('crm_record_id',record_id,'status',p_status,'starts_at',p_starts_at,'due_at',p_due_at));
 return activity.id;
end $$;
revoke all on function public.save_broker_appointment(uuid,uuid,uuid,text,timestamptz,timestamptz,text,text) from public,anon;
grant execute on function public.save_broker_appointment(uuid,uuid,uuid,text,timestamptz,timestamptz,text,text) to authenticated;

create or replace function public.get_broker_lead_insights(p_record_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare lead public.crm_records; msg record;
begin
 select * into lead from public.crm_records where id=p_record_id;
 if lead.id is null or not private.broker_can_read_record(lead.organization_id,lead.id) then raise exception 'Atendimento indisponível.' using errcode='42501'; end if;
 select m.content,m.occurred_at,m.metadata into msg from public.crm_messages m where m.organization_id=lead.organization_id and m.crm_record_id=lead.id and m.actor_type='ai' and m.delivery_status in ('sent','delivered','read','received') order by m.occurred_at desc limit 1;
 return jsonb_build_object('last_message',msg.content,'updated_at',msg.occurred_at,'facts',coalesce(msg.metadata->'facts_used','[]'::jsonb),'questions',coalesce(msg.metadata->'questions_asked','[]'::jsonb),'next_step',msg.metadata->>'recommended_next_step');
end $$;
revoke all on function public.get_broker_lead_insights(uuid) from public,anon;
grant execute on function public.get_broker_lead_insights(uuid) to authenticated;
