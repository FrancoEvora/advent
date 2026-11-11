-- Share term-dependent rates across broker, corporate and Bia simulations.
-- Policy activation is audited separately after the frontend is ready.
CREATE OR REPLACE FUNCTION public.bia_manager_simulate(p_organization_id uuid, p_unit_code text, p_project_id uuid DEFAULT NULL::uuid, p_requested_down_payment_pct numeric DEFAULT NULL::numeric, p_requested_months integer DEFAULT NULL::integer, p_down_payment_installments integer DEFAULT 1, p_balloon_count integer DEFAULT 0, p_balloon_amount numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  unit_row public.crm_inventory_units%rowtype;
  policy_row public.crm_negotiation_parameters%rowtype;
  term_options integer[];
  term_value integer;
  down_payment_pct numeric;
  down_payment numeric;
  down_installments integer := coalesce(p_down_payment_installments, 1);
  down_installment_rate numeric := 0;
  down_installment_amount numeric;
  balloon_count_value integer := coalesce(p_balloon_count, 0);
  balloon_amount_value numeric := coalesce(p_balloon_amount, 0);
  balloon_total numeric;
  balloon_max_count integer;
  financed_amount numeric;
  monthly_payment numeric;
  term_rate numeric;
  scenarios jsonb := '[]'::jsonb;
  disclaimer_value text;
begin

  if private.is_broker_session() then raise exception 'Operação indisponível para o perfil corretor.' using errcode='42501'; end if;
  if not private.arisa_is_admin(p_organization_id) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;

  if upper(trim(coalesce(p_unit_code, ''))) !~ '^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$'
     or p_requested_down_payment_pct is not null
        and (p_requested_down_payment_pct < 0 or p_requested_down_payment_pct > 0.90)
     or p_requested_months is not null
        and (p_requested_months < 12 or p_requested_months > 600)
     or down_installments < 1 or down_installments > 24
     or balloon_count_value < 0 or balloon_count_value > 24
     or balloon_amount_value < 0 then
    raise exception 'PUBLIC_AGENT_SIMULATION_INPUT_INVALID';
  end if;

  if (select count(*) from public.crm_inventory_units u where u.organization_id=p_organization_id and u.unit_code=upper(trim(p_unit_code)) and (p_project_id is null or u.project_id=p_project_id) and u.active)>1 then raise exception 'BIA_SIMULATION_PROJECT_REQUIRED'; end if;
  select unit.* into unit_row from public.crm_inventory_units unit
  where unit.organization_id=p_organization_id and (p_project_id is null or unit.project_id=p_project_id)
    and unit.unit_code=upper(trim(p_unit_code)) and unit.active and unit.status='disponivel'
  for share of unit;
  if not found then raise exception 'PUBLIC_AGENT_UNIT_UNAVAILABLE'; end if;

  select policy.* into policy_row
  from public.crm_negotiation_parameters policy
  where policy.organization_id = p_organization_id
    and policy.project_id = unit_row.project_id
    and policy.active
    and (policy.valid_from is null or policy.valid_from <= current_date)
    and (policy.valid_until is null or policy.valid_until >= current_date)
  order by policy.is_default desc,
    policy.valid_from desc nulls last,
    policy.updated_at desc
  limit 1;

  if not found
     or policy_row.min_down_payment_pct is null
     or policy_row.monthly_interest_rate is null
     or nullif(trim(policy_row.indexer), '') is null then
    raise exception 'PUBLIC_AGENT_SIMULATION_POLICY_UNAVAILABLE';
  end if;

  select array_agg(parsed.term_value order by parsed.term_value)
  into term_options
  from (
    select case
      when option.value ~ '^[0-9]{2,3}$' then option.value::integer
      else null
    end as term_value
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(policy_row.parameters -> 'plan_options') = 'array'
          then policy_row.parameters -> 'plan_options'
        else '[]'::jsonb
      end
    ) option(value)
  ) parsed
  where parsed.term_value between 12 and least(coalesce(policy_row.max_installments, 600), 600);

  if coalesce(array_length(term_options, 1), 0) = 0 then
    if coalesce(policy_row.max_installments, 0) not between 12 and 600 then
      raise exception 'PUBLIC_AGENT_SIMULATION_POLICY_UNAVAILABLE';
    end if;
    term_options := array[
      case
        when p_requested_months is not null
          and p_requested_months <= policy_row.max_installments
          then p_requested_months
        else policy_row.max_installments
      end
    ];
  end if;
  if p_requested_months is not null
     and p_requested_months > policy_row.max_installments then
    raise exception 'PUBLIC_AGENT_SIMULATION_TERM_INVALID';
  end if;
  if p_requested_months is not null then
    term_options := array[p_requested_months];
  end if;

  down_payment_pct := greatest(
    policy_row.min_down_payment_pct,
    coalesce(p_requested_down_payment_pct, policy_row.min_down_payment_pct)
  );
  down_payment := round(unit_row.list_price * down_payment_pct, 2);

  if down_installments > 1 then
    if not coalesce(policy_row.allow_down_payment_installments, false)
       or down_installments > greatest(1, coalesce(policy_row.max_down_payment_installments, 1)) then
      raise exception 'PUBLIC_AGENT_SIMULATION_DOWN_PAYMENT_INVALID';
    end if;
    select parsed.monthly_interest_rate
    into down_installment_rate
    from (
      select
        case
          when coalesce(option ->> 'installments', '') ~ '^[0-9]{1,2}$'
            then (option ->> 'installments')::integer
          else null
        end as installments,
        case
          when coalesce(option ->> 'monthly_interest_rate', '') ~ '^[0-9]+([.][0-9]+)?$'
            then (option ->> 'monthly_interest_rate')::numeric
          else null
        end as monthly_interest_rate
      from jsonb_array_elements(
        case
          when jsonb_typeof(policy_row.parameters -> 'down_payment_options') = 'array'
            then policy_row.parameters -> 'down_payment_options'
          else '[]'::jsonb
        end
      ) option
    ) parsed
    where parsed.installments = down_installments
      and parsed.monthly_interest_rate is not null
    limit 1;
    if not found then
      down_installment_rate := greatest(
        coalesce(policy_row.down_payment_interest_rate, 0),
        0
      );
    end if;
  end if;

  down_installment_rate := private.commercial_entry_rate(policy_row,down_installments);
  down_installment_amount := case
    when down_installment_rate > 0 then round(
      down_payment
      * (
        down_installment_rate * power(1 + down_installment_rate, down_installments)
      )
      / (power(1 + down_installment_rate, down_installments) - 1),
      2
    )
    else round(down_payment / down_installments, 2)
  end;

  balloon_max_count := case
    when coalesce(policy_row.parameters ->> 'annual_balloon_max_count', '') ~ '^[0-9]{1,2}$'
      then least((policy_row.parameters ->> 'annual_balloon_max_count')::integer, 24)
    when coalesce(policy_row.balloon_frequency_months, 0) > 0
      then least(
        floor(
          coalesce(policy_row.max_installments, 0)::numeric
          / policy_row.balloon_frequency_months
        )::integer,
        24
      )
    else 0
  end;
  balloon_total := round(balloon_count_value * balloon_amount_value, 2);
  if (balloon_count_value = 0 and balloon_amount_value <> 0)
     or (balloon_count_value > 0 and balloon_amount_value <= 0)
     or balloon_count_value > balloon_max_count
     or balloon_total > unit_row.list_price * coalesce(policy_row.balloon_limit_pct, 0) then
    raise exception 'PUBLIC_AGENT_SIMULATION_BALLOON_INVALID';
  end if;
  if balloon_count_value > 0
     and coalesce(policy_row.balloon_frequency_months, 0) <= 0 then
    raise exception 'PUBLIC_AGENT_SIMULATION_BALLOON_INVALID';
  end if;

  financed_amount := round(
    unit_row.list_price - down_payment - balloon_total,
    2
  );
  if financed_amount <= 0 then
    raise exception 'PUBLIC_AGENT_SIMULATION_BALLOON_INVALID';
  end if;

  foreach term_value in array term_options loop
    if balloon_count_value > 0
       and balloon_count_value * policy_row.balloon_frequency_months > term_value then
      if p_requested_months is not null then
        raise exception 'PUBLIC_AGENT_SIMULATION_BALLOON_INVALID';
      end if;
      continue;
    end if;
    term_rate := private.commercial_monthly_rate(policy_row,term_value);
    monthly_payment := case
      when term_rate > 0 then round(
        financed_amount
        * (
          term_rate
          * power(1 + term_rate, term_value)
        )
        / (power(1 + term_rate, term_value) - 1),
        2
      )
      else round(financed_amount / term_value, 2)
    end;
    scenarios := scenarios || jsonb_build_array(jsonb_build_object(
      'months', term_value,
      'financedAmount', financed_amount,
      'monthlyPayment', monthly_payment,
      'monthlyInterestRate', term_rate,
      'balloonTotal', balloon_total
    ));
  end loop;

  if jsonb_array_length(scenarios) = 0 then
    raise exception 'PUBLIC_AGENT_SIMULATION_TERM_INVALID';
  end if;

  disclaimer_value := concat_ws(
    ' ',
    nullif(trim(policy_row.parameters ->> 'disclaimer'), ''),
    'Cálculo indicativo pelo método PRICE, sem projetar a variação futura do ' || policy_row.indexer || '.',
    'Condição sujeita à disponibilidade, análise cadastral e aprovação comercial.'
  );

  return jsonb_build_object(
    'projectName', (select name from public.projects where id=unit_row.project_id and organization_id=p_organization_id),
    'unitCode', unit_row.unit_code,
    'area', round(unit_row.area, 2),
    'price', round(unit_row.list_price, 2),
    'minimumDownPaymentPct', policy_row.min_down_payment_pct,
    'minimumDownPaymentApplied', coalesce(p_requested_down_payment_pct, policy_row.min_down_payment_pct) < policy_row.min_down_payment_pct,
    'downPaymentPct', down_payment_pct,
    'downPayment', down_payment,
    'downPaymentInstallments', down_installments,
    'downPaymentInstallmentAmount', down_installment_amount,
    'downPaymentInterestRate', down_installment_rate,
    'balloonCount', balloon_count_value,
    'balloonAmount', balloon_amount_value,
    'balloonFrequencyMonths', coalesce(policy_row.balloon_frequency_months, 12),
    'monthlyInterestRate', (select (scenario->>'monthlyInterestRate')::numeric from jsonb_array_elements(scenarios) scenario order by (scenario->>'monthlyPayment')::numeric limit 1),
    'interestRateTiers', policy_row.parameters->'interest_rate_tiers',
    'indexer', policy_row.indexer,
    'calculationMethod', 'PRICE',
    'scenarios', scenarios,
    'generatedAt', clock_timestamp(),
    'disclaimer', disclaimer_value,
    'policyId', policy_row.id
  );
