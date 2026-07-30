-- Évora Gestão 6.16 — demonstrativo mensal e mapa comercial do terrenista.
-- O snapshot continua imutável: o portal público nunca consulta títulos
-- financeiros ou estoque diretamente e só recebe seções publicadas.

do $preflight$
begin
  if to_regclass('public.partner_landowner_publications') is null
    or to_regclass('public.partner_landowner_contract_terms') is null
    or to_regclass('public.partner_landowner_repass_entries') is null
    or to_regclass('public.crm_contracts') is null
    or to_regclass('public.crm_inventory_units') is null
    or to_regclass('public.crm_proposal_installments') is null
    or to_regclass('public.financial_entries') is null
    or to_regprocedure(
      'public.build_landowner_portal_snapshot_core(uuid,uuid,uuid,date,date)'
    ) is null
    or to_regprocedure(
      'public.get_partner_payment_portal_v2_core(text,text)'
    ) is null then
    raise exception
      'Dependências do demonstrativo periódico do terrenista ausentes.';
  end if;
end
$preflight$;

alter table public.partner_landowner_publications
  drop constraint if exists partner_landowner_sections_check;

update public.partner_landowner_publications
   set visible_sections = visible_sections
     || jsonb_build_object('period_statement', false)
 where not (visible_sections ? 'period_statement');

update public.partner_landowner_publications
   set visible_sections = visible_sections
     || jsonb_build_object('sales_map', false)
 where not (visible_sections ? 'sales_map');

alter table public.partner_landowner_publications
  alter column visible_sections set default jsonb_build_object(
    'lots', true,
    'sales_map', true,
    'vgv', true,
    'vso', true,
    'conditions_summary', true,
    'sales_details', false,
    'delinquency', true,
    'repasses_summary', true,
    'repass_details', false,
    'construction', true,
    'period_statement', true
  );

alter table public.partner_landowner_publications
  add constraint partner_landowner_sections_check
  check (
    jsonb_typeof(visible_sections) = 'object'
    and jsonb_typeof(visible_sections -> 'lots') = 'boolean'
    and jsonb_typeof(visible_sections -> 'sales_map') = 'boolean'
    and jsonb_typeof(visible_sections -> 'vgv') = 'boolean'
    and jsonb_typeof(visible_sections -> 'vso') = 'boolean'
    and jsonb_typeof(
      visible_sections -> 'conditions_summary'
    ) = 'boolean'
    and jsonb_typeof(visible_sections -> 'sales_details') = 'boolean'
    and jsonb_typeof(visible_sections -> 'delinquency') = 'boolean'
    and jsonb_typeof(
      visible_sections -> 'repasses_summary'
    ) = 'boolean'
    and jsonb_typeof(visible_sections -> 'repass_details') = 'boolean'
    and jsonb_typeof(visible_sections -> 'construction') = 'boolean'
    and jsonb_typeof(visible_sections -> 'period_statement') = 'boolean'
    and visible_sections ?& array[
      'lots',
      'sales_map',
      'vgv',
      'vso',
      'conditions_summary',
      'sales_details',
      'delinquency',
      'repasses_summary',
      'repass_details',
      'construction',
      'period_statement'
    ]
    and visible_sections - array[
      'lots',
      'sales_map',
      'vgv',
      'vso',
      'conditions_summary',
      'sales_details',
      'delinquency',
      'repasses_summary',
      'repass_details',
      'construction',
      'period_statement'
    ] = '{}'::jsonb
    and pg_column_size(visible_sections) <= 2048
  );

create index if not exists
  crm_proposal_installments_financial_entry_idx
  on public.crm_proposal_installments (financial_entry_id)
  where financial_entry_id is not null;

