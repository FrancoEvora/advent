-- Évora Gestão 6.14
-- Percentual contratual individual por terrenista e empreendimento.
--
-- O direito contratual é somente informativo: usa recebimentos efetivamente
-- baixados até a data de posição e não cria, altera ou liquida títulos.

do $preflight$
begin
  if to_regclass('public.partner_landowner_publications') is null
    or to_regclass('public.partner_landowner_repass_entries') is null
    or to_regclass('public.crm_contracts') is null
    or to_regclass('public.crm_proposals') is null
    or to_regclass('public.crm_proposal_installments') is null
    or to_regclass('public.financial_entries') is null
    or to_regclass('public.audit_logs') is null
    or to_regprocedure('public.has_app_permission(uuid,text)') is null
    or (
      to_regprocedure(
        'public.build_landowner_portal_snapshot(uuid,uuid,uuid,date,date)'
      ) is null
      and to_regprocedure(
        'public.build_landowner_portal_snapshot_core(uuid,uuid,uuid,date,date)'
      ) is null
    )
    or (
      to_regprocedure(
        'public.get_partner_payment_portal_v2(text,text)'
      ) is null
      and to_regprocedure(
        'public.get_partner_payment_portal_v2_core(text,text)'
      ) is null
    )
    or (
      to_regprocedure('public.reset_partner_portal_data(uuid)') is null
      and to_regprocedure('public.reset_partner_portal_data_core(uuid)') is null
    ) then
    raise exception 'Landowner contract percentage prerequisites are missing.';
  end if;
end
$preflight$;

alter table public.financial_entries
  add column if not exists reconciled_amount numeric(15, 2)
  not null default 0;

create table if not exists public.partner_landowner_contract_terms (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  contractual_percentage numeric(7, 4) not null
    check (
      contractual_percentage > 0
      and contractual_percentage <= 100
    ),
  notes text check (char_length(notes) <= 800),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint partner_landowner_contract_terms_scope_unique
    unique (organization_id, contact_id, project_id)
);

create index if not exists partner_landowner_contract_terms_contact_idx
  on public.partner_landowner_contract_terms (contact_id);

create index if not exists partner_landowner_contract_terms_project_idx
  on public.partner_landowner_contract_terms (project_id);

create index if not exists partner_landowner_contract_terms_created_by_idx
  on public.partner_landowner_contract_terms (created_by);

create index if not exists partner_landowner_contract_terms_updated_by_idx
  on public.partner_landowner_contract_terms (updated_by);

alter table public.partner_landowner_contract_terms
  enable row level security;

drop policy if exists partner_landowner_contract_terms_select
  on public.partner_landowner_contract_terms;

create policy partner_landowner_contract_terms_select
  on public.partner_landowner_contract_terms
  for select
  to authenticated
  using (
    public.has_app_permission(
      partner_landowner_contract_terms.organization_id,
      'partners.view'
    )
  );

revoke all on table public.partner_landowner_contract_terms
  from public, anon, authenticated, service_role;
grant select on table public.partner_landowner_contract_terms
  to authenticated;
grant select, insert, update, delete
  on table public.partner_landowner_contract_terms
  to service_role;

create or replace function public.touch_landowner_contract_terms_updated_at()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  new.updated_at := now();
  return new;
end
$function$;

drop trigger if exists partner_landowner_contract_terms_updated_at
  on public.partner_landowner_contract_terms;

create trigger partner_landowner_contract_terms_updated_at
before update on public.partner_landowner_contract_terms
for each row
execute function public.touch_landowner_contract_terms_updated_at();

revoke all on function public.touch_landowner_contract_terms_updated_at()
  from public, anon, authenticated, service_role;