end
$function$
;

CREATE OR REPLACE FUNCTION public.calculate_public_agent_payment_simulation_v4(p_slug text, p_session_token_hash text, p_fingerprint_hash text, p_unit_code text, p_requested_down_payment_pct numeric DEFAULT NULL::numeric, p_requested_months integer DEFAULT NULL::integer, p_down_payment_installments integer DEFAULT 1, p_balloon_count integer DEFAULT 0, p_balloon_amount numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  session_row crm_private.public_agent_sessions%rowtype;
  experience_row crm_private.public_agent_experiences%rowtype;
  unit_row public.crm_inventory_units%rowtype;
  policy_row public.crm_negotiation_parameters%rowtype;
  term_options integer[];
  term_value integer;
  down_payment_pct numeric;
  down_payment numeric;
  down_installments integer := coalesce(p_down_payment_installments, 1);
  down_installment_rate numeric := 0;
  down_installment_amount numeric;
  balloon_count_value integer := coalesce(p_balloon_count, 0);
  balloon_amount_value numeric := coalesce(p_balloon_amount, 0);
  balloon_total numeric;
  balloon_max_count integer;
  financed_amount numeric;
  monthly_payment numeric;
  term_rate numeric;
  scenarios jsonb := '[]'::jsonb;
  disclaimer_value text;
begin
  perform crm_private.assert_public_agent_service_role();

  if p_session_token_hash !~ '^[a-f0-9]{64}$'
     or p_fingerprint_hash !~ '^[a-f0-9]{64}$'
     or upper(trim(coalesce(p_unit_code, ''))) !~ '^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$'
     or p_requested_down_payment_pct is not null
        and (p_requested_down_payment_pct < 0 or p_requested_down_payment_pct > 0.90)
     or p_requested_months is not null
        and (p_requested_months < 12 or p_requested_months > 600)
     or down_installments < 1 or down_installments > 24
     or balloon_count_value < 0 or balloon_count_value > 24
     or balloon_amount_value < 0 then
    raise exception 'PUBLIC_AGENT_SIMULATION_INPUT_INVALID';
  end if;

  select session.* into session_row
  from crm_private.public_agent_sessions session
  join crm_private.public_agent_experiences experience
    on experience.id = session.experience_id
  where experience.slug = lower(trim(p_slug))
    and experience.active
    and session.session_token_hash = p_session_token_hash
    and session.fingerprint_hash = p_fingerprint_hash
    and session.status not in ('closed', 'blocked')
    and session.expires_at > now()
  for update of session;

  if not found then
    raise exception 'PUBLIC_AGENT_SESSION_INACTIVE';
  end if;

  select * into experience_row
  from crm_private.public_agent_experiences
  where id = session_row.experience_id;

  select unit.* into unit_row
  from public.crm_inventory_units unit
  where unit.organization_id = experience_row.organization_id
    and unit.project_id = experience_row.project_id
    and (experience_row.product_id is null or unit.product_id = experience_row.product_id)
    and unit.unit_code = upper(trim(p_unit_code))
    and unit.active
    and (
      unit.status = 'disponivel'
      or (
        unit.status = 'reservado'
        and exists (
          select 1
          from public.crm_unit_reservations reservation
          where reservation.unit_id = unit.id
            and reservation.status = 'ativa'
            and reservation.expires_at > now()
            and reservation.source_reference = session_row.id::text
        )
      )
    )
  for share of unit;

  if not found then
    raise exception 'PUBLIC_AGENT_UNIT_UNAVAILABLE';
  end if;

  select policy.* into policy_row
  from public.crm_negotiation_parameters policy
  where policy.organization_id = experience_row.organization_id
    and policy.project_id = experience_row.project_id
    and policy.active
    and (policy.valid_from is null or policy.valid_from <= current_date)
    and (policy.valid_until is null or policy.valid_until >= current_date)
  order by policy.is_default desc,
    policy.valid_from desc nulls last,
    policy.updated_at desc
  limit 1;

  if not found
     or policy_row.min_down_payment_pct is null
     or policy_row.monthly_interest_rate is null
     or nullif(trim(policy_row.indexer), '') is null then
    raise exception 'PUBLIC_AGENT_SIMULATION_POLICY_UNAVAILABLE';
  end if;

  select array_agg(parsed.term_value order by parsed.term_value)
  into term_options
  from (
    select case
      when option.value ~ '^[0-9]{2,3}$' then option.value::integer
      else null
    end as term_value
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(policy_row.parameters -> 'plan_options') = 'array'
          then policy_row.parameters -> 'plan_options'
        else '[]'::jsonb
      end
    ) option(value)
  ) parsed
  where parsed.term_value between 12 and least(coalesce(policy_row.max_installments, 600), 600);

  if coalesce(array_length(term_options, 1), 0) = 0 then
    if coalesce(policy_row.max_installments, 0) not between 12 and 600 then
      raise exception 'PUBLIC_AGENT_SIMULATION_POLICY_UNAVAILABLE';
    end if;
    term_options := array[
      case
        when p_requested_months is not null
          and p_requested_months <= policy_row.max_installments
          then p_requested_months
        else policy_row.max_installments
      end
    ];
  end if;
  if p_requested_months is not null
     and p_requested_months > policy_row.max_installments then
    raise exception 'PUBLIC_AGENT_SIMULATION_TERM_INVALID';
  end if;
  if p_requested_months is not null then
    term_options := array[p_requested_months];
  end if;

  down_payment_pct := greatest(
    policy_row.min_down_payment_pct,
    coalesce(p_requested_down_payment_pct, policy_row.min_down_payment_pct)
  );
  down_payment := round(unit_row.list_price * down_payment_pct, 2);

  if down_installments > 1 then
    if not coalesce(policy_row.allow_down_payment_installments, false)
       or down_installments > greatest(1, coalesce(policy_row.max_down_payment_installments, 1)) then
      raise exception 'PUBLIC_AGENT_SIMULATION_DOWN_PAYMENT_INVALID';
    end if;
    select parsed.monthly_interest_rate
    into down_installment_rate
    from (
      select
        case
          when coalesce(option ->> 'installments', '') ~ '^[0-9]{1,2}$'
            then (option ->> 'installments')::integer
          else null
        end as installments,
        case
          when coalesce(option ->> 'monthly_interest_rate', '') ~ '^[0-9]+([.][0-9]+)?$'
            then (option ->> 'monthly_interest_rate')::numeric
          else null
        end as monthly_interest_rate
      from jsonb_array_elements(
        case
          when jsonb_typeof(policy_row.parameters -> 'down_payment_options') = 'array'
            then policy_row.parameters -> 'down_payment_options'
          else '[]'::jsonb
        end
      ) option
    ) parsed
    where parsed.installments = down_installments
      and parsed.monthly_interest_rate is not null
    limit 1;
    if not found then
      down_installment_rate := greatest(
        coalesce(policy_row.down_payment_interest_rate, 0),
        0
      );
    end if;
  end if;

  down_installment_rate := private.commercial_entry_rate(policy_row,down_installments);
  down_installment_amount := case
    when down_installment_rate > 0 then round(
      down_payment
      * (
        down_installment_rate * power(1 + down_installment_rate, down_installments)
      )
      / (power(1 + down_installment_rate, down_installments) - 1),
      2
    )
    else round(down_payment / down_installments, 2)
  end;

  balloon_max_count := case
    when coalesce(policy_row.parameters ->> 'annual_balloon_max_count', '') ~ '^[0-9]{1,2}$'
      then least((policy_row.parameters ->> 'annual_balloon_max_count')::integer, 24)
    when coalesce(policy_row.balloon_frequency_months, 0) > 0
      then least(
        floor(
          coalesce(policy_row.max_installments, 0)::numeric
          / policy_row.balloon_frequency_months
        )::integer,
        24
      )
    else 0
  end;
  balloon_total := round(balloon_count_value * balloon_amount_value, 2);
  if (balloon_count_value = 0 and balloon_amount_value <> 0)
     or (balloon_count_value > 0 and balloon_amount_value <= 0)
     or balloon_count_value > balloon_max_count
     or balloon_total > unit_row.list_price * coalesce(policy_row.balloon_limit_pct, 0) then
    raise exception 'PUBLIC_AGENT_SIMULATION_BALLOON_INVALID';
  end if;
  if balloon_count_value > 0
     and coalesce(policy_row.balloon_frequency_months, 0) <= 0 then
    raise exception 'PUBLIC_AGENT_SIMULATION_BALLOON_INVALID';
  end if;

  financed_amount := round(
    unit_row.list_price - down_payment - balloon_total,
    2
  );
  if financed_amount <= 0 then
    raise exception 'PUBLIC_AGENT_SIMULATION_BALLOON_INVALID';
  end if;

  foreach term_value in array term_options loop
    if balloon_count_value > 0
       and balloon_count_value * policy_row.balloon_frequency_months > term_value then
      if p_requested_months is not null then
        raise exception 'PUBLIC_AGENT_SIMULATION_BALLOON_INVALID';
      end if;
      continue;
    end if;
    term_rate := private.commercial_monthly_rate(policy_row,term_value);
    monthly_payment := case
      when term_rate > 0 then round(
        financed_amount
        * (
          term_rate
          * power(1 + term_rate, term_value)
        )
        / (power(1 + term_rate, term_value) - 1),
        2
      )
      else round(financed_amount / term_value, 2)
    end;
    scenarios := scenarios || jsonb_build_array(jsonb_build_object(
      'months', term_value,
      'financedAmount', financed_amount,
      'monthlyPayment', monthly_payment,
      'monthlyInterestRate', term_rate,
      'balloonTotal', balloon_total
    ));
  end loop;

  if jsonb_array_length(scenarios) = 0 then
    raise exception 'PUBLIC_AGENT_SIMULATION_TERM_INVALID';
  end if;

  disclaimer_value := concat_ws(
    ' ',
    nullif(trim(policy_row.parameters ->> 'disclaimer'), ''),
    'Cálculo indicativo pelo método PRICE, sem projetar a variação futura do ' || policy_row.indexer || '.',
    'Condição sujeita à disponibilidade, análise cadastral e aprovação comercial.'
  );

  return jsonb_build_object(
    'projectName', experience_row.name,
    'unitCode', unit_row.unit_code,
    'area', round(unit_row.area, 2),
    'price', round(unit_row.list_price, 2),
    'minimumDownPaymentPct', policy_row.min_down_payment_pct,
    'minimumDownPaymentApplied', coalesce(p_requested_down_payment_pct, policy_row.min_down_payment_pct) < policy_row.min_down_payment_pct,
    'downPaymentPct', down_payment_pct,
    'downPayment', down_payment,
    'downPaymentInstallments', down_installments,
    'downPaymentInstallmentAmount', down_installment_amount,
    'downPaymentInterestRate', down_installment_rate,
    'balloonCount', balloon_count_value,
    'balloonAmount', balloon_amount_value,
    'balloonFrequencyMonths', coalesce(policy_row.balloon_frequency_months, 12),
    'monthlyInterestRate', (select (scenario->>'monthlyInterestRate')::numeric from jsonb_array_elements(scenarios) scenario order by (scenario->>'monthlyPayment')::numeric limit 1),
    'interestRateTiers', policy_row.parameters->'interest_rate_tiers',
    'indexer', policy_row.indexer,
    'calculationMethod', 'PRICE',
    'scenarios', scenarios,
    'generatedAt', clock_timestamp(),
    'disclaimer', disclaimer_value,
    'policyId', policy_row.id
  );