create or replace function public.build_landowner_sales_map(
  p_organization_id uuid,
  p_project_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
with signed_sales as (
  select distinct on (
    contract.organization_id,
    contract.unit_id
  )
    contract.organization_id,
    contract.unit_id
  from public.crm_contracts contract
  where contract.organization_id = p_organization_id
    and contract.project_id = p_project_id
    and contract.status = 'assinado'
  order by
    contract.organization_id,
    contract.unit_id,
    coalesce(
      contract.customer_signed_at,
      contract.signed_at,
      contract.created_at
    ) desc,
    contract.created_at desc
),
public_units as (
  select
    unit.unit_code,
    unit.block_code,
    unit.lot_number,
    unit.area,
    case
      when sale.unit_id is not null then 'vendido'
      when unit.status = 'disponivel' then 'disponivel'
      when unit.status = 'reservado' then 'reservado'
      when unit.status = 'vendido' then 'vendido'
      when unit.status in (
        'bloqueio_estrategico',
        'bloqueio_comercial'
      ) then 'bloqueado'
      else 'indisponivel'
    end as status
  from public.crm_inventory_units unit
  left join signed_sales sale
    on sale.organization_id = unit.organization_id
   and sale.unit_id = unit.id
  where unit.organization_id = p_organization_id
    and unit.project_id = p_project_id
    and unit.active = true
),
map_metrics as (
  select
    count(*)::integer as total_units,
    count(*) filter (
      where unit.status = 'disponivel'
    )::integer as available_units,
    count(*) filter (
      where unit.status = 'reservado'
    )::integer as reserved_units,
    count(*) filter (
      where unit.status = 'vendido'
    )::integer as sold_units,
    count(*) filter (
      where unit.status = 'bloqueado'
    )::integer as blocked_units,
    count(*) filter (
      where unit.status = 'indisponivel'
    )::integer as unavailable_units
  from public_units unit
),
map_units as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'unit_code', unit.unit_code,
        'block_code', unit.block_code,
        'lot_number', unit.lot_number,
        'area', unit.area,
        'status', unit.status
      )
      order by unit.block_code, unit.lot_number, unit.unit_code
    ),
    '[]'::jsonb
  ) as rows
  from public_units unit
)
select jsonb_build_object(
  'position_date',
    (now() at time zone 'America/Sao_Paulo')::date,
  'total_units', metrics.total_units,
  'counts', jsonb_build_object(
    'disponivel', metrics.available_units,
    'reservado', metrics.reserved_units,
    'vendido', metrics.sold_units,
    'bloqueado', metrics.blocked_units,
    'indisponivel', metrics.unavailable_units
  ),
  'units', units.rows,
  'basis',
    'Posição comercial das unidades ativas congelada no momento da publicação. Bloqueios internos são apresentados de forma agrupada.'
)
from map_metrics metrics
cross join map_units units;
$function$;

revoke all on function public.build_landowner_sales_map(
  uuid,
  uuid
) from public, anon, authenticated, service_role;

