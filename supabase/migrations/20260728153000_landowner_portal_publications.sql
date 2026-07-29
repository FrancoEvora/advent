-- Évora Gestão 6.13
-- Publicações governadas para parceiros terrenistas.
--
-- As fontes contábeis, comerciais e físicas permanecem canônicas. O portal
-- público recebe somente snapshots explicitamente publicados e sem dados
-- pessoais dos compradores.

do $preflight$
begin
  if to_regclass('public.partner_portal_links') is null
    or to_regclass('public.crm_inventory_units') is null
    or to_regclass('public.crm_proposals') is null
    or to_regclass('public.crm_contracts') is null
    or to_regclass('public.crm_proposal_installments') is null
    or to_regclass('public.financial_entries') is null
    or to_regclass('public.construction_work_packages') is null
    or to_regclass('public.role_permissions') is null
    or to_regprocedure('public.get_partner_payment_portal(text,text)') is null
    or to_regprocedure('public.validate_partner_portal_link(text,text,text)') is null
    or to_regprocedure('public.has_app_permission(uuid,text)') is null then
    raise exception 'Landowner portal prerequisites are missing.';
  end if;
end
$preflight$;

create table public.partner_landowner_repass_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  financial_entry_id uuid not null
    references public.financial_entries(id) on delete cascade,
  allocated_amount numeric(15, 2) not null
    check (allocated_amount > 0),
  notes text check (char_length(notes) <= 800),
  registered_by uuid references auth.users(id) on delete set null,
  registered_at timestamptz not null default now(),
  constraint partner_landowner_repass_entry_unique
    unique (financial_entry_id),
  constraint partner_landowner_repass_scope_unique unique (
    organization_id,
    contact_id,
    project_id,
    financial_entry_id
  )
);

create index partner_landowner_repass_scope_idx
  on public.partner_landowner_repass_entries (
    organization_id,
    contact_id,
    project_id,
    registered_at desc
  );

create table public.partner_landowner_publications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  status text not null default 'published'
    check (status in ('published', 'archived')),
  visible_sections jsonb not null default jsonb_build_object(
    'lots', true,
    'vgv', true,
    'vso', true,
    'conditions_summary', true,
    'sales_details', false,
    'delinquency', true,
    'repasses_summary', true,
    'repass_details', false,
    'construction', true
  ),
  snapshot jsonb not null,
  public_note text check (char_length(public_note) <= 1600),
  version integer not null default 1 check (version > 0),
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz not null default now(),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  constraint partner_landowner_publication_period_check
    check (
      period_end >= period_start
      and period_end <= period_start + 1095
    ),
  constraint partner_landowner_sections_check
    check (
      jsonb_typeof(visible_sections) = 'object'
      and jsonb_typeof(visible_sections -> 'lots') = 'boolean'
      and jsonb_typeof(visible_sections -> 'vgv') = 'boolean'
      and jsonb_typeof(visible_sections -> 'vso') = 'boolean'
      and jsonb_typeof(visible_sections -> 'conditions_summary') = 'boolean'
      and jsonb_typeof(visible_sections -> 'sales_details') = 'boolean'
      and jsonb_typeof(visible_sections -> 'delinquency') = 'boolean'
      and jsonb_typeof(visible_sections -> 'repasses_summary') = 'boolean'
      and jsonb_typeof(visible_sections -> 'repass_details') = 'boolean'
      and jsonb_typeof(visible_sections -> 'construction') = 'boolean'
      and visible_sections ?& array[
        'lots',
        'vgv',
        'vso',
        'conditions_summary',
        'sales_details',
        'delinquency',
        'repasses_summary',
        'repass_details',
        'construction'
      ]
      and visible_sections - array[
        'lots',
        'vgv',
        'vso',
        'conditions_summary',
        'sales_details',
        'delinquency',
        'repasses_summary',
        'repass_details',
        'construction'
      ] = '{}'::jsonb
      and pg_column_size(visible_sections) <= 2048
    ),
  constraint partner_landowner_snapshot_check
    check (
      jsonb_typeof(snapshot) = 'object'
      and pg_column_size(snapshot) <= 262144
    )
);

create unique index partner_landowner_one_published_project_idx
  on public.partner_landowner_publications (
    organization_id,
    contact_id,
    project_id
  )
  where status = 'published';

create unique index partner_landowner_publication_version_idx
  on public.partner_landowner_publications (
    organization_id,
    contact_id,
    project_id,
    version
  );

create index partner_landowner_publication_history_idx
  on public.partner_landowner_publications (
    organization_id,
    contact_id,
    project_id,
    published_at desc
  );

alter table public.partner_landowner_publications enable row level security;
alter table public.partner_landowner_repass_entries enable row level security;

create policy partner_landowner_repass_entries_select
  on public.partner_landowner_repass_entries
  for select
  to authenticated
  using (
    public.has_app_permission(
      partner_landowner_repass_entries.organization_id,
      'partners.view'
    )
  );

create policy partner_landowner_publications_select
  on public.partner_landowner_publications
  for select
  to authenticated
  using (
    public.has_app_permission(
      partner_landowner_publications.organization_id,
      'partners.view'
    )
  );

