-- Évora Gestão 6.18 — contratante e extrato individual no portal terrenista.
--
-- O snapshot principal recebe somente o nome do contratante. O detalhamento
-- financeiro é congelado em uma tabela separada por publicação e contrato,
-- sem documentos, contatos, tokens ou dados bancários do comprador.

do $preflight$
begin
  if to_regclass('public.organizations') is null
    or to_regclass('public.contacts') is null
    or to_regclass('public.projects') is null
    or to_regclass('public.audit_logs') is null
    or to_regclass('public.partner_portal_links') is null
    or to_regclass('public.partner_landowner_publications') is null
    or to_regclass('public.crm_contracts') is null
    or to_regclass('public.crm_proposals') is null
    or to_regclass('public.crm_inventory_units') is null
    or to_regclass('public.crm_proposal_installments') is null
    or to_regclass('public.financial_entries') is null
    or to_regprocedure(
      'public.validate_partner_portal_link(text,text,text)'
    ) is null
    or to_regprocedure(
      'public.build_landowner_portal_snapshot(uuid,uuid,uuid,date,date)'
    ) is null then
    raise exception
      'Dependências do extrato individual do terrenista ausentes.';
  end if;

  if to_regclass(
    'public.partner_landowner_contract_statements'
  ) is not null
    or to_regprocedure(
      'public.build_landowner_portal_snapshot_statement_base(uuid,uuid,uuid,date,date)'
    ) is not null then
    raise exception
      'A estrutura do extrato individual já existe ou foi aplicada parcialmente.';
  end if;
end
$preflight$;

create table public.partner_landowner_contract_statements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  publication_id uuid not null
    references public.partner_landowner_publications(id)
    on delete cascade,
  contract_number text not null
    check (char_length(contract_number) between 1 and 160),
  unit_code text not null
    check (char_length(unit_code) between 1 and 120),
  statement jsonb not null,
  created_at timestamptz not null default now(),
  constraint partner_landowner_contract_statement_unique
    unique (publication_id, contract_number, unit_code),
  constraint partner_landowner_contract_statement_shape_check
    check (
      jsonb_typeof(statement) = 'object'
      and statement ?& array[
        'contract',
        'summary',
        'installments',
        'basis'
      ]
      and jsonb_typeof(statement -> 'contract') = 'object'
      and jsonb_typeof(statement -> 'summary') = 'object'
      and jsonb_typeof(statement -> 'installments') = 'array'
      and jsonb_typeof(statement -> 'basis') = 'string'
      and pg_column_size(statement) <= 131072
    )
);

create index partner_landowner_contract_statement_scope_idx
  on public.partner_landowner_contract_statements (
    organization_id,
    publication_id,
    contract_number,
    unit_code
  );

alter table public.partner_landowner_contract_statements
  enable row level security;

revoke all on table public.partner_landowner_contract_statements
  from public, anon, authenticated, service_role;

