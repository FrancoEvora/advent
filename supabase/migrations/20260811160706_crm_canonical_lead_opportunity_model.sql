-- Evora Enterprise - fundacao canonica de leads, oportunidades e atribuicao.
--
-- Esta migracao e deliberadamente aditiva:
--   * contacts continua sendo a pessoa canonica;
--   * crm_records continua sendo a oportunidade canonica e aceita mais de uma
--     oportunidade para o mesmo contato;
--   * projects continua sendo o empreendimento;
--   * crm_inventory_units continua sendo o lote/unidade fisica;
--   * crm_campaigns e marketing_campaigns permanecem nos seus dominios e sao
--     ligados explicitamente, sem criar uma terceira campanha.
--
-- A entrada HTTP, o payload bruto, filas/retries e o agente Vitoria pertencem
-- as proximas etapas. Nenhum token Meta/OpenAI e armazenado nesta estrutura.

set lock_timeout = '5s';
set statement_timeout = '120s';

create schema if not exists private;

do $migration$
begin
  if to_regclass('public.organizations') is null
     or to_regclass('public.organization_members') is null
     or to_regclass('public.role_permissions') is null
     or to_regclass('public.projects') is null
     or to_regclass('public.contacts') is null
     or to_regclass('public.crm_records') is null
     or to_regclass('public.crm_pipelines') is null
     or to_regclass('public.crm_stages') is null
     or to_regclass('public.crm_teams') is null
     or to_regclass('public.crm_team_members') is null
     or to_regclass('public.crm_campaigns') is null
     or to_regclass('public.crm_inventory_units') is null
     or to_regclass('public.marketing_campaigns') is null
     or to_regclass('public.restore_jobs') is null
     or to_regprocedure('public.has_app_permission(uuid,text)') is null then
    raise exception
      'Pre-requisitos de organizacao, CRM, estoque, marketing ou permissoes nao encontrados.';
  end if;
end
$migration$;

-- O backup pelo navegador restaura em varias requisicoes. Esta funcao abre
-- uma janela curta e auditavel somente para o administrador que iniciou um
-- restore formal, permitindo recompor os ledgers append-only sem afrouxar seu
-- uso cotidiano.
create or replace function public.crm_canonical_restore_active(
  p_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.restore_jobs job
    join public.organization_members member
      on member.organization_id = job.organization_id
     and member.user_id = auth.uid()
     and member.active
     and member.role = 'admin'
    where job.organization_id = p_organization_id
      and job.status = 'processando'
      and job.requested_by = auth.uid()
      and job.approved_by = auth.uid()
      and job.created_at >= now() - interval '2 hours'
  );
$function$;

revoke all on function public.crm_canonical_restore_active(uuid)
  from public, anon;
grant execute on function public.crm_canonical_restore_active(uuid)
  to authenticated, service_role;

-- Chaves compostas asseguram isolamento de tenant nos novos relacionamentos.
-- Os IDs continuam sendo as chaves primarias publicas existentes.
create unique index if not exists projects_organization_id_id_uidx
  on public.projects (organization_id, id);
create unique index if not exists contacts_organization_id_id_uidx
  on public.contacts (organization_id, id);
create unique index if not exists crm_records_organization_id_id_uidx
  on public.crm_records (organization_id, id);
create unique index if not exists crm_pipelines_organization_id_id_uidx
  on public.crm_pipelines (organization_id, id);
create unique index if not exists crm_stages_organization_id_id_uidx
  on public.crm_stages (organization_id, id);
create unique index if not exists crm_stages_org_pipeline_id_id_uidx
  on public.crm_stages (organization_id, pipeline_id, id);
create unique index if not exists crm_teams_organization_id_id_uidx
  on public.crm_teams (organization_id, id);
create unique index if not exists crm_campaigns_organization_id_id_uidx
  on public.crm_campaigns (organization_id, id);
create unique index if not exists marketing_campaigns_organization_id_id_uidx
  on public.marketing_campaigns (organization_id, id);

-- As FKs legadas validam apenas o UUID global. Estas guardas compostas
-- impedem que uma linha autorizada de uma organizacao aponte para contato,
-- empreendimento ou campanha de outro tenant. Sao aditivas para preservar o
-- comportamento de exclusao ja usado pelo ERP.
alter table public.crm_records
  add constraint crm_records_contact_organization_fk
    foreign key (organization_id, contact_id)
    references public.contacts(organization_id, id)
    on delete set null (contact_id) not valid,
  add constraint crm_records_project_organization_fk
    foreign key (organization_id, project_id)
    references public.projects(organization_id, id)
    on delete set null (project_id) not valid,
  add constraint crm_records_campaign_organization_fk
    foreign key (organization_id, campaign_id)
    references public.crm_campaigns(organization_id, id)
    on delete set null (campaign_id) not valid,
  add constraint crm_records_pipeline_organization_fk
    foreign key (organization_id, pipeline_id)
    references public.crm_pipelines(organization_id, id)
    on delete set null (pipeline_id) not valid,
  add constraint crm_records_stage_organization_fk
    foreign key (organization_id, stage_id)
    references public.crm_stages(organization_id, id)
    on delete set null (stage_id) not valid,
  add constraint crm_records_stage_pipeline_fk
    foreign key (organization_id, pipeline_id, stage_id)
    references public.crm_stages(organization_id, pipeline_id, id)
    on delete set null (stage_id) not valid,
  add constraint crm_records_team_organization_fk
    foreign key (organization_id, team_id)
    references public.crm_teams(organization_id, id)
    on delete set null (team_id) not valid,
  add constraint crm_records_owner_membership_fk
    foreign key (organization_id, owner_user_id)
    references public.organization_members(organization_id, user_id)
    on delete set null (owner_user_id) not valid,
  add constraint crm_records_sdr_membership_fk
    foreign key (organization_id, sdr_user_id)
    references public.organization_members(organization_id, user_id)
    on delete set null (sdr_user_id) not valid,
  add constraint crm_records_broker_membership_fk
    foreign key (organization_id, broker_user_id)
    references public.organization_members(organization_id, user_id)
    on delete set null (broker_user_id) not valid;

alter table public.crm_stages
  add constraint crm_stages_pipeline_organization_fk
    foreign key (organization_id, pipeline_id)
    references public.crm_pipelines(organization_id, id)
    on delete cascade not valid;

alter table public.crm_team_members
  add constraint crm_team_members_team_organization_fk
    foreign key (organization_id, team_id)
    references public.crm_teams(organization_id, id)
    on delete cascade not valid,
  add constraint crm_team_members_user_membership_fk
    foreign key (organization_id, user_id)
    references public.organization_members(organization_id, user_id)
    on delete cascade not valid;

alter table public.crm_inventory_units
  add constraint crm_inventory_units_project_organization_fk
    foreign key (organization_id, project_id)
    references public.projects(organization_id, id)
    on delete cascade not valid;

alter table public.crm_campaigns
  add constraint crm_campaigns_project_organization_fk
    foreign key (organization_id, project_id)
    references public.projects(organization_id, id)
    on delete set null (project_id) not valid;

alter table public.crm_records
  validate constraint crm_records_contact_organization_fk,
  validate constraint crm_records_project_organization_fk,
  validate constraint crm_records_campaign_organization_fk,
  validate constraint crm_records_pipeline_organization_fk,
  validate constraint crm_records_stage_organization_fk,
  validate constraint crm_records_stage_pipeline_fk,
  validate constraint crm_records_team_organization_fk,
  validate constraint crm_records_owner_membership_fk,
  validate constraint crm_records_sdr_membership_fk,
  validate constraint crm_records_broker_membership_fk;
alter table public.crm_stages
  validate constraint crm_stages_pipeline_organization_fk;
alter table public.crm_team_members
  validate constraint crm_team_members_team_organization_fk,
  validate constraint crm_team_members_user_membership_fk;
alter table public.crm_inventory_units
  validate constraint crm_inventory_units_project_organization_fk;
alter table public.crm_campaigns
  validate constraint crm_campaigns_project_organization_fk;

-- Prospect passa a existir como estado de ciclo de vida da pessoa. Consentimento
-- e bloqueio de contato permanecem na pessoa, e nao em uma integracao externa.
alter table public.contacts
  drop constraint if exists contacts_contact_type_check;