revoke all on table public.partner_landowner_publications
  from public, anon, authenticated;
revoke all on table public.partner_landowner_repass_entries
  from public, anon, authenticated;
grant select on table public.partner_landowner_publications to authenticated;
grant select on table public.partner_landowner_repass_entries to authenticated;

alter table public.contacts
  drop constraint if exists contacts_contact_type_check;
alter table public.contacts
  add constraint contacts_contact_type_check
  check (
    contact_type in (
      'cliente',
      'fornecedor',
      'ambos',
      'terrenista',
      'colaborador',
      'corretor',
      'beneficiario'
    )
  );

alter table public.partner_portal_links
  drop constraint if exists partner_portal_links_partner_kind_check;
alter table public.partner_portal_links
  add constraint partner_portal_links_partner_kind_check
  check (
    partner_kind in (
      'fornecedor',
      'credor_financeiro',
      'terrenista',
      'parceiro',
      'colaborador',
      'beneficiario'
    )
  );

create or replace function public.create_partner_portal_link(
  p_organization_id uuid,
  p_contact_id uuid,
  p_partner_kind text default 'fornecedor',
  p_label text default null,
  p_expires_at timestamptz default (now() + interval '60 days')
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_raw_token text;
  v_link public.partner_portal_links%rowtype;
  v_document_digits text;
  v_contact_type text;
begin
  if v_user_id is null
    or not public.has_app_permission(
      p_organization_id,
      'partners.access.manage'
    ) then
    raise exception 'Acesso não autorizado.';
  end if;

  if p_partner_kind not in (
    'fornecedor',
    'credor_financeiro',
    'terrenista',
    'parceiro',
    'colaborador',
    'beneficiario'
  ) then
    raise exception 'Tipo de parceiro inválido.';
  end if;

  select
    regexp_replace(coalesce(contact.document, ''), '\D', '', 'g'),
    lower(contact.contact_type)
    into v_document_digits, v_contact_type
    from public.contacts contact
   where contact.id = p_contact_id
     and contact.organization_id = p_organization_id
     and contact.active = true;

  if not found then
    raise exception 'Parceiro não localizado.';
  end if;

  if p_partner_kind = 'terrenista'
    and v_contact_type <> 'terrenista' then
    raise exception
      'Classifique o contato como terrenista antes de gerar este acesso.';
  end if;

  if char_length(v_document_digits) < 4 then
    raise exception 'Cadastre o CPF ou CNPJ do parceiro antes de gerar o acesso.';
  end if;

  if p_expires_at <= now() or p_expires_at > now() + interval '365 days' then
    raise exception 'A validade deve estar entre amanhã e 365 dias.';
  end if;

  update public.partner_portal_links
     set active = false,
         revoked_by = v_user_id,
         revoked_at = now(),
         revoke_reason = 'Acesso substituído por um novo link.'
   where organization_id = p_organization_id
     and contact_id = p_contact_id
     and active = true;

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.partner_portal_links (
    organization_id,
    contact_id,
    partner_kind,
    token_hash,
    token_hint,
    label,
    expires_at,
    created_by
  )
  values (
    p_organization_id,
    p_contact_id,
    p_partner_kind,
    extensions.digest(convert_to(v_raw_token, 'UTF8'), 'sha256'),
    right(v_raw_token, 6),
    nullif(btrim(p_label), ''),
    p_expires_at,
    v_user_id
  )
  returning * into v_link;

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
    'partner_portal_link_created',
    'partner_portal_link',
    v_link.id::text,
    jsonb_build_object(
      'contact_id', p_contact_id,
      'partner_kind', p_partner_kind,
      'expires_at', p_expires_at,
      'token_hint', v_link.token_hint
    )
  );

  return jsonb_build_object(
    'id', v_link.id,
    'token', v_raw_token,
    'token_hint', v_link.token_hint,
    'expires_at', v_link.expires_at
  );
end
$function$;