create or replace function public.build_landowner_period_statement(
  p_organization_id uuid,
  p_contact_id uuid,
  p_project_id uuid,
  p_period_start date,
  p_period_end date
)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
with contract_terms as (
  select terms.contractual_percentage
  from public.partner_landowner_contract_terms terms
  where terms.organization_id = p_organization_id
    and terms.contact_id = p_contact_id
    and terms.project_id = p_project_id
),
canonical_sales as (
  select distinct on (contract.organization_id, contract.unit_id)
    contract.organization_id,
    contract.proposal_id,
    coalesce(
      contract.customer_signed_at,
      contract.signed_at,
      contract.created_at
    )::date as sale_date
  from public.crm_contracts contract
  where contract.organization_id = p_organization_id
    and contract.project_id = p_project_id
    and contract.status = 'assinado'
    and coalesce(
      contract.customer_signed_at,
      contract.signed_at,
      contract.created_at
    )::date <= p_period_end
  order by
    contract.organization_id,
    contract.unit_id,
    coalesce(
      contract.customer_signed_at,
      contract.signed_at,
      contract.created_at
    ) desc,
    contract.created_at desc
),
receivable_candidates as (
  select
    coalesce(entry.id, installment.id) as row_key,
    installment.id as installment_id,
    sale.sale_date,
    installment.due_date,
    installment.status as installment_status,
    entry.id as financial_entry_id,
    entry.status as entry_status,
    entry.settlement_date,
    case
      when installment.status = 'cancelada'
        or coalesce(entry.status, '') = 'cancelado'
      then 0
      else greatest(
        coalesce(
          nullif(entry.original_amount, 0),
          entry.amount,
          installment.amount,
          0
        ),
        0
      )
    end::numeric as original_amount,
    case
      when installment.status = 'cancelada'
        or coalesce(entry.status, '') = 'cancelado'
      then 0
      when installment.status = 'paga'
        or coalesce(entry.status, '') = 'recebido'
      then 0
      when entry.id is not null
      then greatest(coalesce(entry.open_amount, entry.amount, 0), 0)
      else greatest(coalesce(installment.amount, 0), 0)
    end::numeric as current_open_amount,
    case
      when installment.status <> 'cancelada'
        and entry.type = 'entrada'
        and entry.project_id = p_project_id
        and entry.status = 'recebido'
        and entry.settlement_date is not null
      then greatest(
        least(
          coalesce(
            nullif(entry.reconciled_amount, 0),
            nullif(entry.original_amount, 0),
            entry.amount,
            installment.amount,
            0
          ),
          coalesce(
            nullif(entry.original_amount, 0),
            entry.amount,
            installment.amount,
            0
          )
        ),
        0
      )
      else 0
    end::numeric as received_amount
  from canonical_sales sale
  join public.crm_proposal_installments installment
    on installment.organization_id = sale.organization_id
   and installment.proposal_id = sale.proposal_id
  left join public.financial_entries entry
    on entry.organization_id = installment.organization_id
   and entry.id = installment.financial_entry_id
   and (
     entry.project_id = p_project_id
     or entry.project_id is null
   )
),
receivable_rows as (
  select distinct on (candidate.row_key)
    candidate.*
  from receivable_candidates candidate
  order by
    candidate.row_key,
    candidate.due_date,
    candidate.installment_id
),
repass_rows as (
  select
    entry.settlement_date,
    classification.allocated_amount::numeric as amount
  from public.partner_landowner_repass_entries classification
  join public.financial_entries entry
    on entry.id = classification.financial_entry_id
   and entry.organization_id = classification.organization_id
  where classification.organization_id = p_organization_id
    and classification.contact_id = p_contact_id
    and classification.project_id = p_project_id
    and entry.contact_id = p_contact_id
    and entry.project_id = p_project_id
    and entry.type = 'saida'
    and entry.status = 'pago'
    and entry.settlement_date is not null
    and entry.status <> 'cancelado'
),
month_ranges as (
  select
    to_char(bucket.month_start, 'YYYY-MM') as month,
    greatest(bucket.month_start, p_period_start)::date as period_start,
    least(
      (
        bucket.month_start
        + interval '1 month'
        - interval '1 day'
      )::date,
      p_period_end
    ) as period_end
  from generate_series(
    date_trunc('month', p_period_start::timestamp)::date,
    date_trunc('month', p_period_end::timestamp)::date,
    interval '1 month'
  ) as bucket(month_start)
),
monthly_receivables as (
  select
    month.month,
    month.period_start,
    month.period_end,
    round(
      coalesce(
        sum(receivable.received_amount) filter (
          where receivable.sale_date <= month.period_end
            and receivable.settlement_date
              between month.period_start and month.period_end
        ),
        0
      ),
      2
    ) as received_amount,
    round(
      coalesce(
        sum(receivable.original_amount) filter (
          where receivable.sale_date <= month.period_end
            and receivable.due_date < month.period_end
        ),
        0
      ),
      2
    ) as receivables_due_amount,
    round(
      coalesce(
        sum(
          case
            when receivable.sale_date > month.period_end
              or receivable.due_date >= month.period_end
            then 0
            when receivable.entry_status = 'recebido'
              and receivable.settlement_date is not null
              and receivable.settlement_date <= month.period_end
            then 0
            when receivable.entry_status = 'recebido'
              and (
                receivable.settlement_date is null
                or receivable.settlement_date > month.period_end
              )
            then receivable.original_amount
            else receivable.current_open_amount
          end
        ),
        0
      ),
      2
    ) as overdue_amount,
    count(*) filter (
      where receivable.sale_date <= month.period_end
        and receivable.due_date < month.period_end
        and (
          case
            when receivable.entry_status = 'recebido'
              and receivable.settlement_date is not null
              and receivable.settlement_date <= month.period_end
            then 0
            when receivable.entry_status = 'recebido'
            then receivable.original_amount
            else receivable.current_open_amount
          end
        ) > 0
    )::integer as overdue_installments
  from month_ranges month
  left join receivable_rows receivable on true
  group by month.month, month.period_start, month.period_end
),
monthly_repasses as (
  select
    month.month,
    round(
      coalesce(
        sum(repass.amount) filter (
          where repass.settlement_date
            between month.period_start and month.period_end
        ),
        0
      ),
      2
    ) as repassed_amount
  from month_ranges month
  left join repass_rows repass on true
  group by month.month
),
monthly_rows as (
  select
    receivable.month,
    receivable.period_start,
    receivable.period_end,
    receivable.received_amount,
    receivable.receivables_due_amount,
    receivable.overdue_amount,
    receivable.overdue_installments,
    case
      when receivable.receivables_due_amount > 0
      then round(
        receivable.overdue_amount
          / receivable.receivables_due_amount
          * 100,
        2
      )
      else 0
    end as overdue_rate_pct,
    terms.contractual_percentage,
    case
      when terms.contractual_percentage is null then null
      else round(
        receivable.received_amount
          * terms.contractual_percentage
          / 100,
        2
      )
    end as repass_due_amount,
    repass.repassed_amount
  from monthly_receivables receivable
  join monthly_repasses repass using (month)
  left join contract_terms terms on true
),
flow_totals as (
  select
    round(coalesce(sum(row.received_amount), 0), 2)
      as received_amount,
    case
      when max(row.contractual_percentage) is null then null
      else round(coalesce(sum(row.repass_due_amount), 0), 2)
    end as repass_due_amount,
    round(coalesce(sum(row.repassed_amount), 0), 2)
      as repassed_amount,
    max(row.contractual_percentage) as contractual_percentage
  from monthly_rows row
),
closing_position as (
  select
    row.receivables_due_amount,
    row.overdue_amount,
    row.overdue_installments,
    row.overdue_rate_pct
  from monthly_rows row
  order by row.period_end desc
  limit 1
)
select jsonb_build_object(
  'configured', totals.contractual_percentage is not null,
  'contractual_percentage', totals.contractual_percentage,
  'totals', jsonb_build_object(
    'received_amount', totals.received_amount,
    'repass_due_amount', totals.repass_due_amount,
    'repassed_amount', totals.repassed_amount,
    'receivables_due_amount',
      coalesce(position.receivables_due_amount, 0),
    'overdue_amount', coalesce(position.overdue_amount, 0),
    'overdue_installments',
      coalesce(position.overdue_installments, 0),
    'overdue_rate_pct', coalesce(position.overdue_rate_pct, 0)
  ),
  'months',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'month', row.month,
            'period_start', row.period_start,
            'period_end', row.period_end,
            'received_amount', row.received_amount,
            'receivables_due_amount', row.receivables_due_amount,
            'overdue_amount', row.overdue_amount,
            'overdue_installments', row.overdue_installments,
            'overdue_rate_pct', row.overdue_rate_pct,
            'repass_due_amount', row.repass_due_amount,
            'repassed_amount', row.repassed_amount
          )
          order by row.period_start
        )
        from monthly_rows row
      ),
      '[]'::jsonb
    ),
  'basis',
    'Recebimentos e repasses realizados usam a data efetiva de baixa. O repasse devido no período é o recebimento baixado no período multiplicado pelo percentual contratual publicado. A inadimplência é uma posição, e não um fluxo somável.',
  'reconstruction_note',
    'As posições mensais são reconstruídas com vencimentos, baixas integrais e saldos disponíveis. Conciliações parciais sem histórico de movimentos usam o saldo remanescente conhecido.'
)
from flow_totals totals
left join closing_position position on true
$function$;

