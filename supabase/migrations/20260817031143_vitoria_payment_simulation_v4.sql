begin;

create or replace function public.calculate_public_agent_payment_simulation_v4(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_unit_code text,
  p_requested_down_payment_pct numeric default null,
  p_requested_months integer default null,
  p_down_payment_installments integer default 1,
  p_balloon_count integer default 0,
  p_balloon_amount numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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
     and not (p_requested_months = any(term_options)) then
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
    monthly_payment := case
      when policy_row.monthly_interest_rate > 0 then round(
        financed_amount
        * (
          policy_row.monthly_interest_rate
          * power(1 + policy_row.monthly_interest_rate, term_value)
        )
        / (power(1 + policy_row.monthly_interest_rate, term_value) - 1),
        2
      )
      else round(financed_amount / term_value, 2)
    end;
    scenarios := scenarios || jsonb_build_array(jsonb_build_object(
      'months', term_value,
      'financedAmount', financed_amount,
      'monthlyPayment', monthly_payment,
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
    'monthlyInterestRate', policy_row.monthly_interest_rate,
    'indexer', policy_row.indexer,
    'calculationMethod', 'PRICE',
    'scenarios', scenarios,
    'generatedAt', clock_timestamp(),
    'disclaimer', disclaimer_value,
    'policyId', policy_row.id
  );
end
$function$;

revoke all on function public.calculate_public_agent_payment_simulation_v4(
  text, text, text, text, numeric, integer, integer, integer, numeric
) from public, anon, authenticated;
grant execute on function public.calculate_public_agent_payment_simulation_v4(
  text, text, text, text, numeric, integer, integer, integer, numeric
) to service_role;

commit;