create or replace function public.build_landowner_portal_snapshot(
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
with valid_sales as (
  select distinct on (contract.unit_id)
    contract.id as contract_id,
    contract.contract_number,
    contract.unit_id,
    contract.proposal_id,
    coalesce(
      contract.customer_signed_at,
      contract.signed_at,
      contract.created_at
    )::date as sale_date,
    proposal.sale_price,
    proposal.list_price,
    proposal.discount_pct,
    proposal.down_payment,
    proposal.financed_amount,
    proposal.installments_count,
    proposal.monthly_interest_rate,
    proposal.indexer,
    unit.unit_code,
    unit.block_code,
    unit.lot_number,
    unit.area
  from public.crm_contracts contract
  join public.crm_proposals proposal
    on proposal.id = contract.proposal_id
   and proposal.organization_id = contract.organization_id
  join public.crm_inventory_units unit
    on unit.id = contract.unit_id
   and unit.organization_id = contract.organization_id
  where contract.organization_id = p_organization_id
    and contract.project_id = p_project_id
    and contract.status = 'assinado'
    and unit.active = true
    and coalesce(
      contract.customer_signed_at,
      contract.signed_at,
      contract.created_at
    )::date <= p_period_end
  order by
    contract.unit_id,
    coalesce(
      contract.customer_signed_at,
      contract.signed_at,
      contract.created_at
    ) desc,
    contract.created_at desc
),
inventory_metrics as (
  select
    count(*)::integer as total_lots,
    count(*) filter (
      where unit.status = 'disponivel'
    )::integer as available_lots,
    coalesce(sum(unit.list_price), 0)::numeric as total_vgv
  from public.crm_inventory_units unit
  where unit.organization_id = p_organization_id
    and unit.project_id = p_project_id
    and unit.active = true
),
sales_metrics as (
  select
    count(*)::integer as sold_lots,
    count(*) filter (
      where sale.sale_date between p_period_start and p_period_end
    )::integer as sold_in_period,
    count(*) filter (
      where sale.sale_date < p_period_start
    )::integer as sold_before_period,
    coalesce(sum(sale.sale_price), 0)::numeric as sold_vgv,
    coalesce(avg(sale.sale_price), 0)::numeric as average_sale_price,
    coalesce(avg(sale.discount_pct), 0)::numeric as average_discount_pct,
    coalesce(avg(sale.installments_count), 0)::numeric
      as average_installments,
    coalesce(
      avg(
        case
          when sale.sale_price > 0
          then sale.down_payment / sale.sale_price * 100
          else 0
        end
      ),
      0
    )::numeric as average_down_payment_pct
  from valid_sales sale
),
receivable_rows as (
  select
    installment.id,
    installment.due_date,
    case
      when installment.status = 'cancelada'
        or coalesce(entry.status, '') = 'cancelado'
      then 0
      else coalesce(
        nullif(entry.original_amount, 0),
        entry.amount,
        installment.amount,
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
      else coalesce(
        installment.amount,
        0
      )
    end::numeric as open_amount
  from public.crm_proposal_installments installment
  join valid_sales sale on sale.proposal_id = installment.proposal_id
  left join public.financial_entries entry
    on entry.id = installment.financial_entry_id
   and entry.organization_id = p_organization_id
  where installment.organization_id = p_organization_id
),
receivable_metrics as (
  select
    coalesce(
      sum(row.original_amount),
      0
    )::numeric as receivable_total,
    coalesce(
      sum(row.open_amount),
      0
    )::numeric as open_total,
    coalesce(
      sum(row.open_amount) filter (
        where row.open_amount > 0
          and row.due_date <
            (now() at time zone 'America/Sao_Paulo')::date
      ),
      0
    )::numeric as overdue_amount,
    count(*) filter (
      where row.open_amount > 0
        and row.due_date <
          (now() at time zone 'America/Sao_Paulo')::date
    )::integer as overdue_installments
  from receivable_rows row
),
repass_rows as (
  select
    entry.id,
    entry.description,
    entry.due_date,
    entry.scheduled_payment_date,
    entry.settlement_date,
    entry.status,
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
    and entry.status <> 'cancelado'
),
repass_metrics as (
  select
    coalesce(
      sum(row.amount) filter (
        where row.status = 'pago'
          and row.settlement_date is not null
          and row.settlement_date <= p_period_end
      ),
      0
    )::numeric as paid_amount,
    coalesce(
      sum(row.amount) filter (
        where not (
          row.status = 'pago'
          and row.settlement_date is not null
          and row.settlement_date <= p_period_end
        )
          and row.due_date <= p_period_end
      ),
      0
    )::numeric as due_not_repassed,
    coalesce(
      sum(row.amount) filter (
        where not (
          row.status = 'pago'
          and row.settlement_date is not null
          and row.settlement_date <= p_period_end
        )
      ),
      0
    )::numeric as total_not_repassed,
    count(*) filter (
      where not (
          row.status = 'pago'
          and row.settlement_date is not null
          and row.settlement_date <= p_period_end
        )
        and row.due_date <= p_period_end
    )::integer as due_not_repassed_count,
    count(*) > 0 as configured
  from repass_rows row
),
work_rows as (
  select
    package.id,
    coalesce(package.wbs_code, package.package_code, package.code) as code,
    package.name,
    package.status,
    package.weight_pct,
    package.planned_progress,
    package.actual_progress,
    package.sort_order
  from public.construction_work_packages package
  where package.organization_id = p_organization_id
    and package.project_id = p_project_id
    and package.is_summary = false
    and package.status not in ('cancelada', 'cancelado')
),
work_metrics as (
  select
    case
      when coalesce(sum(row.weight_pct), 0) > 0
      then (
        sum(row.actual_progress * row.weight_pct)
          / sum(row.weight_pct)
      )::numeric
      else coalesce(avg(row.actual_progress), 0)::numeric
    end as actual_progress,
    case
      when coalesce(sum(row.weight_pct), 0) > 0
      then (
        sum(row.planned_progress * row.weight_pct)
          / sum(row.weight_pct)
      )::numeric
      else coalesce(avg(row.planned_progress), 0)::numeric
    end as planned_progress,
    count(*)::integer as stage_count
  from work_rows row
),
sales_list as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'contract_number', sale.contract_number,
        'unit_code', sale.unit_code,
        'block_code', sale.block_code,
        'lot_number', sale.lot_number,
        'area', sale.area,
        'sale_date', sale.sale_date,
        'list_price', sale.list_price,
        'sale_price', sale.sale_price,
        'discount_pct', sale.discount_pct,
        'down_payment', sale.down_payment,
        'financed_amount', sale.financed_amount,
        'installments_count', sale.installments_count,
        'monthly_interest_rate', sale.monthly_interest_rate,
        'indexer', sale.indexer
      )
      order by sale.sale_date desc, sale.unit_code
    ),
    '[]'::jsonb
  ) as rows
  from valid_sales sale
),
repass_list as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', row.id,
        'description', row.description,
        'due_date', row.due_date,
        'scheduled_payment_date', row.scheduled_payment_date,
        'settlement_date', row.settlement_date,
        'amount', row.amount,
        'status', case
          when row.status = 'pago'
            and (
              row.settlement_date is null
              or row.settlement_date > p_period_end
            )
          then 'aguardando_baixa'
          else row.status
        end
      )
      order by
        coalesce(row.scheduled_payment_date, row.due_date),
        row.description
    ),
    '[]'::jsonb
  ) as rows
  from repass_rows row
),
work_list as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', row.id,
        'code', row.code,
        'name', row.name,
        'status', row.status,
        'weight_pct', row.weight_pct,
        'planned_progress_pct', row.planned_progress,
        'actual_progress_pct', row.actual_progress
      )
      order by row.sort_order, row.code
    ),
    '[]'::jsonb
  ) as rows
  from work_rows row
),
project_row as (
  select project.id, project.code, project.name
  from public.projects project
  where project.id = p_project_id
    and project.organization_id = p_organization_id
),
combined as (
  select
    project.id as project_id,
    project.code as project_code,
    project.name as project_name,
    inventory.total_lots,
    inventory.available_lots,
    inventory.total_vgv,
    sales.sold_lots,
    sales.sold_in_period,
    sales.sold_before_period,
    sales.sold_vgv,
    sales.average_sale_price,
    sales.average_discount_pct,
    sales.average_installments,
    sales.average_down_payment_pct,
    receivables.receivable_total,
    receivables.open_total,
    receivables.overdue_amount,
    receivables.overdue_installments,
    repasses.paid_amount,
    repasses.due_not_repassed,
    repasses.total_not_repassed,
    repasses.due_not_repassed_count,
    repasses.configured as repasses_configured,
    work.actual_progress,
    work.planned_progress,
    work.stage_count,
    sale_rows.rows as sales_rows,
    repass_rows.rows as repass_rows,
    work_rows.rows as work_rows
  from project_row project
  cross join inventory_metrics inventory
  cross join sales_metrics sales
  cross join receivable_metrics receivables
  cross join repass_metrics repasses
  cross join work_metrics work
  cross join sales_list sale_rows
  cross join repass_list repass_rows
  cross join work_list work_rows
)
select jsonb_build_object(
  'project', jsonb_build_object(
    'id', result.project_id,
    'code', result.project_code,
    'name', result.project_name
  ),
  'period', jsonb_build_object(
    'start', p_period_start,
    'end', p_period_end,
    'calculated_at', now(),
    'position_note',
      'Vendas e VSO usam o período informado; os saldos refletem a posição atual na publicação'
  ),
  'summary', jsonb_build_object(
    'total_lots', result.total_lots,
    'sold_lots', result.sold_lots,
    'available_lots', result.available_lots,
    'not_sold_lots', greatest(result.total_lots - result.sold_lots, 0),
    'total_vgv', result.total_vgv,
    'sold_vgv', result.sold_vgv,
    'sold_vgv_pct', case
      when result.total_vgv > 0
      then round(result.sold_vgv / result.total_vgv * 100, 2)
      else 0
    end,
    'sales_in_period', result.sold_in_period,
    'vso_pct', case
      when result.available_lots + result.sold_in_period > 0
      then round(
        result.sold_in_period::numeric
          / (result.available_lots + result.sold_in_period)
          * 100,
        2
      )
      else 0
    end,
    'vso_basis',
      'Vendas assinadas no período / (vendas no período + lotes atualmente disponíveis)'
  ),
  'sales_conditions', jsonb_build_object(
    'average_sale_price', result.average_sale_price,
    'average_discount_pct', round(result.average_discount_pct, 2),
    'average_installments', round(result.average_installments, 1),
    'average_down_payment_pct',
      round(result.average_down_payment_pct, 2),
    'sales', result.sales_rows
  ),
  'delinquency', jsonb_build_object(
    'receivable_total', result.receivable_total,
    'open_total', result.open_total,
    'overdue_amount', result.overdue_amount,
    'overdue_installments', result.overdue_installments,
    'overdue_rate_pct', case
      when result.open_total > 0
      then round(result.overdue_amount / result.open_total * 100, 2)
      else 0
    end,
    'basis', 'Parcelas vencidas e ainda não recebidas / carteira aberta'
  ),
  'repasses', jsonb_build_object(
    'configured', result.repasses_configured,
    'paid_amount', result.paid_amount,
    'due_not_repassed', result.due_not_repassed,
    'total_not_repassed', result.total_not_repassed,
    'due_not_repassed_count', result.due_not_repassed_count,
    'basis',
      'Contas a pagar vinculadas ao terrenista e ao empreendimento',
    'entries', result.repass_rows
  ),
  'construction', jsonb_build_object(
    'actual_progress_pct', round(result.actual_progress, 2),
    'planned_progress_pct', round(result.planned_progress, 2),
    'deviation_pct',
      round(result.actual_progress - result.planned_progress, 2),
    'stage_count', result.stage_count,
    'source', 'Gestão de Obras · EAP ponderada',
    'stages', result.work_rows
  )
)
from combined result;
$function$;