revoke all on function public.build_landowner_period_statement(
  uuid,
  uuid,
  uuid,
  date,
  date
) from public, anon, authenticated, service_role;

create or replace function public.sanitize_landowner_period_statement(
  p_statement jsonb,
  p_delinquency_visible boolean,
  p_repasses_visible boolean
)
returns jsonb
language plpgsql
immutable
set search_path to ''
as $function$
declare
  v_result jsonb;
  v_months jsonb;
  v_basis text :=
    'Recebimentos realizados usam a data efetiva de baixa.';
  v_delinquency_visible boolean :=
    coalesce(p_delinquency_visible, false);
  v_repasses_visible boolean :=
    coalesce(p_repasses_visible, false);
begin
  if coalesce(jsonb_typeof(p_statement) <> 'object', true) then
    return null;
  end if;

  v_result := p_statement;

  if not v_repasses_visible then
    v_result := v_result
      - array['configured', 'contractual_percentage'];
  end if;

  if v_delinquency_visible then
    v_basis := v_basis
      || ' A inadimplência representa a posição no encerramento de cada competência.';
  end if;

  if v_repasses_visible then
    v_basis := v_basis
      || ' O repasse devido é o recebimento baixado multiplicado pelo percentual contratual publicado.';
  end if;

  v_result := jsonb_set(
    v_result,
    '{totals}',
    case
      when v_repasses_visible then
        case
          when v_delinquency_visible
          then coalesce(p_statement -> 'totals', '{}'::jsonb)
          else coalesce(p_statement -> 'totals', '{}'::jsonb)
            - array[
              'receivables_due_amount',
              'overdue_amount',
              'overdue_installments',
              'overdue_rate_pct'
            ]
        end
      when v_delinquency_visible then
        coalesce(p_statement -> 'totals', '{}'::jsonb)
          - array['repass_due_amount', 'repassed_amount']
      else
        coalesce(p_statement -> 'totals', '{}'::jsonb)
          - array[
            'receivables_due_amount',
            'overdue_amount',
            'overdue_installments',
            'overdue_rate_pct',
            'repass_due_amount',
            'repassed_amount'
          ]
    end,
    true
  );

  select coalesce(
    jsonb_agg(
      case
        when v_repasses_visible then
          case
            when v_delinquency_visible then month_row.value
            else month_row.value
              - array[
                'receivables_due_amount',
                'overdue_amount',
                'overdue_installments',
                'overdue_rate_pct'
              ]
          end
        when v_delinquency_visible then
          month_row.value
            - array['repass_due_amount', 'repassed_amount']
        else
          month_row.value
            - array[
              'receivables_due_amount',
              'overdue_amount',
              'overdue_installments',
              'overdue_rate_pct',
              'repass_due_amount',
              'repassed_amount'
            ]
      end
      order by month_row.ordinality
    ),
    '[]'::jsonb
  )
    into v_months
    from jsonb_array_elements(
      coalesce(p_statement -> 'months', '[]'::jsonb)
    ) with ordinality as month_row(value, ordinality);

  return jsonb_set(
    jsonb_set(
      v_result,
      '{months}',
      v_months,
      true
    ),
    '{basis}',
    to_jsonb(v_basis),
    true
  ) || jsonb_build_object(
    'visibility',
    jsonb_build_object(
      'delinquency', v_delinquency_visible,
      'repasses', v_repasses_visible
    )
  );
