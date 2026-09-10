begin;
-- Shared administrative infrastructure, with a server-persisted identity per private conversation.
alter table public.arisa_chat_threads add column assistant text not null default 'arisa' check(assistant in ('arisa','bia'));
create index assistant_chat_threads_owner on public.arisa_chat_threads(organization_id,owner_user_id,assistant,updated_at desc);
create function public.assistant_chat_create_thread(p_organization_id uuid,p_assistant text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result public.arisa_chat_threads;
begin
  if not private.arisa_is_admin(p_organization_id) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  if p_assistant is null or p_assistant not in ('arisa','bia') then raise exception 'ASSISTANT_INVALID'; end if;
  insert into public.arisa_chat_threads(organization_id,owner_user_id,title,assistant)
  values(p_organization_id,auth.uid(),case when p_assistant='bia' then 'Conversa com a Bia' else 'Conversa com a Arisa' end,p_assistant) returning * into result;
  return to_jsonb(result);
end $$;
revoke all on function public.assistant_chat_create_thread(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.assistant_chat_create_thread(uuid,text) to authenticated;

-- Preserve the actual author in the shared archive and memory sources.
create or replace function private.arisa_archive_row(p_source text,r jsonb,p_learn boolean default true)
returns void language plpgsql security definer set search_path='' as $$
declare assistant_name text:='Arisa'; assistant_id text:='arisa'; org uuid:=(r->>'organization_id')::uuid; owner_id uuid; subject text; label text:=''; body text; kind text; author text; channel text; data jsonb; learn boolean:=false;
begin
  if org is null then return; end if;
  if p_source in ('arisa_chat_messages','arisa_chat_files') then
    select t.assistant into assistant_id from public.arisa_chat_threads t where t.id=(r->>'thread_id')::uuid and t.organization_id=org;
  elsif p_source='arisa_chat_actions' then
    select t.assistant into assistant_id from public.arisa_chat_threads t join public.arisa_chat_messages m on m.thread_id=t.id where m.id=(r->>'message_id')::uuid and t.organization_id=org;
  end if;
  assistant_id:=coalesce(assistant_id,'arisa'); assistant_name:=case when assistant_id='bia' then 'Bia' else 'Arisa' end;
  if p_source='arisa_chat_messages' then
    owner_id:=(r->>'owner_user_id')::uuid; subject:='user:'||owner_id; label:='Administrador'; channel:=assistant_id||'_chat'; kind:='message'; author:=r->>'role'; body:=r->>'content';
    data:=r-'lease_token'-'lease_expires_at'-'updated_at'; learn:=p_learn and ((author='user' and r->>'status'='queued') or (author='assistant' and r->>'status'='completed'));
  elsif p_source='crm_messages' then
    subject:='conversation:'||(r->>'conversation_id');
    select 'crm:'||c.id,c.person_name into subject,label from public.crm_records c where c.id=(r->>'crm_record_id')::uuid and c.organization_id=org;
    subject:=coalesce(subject,'conversation:'||(r->>'conversation_id')); label:=coalesce(label,'Contato ainda não identificado');
    channel:=r->>'channel'; kind:='message'; author:=case when r->>'direction'='inbound' then 'external' else 'crm_'||coalesce(r->>'actor_type','team') end; body:=r->>'content'; data:=r;
    learn:=p_learn and (r->>'direction'='inbound' or r->>'delivery_status' in ('sent','delivered','read'));
  elsif p_source='arisa_chat_files' then
    owner_id:=(r->>'owner_user_id')::uuid; subject:='user:'||owner_id; label:='Administrador'; channel:=assistant_id||'_chat'; kind:='file'; author:='user'; body:=r->>'file_name'; data:=r;
  elsif p_source='arisa_chat_actions' then
    owner_id:=(r->>'actor_user_id')::uuid; subject:='user:'||owner_id; label:='Administrador'; channel:='platform'; kind:='action'; author:=assistant_id; body:=r->>'summary'; data:=r;
  else
    subject:='organization:'||org; channel:='platform'; kind:=case when p_source='insights' then 'insight' else 'operation' end; author:='arisa'; data:=r-'lease_token'-'lease_expires_at';
    body:=case when p_source='insights' then coalesce(r->>'title','')||E'\n'||data::text else data::text end;
    learn:=p_learn and p_source in ('insights','arisa_operation_items');
  end if;
  if p_source in ('arisa_chat_messages','arisa_chat_files','arisa_chat_actions') then data:=data||jsonb_build_object('assistant',assistant_id); end if;
  perform private.arisa_archive_put(org,owner_id,p_source,r->>'id',coalesce(channel,'platform'),kind,author,subject,label,
    case when p_source='crm_messages' then 'CRM · '||coalesce(label,'Contato') when kind='file' then body else assistant_name||' · '||kind end,
    body,data,coalesce((r->>'occurred_at')::timestamptz,(r->>'created_at')::timestamptz,now()),learn);
end $$;


-- Same canonical PRICE calculation and current commercial policy as WhatsApp v4, authorized by active administrator instead of a customer session.
create or replace function public.bia_manager_simulate(
  p_organization_id uuid,
  p_unit_code text,
  p_project_id uuid default null,
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


revoke all on function public.bia_manager_simulate(uuid,text,uuid,numeric,integer,integer,integer,numeric) from public,anon,authenticated,service_role;
grant execute on function public.bia_manager_simulate(uuid,text,uuid,numeric,integer,integer,integer,numeric) to authenticated;
notify pgrst, 'reload schema';
commit;
