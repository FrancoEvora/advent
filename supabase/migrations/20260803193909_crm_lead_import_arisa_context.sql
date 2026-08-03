-- Rastreabilidade das importacoes de leads e contexto relacional dos insights
-- Arisa. Esta migracao e exclusivamente estrutural e nao contem dados pessoais.

create table public.crm_lead_import_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  import_job_id uuid
    references public.data_import_jobs(id) on delete set null,
  crm_record_id uuid not null
    references public.crm_records(id) on delete cascade,
  source_system text not null,
  source_file text not null,
  source_file_sha256 text not null,
  external_key text not null,
  source_page integer not null,
  source_row integer not null,
  raw_data jsonb not null default '{}'::jsonb,
  match_status text not null default 'unmatched',
  match_method text,
  match_confidence_pct numeric(5,2),
  contact_id uuid
    references public.contacts(id) on delete set null,
  proposal_id uuid
    references public.crm_proposals(id) on delete set null,
  contract_id uuid
    references public.crm_contracts(id) on delete set null,
  unit_id uuid
    references public.crm_inventory_units(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint crm_lead_import_sources_system_check
    check (length(btrim(source_system)) > 0),
  constraint crm_lead_import_sources_file_check
    check (length(btrim(source_file)) > 0),
  constraint crm_lead_import_sources_sha256_check
    check (source_file_sha256 ~ '^[0-9a-f]{64}$'),
  constraint crm_lead_import_sources_external_key_check
    check (length(btrim(external_key)) > 0),
  constraint crm_lead_import_sources_page_check
    check (source_page > 0),
  constraint crm_lead_import_sources_row_check
    check (source_row > 0),
  constraint crm_lead_import_sources_raw_data_check
    check (jsonb_typeof(raw_data) = 'object'),
  constraint crm_lead_import_sources_match_status_check
    check (match_status in (
      'unmatched', 'candidate', 'matched', 'ambiguous', 'ignored', 'rejected'
    )),
  constraint crm_lead_import_sources_confidence_check
    check (
      match_confidence_pct is null
      or match_confidence_pct between 0 and 100
    ),
  constraint crm_lead_import_sources_occurrence_unique
    unique (
      organization_id, source_system, source_file_sha256,
      source_page, source_row
    )
);

comment on table public.crm_lead_import_sources is
  'Trilha restrita que liga cada ocorrencia de uma fonte importada ao lead canonico e, quando conciliado, aos registros comerciais existentes.';
comment on column public.crm_lead_import_sources.raw_data is
  'Payload original para auditoria. Pode conter dados pessoais e so deve ser lido por perfis com permissao crm.view.';
comment on column public.crm_lead_import_sources.external_key is
  'Chave normalizada e estavel da identidade na origem, sem funcao de autenticacao.';
comment on column public.crm_lead_import_sources.source_file_sha256 is
  'SHA-256 do arquivo de origem, usado com pagina e linha para idempotencia.';
comment on column public.crm_lead_import_sources.match_status is
  'Resultado conservador da conciliacao de identidade com cadastros e contratos existentes.';

create index crm_lead_import_sources_org_external_key_idx
  on public.crm_lead_import_sources (
    organization_id, source_system, external_key
  );
create index crm_lead_import_sources_org_record_idx
  on public.crm_lead_import_sources (organization_id, crm_record_id);
create index crm_lead_import_sources_org_match_status_idx
  on public.crm_lead_import_sources (organization_id, match_status);
create index crm_lead_import_sources_import_job_idx
  on public.crm_lead_import_sources (import_job_id)
  where import_job_id is not null;
create index crm_lead_import_sources_contact_idx
  on public.crm_lead_import_sources (contact_id)
  where contact_id is not null;
create index crm_lead_import_sources_proposal_idx
  on public.crm_lead_import_sources (proposal_id)
  where proposal_id is not null;
create index crm_lead_import_sources_contract_idx
  on public.crm_lead_import_sources (contract_id)
  where contract_id is not null;
create index crm_lead_import_sources_unit_idx
  on public.crm_lead_import_sources (unit_id)
  where unit_id is not null;