end
$function$;

revoke all on function public.sanitize_landowner_period_statement(
  jsonb,
  boolean,
  boolean
) from public, anon, authenticated, service_role;

create or replace function public.build_landowner_portal_snapshot(
  p_organization_id uuid,
  p_contact_id uuid,
  p_project_id uuid,
  p_period_start date,
  p_period_end date
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_snapshot jsonb;
  v_sales_map jsonb;
  v_period_statement jsonb;
  v_contractual_percentage numeric(7, 4);
  v_receipts_basis_amount numeric := 0;
  v_paid_amount numeric := 0;
  v_contractual_entitlement numeric;
  v_contractual_balance numeric;
  v_overpaid_amount numeric;
  v_unprogrammed_amount numeric;
  v_total_not_repassed numeric := 0;
begin
  v_snapshot := public.build_landowner_portal_snapshot_core(
    p_organization_id,
    p_contact_id,
    p_project_id,
    p_period_start,
    p_period_end
  );

  select terms.contractual_percentage
    into v_contractual_percentage
    from public.partner_landowner_contract_terms terms
   where terms.organization_id = p_organization_id
     and terms.contact_id = p_contact_id
     and terms.project_id = p_project_id;

  with canonical_sales as (
    select distinct on (contract.organization_id, contract.unit_id)
      contract.organization_id,
      contract.proposal_id
    from public.crm_contracts contract
    where contract.organization_id = p_organization_id
      and contract.project_id = p_project_id
      and contract.status = 'assinado'
      and coalesce(
        contract.customer_signed_at,
        contract.signed_at,
        contract.created_at
      )::date <= p_period_end
    order by
      contract.organization_id,
      contract.unit_id,
      coalesce(
        contract.customer_signed_at,
        contract.signed_at,
        contract.created_at
      ) desc,
      contract.created_at desc
  ),
  receipt_candidates as (
    select
      coalesce(entry.id, installment.id) as row_key,
      installment.id as installment_id,
      greatest(
        least(
          coalesce(
            nullif(entry.reconciled_amount, 0),
            nullif(entry.original_amount, 0),
            entry.amount,
            installment.amount,
            0
          ),
          coalesce(
            nullif(entry.original_amount, 0),
            entry.amount,
            installment.amount,
            0
          )
        ),
        0
      )::numeric as received_amount
    from canonical_sales sale
    join public.crm_proposal_installments installment
      on installment.proposal_id = sale.proposal_id
     and installment.organization_id = sale.organization_id
    join public.financial_entries entry
      on entry.id = installment.financial_entry_id
     and entry.organization_id = installment.organization_id
    where installment.status <> 'cancelada'
      and entry.project_id = p_project_id
      and entry.type = 'entrada'
      and entry.status = 'recebido'
      and entry.settlement_date is not null
      and entry.settlement_date <= p_period_end
  ),
  receipt_rows as (
    select distinct on (receipt.row_key)
      receipt.row_key,
      receipt.received_amount
    from receipt_candidates receipt
    order by receipt.row_key, receipt.installment_id
  )
  select coalesce(sum(receipt.received_amount), 0)
    into v_receipts_basis_amount
    from receipt_rows receipt;

  v_receipts_basis_amount := round(
    coalesce(v_receipts_basis_amount, 0),
    2
  );
  v_paid_amount := round(
    coalesce((v_snapshot #>> '{repasses,paid_amount}')::numeric, 0),
    2
  );
  v_total_not_repassed := round(
    coalesce(
      (v_snapshot #>> '{repasses,total_not_repassed}')::numeric,
      0
    ),
    2
  );

  if v_contractual_percentage is not null then
    v_contractual_entitlement := round(
      v_receipts_basis_amount * v_contractual_percentage / 100,
      2
    );
    v_contractual_balance := round(
      greatest(v_contractual_entitlement - v_paid_amount, 0),
      2
    );
    v_overpaid_amount := round(
      greatest(v_paid_amount - v_contractual_entitlement, 0),
      2
    );
    v_unprogrammed_amount := round(
      greatest(
        v_contractual_balance - v_total_not_repassed,
        0
      ),
      2
    );
  end if;

  v_period_statement := public.build_landowner_period_statement(
    p_organization_id,
    p_contact_id,
    p_project_id,
    p_period_start,
    p_period_end
  );

  v_sales_map := public.build_landowner_sales_map(
    p_organization_id,
    p_project_id
  );

  return jsonb_set(
    jsonb_set(
      jsonb_set(
        v_snapshot,
        '{repasses}',
        coalesce(v_snapshot -> 'repasses', '{}'::jsonb)
          || jsonb_build_object(
            'configured', v_contractual_percentage is not null,
            'contractual_percentage', v_contractual_percentage,
            'receipts_basis_amount', v_receipts_basis_amount,
            'contractual_entitlement', v_contractual_entitlement,
            'contractual_balance', v_contractual_balance,
            'overpaid_amount', v_overpaid_amount,
            'unprogrammed_amount', v_unprogrammed_amount,
            'basis',
              'Direito estimado = recebimentos de contratos assinados efetivamente baixados até a data de posição × percentual contratual; saldo = direito estimado − repasses classificados como pagos; não programado = saldo − títulos de repasse ainda abertos. O cálculo não altera títulos financeiros.'
          ),
        true
      ),
      '{period_statement}',
      v_period_statement,
      true
    ),
    '{sales_map}',
    v_sales_map,
    true
  );
end
$function$;

revoke all on function public.build_landowner_portal_snapshot(
  uuid,
  uuid,
  uuid,
  date,
  date
) from public, anon, authenticated, service_role;

create or replace function public.publish_landowner_portal_snapshot(
  p_organization_id uuid,
  p_contact_id uuid,
  p_project_id uuid,
  p_period_start date,
  p_period_end date,
  p_visible_sections jsonb,
  p_public_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_sections jsonb := coalesce(
    p_visible_sections,
    jsonb_build_object(
      'lots', true,
      'sales_map', true,
      'vgv', true,
      'vso', true,
      'conditions_summary', true,
      'sales_details', false,
      'delinquency', true,
      'repasses_summary', true,
      'repass_details', false,
      'construction', true,
      'period_statement', true
    )
  );
  v_snapshot jsonb;
  v_version integer;
  v_publication public.partner_landowner_publications%rowtype;
begin
  if not (v_sections ? 'period_statement') then
    v_sections := v_sections
      || jsonb_build_object('period_statement', false);
  end if;

  if not (v_sections ? 'sales_map') then
    v_sections := v_sections
      || jsonb_build_object('sales_map', false);
  end if;

  if v_user_id is null
    or not public.has_app_permission(
      p_organization_id,
      'partners.landowners.publish'
    ) then
    raise exception 'Acesso não autorizado.';
  end if;

  if coalesce(jsonb_typeof(v_sections) <> 'object', true)
    or not coalesce(
      v_sections ?& array[
        'lots',
        'sales_map',
        'vgv',
        'vso',
        'conditions_summary',
        'sales_details',
        'delinquency',
        'repasses_summary',
        'repass_details',
        'construction',
        'period_statement'
      ],
      false
    )
    or v_sections - array[
      'lots',
      'sales_map',
      'vgv',
      'vso',
      'conditions_summary',
      'sales_details',
      'delinquency',
      'repasses_summary',
      'repass_details',
      'construction',
      'period_statement'
    ] <> '{}'::jsonb
    or not coalesce(
      jsonb_typeof(v_sections -> 'lots') = 'boolean',
      false
    )
    or not coalesce(
      jsonb_typeof(v_sections -> 'sales_map') = 'boolean',
      false
    )
    or not coalesce(
      jsonb_typeof(v_sections -> 'vgv') = 'boolean',
      false
    )
    or not coalesce(
      jsonb_typeof(v_sections -> 'vso') = 'boolean',
      false
    )
    or not coalesce(
      jsonb_typeof(v_sections -> 'conditions_summary') = 'boolean',
      false
    )
    or not coalesce(
      jsonb_typeof(v_sections -> 'sales_details') = 'boolean',
      false
    )
    or not coalesce(
      jsonb_typeof(v_sections -> 'delinquency') = 'boolean',
      false
    )
    or not coalesce(
      jsonb_typeof(v_sections -> 'repasses_summary') = 'boolean',
      false
    )
    or not coalesce(
      jsonb_typeof(v_sections -> 'repass_details') = 'boolean',
      false
    )
    or not coalesce(
      jsonb_typeof(v_sections -> 'construction') = 'boolean',
      false
    )
    or not coalesce(
      jsonb_typeof(v_sections -> 'period_statement') = 'boolean',
      false
    ) then
    raise exception 'Configuração de visibilidade inválida.';
  end if;

  perform 1
    from public.projects project
   where project.id = p_project_id
     and project.organization_id = p_organization_id
   for update;

  v_snapshot := public.preview_landowner_portal_publication(
    p_organization_id,
    p_contact_id,
    p_project_id,
    p_period_start,
    p_period_end
  );

  select coalesce(max(publication.version), 0) + 1
    into v_version
    from public.partner_landowner_publications publication
   where publication.organization_id = p_organization_id
     and publication.contact_id = p_contact_id
     and publication.project_id = p_project_id;

  update public.partner_landowner_publications
     set status = 'archived',
         archived_at = now()
   where organization_id = p_organization_id
     and contact_id = p_contact_id
     and project_id = p_project_id
     and status = 'published';

  insert into public.partner_landowner_publications (
    organization_id,
    contact_id,
    project_id,
    period_start,
    period_end,
    visible_sections,
    snapshot,
    public_note,
    version,
    published_by
  )
  values (
    p_organization_id,
    p_contact_id,
    p_project_id,
    p_period_start,
    p_period_end,
    v_sections,
    v_snapshot,
    nullif(btrim(p_public_note), ''),
    v_version,
    v_user_id
  )
  returning * into v_publication;

  insert into public.audit_logs (
    organization_id,
    user_id,
    action,
    entity,
    entity_id,
    new_data
  )
  values (
    p_organization_id,
    v_user_id,
    'landowner_portal_snapshot_published',
    'partner_landowner_publication',
    v_publication.id::text,
    jsonb_build_object(
      'contact_id', p_contact_id,
      'project_id', p_project_id,
      'period_start', p_period_start,
      'period_end', p_period_end,
      'version', v_version,
      'visible_sections', v_sections
    )
  );

  return to_jsonb(v_publication);
end
$function$;

revoke all on function public.publish_landowner_portal_snapshot(
  uuid,
  uuid,
  uuid,
  date,
  date,
  jsonb,
  text
) from public, anon, authenticated, service_role;
grant execute on function public.publish_landowner_portal_snapshot(
  uuid,
  uuid,
  uuid,
  date,
  date,
  jsonb,
  text
) to authenticated;

create or replace function public.get_partner_payment_portal_v2(
  p_token text,
  p_document_last4 text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_portal jsonb;
  v_publications jsonb;
begin
  v_portal := public.get_partner_payment_portal_v2_core(
    p_token,
    p_document_last4
  );

  if v_portal is null
    or coalesce(v_portal #>> '{partner,kind}', '') <> 'terrenista'
    or jsonb_typeof(v_portal #> '{landowner,publications}') <> 'array' then
    return v_portal;
  end if;

  select coalesce(
    jsonb_agg(
      case
        when publication.id is null then portal_publication.value
        else portal_publication.value
          || case
            when coalesce(
              (
                publication.visible_sections
                  ->> 'period_statement'
              )::boolean,
              false
            )
              and publication.snapshot ? 'period_statement'
            then jsonb_build_object(
              'period_statement',
              public.sanitize_landowner_period_statement(
                publication.snapshot -> 'period_statement',
                coalesce(
                  (
                    publication.visible_sections
                      ->> 'delinquency'
                  )::boolean,
                  false
                ),
                coalesce(
                  (
                    publication.visible_sections
                      ->> 'repasses_summary'
                  )::boolean,
                  false
                )
              )
            )
            else '{}'::jsonb
          end
          || case
            when coalesce(
              (
                publication.visible_sections
                  ->> 'sales_map'
              )::boolean,
              false
            )
              and publication.snapshot ? 'sales_map'
            then jsonb_build_object(
              'sales_map',
              publication.snapshot -> 'sales_map'
            )
            else '{}'::jsonb
          end
          || case
            when portal_publication.value ? 'repasses'
              and coalesce(
                (
                  publication.visible_sections
                    ->> 'repasses_summary'
                )::boolean,
                false
              )
            then jsonb_build_object(
              'repasses',
              coalesce(
                portal_publication.value -> 'repasses',
                '{}'::jsonb
              )
                || jsonb_strip_nulls(
                  jsonb_build_object(
                    'contractual_percentage',
                      publication.snapshot
                        #> '{repasses,contractual_percentage}',
                    'receipts_basis_amount',
                      publication.snapshot
                        #> '{repasses,receipts_basis_amount}',
                    'contractual_entitlement',
                      publication.snapshot
                        #> '{repasses,contractual_entitlement}',
                    'contractual_balance',
                      publication.snapshot
                        #> '{repasses,contractual_balance}',
                    'overpaid_amount',
                      publication.snapshot
                        #> '{repasses,overpaid_amount}',
                    'unprogrammed_amount',
                      publication.snapshot
                        #> '{repasses,unprogrammed_amount}'
                  )
                )
            )
            else '{}'::jsonb
          end
      end
      order by portal_publication.ordinality
    ),
    '[]'::jsonb
  )
    into v_publications
    from jsonb_array_elements(
      v_portal #> '{landowner,publications}'
    ) with ordinality as portal_publication(value, ordinality)
    left join public.partner_landowner_publications publication
      on publication.id = case
        when (
          portal_publication.value ->> 'id'
        ) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (portal_publication.value ->> 'id')::uuid
        else null
      end
     and publication.status = 'published';

  return jsonb_set(
    v_portal,
    '{landowner,publications}',
    v_publications,
    true
  );
end
$function$;

revoke all on function public.get_partner_payment_portal_v2(
  text,
  text
) from public, anon, authenticated, service_role;
grant execute on function public.get_partner_payment_portal_v2(
  text,
  text
) to anon, authenticated;

comment on function public.build_landowner_period_statement(
  uuid,
  uuid,
  uuid,
  date,
  date
) is
  'Gera série mensal congelável de recebimentos, inadimplência e direito contratual do terrenista.';

comment on function public.sanitize_landowner_period_statement(
  jsonb,
  boolean,
  boolean
) is
  'Remove do demonstrativo público métricas de inadimplência e repasse que não foram autorizadas na publicação.';

comment on function public.build_landowner_sales_map(uuid, uuid) is
  'Gera mapa comercial sanitizado e congelável, sem compradores, contratos, reservas ou justificativas internas.';

comment on function public.get_partner_payment_portal_v2(text, text) is
  'Valida o acesso protegido e expõe demonstrativo e mapa somente quando publicados, preservando o canal institucional de negociação.';
