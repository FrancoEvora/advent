-- Vitória: consulta comercial em tempo real e bloqueio de lotes sujeito a aprovação administrativa.

alter table public.crm_unit_reservations
  add column if not exists approval_status text not null default 'not_required',
  add column if not exists approval_requested_at timestamptz,
  add column if not exists decided_at timestamptz,
  add column if not exists decided_by uuid,
  add column if not exists decision_notes text,
  add column if not exists source text not null default 'internal',
  add column if not exists source_reference text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.crm_unit_reservations'::regclass
      and conname = 'crm_unit_reservations_approval_status_check'
  ) then
    alter table public.crm_unit_reservations
      add constraint crm_unit_reservations_approval_status_check
      check (approval_status = any (array['not_required'::text,'pending'::text,'approved'::text,'rejected'::text,'expired'::text,'cancelled'::text]));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.crm_unit_reservations'::regclass
      and conname = 'crm_unit_reservations_source_check'
  ) then
    alter table public.crm_unit_reservations
      add constraint crm_unit_reservations_source_check
      check (source = any (array['internal'::text,'proposal'::text,'public_agent'::text,'integration'::text]));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.crm_unit_reservations'::regclass
      and conname = 'crm_unit_reservations_decided_by_fkey'
  ) then
    alter table public.crm_unit_reservations
      add constraint crm_unit_reservations_decided_by_fkey
      foreign key (decided_by) references auth.users(id) on delete set null;
  end if;
end $$;

create unique index if not exists crm_unit_reservations_one_active_per_unit_idx
  on public.crm_unit_reservations(unit_id)
  where status = 'ativa';

create unique index if not exists crm_unit_reservations_one_active_public_session_idx
  on public.crm_unit_reservations(source_reference)
  where source = 'public_agent' and status = 'ativa';

create index if not exists crm_unit_reservations_public_pending_idx
  on public.crm_unit_reservations(organization_id, approval_status, expires_at)
  where source = 'public_agent' and status = 'ativa';

-- Política comercial vigente do Solaris, cadastrada por chave estável da experiência.
with experience as (
  select organization_id, project_id
  from crm_private.public_agent_experiences
  where slug = 'solaris' and active
  order by created_at desc
  limit 1
), existing as (
  select p.id
  from public.crm_negotiation_parameters p
  join experience e on e.organization_id = p.organization_id and e.project_id = p.project_id
  where p.name = 'Política comercial Solaris — 2026.08'
  limit 1
)
insert into public.crm_negotiation_parameters(
  organization_id, project_id, name, active, valid_from, valid_until,
  min_down_payment_pct, max_discount_pct, admin_approval_discount_pct,
  max_installments, min_installment, monthly_interest_rate, indexer,
  grace_months, balloon_limit_pct, balloon_frequency_months,
  proposal_validity_days, reservation_validity_hours,
  require_admin_below_min_price, allow_custom_schedule,
  parameters, allow_down_payment_installments, max_down_payment_installments,
  down_payment_first_due_days, down_payment_frequency_days,
  down_payment_interest_rate, description, is_default
)
select
  e.organization_id, e.project_id, 'Política comercial Solaris — 2026.08', true,
  date '2026-08-15', null,
  0.10, 0, 0,
  150, 0, 0.0033, 'IPCA',
  0, 0.40, 12,
  5, 24,
  true, true,
  jsonb_build_object(
    'plan_options', jsonb_build_array(100,120,150),
    'down_payment_options', jsonb_build_array(
      jsonb_build_object('installments',3,'monthly_interest_rate',0,'label','Entrada de 10% em até 3x sem juros'),
      jsonb_build_object('installments',6,'monthly_interest_rate',0.0033,'label','Entrada de 10% em até 6x com juros de 0,33% ao mês')
    ),
    'annual_balloon_optional', true,
    'annual_balloon_max_count', 8,
    'annual_indexation', 'IPCA',
    'disclaimer', 'Condições sujeitas à disponibilidade da unidade, análise cadastral e aprovação administrativa. Simulações não constituem proposta definitiva.'
  ),
  true, 6, 0, 30, 0.0033,
  'Entrada mínima de 10%; opções de entrada em até 3x sem juros ou em até 6x com juros de 0,33% a.m.; saldo em 100, 120 ou 150 parcelas; juros de 0,33% a.m.; correção anual pelo IPCA; possibilidade de até 8 balões anuais opcionais.',
  true