alter table public.contacts
  add constraint contacts_contact_type_check
    check (contact_type in (
      'prospect', 'cliente', 'fornecedor', 'ambos', 'terrenista',
      'colaborador', 'corretor', 'beneficiario'
    )),
  add column preferred_channel text,
  add column marketing_consent_status text not null default 'unknown',
  add column marketing_consent_at timestamptz,
  add column marketing_consent_source text,
  add column data_processing_basis text,
  add column do_not_contact_at timestamptz,
  add constraint contacts_preferred_channel_check
    check (
      preferred_channel is null
      or preferred_channel in (
        'whatsapp', 'telefone', 'email', 'instagram', 'facebook',
        'site', 'presencial', 'outro'
      )
    ),
  add constraint contacts_marketing_consent_status_check
    check (marketing_consent_status in (
      'unknown', 'granted', 'denied', 'revoked'
    )),
  add constraint contacts_data_processing_basis_check
    check (
      data_processing_basis is null
      or data_processing_basis in (
        'consent', 'pre_contract', 'contract', 'legitimate_interest',
        'legal_obligation', 'not_defined'
      )
    );

-- Consentimento e bloqueio de contato sao campos de governanca. A politica
-- legada de contacts e ampla para atender Financeiro e cadastros mestres, por
-- isso essas colunas recebem uma guarda adicional no banco.
create or replace function private.guard_contact_marketing_governance()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  changed boolean;
begin
  if public.crm_canonical_restore_active(new.organization_id) then
    return new;
  end if;

  if current_user in ('postgres', 'service_role', 'supabase_admin')
     or coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    changed := new.preferred_channel is not null
      or new.marketing_consent_status <> 'unknown'
      or new.marketing_consent_at is not null
      or new.marketing_consent_source is not null
      or new.data_processing_basis is not null
      or new.do_not_contact_at is not null;
  else
    changed := old.preferred_channel is distinct from new.preferred_channel
      or old.marketing_consent_status is distinct from new.marketing_consent_status
      or old.marketing_consent_at is distinct from new.marketing_consent_at
      or old.marketing_consent_source is distinct from new.marketing_consent_source
      or old.data_processing_basis is distinct from new.data_processing_basis
      or old.do_not_contact_at is distinct from new.do_not_contact_at;
  end if;

  if changed and not public.has_app_permission(new.organization_id, 'crm.manage') then
    raise exception 'Seu perfil nao pode alterar consentimento ou bloqueio de contato.';
  end if;

  return new;
end
$function$;

revoke all on function private.guard_contact_marketing_governance()
  from public, anon, authenticated;

create trigger contacts_guard_marketing_governance_insert
before insert on public.contacts
for each row execute function private.guard_contact_marketing_governance();

create trigger contacts_guard_marketing_governance_update
before update of
  preferred_channel, marketing_consent_status, marketing_consent_at,
  marketing_consent_source, data_processing_basis, do_not_contact_at
on public.contacts
for each row execute function private.guard_contact_marketing_governance();

create table public.crm_products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  project_id uuid not null,
  code text not null,
  name text not null,
  product_type text not null,
  description text,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_products_project_fk
    foreign key (organization_id, project_id)
    references public.projects(organization_id, id) on delete cascade,
  constraint crm_products_code_check
    check (code = upper(trim(code)) and char_length(code) between 2 and 80),
  constraint crm_products_name_check
    check (char_length(trim(name)) between 2 and 180),
  constraint crm_products_type_check
    check (char_length(trim(product_type)) between 2 and 80),
  constraint crm_products_metadata_object_check
    check (jsonb_typeof(metadata) = 'object'),
  constraint crm_products_metadata_size_check
    check (pg_column_size(metadata) <= 16384),
  constraint crm_products_org_project_code_key
    unique (organization_id, project_id, code),
  constraint crm_products_org_project_id_key
    unique (organization_id, project_id, id),
  constraint crm_products_org_id_key
    unique (organization_id, id)
);

create index crm_products_org_active_name_idx
  on public.crm_products (organization_id, active, name);
create index crm_products_project_active_idx
  on public.crm_products (project_id, active);

create table public.crm_lead_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  code text not null,
  name text not null,
  provider text not null,
  channel text not null,
  manual_selectable boolean not null default true,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_lead_sources_code_check
    check (code = upper(trim(code)) and char_length(code) between 2 and 80),
  constraint crm_lead_sources_name_check
    check (char_length(trim(name)) between 2 and 180),
  constraint crm_lead_sources_provider_check
    check (
      provider = lower(trim(provider))
      and provider ~ '^[a-z0-9_-]+$'
      and char_length(provider) between 2 and 60
    ),
  constraint crm_lead_sources_channel_check
    check (
      channel = lower(trim(channel))
      and channel ~ '^[a-z0-9_-]+$'
      and char_length(channel) between 2 and 80
    ),
  constraint crm_lead_sources_metadata_object_check
    check (jsonb_typeof(metadata) = 'object'),
  constraint crm_lead_sources_metadata_size_check
    check (pg_column_size(metadata) <= 16384),
  constraint crm_lead_sources_org_code_key
    unique (organization_id, code),
  constraint crm_lead_sources_org_id_key
    unique (organization_id, id)
);

create index crm_lead_sources_org_provider_active_idx
  on public.crm_lead_sources (organization_id, provider, active);

create or replace function private.guard_crm_integration_lead_source()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  organization_key uuid;
  touches_integration_source boolean;
begin
  organization_key := case when tg_op = 'DELETE'
    then old.organization_id else new.organization_id end;

  if public.crm_canonical_restore_active(organization_key)
     or coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'supabase_admin') then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  touches_integration_source := case
    when tg_op = 'INSERT' then not new.manual_selectable
    when tg_op = 'DELETE' then not old.manual_selectable
    else not old.manual_selectable or not new.manual_selectable
  end;

  if touches_integration_source
     and not public.has_app_permission(
       organization_key, 'crm.integrations.manage'
     ) then
    raise exception 'Seu perfil nao pode alterar fontes de integracao.';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$;

revoke all on function private.guard_crm_integration_lead_source()
  from public, anon, authenticated;

create trigger crm_lead_sources_guard_integration
before insert or update or delete on public.crm_lead_sources
for each row execute function private.guard_crm_integration_lead_source();

-- Uma identidade normalizada pode aparecer em mais de um contato legado. A
-- busca e indexada, mas nao e UNIQUE entre pessoas: resultados ambiguos devem
-- ir para revisao humana em vez de fundir contatos automaticamente.
create table public.crm_contact_identities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  contact_id uuid not null,
  identity_type text not null,
  normalized_value text not null,
  verified_at timestamptz,
  last_seen_at timestamptz,
  active boolean not null default true,
  source text not null default 'manual',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_contact_identities_contact_fk
    foreign key (organization_id, contact_id)
    references public.contacts(organization_id, id) on delete cascade,
  constraint crm_contact_identities_type_check
    check (identity_type in (
      'whatsapp', 'phone', 'email', 'meta_user', 'external'
    )),
  constraint crm_contact_identities_value_check
    check (
      normalized_value = trim(normalized_value)
      and char_length(normalized_value) between 3 and 320
    ),
  constraint crm_contact_identities_phone_format_check
    check (
      identity_type not in ('whatsapp', 'phone')
      or normalized_value ~ '^[+][1-9][0-9]{7,14}$'
    ),
  constraint crm_contact_identities_email_format_check
    check (
      identity_type <> 'email'
      or normalized_value = lower(normalized_value)
    ),
  constraint crm_contact_identities_source_check
    check (char_length(trim(source)) between 2 and 80),
  constraint crm_contact_identities_metadata_object_check
    check (jsonb_typeof(metadata) = 'object'),
  constraint crm_contact_identities_metadata_size_check
    check (pg_column_size(metadata) <= 16384),
  constraint crm_contact_identities_contact_value_key
    unique (organization_id, contact_id, identity_type, normalized_value)
);

create index crm_contact_identities_lookup_idx
  on public.crm_contact_identities (
    organization_id, identity_type, normalized_value
  ) where active;
create index crm_contact_identities_contact_active_idx
  on public.crm_contact_identities (contact_id, active);

-- Produto e origem estruturada passam a fazer parte da oportunidade existente.
-- Identificadores externos permanecem no snapshot restrito de atribuicao: isso
-- evita expo-los pelo SELECT amplo legado de crm_records e permite varias
-- captacoes para a mesma oportunidade. O inbox transacional vira a fronteira
-- idempotente de entrada na proxima etapa.
alter table public.crm_records
  add column product_id uuid,
  add column lead_source_id uuid,
  add column originated_at timestamptz;