create or replace function
  public.build_landowner_contract_statement_snapshot(
    p_organization_id uuid,
    p_project_id uuid,
    p_contract_number text,
    p_unit_code text,
    p_position_date date
  )
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
with selected_contract as (
  select
    contract.id,
    contract.proposal_id,
    contract.contract_number,
    coalesce(
      contract.customer_signed_at,
      contract.signed_at,
      contract.created_at
    ) as signed_at,
    left(
      nullif(btrim(proposal.customer_name), ''),
      240
    ) as customer_name,
    unit.unit_code,
    unit.block_code,
    unit.lot_number,
    unit.area,
    proposal.list_price,
    proposal.sale_price,
    proposal.down_payment,
    proposal.financed_amount,
    proposal.installments_count,
    proposal.monthly_interest_rate,
    proposal.indexer
  from public.crm_contracts contract
  join public.crm_proposals proposal
    on proposal.id = contract.proposal_id
   and proposal.organization_id = contract.organization_id
   and proposal.project_id = contract.project_id
   and proposal.unit_id = contract.unit_id
  join public.crm_inventory_units unit
    on unit.id = contract.unit_id
   and unit.organization_id = contract.organization_id
   and unit.project_id = contract.project_id
  where contract.organization_id = p_organization_id
    and contract.project_id = p_project_id
    and contract.status = 'assinado'
    and contract.contract_number = btrim(p_contract_number)
    and unit.unit_code = btrim(p_unit_code)
    and coalesce(
      contract.customer_signed_at,
      contract.signed_at,
      contract.created_at
    )::date <= p_position_date
  order by
    coalesce(
      contract.customer_signed_at,
      contract.signed_at,
      contract.created_at
    ) desc,
    contract.created_at desc
  limit 1
),
installment_source as (
  select
    installment.id,
    installment.installment_number,
    installment.installment_type,
    installment.due_date,
    installment.status as installment_status,
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
      when entry.type = 'entrada'
        and entry.status = 'recebido'
        and entry.settlement_date is not null
        and entry.settlement_date <= p_position_date
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
  from selected_contract contract
  join public.crm_proposal_installments installment
    on installment.organization_id = p_organization_id
   and installment.proposal_id = contract.proposal_id
  left join public.financial_entries entry
    on entry.id = installment.financial_entry_id
   and entry.organization_id = p_organization_id
   and (
     entry.project_id = p_project_id
     or entry.project_id is null
   )
),
installment_rows as (
  select
    source.installment_number,
    source.installment_type,
    source.due_date,
    round(source.original_amount, 2) as original_amount,
    round(
      least(source.received_amount, source.original_amount),
      2
    ) as received_amount,
    round(
      greatest(
        source.original_amount
          - least(source.received_amount, source.original_amount),
        0
      ),
      2
    ) as open_amount,
    case
      when source.entry_status = 'recebido'
        and source.settlement_date is not null
        and source.settlement_date <= p_position_date
      then source.settlement_date
      else null
    end as settlement_date,
    case
      when source.installment_status = 'cancelada'
        or coalesce(source.entry_status, '') = 'cancelado'
      then 'cancelado'
      when greatest(
        source.original_amount
          - least(source.received_amount, source.original_amount),
        0
      ) = 0
      then 'pago'
      when source.due_date < p_position_date
      then 'vencido'
      else 'em_aberto'
    end as public_status
  from installment_source source
),
installment_totals as (
  select
    round(
      coalesce(
        sum(row.original_amount)
          filter (where row.public_status <> 'cancelado'),
        0
      ),
      2
    ) as original_amount,
    round(
      coalesce(
        sum(row.received_amount)
          filter (where row.public_status <> 'cancelado'),
        0
      ),
      2
    ) as received_amount,
    round(
      coalesce(
        sum(row.open_amount)
          filter (where row.public_status <> 'cancelado'),
        0
      ),
      2
    ) as open_amount,
    round(
      coalesce(
        sum(row.open_amount)
          filter (where row.public_status = 'vencido'),
        0
      ),
      2
    ) as overdue_amount,
    count(*) filter (
      where row.public_status <> 'cancelado'
    )::integer as installment_count,
    count(*) filter (
      where row.public_status = 'pago'
    )::integer as paid_installments,
    count(*) filter (
      where row.public_status = 'em_aberto'
    )::integer as open_installments,
    count(*) filter (
      where row.public_status = 'vencido'
    )::integer as overdue_installments
  from installment_rows row
),
installment_list as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'installment_number', row.installment_number,
        'installment_type', row.installment_type,
        'due_date', row.due_date,
        'original_amount', row.original_amount,
        'received_amount', row.received_amount,
        'open_amount', row.open_amount,
        'settlement_date', row.settlement_date,
        'status', row.public_status
      )
      order by
        row.due_date,
        row.installment_number,
        row.installment_type
    ),
    '[]'::jsonb
  ) as rows
  from installment_rows row
)
select jsonb_build_object(
  'contract',
  jsonb_build_object(
    'contract_number', contract.contract_number,
    'customer_name', contract.customer_name,
    'signed_at', contract.signed_at,
    'unit_code', contract.unit_code,
    'block_code', contract.block_code,
    'lot_number', contract.lot_number,
    'area', contract.area,
    'list_price', contract.list_price,
    'sale_price', contract.sale_price,
    'down_payment', contract.down_payment,
    'financed_amount', contract.financed_amount,
    'installments_count', contract.installments_count,
    'monthly_interest_rate', contract.monthly_interest_rate,
    'indexer', contract.indexer
  ),
  'summary',
  jsonb_build_object(
    'contracted_amount', contract.sale_price,
    'received_amount', totals.received_amount,
    'open_amount', totals.open_amount,
    'overdue_amount', totals.overdue_amount,
    'installment_count', totals.installment_count,
    'paid_installments', totals.paid_installments,
    'open_installments', totals.open_installments,
    'overdue_installments', totals.overdue_installments
  ),
  'installments', installments.rows,
  'basis',
    'Posição congelada na publicação. Um recebimento somente é considerado concluído quando o título está com status recebido e possui data efetiva de baixa igual ou anterior à data de posição.'
)
from selected_contract contract
cross join installment_totals totals
cross join installment_list installments;
$function$;