create table public.insight_crm_context (
  insight_id uuid primary key
    references public.insights(id) on delete cascade,
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  crm_record_id uuid not null
    references public.crm_records(id) on delete cascade,
  source_import_id uuid
    references public.crm_lead_import_sources(id) on delete set null,
  contact_id uuid
    references public.contacts(id) on delete set null,
  proposal_id uuid
    references public.crm_proposals(id) on delete set null,
  contract_id uuid
    references public.crm_contracts(id) on delete set null,
  unit_id uuid
    references public.crm_inventory_units(id) on delete set null,
  identity_match_status text not null default 'unmatched',
  identity_match_method text,
  identity_match_confidence_pct numeric(5,2),
  created_at timestamptz not null default now(),
  constraint insight_crm_context_match_status_check
    check (identity_match_status in (
      'not_applicable', 'unmatched', 'candidate', 'matched', 'ambiguous'
    )),
  constraint insight_crm_context_confidence_check
    check (
      identity_match_confidence_pct is null
      or identity_match_confidence_pct between 0 and 100
    )
);

comment on table public.insight_crm_context is
  'Contexto relacional restrito entre um insight da Arisa e o lead, cliente, proposta, contrato e lote correspondentes.';
comment on column public.insight_crm_context.identity_match_status is
  'Estado da conciliacao de identidade utilizada pelo insight; candidate e ambiguous exigem validacao humana.';
comment on column public.insight_crm_context.identity_match_confidence_pct is
  'Confianca da conciliacao de identidade, separada do score comercial do lead.';

create index insight_crm_context_org_record_idx
  on public.insight_crm_context (organization_id, crm_record_id);
create index insight_crm_context_source_import_idx
  on public.insight_crm_context (source_import_id)
  where source_import_id is not null;
create index insight_crm_context_contact_idx
  on public.insight_crm_context (contact_id)
  where contact_id is not null;
create index insight_crm_context_proposal_idx
  on public.insight_crm_context (proposal_id)
  where proposal_id is not null;
create index insight_crm_context_contract_idx
  on public.insight_crm_context (contract_id)
  where contract_id is not null;
create index insight_crm_context_unit_idx
  on public.insight_crm_context (unit_id)
  where unit_id is not null;

-- Uma execucao pode gerar diversos diagnosticos para o mesmo lead, mas nao
-- deve repetir o mesmo modelo analitico para a mesma entidade.
create unique index insights_run_crm_entity_model_uidx
  on public.insights (
    run_id,
    related_entity_id,
    ((evidence ->> 'model'))
  )
  where related_entity_type in ('crm_record', 'crm_records')
    and related_entity_id is not null
    and evidence ? 'model';

alter table public.crm_lead_import_sources enable row level security;
alter table public.insight_crm_context enable row level security;

create policy crm_lead_import_sources_select
on public.crm_lead_import_sources
for select
to authenticated
using (
  public.is_org_member(organization_id)
  and public.has_app_permission(organization_id, 'crm.view')
);

create policy insight_crm_context_select
on public.insight_crm_context
for select
to authenticated
using (
  public.is_org_member(organization_id)
  and public.has_app_permission(organization_id, 'insights.view')
  and public.has_app_permission(organization_id, 'crm.view')
);

-- Insights vinculados ao CRM podem conter contexto comercial identificavel.
-- O acesso passa a exigir simultaneamente as permissoes de Insights e CRM.
drop policy if exists insights_select on public.insights;
create policy insights_select
on public.insights
for select
to authenticated
using (
  public.is_org_member(organization_id)
  and public.has_app_permission(organization_id, 'insights.view')
  and (
    coalesce(related_entity_type, '') not in ('crm_record', 'crm_records')
    or public.has_app_permission(organization_id, 'crm.view')
  )
);

-- O historico herda a visibilidade do insight correspondente, evitando que
-- notas de tratamento revelem contexto de CRM a um perfil sem crm.view.
drop policy if exists insight_status_history_select
  on public.insight_status_history;
create policy insight_status_history_select
on public.insight_status_history
for select
to authenticated
using (
  public.is_org_member(organization_id)
  and public.has_app_permission(organization_id, 'insights.view')
  and exists (
    select 1
    from public.insights insight
    where insight.id = insight_status_history.insight_id
      and insight.organization_id = insight_status_history.organization_id
  )
);

-- A aplicacao cliente recebe somente leitura e sempre fica sujeita a RLS.
-- Escritas de importacao e geracao de insights ficam restritas ao backend.
revoke all on table public.crm_lead_import_sources
  from public, anon, authenticated;
revoke all on table public.insight_crm_context
  from public, anon, authenticated;
grant select on table public.crm_lead_import_sources to authenticated;
grant select on table public.insight_crm_context to authenticated;
grant select, insert, update, delete
  on table public.crm_lead_import_sources to service_role;
grant select, insert, update, delete
  on table public.insight_crm_context to service_role;