update public.crm_records
set originated_at = created_at
where originated_at is null;

alter table public.crm_records
  alter column originated_at set default now(),
  alter column originated_at set not null,
  add constraint crm_records_product_fk
    foreign key (organization_id, project_id, product_id)
    references public.crm_products(organization_id, project_id, id)
    on delete set null (product_id),
  add constraint crm_records_lead_source_fk
    foreign key (organization_id, lead_source_id)
    references public.crm_lead_sources(organization_id, id)
    on delete set null (lead_source_id),
  add constraint crm_records_product_project_check
    check (product_id is null or project_id is not null);

create index crm_records_product_status_idx
  on public.crm_records (organization_id, product_id, record_status);
create index crm_records_lead_source_created_idx
  on public.crm_records (organization_id, lead_source_id, originated_at desc);
create index crm_records_active_continuity_idx
  on public.crm_records (
    organization_id, contact_id, project_id, product_id, updated_at desc
  )
  where record_status = 'aberta' and contact_id is not null;

-- Origens de integracao nao podem ser escolhidas como se fossem uma captacao
-- manual. Somente o boundary servidor/service role pode vincula-las; o
-- identificador externo correspondente vive na atribuicao restrita.
create or replace function private.validate_crm_record_canonical_source()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  source_channel text;
  source_manual_selectable boolean;
  old_source_manual_selectable boolean;
begin
  if public.crm_canonical_restore_active(new.organization_id) then
    return new;
  end if;

  if new.lead_source_id is not null then
    select source.channel, source.manual_selectable
      into source_channel, source_manual_selectable
    from public.crm_lead_sources source
    where source.organization_id = new.organization_id
      and source.id = new.lead_source_id
      and source.active;

    if not found then
      raise exception 'Fonte estruturada inexistente ou inativa.';
    end if;

    if not source_manual_selectable then
      new.source_channel := source_channel;
      if tg_op = 'INSERT'
         and current_user not in ('postgres', 'service_role', 'supabase_admin') then
        raise exception 'Fontes de integracao so podem ser gravadas pelo Hub de Integracao.';
      end if;
    end if;
  end if;

  if tg_op = 'UPDATE'
     and new.lead_source_id is distinct from old.lead_source_id then
    if old.lead_source_id is not null then
      select source.manual_selectable into old_source_manual_selectable
      from public.crm_lead_sources source
      where source.organization_id = old.organization_id
        and source.id = old.lead_source_id;
    end if;

    if (not coalesce(source_manual_selectable, true)
        or not coalesce(old_source_manual_selectable, true))
       and current_user not in ('postgres', 'service_role', 'supabase_admin') then
      raise exception 'Fontes de integracao so podem ser alteradas pelo Hub de Integracao.';
    end if;
  end if;

  return new;
end
$function$;

revoke all on function private.validate_crm_record_canonical_source()
  from public, anon, authenticated;

create trigger crm_records_validate_canonical_source_insert
before insert on public.crm_records
for each row execute function private.validate_crm_record_canonical_source();

create trigger crm_records_validate_canonical_source_update
before update of lead_source_id, source_channel on public.crm_records
for each row execute function private.validate_crm_record_canonical_source();

create or replace function private.validate_crm_record_assignees()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if public.crm_canonical_restore_active(new.organization_id) then
    return new;
  end if;

  if new.owner_user_id is not null and not exists (
    select 1 from public.organization_members member
    where member.organization_id = new.organization_id
      and member.user_id = new.owner_user_id
      and member.active
  ) then
    raise exception 'Responsavel atual nao pertence a organizacao.';
  end if;

  if new.sdr_user_id is not null and not exists (
    select 1 from public.organization_members member
    where member.organization_id = new.organization_id
      and member.user_id = new.sdr_user_id
      and member.active
  ) then
    raise exception 'SDR nao pertence a organizacao.';
  end if;

  if new.broker_user_id is not null and not exists (
    select 1 from public.organization_members member
    where member.organization_id = new.organization_id
      and member.user_id = new.broker_user_id
      and member.active
  ) then
    raise exception 'Corretor nao pertence a organizacao.';
  end if;

  return new;
end
$function$;

revoke all on function private.validate_crm_record_assignees()
  from public, anon, authenticated;

create trigger crm_records_validate_assignees_insert
before insert on public.crm_records
for each row execute function private.validate_crm_record_assignees();

create trigger crm_records_validate_assignees_update
before update of owner_user_id, sdr_user_id, broker_user_id
on public.crm_records
for each row execute function private.validate_crm_record_assignees();

alter table public.crm_inventory_units
  add column product_id uuid,
  add constraint crm_inventory_units_product_fk
    foreign key (organization_id, project_id, product_id)
    references public.crm_products(organization_id, project_id, id)
    on delete set null (product_id);

-- Quando o empreendimento possui uma unica familia comercial ativa, novos
-- lotes e importacoes herdam esse produto automaticamente. Com mais de uma
-- familia, a escolha permanece explicita para evitar classificacao inventada.
create or replace function private.resolve_inventory_unit_product()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  resolved_product_id uuid;
  product_count integer;
begin
  if new.product_id is not null or new.project_id is null then
    return new;
  end if;

  select (array_agg(product.id order by product.id::text))[1], count(*)
    into resolved_product_id, product_count
  from public.crm_products product
  where product.organization_id = new.organization_id
    and product.project_id = new.project_id
    and product.active;

  if product_count = 1 then
    new.product_id := resolved_product_id;
  end if;

  return new;
end
$function$;

revoke all on function private.resolve_inventory_unit_product()
  from public, anon, authenticated;

create trigger crm_inventory_units_resolve_product
before insert or update of project_id, product_id
on public.crm_inventory_units
for each row execute function private.resolve_inventory_unit_product();

create index crm_inventory_units_product_status_idx
  on public.crm_inventory_units (organization_id, product_id, status)
  where product_id is not null;

-- Ponte explicita: crm_campaigns continua sendo a campanha operacional do CRM
-- e marketing_campaigns continua sendo a campanha gerencial do Campaign
-- Control. Identificadores externos ficam em uma tabela restrita, nunca na
-- tabela legada carregada com SELECT * pelo CRM.
alter table public.crm_campaigns
  add column marketing_campaign_id uuid,
  add constraint crm_campaigns_marketing_campaign_fk
    foreign key (organization_id, marketing_campaign_id)
    references public.marketing_campaigns(organization_id, id)
    on delete set null (marketing_campaign_id);

create unique index crm_campaigns_marketing_campaign_uidx
  on public.crm_campaigns (organization_id, marketing_campaign_id)
  where marketing_campaign_id is not null;

create table public.crm_campaign_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  crm_campaign_id uuid not null,
  provider text not null,
  provider_account_id text not null,
  external_campaign_id text not null,
  external_campaign_name text,
  provider_metadata jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_campaign_mappings_campaign_fk
    foreign key (organization_id, crm_campaign_id)
    references public.crm_campaigns(organization_id, id) on delete cascade,
  constraint crm_campaign_mappings_provider_check
    check (
      provider = lower(trim(provider))
      and provider ~ '^[a-z0-9_-]+$'
      and char_length(provider) between 2 and 60
    ),
  constraint crm_campaign_mappings_account_check
    check (
      provider_account_id = trim(provider_account_id)
      and char_length(provider_account_id) between 1 and 255
    ),
  constraint crm_campaign_mappings_external_check
    check (
      external_campaign_id = trim(external_campaign_id)
      and char_length(external_campaign_id) between 1 and 255
    ),
  constraint crm_campaign_mappings_name_check
    check (
      external_campaign_name is null
      or char_length(trim(external_campaign_name)) between 1 and 500
    ),
  constraint crm_campaign_mappings_metadata_object_check
    check (jsonb_typeof(provider_metadata) = 'object'),
  constraint crm_campaign_mappings_metadata_size_check
    check (pg_column_size(provider_metadata) <= 16384),
  constraint crm_campaign_mappings_external_key
    unique (
      organization_id, provider, provider_account_id, external_campaign_id
    ),
  constraint crm_campaign_mappings_campaign_provider_key
    unique (
      organization_id, crm_campaign_id, provider, provider_account_id
    )
);

create index crm_campaign_mappings_campaign_idx
  on public.crm_campaign_mappings (organization_id, crm_campaign_id);