from experience e
where not exists (select 1 from existing);

update public.crm_negotiation_parameters p
set active = true,
    valid_from = date '2026-08-15',
    min_down_payment_pct = 0.10,
    max_discount_pct = 0,
    admin_approval_discount_pct = 0,
    max_installments = 150,
    monthly_interest_rate = 0.0033,
    indexer = 'IPCA',
    balloon_frequency_months = 12,
    proposal_validity_days = 5,
    reservation_validity_hours = 24,
    require_admin_below_min_price = true,
    allow_custom_schedule = true,
    allow_down_payment_installments = true,
    max_down_payment_installments = 6,
    down_payment_interest_rate = 0.0033,
    is_default = true,
    description = 'Entrada mínima de 10%; opções de entrada em até 3x sem juros ou em até 6x com juros de 0,33% a.m.; saldo em 100, 120 ou 150 parcelas; juros de 0,33% a.m.; correção anual pelo IPCA; possibilidade de até 8 balões anuais opcionais.',
    parameters = jsonb_build_object(
      'plan_options', jsonb_build_array(100,120,150),
      'down_payment_options', jsonb_build_array(
        jsonb_build_object('installments',3,'monthly_interest_rate',0,'label','Entrada de 10% em até 3x sem juros'),
        jsonb_build_object('installments',6,'monthly_interest_rate',0.0033,'label','Entrada de 10% em até 6x com juros de 0,33% ao mês')
      ),
      'annual_balloon_optional', true,
      'annual_balloon_max_count', 8,
      'annual_indexation', 'IPCA',
      'disclaimer', 'Condições sujeitas à disponibilidade da unidade, análise cadastral e aprovação administrativa. Simulações não constituem proposta definitiva.'
    ),
    updated_at = now()
where p.name = 'Política comercial Solaris — 2026.08'
  and exists (
    select 1 from crm_private.public_agent_experiences e
    where e.slug='solaris' and e.active
      and e.organization_id=p.organization_id and e.project_id=p.project_id
  );