revoke all on function public.build_landowner_portal_snapshot(
  uuid,
  uuid,
  uuid,
  date,
  date
) from public, anon, authenticated;

create or replace function public.preview_landowner_portal_publication(
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
begin
  if auth.uid() is null
    or not public.has_app_permission(
      p_organization_id,
      'partners.landowners.publish'
    ) then
    raise exception 'Acesso não autorizado.';
  end if;

  if p_period_start is null
    or p_period_end is null
    or p_period_end <>
      (now() at time zone 'America/Sao_Paulo')::date
    or p_period_end < p_period_start
    or p_period_end > p_period_start + 1095 then
    raise exception
      'Informe um período de até três anos encerrado na data atual.';
  end if;

  if not exists (
    select 1
    from public.contacts contact
    where contact.id = p_contact_id
      and contact.organization_id = p_organization_id
      and contact.active = true
      and lower(contact.contact_type) = 'terrenista'
  ) then
    raise exception 'Terrenista ativo não localizado.';
  end if;

  if not exists (
    select 1
    from public.projects project
    where project.id = p_project_id
      and project.organization_id = p_organization_id
  ) then
    raise exception 'Empreendimento não localizado.';
  end if;

  return public.build_landowner_portal_snapshot(
    p_organization_id,
    p_contact_id,
    p_project_id,
    p_period_start,
    p_period_end
  );
end
$function$;

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
      'vgv', true,
      'vso', true,
      'conditions_summary', true,
      'sales_details', false,
      'delinquency', true,
      'repasses_summary', true,
      'repass_details', false,
      'construction', true
    )
  );
  v_snapshot jsonb;
  v_version integer;
  v_publication public.partner_landowner_publications%rowtype;