-- Ledger operacional sem nome, telefone, email, documentos, endereco, renda ou
-- notas. opportunity_key preserva a identidade historica se o cadastro for
-- removido por uma rotina administrativa/LGPD.
create table public.crm_opportunity_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  crm_record_id uuid,
  opportunity_key uuid not null,
  contact_id uuid,
  project_id uuid,
  product_id uuid,
  lead_source_id uuid,
  actor_type text not null default 'system',
  actor_user_id uuid
    references auth.users(id) on delete set null,
  event_type text not null,
  event_source text not null default 'system',
  channel text,
  occurred_at timestamptz not null default now(),
  idempotency_key text,
  correlation_id text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint crm_opportunity_events_record_fk
    foreign key (organization_id, crm_record_id)
    references public.crm_records(organization_id, id)
    on delete set null (crm_record_id),
  constraint crm_opportunity_events_contact_fk
    foreign key (organization_id, contact_id)
    references public.contacts(organization_id, id)
    on delete set null (contact_id),
  constraint crm_opportunity_events_project_fk
    foreign key (organization_id, project_id)
    references public.projects(organization_id, id)
    on delete set null (project_id),
  constraint crm_opportunity_events_product_fk
    foreign key (organization_id, project_id, product_id)
    references public.crm_products(organization_id, project_id, id)
    on delete set null (product_id),
  constraint crm_opportunity_events_source_fk
    foreign key (organization_id, lead_source_id)
    references public.crm_lead_sources(organization_id, id)
    on delete set null (lead_source_id),
  constraint crm_opportunity_events_record_key_check
    check (crm_record_id is null or crm_record_id = opportunity_key),
  constraint crm_opportunity_events_product_project_check
    check (product_id is null or project_id is not null),
  constraint crm_opportunity_events_actor_type_check
    check (actor_type in ('human', 'system', 'integration', 'ai')),
  constraint crm_opportunity_events_type_check
    check (
      event_type = lower(trim(event_type))
      and event_type ~ '^[a-z0-9_]+([.][a-z0-9_]+)*$'
      and char_length(event_type) between 3 and 100
    ),
  constraint crm_opportunity_events_source_check
    check (event_source in (
      'user', 'meta', 'integration', 'automation', 'system',
      'vitoria', 'migration', 'api'
    )),
  constraint crm_opportunity_events_channel_check
    check (
      channel is null
      or (channel = lower(trim(channel)) and char_length(channel) <= 80)
    ),
  constraint crm_opportunity_events_idempotency_check
    check (
      idempotency_key is null
      or (
        idempotency_key = trim(idempotency_key)
        and char_length(idempotency_key) between 3 and 255
      )
    ),
  constraint crm_opportunity_events_correlation_check
    check (
      correlation_id is null
      or (
        correlation_id = trim(correlation_id)
        and char_length(correlation_id) between 3 and 255
      )
    ),
  constraint crm_opportunity_events_data_object_check
    check (jsonb_typeof(data) = 'object'),
  constraint crm_opportunity_events_data_size_check
    check (pg_column_size(data) <= 32768)
);

create unique index crm_opportunity_events_idempotency_uidx
  on public.crm_opportunity_events (organization_id, idempotency_key)
  where idempotency_key is not null;
create index crm_opportunity_events_record_occurred_idx
  on public.crm_opportunity_events (
    organization_id, crm_record_id, occurred_at desc
  ) where crm_record_id is not null;
create index crm_opportunity_events_key_occurred_idx
  on public.crm_opportunity_events (opportunity_key, occurred_at desc);
create index crm_opportunity_events_org_type_occurred_idx
  on public.crm_opportunity_events (
    organization_id, event_type, occurred_at desc
  );
create index crm_opportunity_events_contact_occurred_idx
  on public.crm_opportunity_events (organization_id, contact_id, occurred_at desc)
  where contact_id is not null;
create index crm_opportunity_events_project_idx
  on public.crm_opportunity_events (organization_id, project_id)
  where project_id is not null;
create index crm_opportunity_events_product_idx
  on public.crm_opportunity_events (organization_id, product_id)
  where product_id is not null;
create index crm_opportunity_events_source_idx
  on public.crm_opportunity_events (organization_id, lead_source_id)
  where lead_source_id is not null;
create index crm_opportunity_events_actor_idx
  on public.crm_opportunity_events (actor_user_id)
  where actor_user_id is not null;

-- Cada linha e uma fotografia imutavel da atribuicao no momento da captacao.
-- IDs e nomes externos coexistem para que renomear uma campanha na Meta nao
-- reescreva o historico comercial.
create table public.crm_opportunity_attributions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  crm_record_id uuid,
  opportunity_key uuid not null,
  lead_source_id uuid,
  project_id uuid,
  product_id uuid,
  crm_campaign_id uuid,
  campaign_control_campaign_id uuid,
  provider text not null,
  channel text not null,
  provider_account_id text,
  external_lead_id text not null,
  meta_lead_id text,
  campaign_id text,
  campaign_name text,
  adset_id text,
  adset_name text,
  ad_id text,
  ad_name text,
  creative_id text,
  creative_name text,
  form_id text,
  form_name text,
  page_id text,
  page_name text,
  placement text,
  publisher_platform text,
  platform_position text,
  device_platform text,
  attribution_model text not null default 'source_capture',
  captured_at timestamptz not null,
  received_at timestamptz not null default now(),
  is_primary boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint crm_opportunity_attributions_record_fk
    foreign key (organization_id, crm_record_id)
    references public.crm_records(organization_id, id)
    on delete set null (crm_record_id),
  constraint crm_opportunity_attributions_source_fk
    foreign key (organization_id, lead_source_id)
    references public.crm_lead_sources(organization_id, id)
    on delete set null (lead_source_id),
  constraint crm_opportunity_attributions_project_fk
    foreign key (organization_id, project_id)
    references public.projects(organization_id, id)
    on delete set null (project_id),
  constraint crm_opportunity_attributions_product_fk
    foreign key (organization_id, project_id, product_id)
    references public.crm_products(organization_id, project_id, id)
    on delete set null (product_id),
  constraint crm_opportunity_attributions_crm_campaign_fk
    foreign key (organization_id, crm_campaign_id)
    references public.crm_campaigns(organization_id, id)
    on delete set null (crm_campaign_id),
  constraint crm_opportunity_attributions_control_campaign_fk
    foreign key (organization_id, campaign_control_campaign_id)
    references public.marketing_campaigns(organization_id, id)
    on delete set null (campaign_control_campaign_id),
  constraint crm_opportunity_attributions_record_key_check
    check (crm_record_id is null or crm_record_id = opportunity_key),
  constraint crm_opportunity_attributions_product_project_check
    check (product_id is null or project_id is not null),
  constraint crm_opportunity_attributions_provider_check
    check (
      provider = lower(trim(provider))
      and provider ~ '^[a-z0-9_-]+$'
      and char_length(provider) between 2 and 60
    ),
  constraint crm_opportunity_attributions_channel_check
    check (
      channel = lower(trim(channel))
      and channel ~ '^[a-z0-9_-]+$'
      and char_length(channel) between 2 and 80
    ),
  constraint crm_opportunity_attributions_external_lead_check
    check (
      external_lead_id = trim(external_lead_id)
      and char_length(external_lead_id) between 1 and 255
    ),
  constraint crm_opportunity_attributions_account_check
    check (
      provider_account_id is null
      or (
        provider_account_id = trim(provider_account_id)
        and char_length(provider_account_id) between 1 and 255
      )
    ),
  constraint crm_opportunity_attributions_meta_lead_check
    check (
      (
        provider = 'meta'
        and meta_lead_id is not null
        and meta_lead_id = external_lead_id
      )
      or (provider <> 'meta' and meta_lead_id is null)
    ),
  constraint crm_opportunity_attributions_model_check
    check (
      attribution_model = lower(trim(attribution_model))
      and char_length(attribution_model) between 2 and 80
    ),
  constraint crm_opportunity_attributions_metadata_object_check
    check (jsonb_typeof(metadata) = 'object'),
  constraint crm_opportunity_attributions_metadata_size_check
    check (pg_column_size(metadata) <= 32768),
  constraint crm_opportunity_attributions_external_lead_key
    unique (organization_id, provider, external_lead_id)
);

create unique index crm_opportunity_attributions_primary_uidx
  on public.crm_opportunity_attributions (opportunity_key)
  where is_primary;