create or replace function public.get_public_agent_commercial_context(
  p_slug text,
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  experience_row crm_private.public_agent_experiences%rowtype;
  policy_row public.crm_negotiation_parameters%rowtype;
  filters jsonb := coalesce(p_filters, '{}'::jsonb);
  requested_unit text;
  area_min numeric;
  area_max numeric;
  budget_max numeric;
  result_limit integer := 12;
  units_json jsonb;
  summary_json jsonb;
begin
  perform crm_private.assert_public_agent_service_role();

  if jsonb_typeof(filters) <> 'object' or pg_column_size(filters) > 8192 then
    raise exception 'PUBLIC_AGENT_COMMERCIAL_FILTER_INVALID';
  end if;

  select e.* into experience_row
  from crm_private.public_agent_experiences e
  where e.slug = lower(trim(p_slug)) and e.active
  order by e.created_at desc
  limit 1;
  if not found then raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND'; end if;

  requested_unit := upper(nullif(trim(filters->>'unitCode'),''));
  if requested_unit is not null and requested_unit !~ '^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$' then
    raise exception 'PUBLIC_AGENT_UNIT_CODE_INVALID';
  end if;

  if coalesce(filters->>'areaMin','') ~ '^[0-9]+([.][0-9]+)?$' then area_min := (filters->>'areaMin')::numeric; end if;
  if coalesce(filters->>'areaMax','') ~ '^[0-9]+([.][0-9]+)?$' then area_max := (filters->>'areaMax')::numeric; end if;
  if coalesce(filters->>'budgetMax','') ~ '^[0-9]+([.][0-9]+)?$' then budget_max := (filters->>'budgetMax')::numeric; end if;
  if coalesce(filters->>'limit','') ~ '^[0-9]{1,2}$' then result_limit := greatest(1,least(24,(filters->>'limit')::integer)); end if;

  -- Libera reservas vencidas antes de responder disponibilidade.
  update public.crm_unit_reservations r
  set status = 'expirada',
      approval_status = case when r.approval_status='pending' then 'expired' else r.approval_status end,
      decided_at = coalesce(r.decided_at,now()),
      decision_notes = coalesce(r.decision_notes,'Bloqueio expirado automaticamente.')
  where r.organization_id = experience_row.organization_id
    and r.project_id = experience_row.project_id
    and r.status = 'ativa'
    and r.expires_at is not null
    and r.expires_at <= now();

  select p.* into policy_row
  from public.crm_negotiation_parameters p
  where p.organization_id=experience_row.organization_id
    and p.project_id=experience_row.project_id
    and p.active
    and (p.valid_from is null or p.valid_from<=current_date)
    and (p.valid_until is null or p.valid_until>=current_date)
  order by p.is_default desc,p.valid_from desc nulls last,p.updated_at desc
  limit 1;

  select coalesce(jsonb_agg(to_jsonb(unit_row) - 'match_rank' order by unit_row.match_rank,unit_row.list_price,unit_row.area,unit_row.unit_code),'[]'::jsonb)
  into units_json
  from (
    select
      u.unit_code,
      u.block_code,
      u.lot_number,
      round(u.area,2) as area,
      round(u.frontage,2) as frontage,
      round(u.depth,2) as depth,
      u.corner,
      u.topography,
      u.orientation,
      round(u.list_price,2) as list_price,
      round(coalesce(u.price_per_sqm,case when u.area>0 then u.list_price/u.area end),2) as price_per_sqm,
      u.updated_at,
      case when requested_unit is not null and u.unit_code=requested_unit then 0 else 1 end as match_rank
    from public.crm_inventory_units u
    where u.organization_id=experience_row.organization_id
      and u.project_id=experience_row.project_id
      and (experience_row.product_id is null or u.product_id=experience_row.product_id)
      and u.active
      and u.status='disponivel'
      and (requested_unit is null or u.unit_code=requested_unit)
      and (area_min is null or u.area>=area_min)
      and (area_max is null or u.area<=area_max)
      and (budget_max is null or u.list_price<=budget_max)
    order by match_rank,u.list_price,u.area,u.unit_code
    limit result_limit
  ) unit_row;

  select jsonb_build_object(
    'availableCount',count(*),
    'minimumArea',round(min(u.area),2),
    'maximumArea',round(max(u.area),2),
    'minimumPrice',round(min(u.list_price),2),
    'maximumPrice',round(max(u.list_price),2),
    'pricePerSqm',round(min(coalesce(u.price_per_sqm,case when u.area>0 then u.list_price/u.area end)),2)
  ) into summary_json
  from public.crm_inventory_units u
  where u.organization_id=experience_row.organization_id
    and u.project_id=experience_row.project_id
    and (experience_row.product_id is null or u.product_id=experience_row.product_id)
    and u.active and u.status='disponivel';

  return jsonb_build_object(
    'realTime',true,
    'asOf',clock_timestamp(),
    'project',jsonb_build_object('name',experience_row.name,'slug',experience_row.slug),
    'summary',coalesce(summary_json,'{}'::jsonb),
    'policy',case when policy_row.id is null then null else jsonb_build_object(
      'id',policy_row.id,
      'name',policy_row.name,
      'description',policy_row.description,
      'minimumDownPaymentPct',policy_row.min_down_payment_pct,
      'maximumInstallments',policy_row.max_installments,
      'monthlyInterestRate',policy_row.monthly_interest_rate,
      'indexer',policy_row.indexer,
      'reservationValidityHours',policy_row.reservation_validity_hours,
      'proposalValidityDays',policy_row.proposal_validity_days,
      'allowDownPaymentInstallments',policy_row.allow_down_payment_installments,
      'maximumDownPaymentInstallments',policy_row.max_down_payment_installments,
      'downPaymentInterestRate',policy_row.down_payment_interest_rate,
      'balloonFrequencyMonths',policy_row.balloon_frequency_months,
      'parameters',policy_row.parameters
    ) end,
    'units',units_json
  );
end;
$$;

revoke all on function public.get_public_agent_commercial_context(text,jsonb) from public,anon,authenticated;
grant execute on function public.get_public_agent_commercial_context(text,jsonb) to service_role;

create or replace function public.request_public_agent_unit_hold(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_unit_code text,
  p_customer_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  experience_row crm_private.public_agent_experiences%rowtype;
  session_row crm_private.public_agent_sessions%rowtype;
  unit_row public.crm_inventory_units%rowtype;
  policy_row public.crm_negotiation_parameters%rowtype;
  reservation_row public.crm_unit_reservations%rowtype;
  activity_key uuid;
  hours_value integer := 24;
  protocol_value text;
  now_value timestamptz := now();
begin
  perform crm_private.assert_public_agent_service_role();

  if p_session_token_hash !~ '^[a-f0-9]{64}$'
     or p_fingerprint_hash !~ '^[a-f0-9]{64}$'
     or upper(trim(p_unit_code)) !~ '^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$'
     or char_length(trim(p_customer_name)) not between 2 and 180 then
    raise exception 'PUBLIC_AGENT_HOLD_INPUT_INVALID';
  end if;

  select s.* into session_row
  from crm_private.public_agent_sessions s
  join crm_private.public_agent_experiences e on e.id=s.experience_id
  where e.slug=lower(trim(p_slug)) and e.active
    and s.session_token_hash=p_session_token_hash
    and s.fingerprint_hash=p_fingerprint_hash
  for update of s;
  if not found then raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND'; end if;

  select e.* into experience_row
  from crm_private.public_agent_experiences e
  where e.id=session_row.experience_id and e.active;
  if not found then raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND'; end if;

  if session_row.status in ('closed','blocked') or session_row.expires_at<=now_value then
    raise exception 'PUBLIC_AGENT_SESSION_INACTIVE';
  end if;
  if session_row.contact_id is null or session_row.crm_record_id is null then
    raise exception 'PUBLIC_AGENT_CONTACT_REQUIRED';
  end if;

  select p.* into policy_row
  from public.crm_negotiation_parameters p
  where p.organization_id=experience_row.organization_id
    and p.project_id=experience_row.project_id
    and p.active
    and (p.valid_from is null or p.valid_from<=current_date)
    and (p.valid_until is null or p.valid_until>=current_date)
  order by p.is_default desc,p.valid_from desc nulls last,p.updated_at desc
  limit 1;
  hours_value := greatest(1,least(72,coalesce(policy_row.reservation_validity_hours,24)));

  select r.* into reservation_row
  from public.crm_unit_reservations r
  where r.organization_id=experience_row.organization_id
    and r.source='public_agent'
    and r.source_reference=session_row.id::text
    and r.status='ativa'
    and (r.expires_at is null or r.expires_at>now_value)
  order by r.created_at desc
  limit 1;
  if found then
    protocol_value := 'BLQ-'||upper(left(replace(reservation_row.id::text,'-',''),10));
    return jsonb_build_object(
      'ok',true,
      'idempotent',reservation_row.metadata->>'unit_code'=upper(trim(p_unit_code)),
      'alreadyActive',reservation_row.metadata->>'unit_code'<>upper(trim(p_unit_code)),
      'requestedUnitCode',upper(trim(p_unit_code)),
      'protocol',protocol_value,
      'approvalStatus',reservation_row.approval_status,
      'expiresAt',reservation_row.expires_at,
      'reservationId',reservation_row.id,
      'unit',reservation_row.metadata->'unit_snapshot'
    );
  end if;

  select u.* into unit_row
  from public.crm_inventory_units u
  where u.organization_id=experience_row.organization_id
    and u.project_id=experience_row.project_id
    and (experience_row.product_id is null or u.product_id=experience_row.product_id)
    and u.unit_code=upper(trim(p_unit_code))
    and u.active
  for update;
  if not found then raise exception 'PUBLIC_AGENT_UNIT_NOT_FOUND'; end if;

  update public.crm_unit_reservations r
  set status='expirada',
      approval_status=case when r.approval_status='pending' then 'expired' else r.approval_status end,
      decided_at=coalesce(r.decided_at,now_value),
      decision_notes=coalesce(r.decision_notes,'Bloqueio expirado automaticamente.')
  where r.unit_id=unit_row.id and r.status='ativa' and r.expires_at is not null and r.expires_at<=now_value;

  -- Recarrega o estoque após a limpeza dos bloqueios vencidos.
  select u.* into unit_row from public.crm_inventory_units u where u.id=unit_row.id for update;
  if unit_row.status<>'disponivel' then raise exception 'PUBLIC_AGENT_UNIT_UNAVAILABLE'; end if;

  insert into public.crm_unit_reservations(
    organization_id,project_id,unit_id,crm_record_id,contact_id,customer_name,
    reservation_type,status,starts_at,expires_at,notes,created_by,
    approval_status,approval_requested_at,source,source_reference,metadata
  ) values (
    experience_row.organization_id,experience_row.project_id,unit_row.id,
    session_row.crm_record_id,session_row.contact_id,left(trim(p_customer_name),180),
    'comercial','ativa',now_value,now_value+make_interval(hours=>hours_value),
    'Solicitação de bloqueio realizada pela Vitória; pendente de aprovação do administrador.',
    experience_row.fallback_owner_user_id,
    'pending',now_value,'public_agent',session_row.id::text,
    jsonb_build_object(
      'public_agent_session_id',session_row.id,
      'unit_code',unit_row.unit_code,
      'policy_id',policy_row.id,
      'requested_at',now_value,
      'unit_snapshot',jsonb_build_object(
        'unitCode',unit_row.unit_code,
        'blockCode',unit_row.block_code,
        'lotNumber',unit_row.lot_number,
        'area',round(unit_row.area,2),
        'listPrice',round(unit_row.list_price,2),
        'pricePerSqm',round(coalesce(unit_row.price_per_sqm,case when unit_row.area>0 then unit_row.list_price/unit_row.area end),2)
      )
    )
  ) returning * into reservation_row;

  insert into public.crm_alerts(
    organization_id,crm_record_id,alert_type,severity,title,message,assigned_to,due_at,status
  ) values (
    experience_row.organization_id,session_row.crm_record_id,
    'public_unit_hold:'||left(replace(reservation_row.id::text,'-',''),12),
    'alta','Aprovação de bloqueio — '||unit_row.unit_code,
    'A Vitória bloqueou temporariamente o lote '||unit_row.unit_code||' para '||left(trim(p_customer_name),180)||'. Aprove ou rejeite antes de '||to_char(reservation_row.expires_at at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI')||'.',
    experience_row.fallback_owner_user_id,reservation_row.expires_at,'aberto'
  );

  insert into public.user_activities(
    organization_id,owner_user_id,assigned_by,title,description,activity_type,status,priority,
    starts_at,due_at,related_type,related_id,project_id,tags,board_status
  ) values (
    experience_row.organization_id,experience_row.fallback_owner_user_id,experience_row.fallback_owner_user_id,
    'Aprovar bloqueio do lote '||unit_row.unit_code,
    'Solicitação originada pela Vitória para '||left(trim(p_customer_name),180)||'. O lote permanecerá indisponível até a decisão ou expiração automática.',
    'crm','pendente','urgente',now_value,reservation_row.expires_at,
    'crm_unit_reservation',reservation_row.id,experience_row.project_id,
    array['vitoria','bloqueio','aprovacao']::text[],'backlog'
  ) returning id into activity_key;

  insert into public.crm_opportunity_events(
    organization_id,crm_record_id,opportunity_key,contact_id,project_id,product_id,
    actor_type,event_type,event_source,channel,occurred_at,idempotency_key,correlation_id,data
  ) values (
    experience_row.organization_id,session_row.crm_record_id,session_row.crm_record_id,
    session_row.contact_id,experience_row.project_id,experience_row.product_id,
    'ai','unit.hold_requested','vitoria','site',now_value,
    'public_agent_hold:'||session_row.id::text||':'||unit_row.id::text,
    'public-agent:'||session_row.id::text,
    jsonb_build_object('reservation_id',reservation_row.id,'unit_id',unit_row.id,'unit_code',unit_row.unit_code,'approval_status','pending','expires_at',reservation_row.expires_at,'activity_id',activity_key)
  ) on conflict(organization_id,idempotency_key) where idempotency_key is not null do nothing;

  update crm_private.public_agent_sessions
  set stage='handoff',
      captured_profile=captured_profile||jsonb_build_object('selected_unit_code',unit_row.unit_code,'hold_reservation_id',reservation_row.id,'hold_approval_status','pending'),
      last_activity_at=now_value,updated_at=now_value
  where id=session_row.id;

  protocol_value := 'BLQ-'||upper(left(replace(reservation_row.id::text,'-',''),10));
  return jsonb_build_object(
    'ok',true,'idempotent',false,'protocol',protocol_value,
    'approvalStatus','pending','expiresAt',reservation_row.expires_at,
    'reservationId',reservation_row.id,
    'unit',reservation_row.metadata->'unit_snapshot',
    'message','O lote foi bloqueado temporariamente e aguarda aprovação administrativa.'
  );
exception
  when unique_violation then
    raise exception 'PUBLIC_AGENT_UNIT_UNAVAILABLE';
end;
$$;

revoke all on function public.request_public_agent_unit_hold(text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.request_public_agent_unit_hold(text,text,text,text,text) to service_role;

create or replace function public.get_public_agent_hold_status(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row crm_private.public_agent_sessions%rowtype;
  reservation_row public.crm_unit_reservations%rowtype;
  protocol_value text;
begin
  perform crm_private.assert_public_agent_service_role();
  select s.* into session_row
  from crm_private.public_agent_sessions s
  join crm_private.public_agent_experiences e on e.id=s.experience_id
  where e.slug=lower(trim(p_slug)) and e.active
    and s.session_token_hash=p_session_token_hash
    and s.fingerprint_hash=p_fingerprint_hash;
  if not found then raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND'; end if;

  select r.* into reservation_row
  from public.crm_unit_reservations r
  where r.organization_id=session_row.organization_id
    and r.source='public_agent'
    and r.source_reference=session_row.id::text
  order by r.created_at desc
  limit 1;
  if not found then return jsonb_build_object('hasHold',false); end if;

  if reservation_row.status='ativa' and reservation_row.expires_at is not null and reservation_row.expires_at<=now() then
    update public.crm_unit_reservations
    set status='expirada',approval_status=case when approval_status='pending' then 'expired' else approval_status end,
        decided_at=coalesce(decided_at,now()),decision_notes=coalesce(decision_notes,'Bloqueio expirado automaticamente.')
    where id=reservation_row.id returning * into reservation_row;
  end if;

  protocol_value := 'BLQ-'||upper(left(replace(reservation_row.id::text,'-',''),10));
  return jsonb_build_object(
    'hasHold',true,'protocol',protocol_value,'status',reservation_row.status,
    'approvalStatus',reservation_row.approval_status,'expiresAt',reservation_row.expires_at,
    'unit',reservation_row.metadata->'unit_snapshot'
  );
end;
$$;

revoke all on function public.get_public_agent_hold_status(text,text,text) from public,anon,authenticated;
grant execute on function public.get_public_agent_hold_status(text,text,text) to service_role;

create or replace function public.list_pending_public_agent_unit_holds()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_key uuid := auth.uid();
  result_value jsonb;
begin
  if user_key is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;

  update public.crm_unit_reservations r
  set status='expirada',approval_status='expired',decided_at=coalesce(r.decided_at,now()),decision_notes=coalesce(r.decision_notes,'Bloqueio expirado automaticamente.')
  where r.source='public_agent' and r.status='ativa' and r.approval_status='pending'
    and r.expires_at is not null and r.expires_at<=now()
    and exists (
      select 1 from public.organization_members m
      where m.organization_id=r.organization_id and m.user_id=user_key and m.active and m.role in ('admin','diretoria')
    );

  select coalesce(jsonb_agg(item order by item.expires_at,item.created_at),'[]'::jsonb) into result_value
  from (
    select
      r.id,
      r.created_at,
      r.expires_at,
      r.approval_status,
      r.customer_name,
      r.notes,
      u.unit_code,
      u.block_code,
      u.lot_number,
      round(u.area,2) as area,
      round(u.list_price,2) as list_price,
      c.phone,
      c.email,
      c.city,
      cr.id as crm_record_id,
      p.name as project_name
    from public.crm_unit_reservations r
    join public.crm_inventory_units u on u.id=r.unit_id
    join public.projects p on p.id=r.project_id
    left join public.contacts c on c.id=r.contact_id
    left join public.crm_records cr on cr.id=r.crm_record_id
    where r.source='public_agent' and r.status='ativa' and r.approval_status='pending'
      and (r.expires_at is null or r.expires_at>now())
      and exists (
        select 1 from public.organization_members m
        where m.organization_id=r.organization_id and m.user_id=user_key and m.active and m.role in ('admin','diretoria')
      )
  ) item;
  return result_value;
end;
$$;

revoke all on function public.list_pending_public_agent_unit_holds() from public,anon;
grant execute on function public.list_pending_public_agent_unit_holds() to authenticated;

create or replace function public.decide_public_agent_unit_hold(
  p_reservation_id uuid,
  p_decision text,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_key uuid := auth.uid();
  reservation_row public.crm_unit_reservations%rowtype;
  unit_code_value text;
  decision_value text := lower(trim(p_decision));
  hold_hours integer := 24;
begin
  if user_key is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  if decision_value not in ('approve','reject') then raise exception 'DECISION_INVALID'; end if;
  if p_notes is not null and char_length(p_notes)>2000 then raise exception 'NOTES_TOO_LONG'; end if;

  select r.* into reservation_row
  from public.crm_unit_reservations r
  where r.id=p_reservation_id and r.source='public_agent'
  for update;
  if not found then raise exception 'HOLD_NOT_FOUND'; end if;

  if not exists (
    select 1 from public.organization_members m
    where m.organization_id=reservation_row.organization_id and m.user_id=user_key and m.active and m.role in ('admin','diretoria')
  ) then raise exception 'FORBIDDEN' using errcode='42501'; end if;

  if reservation_row.status<>'ativa' or (reservation_row.expires_at is not null and reservation_row.expires_at<=now()) then
    if reservation_row.status='ativa' then
      update public.crm_unit_reservations set status='expirada',approval_status='expired',decided_at=now(),decided_by=user_key,decision_notes=coalesce(p_notes,'Bloqueio expirado antes da decisão.') where id=reservation_row.id returning * into reservation_row;
    end if;
    raise exception 'HOLD_NOT_ACTIVE';
  end if;

  select u.unit_code into unit_code_value from public.crm_inventory_units u where u.id=reservation_row.unit_id;

  if decision_value='approve' then
    select greatest(1,least(72,coalesce(p.reservation_validity_hours,24))) into hold_hours
    from public.crm_negotiation_parameters p
    where p.id = nullif(reservation_row.metadata->>'policy_id','')::uuid;
    hold_hours := coalesce(hold_hours,24);

    update public.crm_unit_reservations
    set approval_status='approved',approved_by=user_key,decided_by=user_key,decided_at=now(),
        expires_at=now()+make_interval(hours=>hold_hours),decision_notes=nullif(trim(p_notes),'')
    where id=reservation_row.id returning * into reservation_row;
  else
    update public.crm_unit_reservations
    set approval_status='rejected',status='cancelada',decided_by=user_key,decided_at=now(),decision_notes=coalesce(nullif(trim(p_notes),''),'Bloqueio rejeitado pelo administrador.')
    where id=reservation_row.id returning * into reservation_row;
  end if;

  update public.crm_alerts
  set status='resolvido',resolved_at=now()
  where organization_id=reservation_row.organization_id
    and alert_type='public_unit_hold:'||left(replace(reservation_row.id::text,'-',''),12)
    and status='aberto';

  update public.user_activities
  set status='concluida',board_status='done',completed_at=now(),progress_percent=100,
      progress_note=case when decision_value='approve' then 'Bloqueio aprovado.' else 'Bloqueio rejeitado.' end,
      last_progress_at=now(),updated_by=user_key,updated_at=now()
  where organization_id=reservation_row.organization_id
    and related_type='crm_unit_reservation' and related_id=reservation_row.id
    and status<>'concluida';

  insert into public.audit_logs(organization_id,user_id,action,entity,entity_id,old_data,new_data)
  values(reservation_row.organization_id,user_key,'public_agent_hold_decision','crm_unit_reservations',reservation_row.id::text,
    jsonb_build_object('approval_status','pending'),
    jsonb_build_object('decision',decision_value,'approval_status',reservation_row.approval_status,'status',reservation_row.status,'unit_code',unit_code_value,'notes',p_notes));

  return jsonb_build_object(
    'ok',true,'reservationId',reservation_row.id,'decision',decision_value,
    'approvalStatus',reservation_row.approval_status,'status',reservation_row.status,
    'unitCode',unit_code_value,'expiresAt',reservation_row.expires_at
  );
end;
$$;

revoke all on function public.decide_public_agent_unit_hold(uuid,text,text) from public,anon;
grant execute on function public.decide_public_agent_unit_hold(uuid,text,text) to authenticated;

-- A base da Vitória passa a permitir fatos comerciais somente quando vierem do contexto em tempo real.
update crm_private.public_agent_experiences e
set knowledge = jsonb_set(
      jsonb_set(
        e.knowledge,
        '{guardrails}',
        coalesce(e.knowledge->'guardrails','[]'::jsonb)
          || jsonb_build_array(
            'Valores, disponibilidade e condições de pagamento só podem ser informados a partir do contexto comercial em tempo real retornado pelo sistema.',
            'Nunca revelar preço mínimo interno, margem, desconto não autorizado ou dados de outros clientes.',
            'O bloqueio público é temporário, exige identificação e consentimento para contato, e sempre permanece pendente de aprovação administrativa.'
          ),
        true
      ),
      '{approvedFacts}',
      (coalesce(e.knowledge->'approvedFacts','[]'::jsonb) - 'A disponibilidade, os valores e as condições comerciais podem mudar e devem ser confirmados pela equipe comercial.')
        || jsonb_build_array(
          'A Vitória consulta em tempo real os lotes disponíveis, os valores de tabela e a política comercial vigente.',
          'A Vitória pode solicitar o bloqueio temporário de um lote disponível; o bloqueio aguarda aprovação administrativa e expira automaticamente se não for decidido no prazo informado.'
        ),
      true
    ),
    theme = jsonb_set(
      jsonb_set(
        e.theme,
        '{quickReplies}',
        jsonb_build_array('Ver lotes disponíveis','Condições de pagamento','Quero morar','Quero investir'),
        true
      ),
      '{privacyNotice}',
      to_jsonb('Seus dados serão usados pela Évora Urbanismo para prestar o atendimento solicitado. O recebimento de novidades é opcional.'::text),
      true
    ),
    subtitle = 'Converse com a Vitória, consulte lotes e valores em tempo real e solicite um bloqueio sujeito à aprovação administrativa.',
    updated_at = now()
where e.slug='solaris' and e.active;