begin
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
        'vgv',
        'vso',
        'conditions_summary',
        'sales_details',
        'delinquency',
        'repasses_summary',
        'repass_details',
        'construction'
      ],
      false
    )
    or v_sections - array[
      'lots',
      'vgv',
      'vso',
      'conditions_summary',
      'sales_details',
      'delinquency',
      'repasses_summary',
      'repass_details',
      'construction'
    ] <> '{}'::jsonb
    or not coalesce(jsonb_typeof(v_sections -> 'lots') = 'boolean', false)
    or not coalesce(jsonb_typeof(v_sections -> 'vgv') = 'boolean', false)
    or not coalesce(jsonb_typeof(v_sections -> 'vso') = 'boolean', false)
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

create or replace function public.archive_landowner_portal_snapshot(
  p_organization_id uuid,
  p_contact_id uuid,
  p_project_id uuid,
  p_reason text default 'Publicação retirada pela administração.'
)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_archived_ids jsonb;
begin
  if v_user_id is null
    or not public.has_app_permission(
      p_organization_id,
      'partners.landowners.publish'
    ) then
    raise exception 'Acesso não autorizado.';
  end if;

  with archived as (
    update public.partner_landowner_publications
       set status = 'archived',
           archived_at = now()
     where organization_id = p_organization_id
       and contact_id = p_contact_id
       and project_id = p_project_id
       and status = 'published'
    returning id
  )
  select coalesce(jsonb_agg(archived.id), '[]'::jsonb)
    into v_archived_ids
    from archived;

  if jsonb_array_length(v_archived_ids) = 0 then
    return false;
  end if;

  insert into public.audit_logs (
    organization_id,
    user_id,
    action,
    entity,
    new_data
  )
  values (
    p_organization_id,
    v_user_id,
    'landowner_portal_snapshot_archived',
    'partner_landowner_publication',
    jsonb_build_object(
      'contact_id', p_contact_id,
      'project_id', p_project_id,
      'publication_ids', v_archived_ids,
      'reason', left(
        coalesce(
          nullif(btrim(p_reason), ''),
          'Publicação retirada pela administração.'
        ),
        800
      )
    )
  );

  return true;
end
$function$;

create or replace function public.set_landowner_repass_entry(
  p_organization_id uuid,
  p_contact_id uuid,
  p_project_id uuid,
  p_financial_entry_id uuid,
  p_enabled boolean,
  p_allocated_amount numeric default null,
  p_notes text default null
)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_entry_amount numeric;
  v_allocation numeric;