create index crm_opportunity_attributions_record_idx
  on public.crm_opportunity_attributions (organization_id, crm_record_id)
  where crm_record_id is not null;
create index crm_opportunity_attributions_source_idx
  on public.crm_opportunity_attributions (organization_id, lead_source_id)
  where lead_source_id is not null;
create index crm_opportunity_attributions_project_idx
  on public.crm_opportunity_attributions (organization_id, project_id)
  where project_id is not null;
create index crm_opportunity_attributions_product_idx
  on public.crm_opportunity_attributions (organization_id, product_id)
  where product_id is not null;
create index crm_opportunity_attributions_crm_campaign_idx
  on public.crm_opportunity_attributions (organization_id, crm_campaign_id)
  where crm_campaign_id is not null;
create index crm_opportunity_attributions_control_campaign_idx
  on public.crm_opportunity_attributions (
    organization_id, campaign_control_campaign_id
  ) where campaign_control_campaign_id is not null;
create index crm_opportunity_attributions_campaign_idx
  on public.crm_opportunity_attributions (
    organization_id, provider, campaign_id, captured_at desc
  );
create index crm_opportunity_attributions_adset_idx
  on public.crm_opportunity_attributions (
    organization_id, provider, adset_id, captured_at desc
  ) where adset_id is not null;
create index crm_opportunity_attributions_ad_idx
  on public.crm_opportunity_attributions (
    organization_id, provider, ad_id, captured_at desc
  ) where ad_id is not null;
create index crm_opportunity_attributions_creative_idx
  on public.crm_opportunity_attributions (
    organization_id, provider, creative_id, captured_at desc
  ) where creative_id is not null;
create index crm_opportunity_attributions_form_idx
  on public.crm_opportunity_attributions (
    organization_id, provider, form_id, captured_at desc
  ) where form_id is not null;

-- A atribuicao e sempre uma fotografia de uma oportunidade real. O trigger
-- completa as chaves canonicas e rejeita qualquer divergencia de tenant,
-- produto, origem ou campanha antes de gravar o ledger. O primeiro snapshot
-- vira a origem primaria; captacoes posteriores permanecem vinculadas a mesma
-- oportunidade sem sobrescrever a atribuicao original.
create or replace function private.validate_crm_opportunity_attribution()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  record_row public.crm_records%rowtype;
  source_provider text;
  source_channel text;
  resolved_crm_campaign_id uuid;
  control_campaign_id uuid;
  has_primary_attribution boolean;
begin
  if public.crm_canonical_restore_active(new.organization_id) then
    return new;
  end if;

  if new.crm_record_id is null then
    raise exception 'A atribuicao deve nascer vinculada a uma oportunidade.';
  end if;

  select record.* into record_row
  from public.crm_records record
  where record.organization_id = new.organization_id
    and record.id = new.crm_record_id;

  if not found then
    raise exception 'Oportunidade canonica nao encontrada para a atribuicao.';
  end if;

  new.opportunity_key := new.crm_record_id;

  if new.project_id is null then new.project_id := record_row.project_id;
  elsif new.project_id is distinct from record_row.project_id then
    raise exception 'Empreendimento da atribuicao diverge da oportunidade.';
  end if;

  if new.product_id is null then new.product_id := record_row.product_id;
  elsif new.product_id is distinct from record_row.product_id then
    raise exception 'Produto da atribuicao diverge da oportunidade.';
  end if;

  if new.lead_source_id is null then new.lead_source_id := record_row.lead_source_id;
  elsif new.lead_source_id is distinct from record_row.lead_source_id then
    raise exception 'Fonte da atribuicao diverge da oportunidade.';
  end if;

  if new.lead_source_id is null then
    raise exception 'A oportunidade deve possuir uma fonte estruturada.';
  end if;

  select source.provider, source.channel
    into source_provider, source_channel
  from public.crm_lead_sources source
  where source.organization_id = new.organization_id
    and source.id = new.lead_source_id
    and source.active;

  if not found
     or source_provider is distinct from new.provider
     or source_channel is distinct from new.channel then
    raise exception 'Provedor ou canal diverge da fonte estruturada.';
  end if;

  if new.provider = 'meta' then
    new.meta_lead_id := new.external_lead_id;
  elsif new.meta_lead_id is not null then
    raise exception 'meta_lead_id so pode ser usado com o provedor Meta.';
  end if;

  select exists (
    select 1
    from public.crm_opportunity_attributions attribution
    where attribution.organization_id = new.organization_id
      and attribution.opportunity_key = new.opportunity_key
      and attribution.is_primary
  ) into has_primary_attribution;

  if has_primary_attribution and new.is_primary then
    raise exception 'A oportunidade ja possui uma atribuicao primaria.';
  elsif not has_primary_attribution then
    new.is_primary := true;
  end if;

  if new.campaign_id is not null and new.provider_account_id is not null then
    select
      mapping.crm_campaign_id,
      campaign.marketing_campaign_id
    into
      resolved_crm_campaign_id,
      control_campaign_id
    from public.crm_campaign_mappings mapping
    join public.crm_campaigns campaign
      on campaign.organization_id = mapping.organization_id
     and campaign.id = mapping.crm_campaign_id
    where mapping.organization_id = new.organization_id
      and mapping.provider = new.provider
      and mapping.provider_account_id = new.provider_account_id
      and mapping.external_campaign_id = new.campaign_id;

    if resolved_crm_campaign_id is not null then
      if new.crm_campaign_id is null then
        new.crm_campaign_id := resolved_crm_campaign_id;
      elsif new.crm_campaign_id is distinct from resolved_crm_campaign_id then
        raise exception 'Campanha CRM diverge do mapeamento externo.';
      end if;
    elsif new.crm_campaign_id is not null then
      raise exception 'Campanha CRM informada nao possui mapeamento externo.';
    end if;

    if new.campaign_control_campaign_id is null then
      new.campaign_control_campaign_id := control_campaign_id;
    elsif new.campaign_control_campaign_id is distinct from control_campaign_id then
      raise exception 'Campanha do Campaign Control diverge da ponte CRM.';
    end if;
  elsif new.crm_campaign_id is not null
        or new.campaign_control_campaign_id is not null then
    raise exception 'Campanha interna exige campaign_id e conta do provedor.';
  end if;

  return new;
end
$function$;

revoke all on function private.validate_crm_opportunity_attribution()
  from public, anon, authenticated;

create trigger crm_opportunity_attributions_validate_insert
before insert on public.crm_opportunity_attributions
for each row execute function private.validate_crm_opportunity_attribution();

create or replace function private.touch_crm_canonical_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := now();
  return new;
end
$function$;

revoke all on function private.touch_crm_canonical_updated_at()
  from public, anon, authenticated;

create trigger crm_products_touch_updated_at
before update on public.crm_products
for each row execute function private.touch_crm_canonical_updated_at();

create trigger crm_lead_sources_touch_updated_at
before update on public.crm_lead_sources
for each row execute function private.touch_crm_canonical_updated_at();

create trigger crm_contact_identities_touch_updated_at
before update on public.crm_contact_identities
for each row execute function private.touch_crm_canonical_updated_at();

create trigger crm_campaign_mappings_touch_updated_at
before update on public.crm_campaign_mappings
for each row execute function private.touch_crm_canonical_updated_at();

-- Produto e origem do piloto sao resolvidos por codigo, nunca por UUID fixo.
insert into public.crm_products (
  organization_id, project_id, code, name, product_type, description, metadata
)
select
  project.organization_id,
  project.id,
  'LOTES_RESIDENCIAIS',
  'Lotes residenciais',
  'lote_residencial',
  'Familia comercial de lotes residenciais do empreendimento Solaris.',
  jsonb_build_object('pilot', 'solaris_meta_instant_form')
from public.projects project
where project.active
  and upper(project.code) = 'SOL'
on conflict (organization_id, project_id, code) do nothing;

insert into public.crm_lead_sources (
  organization_id, code, name, provider, channel, manual_selectable, metadata
)
select distinct
  project.organization_id,
  'META_INSTANT_FORM',
  'Meta Lead Ads - Formulario Instantaneo',
  'meta',
  'meta_lead_ads',
  false,
  jsonb_build_object('pilot', 'solaris_meta_instant_form')
from public.projects project
where project.active
  and upper(project.code) = 'SOL'
on conflict (organization_id, code) do nothing;