revoke all on function
  public.build_landowner_contract_statement_snapshot(
    uuid,
    uuid,
    text,
    text,
    date
  )
  from public, anon, authenticated, service_role;

create or replace function public.enrich_landowner_sales_snapshot(
  p_snapshot jsonb,
  p_organization_id uuid,
  p_project_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_sales jsonb;
begin
  if coalesce(jsonb_typeof(p_snapshot) <> 'object', true)
    or jsonb_typeof(
      p_snapshot #> '{sales_conditions,sales}'
    ) <> 'array' then
    return p_snapshot;
  end if;

  select coalesce(
    jsonb_agg(
      sale.value
        || jsonb_build_object(
          'customer_name',
          customer.customer_name
        )
      order by sale.ordinality
    ),
    '[]'::jsonb
  )
    into v_sales
    from jsonb_array_elements(
      p_snapshot #> '{sales_conditions,sales}'
    ) with ordinality as sale(value, ordinality)
    left join lateral (
      select left(
        nullif(btrim(proposal.customer_name), ''),
        240
      ) as customer_name
      from public.crm_contracts contract
      join public.crm_proposals proposal
        on proposal.id = contract.proposal_id
       and proposal.organization_id = contract.organization_id
       and proposal.project_id = contract.project_id
       and proposal.unit_id = contract.unit_id
      join public.crm_inventory_units unit
        on unit.id = contract.unit_id
       and unit.organization_id = contract.organization_id
       and unit.project_id = contract.project_id
      where contract.organization_id = p_organization_id
        and contract.project_id = p_project_id
        and contract.status = 'assinado'
        and contract.contract_number
          = sale.value ->> 'contract_number'
        and unit.unit_code = sale.value ->> 'unit_code'
      order by
        coalesce(
          contract.customer_signed_at,
          contract.signed_at,
          contract.created_at
        ) desc,
        contract.created_at desc
      limit 1
    ) customer on true;

  return jsonb_set(
    p_snapshot,
    '{sales_conditions,sales}',
    v_sales,
    true
  );
end
$function$;

revoke all on function public.enrich_landowner_sales_snapshot(
  jsonb,
  uuid,
  uuid
) from public, anon, authenticated, service_role;

alter function public.build_landowner_portal_snapshot(
  uuid,
  uuid,
  uuid,
  date,
  date
) rename to build_landowner_portal_snapshot_statement_base;

revoke all on function
  public.build_landowner_portal_snapshot_statement_base(
    uuid,
    uuid,
    uuid,
    date,
    date
  )
  from public, anon, authenticated, service_role;

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
select public.enrich_landowner_sales_snapshot(
  public.build_landowner_portal_snapshot_statement_base(
    p_organization_id,
    p_contact_id,
    p_project_id,
    p_period_start,
    p_period_end
  ),
  p_organization_id,
  p_project_id
);
$function$;

revoke all on function public.build_landowner_portal_snapshot(
  uuid,
  uuid,
  uuid,
  date,
  date
) from public, anon, authenticated, service_role;

create or replace function
  public.capture_landowner_contract_statements()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_sale jsonb;
  v_contract_number text;
  v_unit_code text;
  v_statement jsonb;
begin
  if new.status <> 'published'
    or not coalesce(
      (new.visible_sections ->> 'sales_details')::boolean,
      false
    ) then
    return new;
  end if;

  if jsonb_typeof(
    new.snapshot #> '{sales_conditions,sales}'
  ) <> 'array' then
    raise exception
      'A publicação detalhada não contém uma lista de contratos válida.';
  end if;

  for v_sale in
    select sale.value
      from jsonb_array_elements(
        new.snapshot #> '{sales_conditions,sales}'
      ) as sale(value)
  loop
    v_contract_number := nullif(
      btrim(v_sale ->> 'contract_number'),
      ''
    );
    v_unit_code := nullif(
      btrim(v_sale ->> 'unit_code'),
      ''
    );

    if v_contract_number is null or v_unit_code is null then
      raise exception
        'Contrato ou unidade inválida na publicação detalhada.';
    end if;

    v_statement :=
      public.build_landowner_contract_statement_snapshot(
        new.organization_id,
        new.project_id,
        v_contract_number,
        v_unit_code,
        new.period_end
      );

    if v_statement is null then
      raise exception
        'Não foi possível congelar o extrato do contrato % (%).',
        v_contract_number,
        v_unit_code;
    end if;

    insert into public.partner_landowner_contract_statements (
      organization_id,
      publication_id,
      contract_number,
      unit_code,
      statement
    )
    values (
      new.organization_id,
      new.id,
      v_contract_number,
      v_unit_code,
      v_statement
    );
  end loop;

  return new;
end
$function$;

revoke all on function
  public.capture_landowner_contract_statements()
  from public, anon, authenticated, service_role;

create trigger partner_landowner_contract_statements_capture
after insert on public.partner_landowner_publications
for each row
execute function public.capture_landowner_contract_statements();

create or replace function
  public.get_landowner_contract_statement(
    p_token text,
    p_document_last4 text,
    p_publication_id uuid,
    p_contract_number text,
    p_unit_code text
  )
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_link public.partner_portal_links%rowtype;
  v_contract_number text :=
    nullif(btrim(p_contract_number), '');
  v_unit_code text := nullif(btrim(p_unit_code), '');
  v_statement jsonb;
begin
  if p_publication_id is null
    or v_contract_number is null
    or char_length(v_contract_number) > 160
    or v_unit_code is null
    or char_length(v_unit_code) > 120 then
    return null;
  end if;

  v_link := public.validate_partner_portal_link(
    p_token,
    p_document_last4,
    'landowner_contract_statement_view'
  );

  if v_link.id is null
    or v_link.partner_kind <> 'terrenista' then
    return null;
  end if;

  select statement.statement
    into v_statement
    from public.partner_landowner_publications publication
    join public.partner_landowner_contract_statements statement
      on statement.publication_id = publication.id
     and statement.organization_id = publication.organization_id
   where publication.id = p_publication_id
     and publication.organization_id = v_link.organization_id
     and publication.contact_id = v_link.contact_id
     and publication.status = 'published'
     and coalesce(
       (publication.visible_sections ->> 'sales_details')::boolean,
       false
     )
     and statement.contract_number = v_contract_number
     and statement.unit_code = v_unit_code
     and exists (
       select 1
         from jsonb_array_elements(
           coalesce(
             publication.snapshot #> '{sales_conditions,sales}',
             '[]'::jsonb
           )
         ) as sale(value)
        where sale.value ->> 'contract_number'
          = v_contract_number
          and sale.value ->> 'unit_code' = v_unit_code
     )
   limit 1;

  return v_statement;
end
$function$;

revoke all on function public.get_landowner_contract_statement(
  text,
  text,
  uuid,
  text,
  text
) from public, anon, authenticated, service_role;

grant execute on function public.get_landowner_contract_statement(
  text,
  text,
  uuid,
  text,
  text
) to anon, authenticated;

do $backfill$
declare
  v_current public.partner_landowner_publications%rowtype;
  v_snapshot jsonb;
  v_version integer;
  v_new_publication_id uuid;
begin
  for v_current in
    select publication.*
      from public.partner_landowner_publications publication
     where publication.status = 'published'
       and coalesce(
         (
           publication.visible_sections
             ->> 'sales_details'
         )::boolean,
         false
       )
     order by
       publication.organization_id,
       publication.contact_id,
       publication.project_id
     for update
  loop
    v_snapshot := public.enrich_landowner_sales_snapshot(
      v_current.snapshot,
      v_current.organization_id,
      v_current.project_id
    );

    if pg_column_size(v_snapshot) > 262144 then
      raise exception
        'O snapshot enriquecido da publicação % excede o limite permitido.',
        v_current.id;
    end if;

    select coalesce(max(publication.version), 0) + 1
      into v_version
      from public.partner_landowner_publications publication
     where publication.organization_id = v_current.organization_id
       and publication.contact_id = v_current.contact_id
       and publication.project_id = v_current.project_id;

    update public.partner_landowner_publications
       set status = 'archived',
           archived_at = now()
     where id = v_current.id
       and status = 'published';

    insert into public.partner_landowner_publications (
      organization_id,
      contact_id,
      project_id,
      period_start,
      period_end,
      status,
      visible_sections,
      snapshot,
      public_note,
      version,
      published_by,
      published_at
    )
    values (
      v_current.organization_id,
      v_current.contact_id,
      v_current.project_id,
      v_current.period_start,
      v_current.period_end,
      'published',
      v_current.visible_sections,
      v_snapshot,
      v_current.public_note,
      v_version,
      null,
      now()
    )
    returning id into v_new_publication_id;

    insert into public.audit_logs (
      organization_id,
      user_id,
      action,
      entity,
      entity_id,
      old_data,
      new_data
    )
    values (
      v_current.organization_id,
      null,
      'landowner_contract_statements_published',
      'partner_landowner_publication',
      v_new_publication_id::text,
      jsonb_build_object(
        'publication_id', v_current.id,
        'version', v_current.version
      ),
      jsonb_build_object(
        'publication_id', v_new_publication_id,
        'version', v_version,
        'reason',
          'Publicação versionada para incluir o contratante e os extratos individuais congelados.'
      )
    );
  end loop;
end
$backfill$;

comment on table public.partner_landowner_contract_statements is
  'Extratos sanitizados e imutáveis por publicação, contrato e unidade, acessíveis somente pela RPC protegida do terrenista.';

comment on function public.build_landowner_contract_statement_snapshot(
  uuid,
  uuid,
  text,
  text,
  date
) is
  'Congela o extrato sanitizado do contrato na data de posição da publicação.';

comment on function public.get_landowner_contract_statement(
  text,
  text,
  uuid,
  text,
  text
) is
  'Retorna um extrato congelado somente após validar token, documento, terrenista, publicação, visibilidade e pertencimento do contrato.';

comment on function public.build_landowner_portal_snapshot(
  uuid,
  uuid,
  uuid,
  date,
  date
) is
  'Acrescenta exclusivamente o nome sanitizado do contratante à lista de vendas do snapshot do terrenista.';