begin
  if v_user_id is null
    or not public.has_app_permission(
      p_organization_id,
      'partners.landowners.publish'
  ) then
    raise exception 'Acesso não autorizado.';
  end if;

  if not exists (
    select 1
      from public.contacts contact
     where contact.id = p_contact_id
       and contact.organization_id = p_organization_id
       and contact.active = true
       and lower(contact.contact_type) = 'terrenista'
  ) then
    raise exception 'Terrenista ativo não localizado.';
  end if;

  if p_enabled then
    select coalesce(nullif(entry.original_amount, 0), entry.amount)
      into v_entry_amount
      from public.financial_entries entry
     where entry.id = p_financial_entry_id
       and entry.organization_id = p_organization_id
       and entry.contact_id = p_contact_id
       and entry.project_id = p_project_id
       and entry.type = 'saida'
       and entry.status <> 'cancelado'
     for update;

    if not found then
      raise exception
        'Selecione uma conta a pagar do mesmo terrenista e empreendimento.';
    end if;

    v_allocation := round(
      coalesce(p_allocated_amount, v_entry_amount),
      2
    );

    if v_allocation <= 0
      or v_allocation > v_entry_amount then
      raise exception
        'A alocação deve ser positiva e não pode exceder o valor disponível do título.';
    end if;

    insert into public.partner_landowner_repass_entries (
      organization_id,
      contact_id,
      project_id,
      financial_entry_id,
      allocated_amount,
      notes,
      registered_by
    )
    values (
      p_organization_id,
      p_contact_id,
      p_project_id,
      p_financial_entry_id,
      v_allocation,
      nullif(btrim(p_notes), ''),
      v_user_id
    )
    on conflict (financial_entry_id)
    do update set
      organization_id = excluded.organization_id,
      contact_id = excluded.contact_id,
      project_id = excluded.project_id,
      allocated_amount = excluded.allocated_amount,
      notes = excluded.notes,
      registered_by = excluded.registered_by,
      registered_at = now();
  else
    delete from public.partner_landowner_repass_entries
     where organization_id = p_organization_id
       and contact_id = p_contact_id
       and project_id = p_project_id
       and financial_entry_id = p_financial_entry_id;
  end if;

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
    case
      when p_enabled then 'landowner_repass_classified'
      else 'landowner_repass_unclassified'
    end,
    'financial_entry',
    p_financial_entry_id::text,
    jsonb_build_object(
      'contact_id', p_contact_id,
      'project_id', p_project_id,
      'included_in_landowner_portal', p_enabled,
      'allocated_amount', case
        when p_enabled then v_allocation
        else null
      end
    )
  );

  return true;
end
$function$;

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
  v_base jsonb;
  v_link public.partner_portal_links%rowtype;
  v_publications jsonb := '[]'::jsonb;