-- O piloto possui uma unica familia de produto conhecida. O backfill nao cria
-- contatos, nao mescla pessoas e nao inventa atribuicao de midia no legado.
update public.crm_inventory_units inventory
set product_id = product.id
from public.crm_products product
where inventory.organization_id = product.organization_id
  and inventory.project_id = product.project_id
  and product.code = 'LOTES_RESIDENCIAIS'
  and inventory.product_id is null;

update public.crm_records record
set product_id = product.id
from public.crm_products product
where record.organization_id = product.organization_id
  and record.project_id = product.project_id
  and product.code = 'LOTES_RESIDENCIAIS'
  and record.product_id is null;

-- Telefones legados sao registrados apenas como phone; a migracao nao afirma
-- que eles possuem WhatsApp. Duplicidades entre contatos sao preservadas.
with normalized_phone as (
  select
    contact.id,
    contact.organization_id,
    contact.phone,
    regexp_replace(contact.phone, '[^0-9]', '', 'g') as digits
  from public.contacts contact
  where nullif(trim(contact.phone), '') is not null
), valid_phone as (
  select
    id,
    organization_id,
    case
      when digits ~ '^55[1-9][0-9]{9,10}$' then '+' || digits
      when digits ~ '^[1-9][0-9]{9,10}$' then '+55' || digits
      else null
    end as normalized_value
  from normalized_phone
)
insert into public.crm_contact_identities (
  organization_id, contact_id, identity_type, normalized_value,
  source, metadata
)
select
  valid_phone.organization_id,
  valid_phone.id,
  'phone',
  valid_phone.normalized_value,
  'migration',
  jsonb_build_object('legacy_field', 'contacts.phone')
from valid_phone
where valid_phone.normalized_value is not null
on conflict (
  organization_id, contact_id, identity_type, normalized_value
) do nothing;

insert into public.crm_contact_identities (
  organization_id, contact_id, identity_type, normalized_value,
  source, metadata
)
select
  contact.organization_id,
  contact.id,
  'email',
  lower(trim(contact.email)),
  'migration',
  jsonb_build_object('legacy_field', 'contacts.email')
from public.contacts contact
where nullif(trim(contact.email), '') is not null
  and position('@' in contact.email) > 1
on conflict (
  organization_id, contact_id, identity_type, normalized_value
) do nothing;

-- O canal/origem operacional continua visivel com crm.view. IDs externos,
-- nomes e snapshots de campanha/anuncio ficam separados por esta permissao
-- para papeis comerciais e de marketing.
insert into public.role_permissions (
  organization_id, role, permission_key, allowed, updated_at
)
select organization.id, permission.role, permission.permission_key, true, now()
from public.organizations organization
cross join (values
  ('admin', 'crm.attribution.view'),
  ('diretoria', 'crm.attribution.view'),
  ('gestor_crm', 'crm.attribution.view'),
  ('marketing', 'crm.attribution.view'),
  ('comercial', 'crm.attribution.view'),
  ('sdr', 'crm.attribution.view'),
  ('corretor', 'crm.attribution.view')
) as permission(role, permission_key)
where organization.active
on conflict (organization_id, role, permission_key) do nothing;

insert into public.role_permissions (
  organization_id, role, permission_key, allowed, updated_at
)
select organization.id, permission.role, permission.permission_key, true, now()
from public.organizations organization
cross join (values
  ('admin', 'crm.integrations.manage'),
  ('diretoria', 'crm.integrations.manage'),
  ('gestor_crm', 'crm.integrations.manage'),
  ('marketing', 'crm.integrations.manage'),
  ('admin', 'crm.copilot.use'),
  ('diretoria', 'crm.copilot.use'),
  ('gestor_crm', 'crm.copilot.use'),
  ('comercial', 'crm.copilot.use'),
  ('sdr', 'crm.copilot.use'),
  ('corretor', 'crm.copilot.use'),
  ('admin', 'crm.copilot.approve_send'),
  ('diretoria', 'crm.copilot.approve_send'),
  ('gestor_crm', 'crm.copilot.approve_send'),
  ('comercial', 'crm.copilot.approve_send'),
  ('sdr', 'crm.copilot.approve_send'),
  ('corretor', 'crm.copilot.approve_send')
) as permission(role, permission_key)
where organization.active
on conflict (organization_id, role, permission_key) do nothing;

create or replace function private.capture_crm_opportunity_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  source_name text;
  actor_name text;
  type_name text;
  change_data jsonb;
  correlation_value text;
begin
  if public.crm_canonical_restore_active(
    case when tg_op = 'DELETE' then old.organization_id else new.organization_id end
  ) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  source_name := coalesce(
    nullif(current_setting('app.crm_event_source', true), ''),
    case when auth.uid() is null then 'system' else 'user' end
  );
  if source_name not in (
    'user', 'meta', 'integration', 'automation', 'system',
    'vitoria', 'migration', 'api'
  ) then
    source_name := 'system';
  end if;
  actor_name := case
    when source_name = 'user' then 'human'
    when source_name = 'vitoria' then 'ai'
    when source_name in ('meta', 'integration', 'api') then 'integration'
    else 'system'
  end;
  correlation_value := nullif(
    current_setting('app.correlation_id', true), ''
  );

  if tg_op = 'INSERT' then
    insert into public.crm_opportunity_events (
      organization_id, crm_record_id, opportunity_key, contact_id,
      project_id, product_id, lead_source_id, actor_type, actor_user_id,
      event_type, event_source, channel, occurred_at, idempotency_key,
      correlation_id, data
    ) values (
      new.organization_id, new.id, new.id, new.contact_id,
      new.project_id, new.product_id, new.lead_source_id,
      actor_name, auth.uid(), 'opportunity.created', source_name,
      lower(trim(new.source_channel)),
      coalesce(new.originated_at, new.created_at, now()),
      'crm_record:' || new.id::text || ':created', correlation_value,
      jsonb_strip_nulls(jsonb_build_object(
        'stage', new.stage,
        'stage_id', new.stage_id,
        'record_status', new.record_status,
        'campaign_linked', new.campaign_id is not null,
        'owner_user_id', new.owner_user_id,
        'sdr_user_id', new.sdr_user_id,
        'broker_user_id', new.broker_user_id,
        'lead_score', new.lead_score,
        'temperature', new.temperature,
        'priority', new.priority,
        'sla_due_at', new.sla_due_at,
        'next_action_at', new.next_action_at
      ))
    );
    return new;
  end if;

  if tg_op = 'DELETE' then
    insert into public.crm_opportunity_events (
      organization_id, crm_record_id, opportunity_key, contact_id,
      project_id, product_id, lead_source_id, actor_type, actor_user_id,
      event_type, event_source, channel, occurred_at, idempotency_key,
      correlation_id, data
    ) values (
      old.organization_id, old.id, old.id, old.contact_id,
      old.project_id, old.product_id, old.lead_source_id,
      actor_name, auth.uid(), 'opportunity.deleted', source_name,
      lower(trim(old.source_channel)), now(),
      'crm_record:' || old.id::text || ':deleted', correlation_value,
      jsonb_strip_nulls(jsonb_build_object(
        'stage', old.stage,
        'stage_id', old.stage_id,
        'record_status', old.record_status
      ))
    );
    return old;
  end if;

  change_data := jsonb_strip_nulls(jsonb_build_object(
    'contact_id', case when old.contact_id is distinct from new.contact_id
      then jsonb_build_object('old', old.contact_id, 'new', new.contact_id) end,
    'project_id', case when old.project_id is distinct from new.project_id
      then jsonb_build_object('old', old.project_id, 'new', new.project_id) end,
    'product_id', case when old.product_id is distinct from new.product_id
      then jsonb_build_object('old', old.product_id, 'new', new.product_id) end,
    'lead_source_id', case when old.lead_source_id is distinct from new.lead_source_id
      then jsonb_build_object('old', old.lead_source_id, 'new', new.lead_source_id) end,
    'campaign_assignment', case when old.campaign_id is distinct from new.campaign_id
      then jsonb_build_object(
        'changed', true,
        'new_value_present', new.campaign_id is not null
      ) end,
    'stage', case when old.stage is distinct from new.stage
      then jsonb_build_object('old', old.stage, 'new', new.stage) end,
    'stage_id', case when old.stage_id is distinct from new.stage_id
      then jsonb_build_object('old', old.stage_id, 'new', new.stage_id) end,
    'record_status', case when old.record_status is distinct from new.record_status
      then jsonb_build_object('old', old.record_status, 'new', new.record_status) end,
    'owner_user_id', case when old.owner_user_id is distinct from new.owner_user_id
      then jsonb_build_object('old', old.owner_user_id, 'new', new.owner_user_id) end,
    'sdr_user_id', case when old.sdr_user_id is distinct from new.sdr_user_id
      then jsonb_build_object('old', old.sdr_user_id, 'new', new.sdr_user_id) end,
    'broker_user_id', case when old.broker_user_id is distinct from new.broker_user_id
      then jsonb_build_object('old', old.broker_user_id, 'new', new.broker_user_id) end,
    'lead_score', case when old.lead_score is distinct from new.lead_score
      then jsonb_build_object('old', old.lead_score, 'new', new.lead_score) end,
    'temperature', case when old.temperature is distinct from new.temperature
      then jsonb_build_object('old', old.temperature, 'new', new.temperature) end,
    'priority', case when old.priority is distinct from new.priority
      then jsonb_build_object('old', old.priority, 'new', new.priority) end,
    'sla_due_at', case when old.sla_due_at is distinct from new.sla_due_at
      then jsonb_build_object('old', old.sla_due_at, 'new', new.sla_due_at) end,
    'first_response_at', case when old.first_response_at is distinct from new.first_response_at
      then jsonb_build_object('old', old.first_response_at, 'new', new.first_response_at) end,
    'next_action_at', case when old.next_action_at is distinct from new.next_action_at
      then jsonb_build_object('old', old.next_action_at, 'new', new.next_action_at) end,
    'lost_reason', case when old.lost_reason is distinct from new.lost_reason
      then jsonb_build_object(
        'changed', true,
        'new_value_present', new.lost_reason is not null
      ) end,
    'estimated_value', case when old.estimated_value is distinct from new.estimated_value
      then jsonb_build_object('old', old.estimated_value, 'new', new.estimated_value) end,
    'probability', case when old.probability is distinct from new.probability
      then jsonb_build_object('old', old.probability, 'new', new.probability) end,
    'converted_at', case when old.converted_at is distinct from new.converted_at
      then jsonb_build_object('old', old.converted_at, 'new', new.converted_at) end
  ));

  if change_data = '{}'::jsonb then
    return new;
  end if;

  type_name := case
    when old.record_status is distinct from new.record_status
         and new.record_status = 'ganha' then 'opportunity.won'
    when old.record_status is distinct from new.record_status
         and new.record_status = 'perdida' then 'opportunity.lost'
    when old.first_response_at is distinct from new.first_response_at
         and new.first_response_at is not null then 'lead.first_contacted'
    when old.stage is distinct from new.stage
         or old.stage_id is distinct from new.stage_id
      then 'opportunity.stage_changed'
    when old.owner_user_id is distinct from new.owner_user_id
         or old.sdr_user_id is distinct from new.sdr_user_id
         or old.broker_user_id is distinct from new.broker_user_id
      then 'opportunity.assignment_changed'
    when old.lead_score is distinct from new.lead_score
         or old.temperature is distinct from new.temperature
         or old.priority is distinct from new.priority
      then 'opportunity.qualification_changed'
    when old.next_action_at is distinct from new.next_action_at
         or old.sla_due_at is distinct from new.sla_due_at
      then 'opportunity.follow_up_changed'
    else 'opportunity.updated'
  end;

  insert into public.crm_opportunity_events (
    organization_id, crm_record_id, opportunity_key, contact_id,
    project_id, product_id, lead_source_id, actor_type, actor_user_id,
    event_type, event_source, channel, occurred_at, correlation_id, data
  ) values (
    new.organization_id, new.id, new.id, new.contact_id,
    new.project_id, new.product_id, new.lead_source_id,
    actor_name, auth.uid(), type_name, source_name,
    lower(trim(new.source_channel)), now(), correlation_value, change_data
  );
  return new;