end
$function$
;

CREATE OR REPLACE FUNCTION public.crm_prepare_proposal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  policy public.crm_negotiation_parameters%rowtype;
  unit_row public.crm_inventory_units%rowtype;
  campaign public.crm_campaigns%rowtype;
  lead_campaign_id uuid;
  lead_organization_id uuid;
  lead_project_id uuid;
  down_pct numeric := 0;
begin
  select * into unit_row
  from public.crm_inventory_units
  where id = new.unit_id;

  if unit_row.id is null then
    raise exception 'Unidade comercial não encontrada';
  end if;

  if unit_row.organization_id <> new.organization_id
     or unit_row.project_id <> new.project_id then
    raise exception 'A unidade não pertence à organização e ao empreendimento da proposta';
  end if;

  if (tg_op = 'INSERT' or new.unit_id is distinct from old.unit_id)
     and unit_row.status in ('vendido', 'indisponivel') then
    raise exception 'A unidade não está disponível para proposta';
  end if;

  if tg_op = 'UPDATE' and old.submitted_at is not null and (
    new.organization_id is distinct from old.organization_id
    or new.project_id is distinct from old.project_id
    or new.unit_id is distinct from old.unit_id
    or new.crm_record_id is distinct from old.crm_record_id
    or new.campaign_id is distinct from old.campaign_id
    or new.negotiation_policy_id is distinct from old.negotiation_policy_id
    or new.policy_snapshot is distinct from old.policy_snapshot
    or new.list_price is distinct from old.list_price
    or new.sale_price is distinct from old.sale_price
    or new.down_payment is distinct from old.down_payment
    or new.down_payment_installments_count is distinct from old.down_payment_installments_count
    or new.down_payment_first_due_date is distinct from old.down_payment_first_due_date
    or new.installments_count is distinct from old.installments_count
    or new.monthly_interest_rate is distinct from old.monthly_interest_rate
    or new.grace_months is distinct from old.grace_months
    or new.balloon_total is distinct from old.balloon_total
    or new.payment_plan is distinct from old.payment_plan
  ) then
    raise exception 'As condições e a política de uma proposta submetida são imutáveis; cancele e emita uma nova proposta';
  end if;

  if tg_op = 'UPDATE' and old.submitted_at is not null then
    return new;
  end if;

  if new.proposal_number is null then
    new.proposal_number := 'PROP-' || to_char(now(), 'YYYY') || '-' ||
      lpad(nextval('public.crm_proposal_number_seq')::text, 6, '0');
  end if;

  if new.list_price <= 0 then
    new.list_price := unit_row.list_price;
  end if;
  if new.sale_price <= 0 then
    new.sale_price := greatest(new.list_price - new.discount_amount, 0);
  end if;

  new.discount_amount := greatest(new.list_price - new.sale_price, 0);
  new.discount_pct := case when new.list_price > 0
    then new.discount_amount / new.list_price else 0 end;
  new.financed_amount := greatest(new.sale_price - new.down_payment, 0);
  down_pct := case when new.sale_price > 0
    then new.down_payment / new.sale_price else 0 end;

  if new.crm_record_id is not null then
    select record.organization_id, record.project_id, record.campaign_id
    into lead_organization_id, lead_project_id, lead_campaign_id
    from public.crm_records record
    where record.id = new.crm_record_id;

    if lead_organization_id is null
       or lead_organization_id <> new.organization_id
       or (lead_project_id is not null and lead_project_id <> new.project_id) then
      raise exception 'O lead não pertence à organização e ao empreendimento da proposta';
    end if;

    if new.campaign_id is null then
      new.campaign_id := lead_campaign_id;
    end if;
  end if;

  if new.campaign_id is not null then
    select * into campaign
    from public.crm_campaigns
    where id = new.campaign_id
      and organization_id = new.organization_id;

    if campaign.id is null
       or (campaign.project_id is not null and campaign.project_id <> new.project_id) then
      raise exception 'A campanha comercial não pertence ao empreendimento da proposta';
    end if;
  end if;

  if campaign.negotiation_policy_id is not null then
    if new.negotiation_policy_id is not null
       and new.negotiation_policy_id <> campaign.negotiation_policy_id then
      raise exception 'A proposta deve utilizar a política comercial vinculada à campanha';
    end if;

    select * into policy
    from public.crm_negotiation_parameters
    where id = campaign.negotiation_policy_id
      and organization_id = new.organization_id
      and project_id = new.project_id
      and active
      and (valid_from is null or valid_from <= current_date)
      and (valid_until is null or valid_until >= current_date);

    if policy.id is null then
      raise exception 'A política comercial vinculada à campanha não está vigente';
    end if;
  elsif new.negotiation_policy_id is not null then
    select * into policy
    from public.crm_negotiation_parameters
    where id = new.negotiation_policy_id
      and organization_id = new.organization_id
      and project_id = new.project_id
      and active
      and (valid_from is null or valid_from <= current_date)
      and (valid_until is null or valid_until >= current_date);

    if policy.id is null then
      raise exception 'A política comercial informada não está vigente para o empreendimento';
    end if;
  else
    select * into policy
    from public.crm_negotiation_parameters
    where project_id = new.project_id
      and organization_id = new.organization_id
      and active
      and (valid_from is null or valid_from <= current_date)
      and (valid_until is null or valid_until >= current_date)
    order by is_default desc, created_at desc
    limit 1;
  end if;

  if policy.id is not null then
    if new.status='submetida' and jsonb_typeof(policy.parameters->'interest_rate_tiers')='array' and new.installments_count>0 then
      if new.monthly_interest_rate is distinct from private.commercial_monthly_rate(policy,new.installments_count) then
        raise exception 'Taxa incompatível com o prazo e a política vigente. Recalcule a proposta.';
      end if;
    end if;
    new.negotiation_policy_id := policy.id;
    if tg_op = 'INSERT' or coalesce(new.policy_snapshot, '{}'::jsonb) = '{}'::jsonb then
      new.policy_snapshot := to_jsonb(policy) - 'created_by' - 'updated_by';
    end if;
    if new.valid_until is null then
      new.valid_until := now() + (policy.proposal_validity_days || ' days')::interval;
    end if;
    new.requires_approval :=
      new.discount_pct > policy.admin_approval_discount_pct
      or new.discount_pct > policy.max_discount_pct
      or down_pct < policy.min_down_payment_pct
      or new.installments_count > policy.max_installments
      or (
        policy.min_installment > 0
        and new.installments_count > 0
        and new.financed_amount / new.installments_count < policy.min_installment
      )
      or (
        policy.require_admin_below_min_price
        and unit_row.minimum_price is not null
        and new.sale_price < unit_row.minimum_price
      );
  elsif new.status = 'submetida' then
    raise exception 'Nenhuma política comercial vigente foi definida para o empreendimento';
  elsif new.valid_until is null then
    new.valid_until := now() + interval '5 days';
  end if;

  if new.status = 'submetida' then
    new.submitted_at := coalesce(new.submitted_at, now());
    new.approval_status := case when new.requires_approval
      then 'pendente' else 'aprovada' end;
  end if;

  return new;
end;
$function$
;
notify pgrst,'reload schema';