begin
  v_base := public.get_partner_payment_portal(
    p_token,
    p_document_last4
  );

  if v_base is null then
    return null;
  end if;

  if coalesce(v_base #>> '{partner,kind}', '') <> 'terrenista' then
    return v_base || jsonb_build_object('landowner', null);
  end if;

  select link.*
    into v_link
    from public.partner_portal_links link
   where link.token_hash =
      extensions.digest(convert_to(lower(btrim(p_token)), 'UTF8'), 'sha256')
     and link.active = true
     and link.partner_kind = 'terrenista'
   limit 1;

  if v_link.id is null then
    return v_base || jsonb_build_object('landowner', null);
  end if;

  with latest as (
    select distinct on (publication.project_id)
      publication.*
    from public.partner_landowner_publications publication
    where publication.organization_id = v_link.organization_id
      and publication.contact_id = v_link.contact_id
      and publication.status = 'published'
    order by publication.project_id, publication.published_at desc
  )
  select coalesce(
    jsonb_agg(
      jsonb_strip_nulls(
        jsonb_build_object(
          'id', publication.id,
          'version', publication.version,
          'project', publication.snapshot -> 'project',
          'period', publication.snapshot -> 'period',
          'public_note', publication.public_note,
          'published_at', publication.published_at,
          'summary', case
            when coalesce(
              (publication.visible_sections ->> 'lots')::boolean,
              false
            ) or coalesce(
              (publication.visible_sections ->> 'vgv')::boolean,
              false
            ) or coalesce(
              (publication.visible_sections ->> 'vso')::boolean,
              false
            )
            then jsonb_strip_nulls(
              jsonb_build_object(
                'total_lots', case
                  when (publication.visible_sections ->> 'lots')::boolean
                  then publication.snapshot #> '{summary,total_lots}'
                end,
                'sold_lots', case
                  when (publication.visible_sections ->> 'lots')::boolean
                  then publication.snapshot #> '{summary,sold_lots}'
                end,
                'available_lots', case
                  when (publication.visible_sections ->> 'lots')::boolean
                  then publication.snapshot #> '{summary,available_lots}'
                end,
                'not_sold_lots', case
                  when (publication.visible_sections ->> 'lots')::boolean
                  then publication.snapshot #> '{summary,not_sold_lots}'
                end,
                'total_vgv', case
                  when (publication.visible_sections ->> 'vgv')::boolean
                  then publication.snapshot #> '{summary,total_vgv}'
                end,
                'sold_vgv', case
                  when (publication.visible_sections ->> 'vgv')::boolean
                  then publication.snapshot #> '{summary,sold_vgv}'
                end,
                'sold_vgv_pct', case
                  when (publication.visible_sections ->> 'vgv')::boolean
                  then publication.snapshot #> '{summary,sold_vgv_pct}'
                end,
                'sales_in_period', case
                  when (publication.visible_sections ->> 'vso')::boolean
                  then publication.snapshot #> '{summary,sales_in_period}'
                end,
                'vso_pct', case
                  when (publication.visible_sections ->> 'vso')::boolean
                  then publication.snapshot #> '{summary,vso_pct}'
                end,
                'vso_basis', case
                  when (publication.visible_sections ->> 'vso')::boolean
                  then publication.snapshot #> '{summary,vso_basis}'
                end
              )
            )
          end,
          'sales_conditions', case
            when coalesce(
              (publication.visible_sections ->> 'conditions_summary')::boolean,
              false
            ) or coalesce(
              (publication.visible_sections ->> 'sales_details')::boolean,
              false
            )
            then jsonb_strip_nulls(
              jsonb_build_object(
                'average_sale_price', case
                  when (
                    publication.visible_sections
                      ->> 'conditions_summary'
                  )::boolean
                  then publication.snapshot
                    #> '{sales_conditions,average_sale_price}'
                end,
                'average_discount_pct', case
                  when (
                    publication.visible_sections
                      ->> 'conditions_summary'
                  )::boolean
                  then publication.snapshot
                    #> '{sales_conditions,average_discount_pct}'
                end,
                'average_installments', case
                  when (
                    publication.visible_sections
                      ->> 'conditions_summary'
                  )::boolean
                  then publication.snapshot
                    #> '{sales_conditions,average_installments}'
                end,
                'average_down_payment_pct', case
                  when (
                    publication.visible_sections
                      ->> 'conditions_summary'
                  )::boolean
                  then publication.snapshot
                    #> '{sales_conditions,average_down_payment_pct}'
                end,
                'sales', case
                  when (
                    publication.visible_sections
                      ->> 'sales_details'
                  )::boolean
                  then publication.snapshot #> '{sales_conditions,sales}'
                end
              )
            )
          end,
          'delinquency', case
            when coalesce(
              (publication.visible_sections ->> 'delinquency')::boolean,
              false
            )
            then publication.snapshot -> 'delinquency'
          end,
          'repasses', case
            when coalesce(
              (
                publication.visible_sections
                  ->> 'repasses_summary'
              )::boolean,
              false
            ) or coalesce(
              (
                publication.visible_sections
                  ->> 'repass_details'
              )::boolean,
              false
            )
            then jsonb_strip_nulls(
              jsonb_build_object(
                'configured',
                  publication.snapshot #> '{repasses,configured}',
                'paid_amount', case
                  when (
                    publication.visible_sections
                      ->> 'repasses_summary'
                  )::boolean
                  then publication.snapshot #> '{repasses,paid_amount}'
                end,
                'due_not_repassed', case
                  when (
                    publication.visible_sections
                      ->> 'repasses_summary'
                  )::boolean
                  then publication.snapshot
                    #> '{repasses,due_not_repassed}'
                end,
                'total_not_repassed', case
                  when (
                    publication.visible_sections
                      ->> 'repasses_summary'
                  )::boolean
                  then publication.snapshot
                    #> '{repasses,total_not_repassed}'
                end,
                'due_not_repassed_count', case
                  when (
                    publication.visible_sections
                      ->> 'repasses_summary'
                  )::boolean
                  then publication.snapshot
                    #> '{repasses,due_not_repassed_count}'
                end,
                'basis', case
                  when (
                    publication.visible_sections
                      ->> 'repasses_summary'
                  )::boolean
                  then publication.snapshot #> '{repasses,basis}'
                end,
                'entries', case
                  when (
                    publication.visible_sections
                      ->> 'repass_details'
                  )::boolean
                  then publication.snapshot #> '{repasses,entries}'
                end
              )
            )
          end,
          'construction', case
            when coalesce(
              (publication.visible_sections ->> 'construction')::boolean,
              false
            )
            then publication.snapshot -> 'construction'
          end
        )
      )
      order by publication.published_at desc
    ),
    '[]'::jsonb
  )
    into v_publications
    from latest publication;

  return v_base || jsonb_build_object(
    'landowner',
    jsonb_build_object(
      'publications', v_publications,
      'governance_note',
        'Dados consolidados no último fechamento publicado pela Évora.'
    )
  );
end
$function$;

create or replace function public.reset_partner_portal_data(
  p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_counts jsonb;
begin
  if v_user_id is null
    or not public.has_app_permission(
      p_organization_id,
      'platform.manage'
    ) then
    raise exception 'Acesso não autorizado.';
  end if;

  select jsonb_build_object(
    'links', count(*) filter (where source = 'links'),
    'payment_publications',
      count(*) filter (where source = 'payment_publications'),
    'landowner_publications',
      count(*) filter (where source = 'landowner_publications'),
    'landowner_repasses',
      count(*) filter (where source = 'landowner_repasses'),
    'negotiations', count(*) filter (where source = 'negotiations'),
    'messages', count(*) filter (where source = 'messages'),
    'access_logs', count(*) filter (where source = 'access_logs')
  )
    into v_counts
    from (
      select 'links' source
        from public.partner_portal_links
       where organization_id = p_organization_id
      union all
      select 'payment_publications'
        from public.partner_payment_publications
       where organization_id = p_organization_id
      union all
      select 'landowner_publications'
        from public.partner_landowner_publications
       where organization_id = p_organization_id
      union all
      select 'landowner_repasses'
        from public.partner_landowner_repass_entries
       where organization_id = p_organization_id
      union all
      select 'negotiations'
        from public.partner_negotiations
       where organization_id = p_organization_id
      union all
      select 'messages'
        from public.partner_negotiation_messages
       where organization_id = p_organization_id
      union all
      select 'access_logs'
        from public.partner_portal_access_logs
       where organization_id = p_organization_id
    ) scoped_rows;

  delete from public.partner_portal_access_logs
   where organization_id = p_organization_id;
  delete from public.partner_negotiation_messages
   where organization_id = p_organization_id;
  delete from public.partner_negotiations
   where organization_id = p_organization_id;
  delete from public.partner_landowner_publications
   where organization_id = p_organization_id;
  delete from public.partner_landowner_repass_entries
   where organization_id = p_organization_id;
  delete from public.partner_payment_publications
   where organization_id = p_organization_id;
  delete from public.partner_portal_links
   where organization_id = p_organization_id;

  insert into public.audit_logs (
    organization_id,
    user_id,
    action,
    entity,
    new_data
  )
  values (
    p_organization_id,
    v_user_id,
    'partner_portal_data_reset',
    'partner_portal',
    v_counts
  );

  return v_counts;
end
$function$;

revoke all on function public.preview_landowner_portal_publication(
  uuid,
  uuid,
  uuid,
  date,
  date
) from public, anon;
revoke all on function public.publish_landowner_portal_snapshot(
  uuid,
  uuid,
  uuid,
  date,
  date,
  jsonb,
  text
) from public, anon;
revoke all on function public.archive_landowner_portal_snapshot(
  uuid,
  uuid,
  uuid,
  text
) from public, anon;
revoke all on function public.get_partner_payment_portal_v2(
  text,
  text
) from public;
revoke all on function public.set_landowner_repass_entry(
  uuid,
  uuid,
  uuid,
  uuid,
  boolean,
  numeric,
  text
) from public, anon;
revoke all on function public.reset_partner_portal_data(uuid)
  from public, anon;
revoke all on function public.create_partner_portal_link(
  uuid,
  uuid,
  text,
  text,
  timestamptz
) from public, anon;

grant execute on function public.preview_landowner_portal_publication(
  uuid,
  uuid,
  uuid,
  date,
  date
) to authenticated;
grant execute on function public.publish_landowner_portal_snapshot(
  uuid,
  uuid,
  uuid,
  date,
  date,
  jsonb,
  text
) to authenticated;
grant execute on function public.archive_landowner_portal_snapshot(
  uuid,
  uuid,
  uuid,
  text
) to authenticated;
grant execute on function public.get_partner_payment_portal_v2(
  text,
  text
) to anon, authenticated;
grant execute on function public.set_landowner_repass_entry(
  uuid,
  uuid,
  uuid,
  uuid,
  boolean,
  numeric,
  text
) to authenticated;
grant execute on function public.reset_partner_portal_data(uuid)
  to authenticated;
grant execute on function public.create_partner_portal_link(
  uuid,
  uuid,
  text,
  text,
  timestamptz
) to authenticated;

insert into public.role_permissions (
  organization_id,
  role,
  permission_key,
  allowed,
  updated_at
)
select
  organization.id,
  role_name.role,
  'partners.landowners.publish',
  role_name.role in ('admin', 'diretoria'),
  now()
from public.organizations organization
cross join (
  values
    ('admin'),
    ('diretoria'),
    ('financeiro'),
    ('engenharia'),
    ('comercial'),
    ('compras'),
    ('consulta'),
    ('gestor_crm'),
    ('sdr'),
    ('corretor'),
    ('marketing')
) as role_name(role)
on conflict (organization_id, role, permission_key) do nothing;

comment on table public.partner_landowner_publications is
  'Immutable, explicitly published snapshots for landowner partners.';
comment on table public.partner_landowner_repass_entries is
  'Explicit classification of financial payables that represent landowner repasses.';
comment on function public.get_partner_payment_portal_v2(text, text) is
  'Extends the protected payment portal with privacy-safe landowner publications.';