end
$function$;

revoke all on function private.capture_crm_opportunity_event()
  from public, anon, authenticated;

create trigger crm_records_capture_opportunity_insert
after insert on public.crm_records
for each row execute function private.capture_crm_opportunity_event();

create trigger crm_records_capture_opportunity_update
after update of
  contact_id, project_id, product_id, lead_source_id, campaign_id,
  stage, stage_id, record_status, owner_user_id,
  sdr_user_id, broker_user_id, lead_score, temperature, priority,
  sla_due_at, first_response_at, next_action_at, lost_reason,
  estimated_value, probability, converted_at
on public.crm_records
for each row execute function private.capture_crm_opportunity_event();

create trigger crm_records_capture_opportunity_delete
before delete on public.crm_records
for each row execute function private.capture_crm_opportunity_event();

create or replace function private.capture_crm_attribution_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  contact_key uuid;
  correlation_value text;
begin
  if public.crm_canonical_restore_active(new.organization_id) then
    return new;
  end if;

  select record.contact_id into contact_key
  from public.crm_records record
  where record.organization_id = new.organization_id
    and record.id = new.crm_record_id;

  correlation_value := nullif(
    current_setting('app.correlation_id', true), ''
  );

  insert into public.crm_opportunity_events (
    organization_id, crm_record_id, opportunity_key, contact_id,
    project_id, product_id, lead_source_id, actor_type, actor_user_id,
    event_type, event_source, channel, occurred_at, idempotency_key,
    correlation_id, data
  ) values (
    new.organization_id, new.crm_record_id, new.opportunity_key, contact_key,
    new.project_id, new.product_id, new.lead_source_id,
    'integration', auth.uid(), 'attribution.captured',
    case when new.provider = 'meta' then 'meta' else 'integration' end,
    new.channel, new.captured_at,
    'attribution:' || new.id::text, correlation_value,
    jsonb_build_object(
      'attribution_id', new.id,
      'details_restricted', true
    )
  );
  return new;
end
$function$;

revoke all on function private.capture_crm_attribution_event()
  from public, anon, authenticated;

create trigger crm_opportunity_attributions_capture_event
after insert on public.crm_opportunity_attributions
for each row execute function private.capture_crm_attribution_event();