create or replace function public.set_landowner_contract_terms(
  organization_id uuid,
  contact_id uuid,
  project_id uuid,
  contractual_percentage numeric,
  notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_organization_id uuid := organization_id;
  v_contact_id uuid := contact_id;
  v_project_id uuid := project_id;
  v_percentage numeric(7, 4);
  v_notes text;
  v_previous public.partner_landowner_contract_terms%rowtype;
  v_saved public.partner_landowner_contract_terms%rowtype;
begin
  if v_user_id is null
    or not public.has_app_permission(
      v_organization_id,
      'partners.landowners.publish'
    ) then
    raise exception 'Acesso não autorizado.';
  end if;

  if contractual_percentage is null
    or contractual_percentage <= 0
    or contractual_percentage > 100 then
    raise exception
      'Informe um percentual contratual maior que zero e de até 100 pontos percentuais.';
  end if;

  v_percentage := round(contractual_percentage, 4);
  v_notes := nullif(btrim(notes), '');

  if char_length(v_notes) > 800 then
    raise exception 'As observações podem ter no máximo 800 caracteres.';
  end if;

  if not exists (
    select 1
     from public.contacts contact
     where contact.id = v_contact_id
       and contact.organization_id = v_organization_id
       and contact.active = true
       and lower(contact.contact_type) = 'terrenista'
  ) then
    raise exception 'Terrenista ativo não localizado.';
  end if;

  if not exists (
    select 1
     from public.projects project
     where project.id = v_project_id
       and project.organization_id = v_organization_id
  ) then
    raise exception 'Empreendimento não localizado.';
  end if;

  select terms.*
    into v_previous
    from public.partner_landowner_contract_terms terms
   where terms.organization_id = v_organization_id
     and terms.contact_id = v_contact_id
     and terms.project_id = v_project_id
   for update;

  insert into public.partner_landowner_contract_terms (
    organization_id,
    contact_id,
    project_id,
    contractual_percentage,
    notes,
    created_by,
    updated_by
  )
  values (
    v_organization_id,
    v_contact_id,
    v_project_id,
    v_percentage,
    v_notes,
    v_user_id,
    v_user_id
  )
  on conflict on constraint
    partner_landowner_contract_terms_scope_unique
  do update set
    contractual_percentage = excluded.contractual_percentage,
    notes = excluded.notes,
    updated_by = excluded.updated_by,
    updated_at = now()
  returning * into v_saved;

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
    v_organization_id,
    v_user_id,
    case
      when v_previous.id is null
      then 'landowner_contract_terms_created'
      else 'landowner_contract_terms_updated'
    end,
    'partner_landowner_contract_terms',
    v_saved.id::text,
    case
      when v_previous.id is null then null
      else jsonb_build_object(
        'contact_id', v_previous.contact_id,
        'project_id', v_previous.project_id,
        'contractual_percentage', v_previous.contractual_percentage,
        'notes', v_previous.notes,
        'updated_at', v_previous.updated_at
      )
    end,
    jsonb_build_object(
      'contact_id', v_saved.contact_id,
      'project_id', v_saved.project_id,
      'contractual_percentage', v_saved.contractual_percentage,
      'notes', v_saved.notes,
      'updated_at', v_saved.updated_at
    )
  );

  return jsonb_build_object(
    'id', v_saved.id,
    'organization_id', v_saved.organization_id,
    'contact_id', v_saved.contact_id,
    'project_id', v_saved.project_id,
    'contractual_percentage', v_saved.contractual_percentage,
    'notes', v_saved.notes,
    'updated_at', v_saved.updated_at
  );
end
$function$;

revoke all on function public.set_landowner_contract_terms(
  uuid,
  uuid,
  uuid,
  numeric,
  text
) from public, anon, authenticated, service_role;
grant execute on function public.set_landowner_contract_terms(
  uuid,
  uuid,
  uuid,
  numeric,
  text
) to authenticated;

do $rename_snapshot_core$
begin
  if to_regprocedure(
    'public.build_landowner_portal_snapshot_core(uuid,uuid,uuid,date,date)'
  ) is null then
    alter function public.build_landowner_portal_snapshot(
      uuid,
      uuid,
      uuid,
      date,
      date
    ) rename to build_landowner_portal_snapshot_core;
  end if;
end
$rename_snapshot_core$;