-- A limpeza administrativa existente opera em varias requisicoes no browser.
-- Este boundary controlado remove os novos ledgers ao final do fluxo sem
-- conceder DELETE cotidiano sobre historico/atribuicao. Catalogos so sao
-- removidos na limpeza completa.
create or replace function public.purge_crm_canonical_data(
  p_organization_id uuid,
  p_include_catalogs boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attribution_count integer;
  event_count integer;
  identity_count integer := 0;
  campaign_mapping_count integer := 0;
  product_count integer := 0;
  source_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.has_app_permission(p_organization_id, 'platform.manage') then
    raise exception 'Seu perfil nao pode limpar os dados canonicos do CRM.';
  end if;

  with removed as (
    delete from public.crm_opportunity_attributions attribution
    where attribution.organization_id = p_organization_id
    returning 1
  ) select count(*) into attribution_count from removed;

  if p_include_catalogs then
    with removed as (
      delete from public.crm_contact_identities identity
      where identity.organization_id = p_organization_id
      returning 1
    ) select count(*) into identity_count from removed;

    with removed as (
      delete from public.crm_campaign_mappings mapping
      where mapping.organization_id = p_organization_id
      returning 1
    ) select count(*) into campaign_mapping_count from removed;

    with removed as (
      delete from public.crm_products product
      where product.organization_id = p_organization_id
      returning 1
    ) select count(*) into product_count from removed;

    with removed as (
      delete from public.crm_lead_sources source
      where source.organization_id = p_organization_id
      returning 1
    ) select count(*) into source_count from removed;
  end if;

  -- Fica por ultimo: delecoes de catalogo podem acionar o ledger por meio das
  -- FKs que limpam product_id/lead_source_id de registros remanescentes.
  with removed as (
    delete from public.crm_opportunity_events event
    where event.organization_id = p_organization_id
    returning 1
  ) select count(*) into event_count from removed;

  return jsonb_build_object(
    'attributions', attribution_count,
    'events', event_count,
    'identities', identity_count,
    'campaign_mappings', campaign_mapping_count,
    'products', product_count,
    'lead_sources', source_count
  );
end
$function$;

revoke all on function public.purge_crm_canonical_data(uuid, boolean)
  from public, anon;
grant execute on function public.purge_crm_canonical_data(uuid, boolean)
  to authenticated, service_role;

-- Snapshot honesto do legado: registra o estado observado na ativacao do
-- modelo, sem inventar uma cronologia retroativa.
insert into public.crm_opportunity_events (
  organization_id, crm_record_id, opportunity_key, contact_id,
  project_id, product_id, lead_source_id, actor_type, actor_user_id,
  event_type, event_source, channel, occurred_at, idempotency_key,
  correlation_id, data
)
select
  record.organization_id,
  record.id,
  record.id,
  record.contact_id,
  record.project_id,
  record.product_id,
  record.lead_source_id,
  'system',
  null,
  'migration.snapshot',
  'migration',
  lower(trim(record.source_channel)),
  now(),
  'migration.snapshot:' || record.id::text,
  'migration-20260811153000',
  jsonb_strip_nulls(jsonb_build_object(
    'original_created_at', record.created_at,
    'stage', record.stage,
    'stage_id', record.stage_id,
    'record_status', record.record_status,
    'crm_campaign_id', record.campaign_id,
    'owner_user_id', record.owner_user_id,
    'sdr_user_id', record.sdr_user_id,
    'broker_user_id', record.broker_user_id,
    'lead_score', record.lead_score,
    'temperature', record.temperature,
    'priority', record.priority,
    'sla_due_at', record.sla_due_at,
    'next_action_at', record.next_action_at,
    'snapshot_reason', 'canonical_model_activation'
  ))
from public.crm_records record;

alter table public.crm_products enable row level security;
alter table public.crm_lead_sources enable row level security;
alter table public.crm_campaign_mappings enable row level security;
alter table public.crm_contact_identities enable row level security;
alter table public.crm_opportunity_attributions enable row level security;
alter table public.crm_opportunity_events enable row level security;

create policy crm_products_select
on public.crm_products
for select to authenticated
using (public.has_app_permission(organization_id, 'crm.view'));

create policy crm_products_insert
on public.crm_products
for insert to authenticated
with check (public.has_app_permission(organization_id, 'crm.manage'));

create policy crm_products_update
on public.crm_products
for update to authenticated
using (public.has_app_permission(organization_id, 'crm.manage'))
with check (public.has_app_permission(organization_id, 'crm.manage'));

create policy crm_products_delete
on public.crm_products
for delete to authenticated
using (public.crm_canonical_restore_active(organization_id));

create policy crm_lead_sources_select
on public.crm_lead_sources
for select to authenticated
using (public.has_app_permission(organization_id, 'crm.view'));

create policy crm_lead_sources_insert
on public.crm_lead_sources
for insert to authenticated
with check (public.has_app_permission(organization_id, 'crm.manage'));

create policy crm_lead_sources_update
on public.crm_lead_sources
for update to authenticated
using (public.has_app_permission(organization_id, 'crm.manage'))
with check (public.has_app_permission(organization_id, 'crm.manage'));

create policy crm_lead_sources_delete
on public.crm_lead_sources
for delete to authenticated
using (public.crm_canonical_restore_active(organization_id));

create policy crm_campaign_mappings_select
on public.crm_campaign_mappings
for select to authenticated
using (public.has_app_permission(organization_id, 'crm.attribution.view'));

create policy crm_campaign_mappings_insert
on public.crm_campaign_mappings
for insert to authenticated
with check (
  public.has_app_permission(organization_id, 'crm.integrations.manage')
  or public.crm_canonical_restore_active(organization_id)
);

create policy crm_campaign_mappings_update
on public.crm_campaign_mappings
for update to authenticated
using (
  public.has_app_permission(organization_id, 'crm.integrations.manage')
  or public.crm_canonical_restore_active(organization_id)
)
with check (
  public.has_app_permission(organization_id, 'crm.integrations.manage')
  or public.crm_canonical_restore_active(organization_id)
);

create policy crm_campaign_mappings_delete
on public.crm_campaign_mappings
for delete to authenticated
using (
  public.has_app_permission(organization_id, 'crm.integrations.manage')
  or public.crm_canonical_restore_active(organization_id)
);

create policy crm_contact_identities_select
on public.crm_contact_identities
for select to authenticated
using (
  public.has_app_permission(organization_id, 'crm.view')
  and (
    identity_type in ('whatsapp', 'phone', 'email')
    or public.has_app_permission(organization_id, 'crm.attribution.view')
  )
);

create policy crm_contact_identities_restore_insert
on public.crm_contact_identities
for insert to authenticated
with check (public.crm_canonical_restore_active(organization_id));

create policy crm_contact_identities_restore_update
on public.crm_contact_identities
for update to authenticated
using (public.crm_canonical_restore_active(organization_id))
with check (public.crm_canonical_restore_active(organization_id));

create policy crm_contact_identities_restore_delete
on public.crm_contact_identities
for delete to authenticated
using (public.crm_canonical_restore_active(organization_id));

create policy crm_opportunity_attributions_select
on public.crm_opportunity_attributions
for select to authenticated
using (public.has_app_permission(organization_id, 'crm.attribution.view'));

create policy crm_opportunity_attributions_restore_insert
on public.crm_opportunity_attributions
for insert to authenticated
with check (public.crm_canonical_restore_active(organization_id));

create policy crm_opportunity_attributions_restore_update
on public.crm_opportunity_attributions
for update to authenticated
using (public.crm_canonical_restore_active(organization_id))
with check (public.crm_canonical_restore_active(organization_id));

create policy crm_opportunity_attributions_restore_delete
on public.crm_opportunity_attributions
for delete to authenticated
using (public.crm_canonical_restore_active(organization_id));

create policy crm_opportunity_events_select
on public.crm_opportunity_events
for select to authenticated
using (public.has_app_permission(organization_id, 'crm.view'));

create policy crm_opportunity_events_restore_insert
on public.crm_opportunity_events
for insert to authenticated
with check (public.crm_canonical_restore_active(organization_id));

create policy crm_opportunity_events_restore_update
on public.crm_opportunity_events
for update to authenticated
using (public.crm_canonical_restore_active(organization_id))
with check (public.crm_canonical_restore_active(organization_id));

create policy crm_opportunity_events_restore_delete
on public.crm_opportunity_events
for delete to authenticated
using (public.crm_canonical_restore_active(organization_id));

revoke all on table public.crm_products
  from public, anon, authenticated;
revoke all on table public.crm_lead_sources
  from public, anon, authenticated;
revoke all on table public.crm_campaign_mappings
  from public, anon, authenticated;
revoke all on table public.crm_contact_identities
  from public, anon, authenticated;
revoke all on table public.crm_opportunity_attributions
  from public, anon, authenticated;
revoke all on table public.crm_opportunity_events
  from public, anon, authenticated;

grant select, insert, update, delete on table public.crm_products
  to authenticated;
grant select, insert, update, delete on table public.crm_lead_sources
  to authenticated;
grant select, insert, update, delete on table public.crm_campaign_mappings
  to authenticated;
grant select, insert, update, delete on table public.crm_contact_identities
  to authenticated;
grant select, insert, update, delete on table public.crm_opportunity_attributions
  to authenticated;
grant select, insert, update, delete on table public.crm_opportunity_events
  to authenticated;

grant all on table public.crm_products to service_role;
grant all on table public.crm_lead_sources to service_role;
grant all on table public.crm_campaign_mappings to service_role;
grant all on table public.crm_contact_identities to service_role;
grant select, insert on table public.crm_opportunity_attributions
  to service_role;
grant select, insert on table public.crm_opportunity_events
  to service_role;

comment on table public.crm_products is
  'Familias comerciais por empreendimento. O lote fisico permanece em crm_inventory_units.';
comment on table public.crm_lead_sources is
  'Catalogo governado de origens/canais de leads e oportunidades.';
comment on table public.crm_campaign_mappings is
  'Mapeamento restrito entre campanha CRM e identidade externa do provedor; nunca armazena tokens.';
comment on table public.crm_contact_identities is
  'Identidades normalizadas para conciliacao conservadora; valores duplicados entre pessoas sao permitidos.';
comment on table public.crm_opportunity_attributions is
  'Snapshot restrito e imutavel de lead externo, campanha, conjunto, anuncio, criativo, formulario e placement na captacao.';
comment on table public.crm_opportunity_events is
  'Historico append-only e minimizado das mudancas relevantes da jornada comercial.';
comment on column public.crm_campaigns.marketing_campaign_id is
  'Ponte explicita para a campanha gerencial correspondente no Evora Campaign Control.';
comment on column public.crm_campaign_mappings.provider_metadata is
  'Metadados nao sensiveis do provedor; tokens e segredos devem permanecer fora desta tabela.';