revoke all on function public.build_landowner_portal_snapshot_core(
  uuid,
  uuid,
  uuid,
  date,
  date
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
  )
  select coalesce(sum(receipt.received_amount), 0)
    into v_receipts_basis_amount
    from (
      select
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
    ) receipt;

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

  return jsonb_set(
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

revoke all on function public.preview_landowner_portal_publication(
  uuid,
  uuid,
  uuid,
  date,
  date
) from public, anon, authenticated, service_role;
grant execute on function public.preview_landowner_portal_publication(
  uuid,
  uuid,
  uuid,
  date,
  date
) to authenticated;

create or replace function public.enforce_landowner_contract_terms_on_publication()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  v_contractual_percentage numeric(7, 4);
begin
  select terms.contractual_percentage
    into v_contractual_percentage
    from public.partner_landowner_contract_terms terms
   where terms.organization_id = new.organization_id
     and terms.contact_id = new.contact_id
     and terms.project_id = new.project_id;

  if v_contractual_percentage is null
    or not coalesce(
      (new.snapshot #>> '{repasses,configured}')::boolean,
      false
    )
    or coalesce(
      round(
        (new.snapshot #>> '{repasses,contractual_percentage}')::numeric,
        4
      ) <> v_contractual_percentage,
      true
    ) then
    raise exception
      'Cadastre o percentual contratual deste terrenista e empreendimento antes de publicar.';
  end if;

  return new;
end
$function$;

drop trigger if exists partner_landowner_publication_contract_terms
  on public.partner_landowner_publications;

create trigger partner_landowner_publication_contract_terms
before insert or update of
  organization_id,
  contact_id,
  project_id,
  snapshot
on public.partner_landowner_publications
for each row
execute function public.enforce_landowner_contract_terms_on_publication();

revoke all on function
  public.enforce_landowner_contract_terms_on_publication()
  from public, anon, authenticated, service_role;

do $rename_portal_core$
begin
  if to_regprocedure(
    'public.get_partner_payment_portal_v2_core(text,text)'
  ) is null then
    alter function public.get_partner_payment_portal_v2(text, text)
      rename to get_partner_payment_portal_v2_core;
  end if;
end
$rename_portal_core$;

revoke all on function public.get_partner_payment_portal_v2_core(
  text,
  text
) from public, anon, authenticated, service_role;

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
        when publication.id is not null
          and portal_publication.value ? 'repasses'
          and coalesce(
            (
              publication.visible_sections
                ->> 'repasses_summary'
            )::boolean,
            false
          )
        then jsonb_set(
          portal_publication.value,
          '{repasses}',
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
            ),
          true
        )
        else portal_publication.value
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

do $rename_reset_core$
begin
  if to_regprocedure(
    'public.reset_partner_portal_data_core(uuid)'
  ) is null then
    alter function public.reset_partner_portal_data(uuid)
      rename to reset_partner_portal_data_core;
  end if;
end
$rename_reset_core$;

revoke all on function public.reset_partner_portal_data_core(uuid)
  from public, anon, authenticated, service_role;

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
  v_terms_count integer;
  v_counts jsonb;
begin
  if v_user_id is null
    or not public.has_app_permission(
      p_organization_id,
      'platform.manage'
    ) then
    raise exception 'Acesso não autorizado.';
  end if;

  select count(*)::integer
    into v_terms_count
    from public.partner_landowner_contract_terms terms
   where terms.organization_id = p_organization_id;

  v_counts := public.reset_partner_portal_data_core(
    p_organization_id
  );

  delete from public.partner_landowner_contract_terms terms
   where terms.organization_id = p_organization_id;

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
    'landowner_contract_terms_reset',
    'partner_portal',
    jsonb_build_object(
      'landowner_contract_terms', v_terms_count
    )
  );

  return coalesce(v_counts, '{}'::jsonb)
    || jsonb_build_object(
      'landowner_contract_terms', v_terms_count
    );
end
$function$;

revoke all on function public.reset_partner_portal_data(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.reset_partner_portal_data(uuid)
  to authenticated;

comment on table public.partner_landowner_contract_terms is
  'Percentual contratual digitado por terrenista e empreendimento, sem mutação automática de títulos.';

comment on column
  public.partner_landowner_contract_terms.contractual_percentage is
  'Percentual em pontos percentuais, maior que zero e de até 100.';

comment on function public.set_landowner_contract_terms(
  uuid,
  uuid,
  uuid,
  numeric,
  text
) is
  'Cadastra ou atualiza o percentual contratual individual com permissão e trilha de auditoria.';

comment on function public.build_landowner_portal_snapshot(
  uuid,
  uuid,
  uuid,
  date,
  date
) is
  'Acrescenta ao snapshot o direito contratual estimado sobre recebimentos efetivamente baixados.';
