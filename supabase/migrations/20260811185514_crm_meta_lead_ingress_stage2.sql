-- Evora Enterprise - Stage 2: entrada duravel e canonica de Meta Lead Ads.
--
-- Fronteiras desta migracao:
--   * contacts, crm_records e os ledgers da Stage 1 continuam canonicos;
--   * um delivery HTTP bruto e armazenado uma unica vez por SHA-256;
--   * ate 1.000 notificacoes leadgen sao materializadas em lote, sem repetir
--     o corpo bruto e sem depender do tempo da Graph API para responder a Meta;
--   * segredos e tokens nunca sao persistidos nas tabelas publicas ou privadas;
--   * o worker usa leases com fencing token para impedir conclusao stale.
--
-- Esta migracao nao cadastra page_id/form_id ficticios. Uma rota so pode ser
-- ativada depois que a pagina, formulario e owner de fallback forem definidos.

set lock_timeout = '5s';
set statement_timeout = '120s';

do $preflight$
begin
  if to_regclass('public.organizations') is null
     or to_regclass('public.organization_members') is null
     or to_regclass('public.projects') is null
     or to_regclass('public.contacts') is null
     or to_regclass('public.crm_records') is null
     or to_regclass('public.crm_products') is null
     or to_regclass('public.crm_lead_sources') is null
     or to_regclass('public.crm_pipelines') is null
     or to_regclass('public.crm_stages') is null
     or to_regclass('public.crm_teams') is null
     or to_regclass('public.crm_team_members') is null
     or to_regclass('public.crm_campaigns') is null
     or to_regclass('public.crm_campaign_mappings') is null
     or to_regclass('public.crm_contact_identities') is null
     or to_regclass('public.crm_opportunity_attributions') is null
     or to_regclass('public.crm_opportunity_events') is null
     or to_regclass('public.crm_lead_assignments') is null
     or to_regclass('public.crm_lead_assignment_events') is null
     or to_regclass('public.crm_actions') is null
     or to_regclass('public.audit_logs') is null
     or to_regprocedure('public.has_app_permission(uuid,text)') is null
     or to_regprocedure('public.audit_business_entity()') is null
     or to_regprocedure(
          'private.create_crm_assignment(uuid,text,uuid,text,timestamp with time zone,text,uuid,text,boolean)'
        ) is null
     or to_regprocedure(
          'public.purge_crm_canonical_data(uuid,boolean)'
        ) is null
     or to_regprocedure(
          'crm_private.purge_crm_canonical_data_internal(uuid,boolean)'
        ) is null then
    raise exception 'Stage 1 canonica ou boundary administrativo nao encontrado.';
  end if;

  if not exists (
    select 1
    from pg_extension extension_row
    where extension_row.extname = 'pgcrypto'
  ) or not exists (
    select 1
    from pg_extension extension_row
    where extension_row.extname = 'pg_cron'
  ) or not exists (
    select 1
    from pg_extension extension_row
    where extension_row.extname = 'pg_net'
  ) or not exists (
    select 1
    from pg_extension extension_row
    where extension_row.extname = 'supabase_vault'
  ) then
    raise exception
      'Extensoes pgcrypto, pg_cron, pg_net e Vault sao obrigatorias.';
  end if;
end
$preflight$;

create schema crm_integration_private authorization postgres;
revoke all on schema crm_integration_private
  from public, anon, authenticated, service_role;

-- Espelha exatamente a normalizacao server-side usada pelo worker. Ela cobre
-- contatos criados/editados depois do backfill Stage 1, quando phone ainda
-- pode existir apenas no cadastro principal e nao no ledger de identidades.
create or replace function crm_integration_private.normalize_phone_e164(
  p_value text,
  p_default_country_code text
)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $function$
declare
  trimmed_value text;
  digits text;
  had_international_prefix boolean;
  already_international boolean;
begin
  if p_value is null
     or p_default_country_code is null
     or p_default_country_code !~ '^[1-9][0-9]{0,2}$' then
    return null;
  end if;

  trimmed_value := trim(p_value);
  if trimmed_value = '' then
    return null;
  end if;

  had_international_prefix :=
    left(trimmed_value, 1) = '+' or left(trimmed_value, 2) = '00';
  digits := regexp_replace(trimmed_value, '[^0-9]', '', 'g');
  if left(trimmed_value, 2) = '00' then
    digits := substring(digits from 3);
  end if;

  if not had_international_prefix then
    if left(digits, 1) = '0' and char_length(digits) in (11, 12) then
      digits := substring(digits from 2);
    end if;

    already_international :=
      left(digits, char_length(p_default_country_code)) =
        p_default_country_code
      and char_length(digits) between
        char_length(p_default_country_code) + 10
        and char_length(p_default_country_code) + 11;

    if not already_international
       and char_length(digits) between 10 and 11 then
      digits := p_default_country_code || digits;
    elsif not already_international then
      return null;
    end if;
  end if;

  if digits ~ '^[0-9]{8,15}$' then
    return '+' || digits;
  end if;
  return null;
end
$function$;

revoke all on function
  crm_integration_private.normalize_phone_e164(text, text)
  from public, anon, authenticated, service_role;

-- Chave candidata necessaria para a FK composta do inbox sem abrir uma
-- referencia somente por UUID fora do tenant.
create unique index crm_opportunity_attributions_org_id_uidx
  on public.crm_opportunity_attributions (organization_id, id);

-- Configuracao nao secreta page/form -> contexto canonico. A campanha externa
-- continua sendo conciliada por crm_campaign_mappings, sem duplicar Campaign
-- Control. fallback_owner_user_id e obrigatorio em toda rota ativa: mesmo se
-- a equipe ficar vazia, o Hub nunca cria oportunidade sem owner.
create table public.crm_meta_lead_routes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  name text not null,
  page_id text not null,
  form_id text not null,
  provider_account_id text,
  project_id uuid not null,
  product_id uuid not null,
  lead_source_id uuid not null,
  pipeline_id uuid not null,
  initial_stage_id uuid not null,
  team_id uuid,
  fallback_owner_user_id uuid,
  assignment_strategy text not null default 'round_robin',
  assignment_role text not null default 'sdr',
  first_contact_sla_minutes integer not null default 60,
  default_country_calling_code text not null default '55',
  active boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_meta_lead_routes_project_fk
    foreign key (organization_id, project_id)
    references public.projects(organization_id, id) on delete cascade,
  constraint crm_meta_lead_routes_product_fk
    foreign key (organization_id, project_id, product_id)
    references public.crm_products(organization_id, project_id, id)
    on delete restrict,
  constraint crm_meta_lead_routes_source_fk
    foreign key (organization_id, lead_source_id)
    references public.crm_lead_sources(organization_id, id)
    on delete restrict,
  constraint crm_meta_lead_routes_pipeline_fk
    foreign key (organization_id, pipeline_id)
    references public.crm_pipelines(organization_id, id)
    on delete restrict,
  constraint crm_meta_lead_routes_stage_fk
    foreign key (organization_id, pipeline_id, initial_stage_id)
    references public.crm_stages(organization_id, pipeline_id, id)
    on delete restrict,
  constraint crm_meta_lead_routes_team_fk
    foreign key (organization_id, team_id)
    references public.crm_teams(organization_id, id)
    on delete set null (team_id),
  constraint crm_meta_lead_routes_fallback_fk
    foreign key (organization_id, fallback_owner_user_id)
    references public.organization_members(organization_id, user_id)
    on delete set null (fallback_owner_user_id),
  constraint crm_meta_lead_routes_org_id_key
    unique (organization_id, id),
  constraint crm_meta_lead_routes_page_form_key
    unique (page_id, form_id),
  constraint crm_meta_lead_routes_org_name_key
    unique (organization_id, name),
  constraint crm_meta_lead_routes_name_check
    check (char_length(trim(name)) between 2 and 180),
  constraint crm_meta_lead_routes_page_check
    check (
      page_id = trim(page_id)
      and page_id ~ '^[0-9]{1,64}$'
    ),
  constraint crm_meta_lead_routes_form_check
    check (
      form_id = trim(form_id)
      and form_id ~ '^[0-9]{1,64}$'
    ),
  constraint crm_meta_lead_routes_account_check
    check (
      provider_account_id is null
      or (
        provider_account_id = trim(provider_account_id)
        and provider_account_id ~ '^[0-9]{1,64}$'
      )
    ),
  constraint crm_meta_lead_routes_strategy_check
    check (assignment_strategy in (
      'round_robin', 'least_queue', 'fallback_only'
    )),
  constraint crm_meta_lead_routes_role_check
    check (assignment_role in ('sdr', 'broker')),
  constraint crm_meta_lead_routes_team_strategy_check
    check (assignment_strategy = 'fallback_only' or team_id is not null),
  constraint crm_meta_lead_routes_active_fallback_check
    check (not active or fallback_owner_user_id is not null),
  constraint crm_meta_lead_routes_sla_check
    check (first_contact_sla_minutes between 5 and 10080),
  constraint crm_meta_lead_routes_country_code_check
    check (default_country_calling_code ~ '^[1-9][0-9]{0,2}$'),
  constraint crm_meta_lead_routes_metadata_object_check
    check (jsonb_typeof(metadata) = 'object'),
  constraint crm_meta_lead_routes_metadata_size_check
    check (pg_column_size(metadata) <= 16384)
);

create index crm_meta_lead_routes_org_active_idx
  on public.crm_meta_lead_routes (organization_id, active, updated_at desc);
create index crm_meta_lead_routes_project_active_idx
  on public.crm_meta_lead_routes (organization_id, project_id, active);
create index crm_meta_lead_routes_product_fk_idx
  on public.crm_meta_lead_routes (organization_id, project_id, product_id);
create index crm_meta_lead_routes_source_fk_idx
  on public.crm_meta_lead_routes (organization_id, lead_source_id);
create index crm_meta_lead_routes_stage_fk_idx
  on public.crm_meta_lead_routes (
    organization_id, pipeline_id, initial_stage_id
  );
create index crm_meta_lead_routes_team_fk_idx
  on public.crm_meta_lead_routes (organization_id, team_id)
  where team_id is not null;
create index crm_meta_lead_routes_fallback_fk_idx
  on public.crm_meta_lead_routes (
    organization_id, fallback_owner_user_id
  ) where fallback_owner_user_id is not null;

create or replace function crm_integration_private.validate_meta_lead_route()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  source_row public.crm_lead_sources%rowtype;
  route_team_type text;
begin
  new.name := trim(new.name);
  new.page_id := trim(new.page_id);
  new.form_id := trim(new.form_id);
  new.provider_account_id := nullif(
    regexp_replace(
      trim(new.provider_account_id),
      '^act_',
      '',
      'i'
    ),
    ''
  );
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  if tg_op = 'INSERT' then
    -- No Data API, autoria sempre vem do JWT e nao de UUID fornecido pelo
    -- cliente. Restore/server sem JWT ainda consegue preservar a autoria.
    new.created_by := coalesce(auth.uid(), new.created_by);
  end if;

  if tg_op = 'UPDATE'
     and row(
       new.organization_id,
       new.page_id,
       new.form_id,
       new.provider_account_id,
       new.project_id,
       new.product_id,
       new.lead_source_id,
       new.pipeline_id,
       new.initial_stage_id
     ) is distinct from row(
       old.organization_id,
       old.page_id,
       old.form_id,
       old.provider_account_id,
       old.project_id,
       old.product_id,
       old.lead_source_id,
       old.pipeline_id,
       old.initial_stage_id
     )
     and exists (
       select 1
       from crm_integration_private.integration_inbox_events inbox
       where inbox.organization_id = old.organization_id
         and inbox.route_id = old.id
         and inbox.status in ('pending', 'retry', 'processing')
     ) then
    raise exception
      'Nao altere o destino estrutural enquanto a rota possui eventos em aberto.';
  end if;

  if jsonb_path_exists(
       new.metadata,
       '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^(token|secret|password|authorization|cookie|app_secret|access_token)$" flag "i")'
     ) then
    raise exception 'Metadata da rota nao pode persistir segredos.';
  end if;

  -- Uma rota sempre pode ser desativada, inclusive depois que algum catalogo
  -- externo ficou inativo. Dependencias operacionais sao exigidas somente
  -- para NEW.active=true; as FKs compostas continuam garantindo coerencia.
  if new.active then
    select source.* into source_row
    from public.crm_lead_sources source
    where source.organization_id = new.organization_id
      and source.id = new.lead_source_id;

    if not found
       or source_row.provider <> 'meta'
       or source_row.channel <> 'meta_lead_ads'
       or source_row.manual_selectable
       or not source_row.active then
      raise exception
        'Rota ativa exige fonte ativa META/meta_lead_ads de integracao.';
    end if;

    if not exists (
      select 1
      from public.projects project
      where project.organization_id = new.organization_id
        and project.id = new.project_id
        and project.active
    ) or not exists (
      select 1
      from public.crm_products product
      where product.organization_id = new.organization_id
        and product.project_id = new.project_id
        and product.id = new.product_id
        and product.active
    ) then
      raise exception 'Empreendimento ou produto da rota esta inativo.';
    end if;

    if not exists (
      select 1
      from public.crm_pipelines pipeline
      join public.crm_stages stage
        on stage.organization_id = pipeline.organization_id
       and stage.pipeline_id = pipeline.id
      where pipeline.organization_id = new.organization_id
        and pipeline.id = new.pipeline_id
        and pipeline.active
        and stage.id = new.initial_stage_id
        and stage.active
        and not stage.is_won
        and not stage.is_lost
    ) then
      raise exception 'Pipeline ou etapa inicial da rota esta inativa/invalida.';
    end if;

    if new.team_id is not null then
      select lower(team.team_type) into route_team_type
      from public.crm_teams team
      where team.organization_id = new.organization_id
        and team.id = new.team_id
        and team.active;

      if not found then
        raise exception 'Equipe comercial da rota esta inativa.';
      end if;

      if (new.assignment_role = 'sdr' and route_team_type not in (
            'sdr', 'pre_vendas', 'pre-vendas'
          ))
         or (new.assignment_role = 'broker' and route_team_type not in (
            'corretor', 'corretores', 'vendas', 'comercial'
          )) then
        raise exception 'Tipo da equipe diverge do papel comercial da rota.';
      end if;
    end if;

    if not exists (
      select 1
      from public.organization_members member
      where member.organization_id = new.organization_id
        and member.user_id = new.fallback_owner_user_id
        and member.active
    ) then
      raise exception 'Rota ativa exige owner de fallback ativo.';
    end if;
  end if;

  return new;
end
$function$;

revoke all on function
  crm_integration_private.validate_meta_lead_route()
  from public, anon, authenticated, service_role;

create trigger crm_meta_lead_routes_validate
before insert or update on public.crm_meta_lead_routes
for each row execute function
  crm_integration_private.validate_meta_lead_route();

-- Configuracao nao secreta entra no ledger corporativo existente. Payloads
-- de webhook nunca passam por este trigger/tabela publica.
create trigger crm_meta_lead_routes_audit
after insert or update or delete on public.crm_meta_lead_routes
for each row execute function public.audit_business_entity();

-- Delivery HTTP bruto: privado, deduplicado pelo SHA-256 dos bytes exatos e
-- purgado apos 90 dias. request_headers recebe apenas allowlist sanitizada no
-- gateway; Authorization/Cookie sao rejeitados pela RPC.
create table crm_integration_private.integration_webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'meta',
  raw_body_sha256 text not null,
  raw_body jsonb not null,
  request_headers jsonb not null default '{}'::jsonb,
  signature_verified boolean not null,
  signature_algorithm text not null default 'hmac-sha256',
  correlation_id text not null,
  first_received_at timestamptz not null,
  last_received_at timestamptz not null,
  delivery_count integer not null default 1,
  raw_retention_until timestamptz not null,
  raw_purged_at timestamptz,
  created_at timestamptz not null default now(),
  constraint integration_webhook_deliveries_provider_check
    check (provider = 'meta'),
  constraint integration_webhook_deliveries_sha_check
    check (raw_body_sha256 ~ '^[a-f0-9]{64}$'),
  constraint integration_webhook_deliveries_raw_object_check
    check (jsonb_typeof(raw_body) = 'object'),
  constraint integration_webhook_deliveries_raw_size_check
    check (pg_column_size(raw_body) <= 4194304),
  constraint integration_webhook_deliveries_headers_object_check
    check (jsonb_typeof(request_headers) = 'object'),
  constraint integration_webhook_deliveries_headers_size_check
    check (pg_column_size(request_headers) <= 16384),
  constraint integration_webhook_deliveries_signature_check
    check (signature_verified),
  constraint integration_webhook_deliveries_correlation_check
    check (
      correlation_id = trim(correlation_id)
      and char_length(correlation_id) between 3 and 255
    ),
  constraint integration_webhook_deliveries_count_check
    check (delivery_count >= 1),
  constraint integration_webhook_deliveries_provider_sha_key
    unique (provider, raw_body_sha256)
);

create index integration_webhook_deliveries_retention_idx
  on crm_integration_private.integration_webhook_deliveries (
    raw_retention_until
  ) where raw_purged_at is null;

-- Inbox duravel por leadgen. O payload completo fetched da Graph API vive aqui
-- somente durante a retencao. O estado operacional e os hashes permanecem
-- depois da minimizacao para auditoria e idempotencia.
create table crm_integration_private.integration_inbox_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'meta',
  organization_id uuid
    references public.organizations(id) on delete cascade,
  route_id uuid,
  first_delivery_id uuid not null
    references crm_integration_private.integration_webhook_deliveries(id)
    on delete restrict,
  last_delivery_id uuid not null
    references crm_integration_private.integration_webhook_deliveries(id)
    on delete restrict,
  event_key text not null,
  external_lead_id text not null,
  meta_lead_id text not null,
  page_id text not null,
  form_id text,
  event_occurred_at timestamptz not null,
  first_received_at timestamptz not null,
  last_received_at timestamptz not null,
  event_payload jsonb not null default '{}'::jsonb,
  event_payload_sha256 text not null,
  lead_payload jsonb,
  lead_payload_sha256 text,
  raw_retention_until timestamptz not null,
  raw_purged_at timestamptz,
  correlation_id text not null,
  status text not null default 'unmapped',
  delivery_count integer not null default 1,
  attempt_count integer not null default 0,
  max_attempts integer not null default 8,
  attempts_per_cycle integer not null default 8,
  requeue_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lock_token uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_message text,
  last_error_details jsonb not null default '{}'::jsonb,
  last_error_at timestamptz,
  contact_id uuid,
  crm_record_id uuid,
  attribution_id uuid,
  owner_user_id uuid,
  outcome text,
  contact_match text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint integration_inbox_events_route_fk
    foreign key (organization_id, route_id)
    references public.crm_meta_lead_routes(organization_id, id)
    on delete restrict,
  constraint integration_inbox_events_contact_fk
    foreign key (organization_id, contact_id)
    references public.contacts(organization_id, id)
    on delete set null (contact_id),
  constraint integration_inbox_events_record_fk
    foreign key (organization_id, crm_record_id)
    references public.crm_records(organization_id, id)
    on delete set null (crm_record_id),
  constraint integration_inbox_events_attribution_fk
    foreign key (organization_id, attribution_id)
    references public.crm_opportunity_attributions(organization_id, id)
    on delete set null (attribution_id),
  constraint integration_inbox_events_owner_fk
    foreign key (organization_id, owner_user_id)
    references public.organization_members(organization_id, user_id)
    on delete set null (owner_user_id),
  constraint integration_inbox_events_provider_check
    check (provider = 'meta'),
  constraint integration_inbox_events_route_org_check
    check (route_id is null or organization_id is not null),
  constraint integration_inbox_events_external_check
    check (
      external_lead_id = trim(external_lead_id)
      and char_length(external_lead_id) between 1 and 255
      and meta_lead_id = external_lead_id
    ),
  constraint integration_inbox_events_key_check
    check (
      event_key = trim(event_key)
      and char_length(event_key) between 1 and 255
    ),
  constraint integration_inbox_events_page_check
    check (page_id ~ '^[0-9]{1,64}$'),
  constraint integration_inbox_events_form_check
    check (form_id is null or form_id ~ '^[0-9]{1,64}$'),
  constraint integration_inbox_events_event_payload_object_check
    check (jsonb_typeof(event_payload) = 'object'),
  constraint integration_inbox_events_event_payload_size_check
    check (pg_column_size(event_payload) <= 32768),
  constraint integration_inbox_events_event_sha_check
    check (event_payload_sha256 ~ '^[a-f0-9]{64}$'),
  constraint integration_inbox_events_lead_payload_check
    check (
      lead_payload is null
      or (
        jsonb_typeof(lead_payload) = 'object'
        and pg_column_size(lead_payload) <= 524288
      )
    ),
  constraint integration_inbox_events_lead_sha_check
    check (
      lead_payload_sha256 is null
      or lead_payload_sha256 ~ '^[a-f0-9]{64}$'
    ),
  constraint integration_inbox_events_status_check
    check (status in (
      'unmapped', 'pending', 'processing', 'retry',
      'processed', 'dead_letter'
    )),
  constraint integration_inbox_events_delivery_count_check
    check (delivery_count >= 1),
  constraint integration_inbox_events_attempt_check
    check (
      attempt_count between 0 and 100
      and max_attempts between 1 and 100
      and attempts_per_cycle between 1 and 20
      and requeue_count between 0 and 100
    ),
  constraint integration_inbox_events_lease_check
    check (
      status <> 'processing'
      or (
        lock_token is not null
        and lease_owner is not null
        and lease_expires_at is not null
      )
    ),
  constraint integration_inbox_events_error_details_check
    check (
      jsonb_typeof(last_error_details) = 'object'
      and pg_column_size(last_error_details) <= 16384
    ),
  constraint integration_inbox_events_provider_lead_key
    unique (provider, external_lead_id)
);

create index integration_inbox_events_ready_idx
  on crm_integration_private.integration_inbox_events (
    next_attempt_at, first_received_at, id
  ) where status in ('pending', 'retry');
create index integration_inbox_events_expired_lease_idx
  on crm_integration_private.integration_inbox_events (
    lease_expires_at, first_received_at, id
  ) where status = 'processing';
create index integration_inbox_events_unmapped_idx
  on crm_integration_private.integration_inbox_events (
    page_id, form_id, first_received_at
  ) where status = 'unmapped';
create index integration_inbox_events_org_status_idx
  on crm_integration_private.integration_inbox_events (
    organization_id, status, first_received_at desc
  ) where organization_id is not null;
create index integration_inbox_events_route_fk_idx
  on crm_integration_private.integration_inbox_events (
    organization_id, route_id
  ) where route_id is not null;
create index integration_inbox_events_contact_fk_idx
  on crm_integration_private.integration_inbox_events (
    organization_id, contact_id
  ) where contact_id is not null;
create index integration_inbox_events_record_fk_idx
  on crm_integration_private.integration_inbox_events (
    organization_id, crm_record_id
  ) where crm_record_id is not null;
create index integration_inbox_events_attribution_fk_idx
  on crm_integration_private.integration_inbox_events (
    organization_id, attribution_id
  ) where attribution_id is not null;
create index integration_inbox_events_owner_fk_idx
  on crm_integration_private.integration_inbox_events (
    organization_id, owner_user_id
  ) where owner_user_id is not null;
create index integration_inbox_events_first_delivery_fk_idx
  on crm_integration_private.integration_inbox_events (first_delivery_id);
create index integration_inbox_events_last_delivery_fk_idx
  on crm_integration_private.integration_inbox_events (last_delivery_id);
create index integration_inbox_events_retention_idx
  on crm_integration_private.integration_inbox_events (
    raw_retention_until
  ) where raw_purged_at is null;

create table crm_integration_private.integration_inbox_transitions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null
    references crm_integration_private.integration_inbox_events(id)
    on delete cascade,
  organization_id uuid
    references public.organizations(id) on delete cascade,
  attempt_number integer not null,
  transition text not null,
  worker_id text,
  lock_token uuid,
  error_code text,
  error_message text,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  constraint integration_inbox_transitions_attempt_check
    check (attempt_number between 0 and 100),
  constraint integration_inbox_transitions_type_check
    check (transition in (
      'enqueued', 'mapped', 'claimed', 'processed',
      'retry_scheduled', 'dead_lettered', 'requeued'
    )),
  constraint integration_inbox_transitions_details_check
    check (
      jsonb_typeof(details) = 'object'
      and pg_column_size(details) <= 16384
    ),
  constraint integration_inbox_transitions_event_attempt_key
    unique (event_id, attempt_number, transition)
);

create index integration_inbox_transitions_event_idx
  on crm_integration_private.integration_inbox_transitions (
    event_id, occurred_at desc
  );
create index integration_inbox_transitions_org_idx
  on crm_integration_private.integration_inbox_transitions (
    organization_id, occurred_at desc
  ) where organization_id is not null;

alter table crm_integration_private.integration_webhook_deliveries
  enable row level security;
alter table crm_integration_private.integration_inbox_events
  enable row level security;
alter table crm_integration_private.integration_inbox_transitions
  enable row level security;

revoke all on all tables in schema crm_integration_private
  from public, anon, authenticated, service_role;

-- Uma unica chamada por POST da Meta. O corpo bruto e deduplicado; os itens
-- leadgen sao validados e gravados set-based na mesma transacao. O gateway so
-- deve devolver 2xx a Meta depois que esta RPC confirmar o commit.
create or replace function public.enqueue_meta_lead_delivery(
  p_raw_body_sha256 text,
  p_raw_body jsonb,
  p_request_headers jsonb,
  p_signature_verified boolean,
  p_events jsonb,
  p_correlation_id text default null,
  p_received_at timestamptz default now(),
  p_max_attempts integer default 8
)
returns table (
  delivery_id uuid,
  total_events integer,
  inserted_events integer,
  duplicate_events integer,
  mapped_events integer,
  unmapped_events integer,
  correlation_id text
)
language plpgsql
security definer
set search_path = ''
as $function$
#variable_conflict use_column
declare
  delivery_row
    crm_integration_private.integration_webhook_deliveries%rowtype;
  correlation_value text;
  total_count integer;
  inserted_count integer;
  mapped_count integer;
  route_snapshot jsonb := '[]'::jsonb;
begin
  if not p_signature_verified then
    raise exception 'META_SIGNATURE_INVALID';
  end if;

  if p_raw_body_sha256 is null
     or p_raw_body_sha256 <> lower(trim(p_raw_body_sha256))
     or p_raw_body_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'META_RAW_SHA256_INVALID';
  end if;

  if p_raw_body is null
     or jsonb_typeof(p_raw_body) <> 'object'
     or pg_column_size(p_raw_body) > 4194304 then
    raise exception 'META_RAW_BODY_INVALID';
  end if;

  if p_request_headers is null
     or jsonb_typeof(p_request_headers) <> 'object'
     or pg_column_size(p_request_headers) > 16384 then
    raise exception 'META_HEADERS_INVALID';
  end if;

  -- O Hub envia somente esta allowlist. Cookie, Authorization, apikey e
  -- qualquer header inesperado nunca chegam ao armazenamento de auditoria.
  if exists (
    select 1
    from jsonb_object_keys(p_request_headers) as header_name(value)
    where lower(header_name.value) not in (
      'content-type', 'user-agent', 'x-hub-signature-256'
    )
  ) then
    raise exception 'META_HEADERS_NOT_ALLOWLISTED';
  end if;

  if p_events is null
     or jsonb_typeof(p_events) <> 'array'
     or jsonb_array_length(p_events) not between 1 and 1000 then
    raise exception 'META_EVENTS_BATCH_INVALID';
  end if;

  if p_received_at is null
     or p_received_at < now() - interval '24 hours'
     or p_received_at > now() + interval '5 minutes' then
    raise exception 'META_RECEIVED_AT_INVALID';
  end if;

  if p_max_attempts not between 1 and 20 then
    raise exception 'META_MAX_ATTEMPTS_INVALID';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_events) as item(value)
    where jsonb_typeof(item.value) <> 'object'
       or nullif(trim(item.value ->> 'event_key'), '') is null
       or char_length(trim(item.value ->> 'event_key')) > 255
       or nullif(trim(item.value ->> 'meta_lead_id'), '') is null
       or char_length(trim(item.value ->> 'meta_lead_id')) > 255
       or coalesce(item.value ->> 'page_id', '') !~ '^[0-9]{1,64}$'
       or (
         nullif(trim(item.value ->> 'form_id'), '') is not null
         and trim(item.value ->> 'form_id') !~ '^[0-9]{1,64}$'
       )
       or nullif(trim(item.value ->> 'event_occurred_at'), '') is null
       or (
         item.value ? 'event_payload'
         and (
           jsonb_typeof(item.value -> 'event_payload') <> 'object'
           or pg_column_size(item.value -> 'event_payload') > 32768
         )
       )
  ) then
    raise exception 'META_EVENT_ITEM_INVALID';
  end if;

  if (
    select count(*) <> count(distinct trim(item.value ->> 'meta_lead_id'))
    from jsonb_array_elements(p_events) as item(value)
  ) then
    raise exception 'META_EVENT_BATCH_HAS_DUPLICATE_LEAD';
  end if;

  -- Forca o parse de todos os timestamps antes de qualquer escrita.
  perform (item.value ->> 'event_occurred_at')::timestamptz
  from jsonb_array_elements(p_events) as item(value);

  if exists (
    select 1
    from jsonb_array_elements(p_events) as item(value)
    where (item.value ->> 'event_occurred_at')::timestamptz
            < p_received_at - interval '90 days'
       or (item.value ->> 'event_occurred_at')::timestamptz
            > p_received_at + interval '5 minutes'
  ) then
    raise exception 'META_EVENT_OCCURRED_AT_INVALID';
  end if;

  -- Fecha a corrida entre precheck e ON CONFLICT. Locks ordenados por lead
  -- fazem duas entregas concorrentes divergentes se enxergarem antes de
  -- qualquer upsert; a segunda obrigatoriamente falha no precheck abaixo.
  perform pg_advisory_xact_lock(hashtextextended(
    'meta_lead:' || trim(item.value ->> 'meta_lead_id'),
    0
  ))
  from jsonb_array_elements(p_events) as item(value)
  order by trim(item.value ->> 'meta_lead_id');

  -- Ordem global de locks do ingresso: route -> delivery -> inbox. O snapshot
  -- vem das proprias linhas SHARE-lockadas e evita novo lookup de rota depois
  -- que o delivery ja estiver travado.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', locked_route.id,
        'organization_id', locked_route.organization_id,
        'page_id', locked_route.page_id,
        'form_id', locked_route.form_id
      ) order by locked_route.id
    ),
    '[]'::jsonb
  ) into route_snapshot
  from (
    select
      route.id, route.organization_id, route.page_id, route.form_id
    from public.crm_meta_lead_routes route
    where route.active
      and exists (
        select 1
        from jsonb_array_elements(p_events) item(value)
        where trim(item.value ->> 'page_id') = route.page_id
          and nullif(trim(item.value ->> 'form_id'), '') = route.form_id
      )
    order by route.id
    for share
  ) locked_route;

  -- Um meta_lead_id nunca pode reaparecer com pagina, formulario ou chave de
  -- evento diferentes. A divergencia e rejeitada antes do upsert para nao
  -- reatribuir silenciosamente um lead ja canonizado.
  if exists (
    select 1
    from jsonb_array_elements(p_events) as item(value)
    join crm_integration_private.integration_inbox_events inbox
      on inbox.provider = 'meta'
     and inbox.external_lead_id = trim(item.value ->> 'meta_lead_id')
    where inbox.page_id is distinct from trim(item.value ->> 'page_id')
       or inbox.form_id is distinct from
          nullif(trim(item.value ->> 'form_id'), '')
       or inbox.event_key is distinct from
          trim(item.value ->> 'event_key')
  ) then
    raise exception 'META_EVENT_IDENTITY_MISMATCH';
  end if;

  correlation_value := coalesce(
    nullif(trim(p_correlation_id), ''),
    gen_random_uuid()::text
  );
  if char_length(correlation_value) not between 3 and 255 then
    raise exception 'META_CORRELATION_ID_INVALID';
  end if;

  insert into crm_integration_private.integration_webhook_deliveries (
    provider, raw_body_sha256, raw_body, request_headers,
    signature_verified, signature_algorithm, correlation_id,
    first_received_at, last_received_at, delivery_count,
    raw_retention_until
  ) values (
    'meta', p_raw_body_sha256, p_raw_body, p_request_headers,
    true, 'hmac-sha256', correlation_value,
    p_received_at, p_received_at, 1,
    p_received_at + interval '90 days'
  )
  on conflict (provider, raw_body_sha256) do update
  set last_received_at = greatest(
        crm_integration_private.integration_webhook_deliveries.last_received_at,
        excluded.last_received_at
      ),
      delivery_count =
        crm_integration_private.integration_webhook_deliveries.delivery_count + 1
  returning * into delivery_row;

  with input_events as (
    select
      trim(item.value ->> 'event_key') as event_key,
      trim(item.value ->> 'meta_lead_id') as meta_lead_id,
      trim(item.value ->> 'page_id') as page_id,
      nullif(trim(item.value ->> 'form_id'), '') as form_id,
      (item.value ->> 'event_occurred_at')::timestamptz
        as event_occurred_at,
      coalesce(item.value -> 'event_payload', '{}'::jsonb)
        as event_payload
    from jsonb_array_elements(p_events) as item(value)
  ), routed_events as (
    select
      input_event.*,
      route.id as route_id,
      route.organization_id
    from input_events input_event
    left join jsonb_to_recordset(route_snapshot) as route(
      id uuid,
      organization_id uuid,
      page_id text,
      form_id text
    )
      on route.page_id = input_event.page_id
     and route.form_id = input_event.form_id
  ), upserted_events as (
    insert into crm_integration_private.integration_inbox_events (
      provider, organization_id, route_id,
      first_delivery_id, last_delivery_id,
      event_key, external_lead_id, meta_lead_id, page_id, form_id,
      event_occurred_at, first_received_at, last_received_at,
      event_payload, event_payload_sha256,
      raw_retention_until, correlation_id, status,
      delivery_count, attempt_count, max_attempts,
      attempts_per_cycle, next_attempt_at
    )
    select
      'meta', routed_event.organization_id, routed_event.route_id,
      delivery_row.id, delivery_row.id,
      routed_event.event_key,
      routed_event.meta_lead_id, routed_event.meta_lead_id,
      routed_event.page_id, routed_event.form_id,
      routed_event.event_occurred_at,
      p_received_at, p_received_at,
      routed_event.event_payload,
      encode(
        extensions.digest(
          convert_to(routed_event.event_payload::text, 'UTF8'),
          'sha256'
        ),
        'hex'
      ),
      p_received_at + interval '90 days', correlation_value,
      case when routed_event.route_id is null then 'unmapped'
           else 'pending' end,
      1, 0, p_max_attempts, p_max_attempts, p_received_at
    from routed_events routed_event
    on conflict (provider, external_lead_id) do update
    set last_delivery_id = excluded.last_delivery_id,
        last_received_at = greatest(
          crm_integration_private.integration_inbox_events.last_received_at,
          excluded.last_received_at
        ),
        delivery_count =
          crm_integration_private.integration_inbox_events.delivery_count + 1,
        max_attempts = greatest(
          crm_integration_private.integration_inbox_events.max_attempts,
          excluded.max_attempts
        ),
        attempts_per_cycle = greatest(
          crm_integration_private.integration_inbox_events.attempts_per_cycle,
          excluded.attempts_per_cycle
        ),
        organization_id = case
          when crm_integration_private.integration_inbox_events.status =
               'unmapped'
            then coalesce(
              excluded.organization_id,
              crm_integration_private.integration_inbox_events.organization_id
            )
          else crm_integration_private.integration_inbox_events.organization_id
        end,
        route_id = case
          when crm_integration_private.integration_inbox_events.status =
               'unmapped'
            then coalesce(
              excluded.route_id,
              crm_integration_private.integration_inbox_events.route_id
            )
          else crm_integration_private.integration_inbox_events.route_id
        end,
        status = case
          when crm_integration_private.integration_inbox_events.status =
               'unmapped'
               and excluded.route_id is not null then 'pending'
          else crm_integration_private.integration_inbox_events.status
        end,
        next_attempt_at = case
          when crm_integration_private.integration_inbox_events.status =
               'unmapped'
               and excluded.route_id is not null then now()
          else crm_integration_private.integration_inbox_events.next_attempt_at
        end,
        updated_at = now()
    returning
      id, organization_id, status, attempt_count,
      (xmax = '0'::xid) as inserted
  ), enqueue_transitions as (
    insert into crm_integration_private.integration_inbox_transitions (
      event_id, organization_id, attempt_number, transition, details
    )
    select
      upserted.id, upserted.organization_id, 0, 'enqueued',
      jsonb_build_object('payload_restricted', true)
    from upserted_events upserted
    on conflict (event_id, attempt_number, transition) do nothing
    returning event_id
  ), mapping_transitions as (
    insert into crm_integration_private.integration_inbox_transitions (
      event_id, organization_id, attempt_number, transition, details
    )
    select
      upserted.id, upserted.organization_id, 0, 'mapped',
      jsonb_build_object('route_resolved', true)
    from upserted_events upserted
    where upserted.organization_id is not null
    on conflict (event_id, attempt_number, transition) do nothing
    returning event_id
  )
  select
    count(*)::integer,
    count(*) filter (where upserted.inserted)::integer,
    count(*) filter (where upserted.organization_id is not null)::integer
  into total_count, inserted_count, mapped_count
  from upserted_events upserted;

  return query
  select
    delivery_row.id,
    total_count,
    inserted_count,
    total_count - inserted_count,
    mapped_count,
    total_count - mapped_count,
    correlation_value;
end
$function$;

revoke all on function public.enqueue_meta_lead_delivery(
  text, jsonb, jsonb, boolean, jsonb, text, timestamptz, integer
) from public, anon, authenticated;
grant execute on function public.enqueue_meta_lead_delivery(
  text, jsonb, jsonb, boolean, jsonb, text, timestamptz, integer
) to service_role;

-- Claim atomico e nao bloqueante. Um reclaim sempre gera novo lock_token;
-- portanto o worker anterior nao consegue concluir depois de perder o lease.
create or replace function public.claim_meta_lead_events(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  event_id uuid,
  lock_token uuid,
  route_id uuid,
  organization_id uuid,
  meta_lead_id text,
  page_id text,
  form_id text,
  default_country_calling_code text,
  event_occurred_at timestamptz,
  received_at timestamptz,
  event_payload jsonb,
  correlation_id text,
  attempt_count integer,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
#variable_conflict use_column
declare
  remap_route_snapshot jsonb := '[]'::jsonb;
begin
  if p_worker_id is null
     or trim(p_worker_id) !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,119}$' then
    raise exception 'META_WORKER_ID_INVALID';
  end if;
  if p_limit not between 1 and 100 then
    raise exception 'META_CLAIM_LIMIT_INVALID';
  end if;
  if p_lease_seconds not between 30 and 900 then
    raise exception 'META_LEASE_INVALID';
  end if;

  -- Remapeamento tambem segue route -> inbox. O snapshot impede que uma rota
  -- inserida depois dos locks seja usada sem participar da ordem global.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', locked_route.id,
        'organization_id', locked_route.organization_id,
        'page_id', locked_route.page_id,
        'form_id', locked_route.form_id
      ) order by locked_route.id
    ),
    '[]'::jsonb
  ) into remap_route_snapshot
  from (
    select
      route.id, route.organization_id, route.page_id, route.form_id
    from public.crm_meta_lead_routes route
    where route.active
      and exists (
        select 1
        from crm_integration_private.integration_inbox_events inbox
        where inbox.status = 'unmapped'
          and inbox.page_id = route.page_id
          and inbox.form_id = route.form_id
      )
    order by route.id
    for share
  ) locked_route;

  -- Rotas criadas depois do webhook recuperam automaticamente os itens que
  -- entraram sem tenant. form_id ausente permanece unmapped para revisao.
  with remapped as (
    update crm_integration_private.integration_inbox_events inbox
    set organization_id = route.organization_id,
        route_id = route.id,
        status = 'pending',
        next_attempt_at = now(),
        updated_at = now()
    from jsonb_to_recordset(remap_route_snapshot) as route(
      id uuid,
      organization_id uuid,
      page_id text,
      form_id text
    )
    where inbox.status = 'unmapped'
      and inbox.page_id = route.page_id
      and inbox.form_id = route.form_id
    returning inbox.id, inbox.organization_id, inbox.attempt_count
  )
  insert into crm_integration_private.integration_inbox_transitions (
    event_id, organization_id, attempt_number, transition, details
  )
  select
    remapped.id, remapped.organization_id, remapped.attempt_count,
    'mapped', jsonb_build_object('route_resolved', true)
  from remapped
  on conflict (event_id, attempt_number, transition) do nothing;

  -- Se o worker morreu no ultimo attempt, o item nao pode ficar eternamente
  -- em processing. O sweep fecha o lease expirado como dead letter antes de
  -- selecionar novos claims.
  with exhausted as (
    update crm_integration_private.integration_inbox_events inbox
    set status = 'dead_letter',
        lock_token = null,
        lease_owner = null,
        lease_expires_at = null,
        last_error_code = 'LEASE_EXPIRED_MAX_ATTEMPTS',
        last_error_message =
          'Worker lease expired after the final configured attempt.',
        last_error_details = '{}'::jsonb,
        last_error_at = now(),
        updated_at = now()
    where inbox.status = 'processing'
      and inbox.lease_expires_at <= now()
      and inbox.attempt_count >= inbox.max_attempts
    returning inbox.id, inbox.organization_id, inbox.attempt_count
  )
  insert into crm_integration_private.integration_inbox_transitions (
    event_id, organization_id, attempt_number, transition,
    error_code, error_message, details
  )
  select
    exhausted.id, exhausted.organization_id, exhausted.attempt_count,
    'dead_lettered', 'LEASE_EXPIRED_MAX_ATTEMPTS',
    'Worker lease expired after the final configured attempt.',
    jsonb_build_object('lease_fencing', true)
  from exhausted
  on conflict (event_id, attempt_number, transition) do nothing;

  return query
  with candidates as (
    select inbox.id
    from crm_integration_private.integration_inbox_events inbox
    where inbox.organization_id is not null
      and inbox.route_id is not null
      and inbox.attempt_count < inbox.max_attempts
      and (
        (
          inbox.status in ('pending', 'retry')
          and inbox.next_attempt_at <= now()
        )
        or (
          inbox.status = 'processing'
          and inbox.lease_expires_at <= now()
        )
      )
      and exists (
        select 1
        from public.crm_meta_lead_routes route
        where route.organization_id = inbox.organization_id
          and route.id = inbox.route_id
          and route.active
      )
    order by inbox.next_attempt_at, inbox.first_received_at, inbox.id
    limit p_limit
    for update skip locked
  ), claimed as (
    update crm_integration_private.integration_inbox_events inbox
    set status = 'processing',
        attempt_count = inbox.attempt_count + 1,
        lock_token = gen_random_uuid(),
        lease_owner = trim(p_worker_id),
        lease_expires_at = now()
          + make_interval(secs => p_lease_seconds),
        updated_at = now()
    from candidates candidate
    where inbox.id = candidate.id
    returning inbox.*
  ), claim_transitions as (
    insert into crm_integration_private.integration_inbox_transitions (
      event_id, organization_id, attempt_number, transition,
      worker_id, lock_token, details
    )
    select
      claimed.id, claimed.organization_id, claimed.attempt_count,
      'claimed', claimed.lease_owner, claimed.lock_token,
      jsonb_build_object('lease_seconds', p_lease_seconds)
    from claimed
    on conflict (event_id, attempt_number, transition) do nothing
    returning event_id
  )
  select
    claimed.id,
    claimed.lock_token,
    claimed.route_id,
    claimed.organization_id,
    claimed.meta_lead_id,
    claimed.page_id,
    claimed.form_id,
    route.default_country_calling_code,
    claimed.event_occurred_at,
    claimed.first_received_at,
    claimed.event_payload,
    claimed.correlation_id,
    claimed.attempt_count,
    claimed.lease_expires_at
  from claimed
  join public.crm_meta_lead_routes route
    on route.organization_id = claimed.organization_id
   and route.id = claimed.route_id
  join claim_transitions transition_row
    on transition_row.event_id = claimed.id;
end
$function$;

revoke all on function public.claim_meta_lead_events(
  text, integer, integer
) from public, anon, authenticated;
grant execute on function public.claim_meta_lead_events(
  text, integer, integer
) to service_role;

-- Materializacao canonica em uma unica transacao curta. Chamadas externas a
-- Graph API acontecem antes desta RPC; nenhum lock e mantido durante I/O.
-- p_lead aceita campos adicionais, mas le somente:
-- {
--   raw_payload: object,
--   person: {
--     name, phone_e164, email, marketing_consent_status,
--     marketing_consent_at, marketing_consent_source
--   },
--   attribution: {
--     provider_account_id, campaign_id/name, adset_id/name, ad_id/name,
--     creative_id/name, form_name, page_name, placement,
--     publisher_platform, platform_position, device_platform, captured_at
--   }
-- }
create or replace function public.ingest_meta_lead(
  p_event_id uuid,
  p_lock_token uuid,
  p_lead jsonb
)
returns table (
  event_id uuid,
  organization_id uuid,
  contact_id uuid,
  crm_record_id uuid,
  attribution_id uuid,
  owner_user_id uuid,
  outcome text,
  idempotent boolean,
  contact_match text
)
language plpgsql
security definer
set search_path = ''
as $function$
#variable_conflict use_column
declare
  inbox_row crm_integration_private.integration_inbox_events%rowtype;
  route_row public.crm_meta_lead_routes%rowtype;
  source_row public.crm_lead_sources%rowtype;
  stage_row public.crm_stages%rowtype;
  continuity_row public.crm_records%rowtype;
  raw_payload jsonb;
  person_data jsonb;
  attribution_data jsonb;
  person_name_value text;
  phone_value text;
  email_value text;
  consent_status_value text;
  consent_at_value timestamptz;
  consent_source_value text;
  captured_at_value timestamptz;
  provider_account_value text;
  campaign_id_value text;
  campaign_name_value text;
  adset_id_value text;
  adset_name_value text;
  ad_id_value text;
  ad_name_value text;
  creative_id_value text;
  creative_name_value text;
  form_name_value text;
  page_name_value text;
  placement_value text;
  publisher_platform_value text;
  platform_position_value text;
  device_platform_value text;
  contact_key uuid;
  record_key uuid;
  attribution_key uuid;
  owner_key uuid;
  assignment_owner_key uuid;
  sdr_key uuid;
  broker_key uuid;
  team_key uuid;
  crm_campaign_key uuid;
  campaign_control_key uuid;
  mapped_campaign_project_key uuid;
  mapped_control_project_key uuid;
  match_count integer;
  match_kind text;
  outcome_kind text;
  campaign_display_name text;
  enrichment_warnings jsonb := '[]'::jsonb;
  attribution_incomplete boolean := false;
  existing_attribution_incomplete boolean := false;
  identity_ambiguous boolean := false;
  selected_team_member boolean := false;
  assignment_role_value text;
  assignment_due_at timestamptz;
  contact_blocked boolean := false;
  existing_assignment boolean := false;
begin
  if p_event_id is null or p_lock_token is null then
    raise exception 'META_LEASE_TOKEN_REQUIRED';
  end if;

  select inbox.* into inbox_row
  from crm_integration_private.integration_inbox_events inbox
  where inbox.id = p_event_id;

  if not found then
    raise exception 'META_EVENT_NOT_FOUND';
  end if;

  -- Resposta idempotente apos perda da resposta HTTP: somente o mesmo fencing
  -- token que concluiu o evento pode recuperar o resultado.
  if inbox_row.status = 'processed' then
    select inbox.* into inbox_row
    from crm_integration_private.integration_inbox_events inbox
    where inbox.id = p_event_id
    for update;
    if not found or inbox_row.status <> 'processed' then
      raise exception 'META_STALE_LEASE';
    end if;
    if inbox_row.lock_token is distinct from p_lock_token then
      raise exception 'META_STALE_LEASE';
    end if;
    return query
    select
      inbox_row.id,
      inbox_row.organization_id,
      inbox_row.contact_id,
      inbox_row.crm_record_id,
      inbox_row.attribution_id,
      inbox_row.owner_user_id,
      inbox_row.outcome,
      true,
      inbox_row.contact_match;
    return;
  end if;

  if inbox_row.status <> 'processing'
     or inbox_row.lock_token is distinct from p_lock_token
     or inbox_row.lease_expires_at is null
     or inbox_row.lease_expires_at <= clock_timestamp() then
    raise exception 'META_STALE_LEASE';
  end if;

  select route.* into route_row
  from public.crm_meta_lead_routes route
  where route.organization_id = inbox_row.organization_id
    and route.id = inbox_row.route_id
    and route.page_id = inbox_row.page_id
    and route.form_id = inbox_row.form_id
    and route.active
  for share;

  if not found then
    raise exception 'META_ROUTE_INACTIVE';
  end if;

  -- O trigger protege a configuracao quando ela e gravada, mas catalogos
  -- podem ser desativados depois. Estes locks mantem o snapshot operacional
  -- valido ate o commit e toda falha acontece antes de criar contato/record.
  perform 1
  from public.projects project
  where project.organization_id = route_row.organization_id
    and project.id = route_row.project_id
    and project.active
  for share;
  if not found then
    raise exception 'META_PROJECT_INACTIVE';
  end if;

  perform 1
  from public.crm_products product
  where product.organization_id = route_row.organization_id
    and product.project_id = route_row.project_id
    and product.id = route_row.product_id
    and product.active
  for share;
  if not found then
    raise exception 'META_PRODUCT_INACTIVE';
  end if;

  select source.* into source_row
  from public.crm_lead_sources source
  where source.organization_id = route_row.organization_id
    and source.id = route_row.lead_source_id
    and source.active
    and source.provider = 'meta'
    and source.channel = 'meta_lead_ads'
    and not source.manual_selectable
  for share;
  if not found then
    raise exception 'META_SOURCE_INACTIVE';
  end if;

  perform 1
  from public.crm_pipelines pipeline
  where pipeline.organization_id = route_row.organization_id
    and pipeline.id = route_row.pipeline_id
    and pipeline.active
  for share;
  if not found then
    raise exception 'META_PIPELINE_INACTIVE';
  end if;

  select stage.* into stage_row
  from public.crm_stages stage
  where stage.organization_id = route_row.organization_id
    and stage.pipeline_id = route_row.pipeline_id
    and stage.id = route_row.initial_stage_id
    and stage.active
    and not stage.is_won
    and not stage.is_lost
  for share;
  if not found then
    raise exception 'META_INITIAL_STAGE_INACTIVE';
  end if;

  if route_row.team_id is not null then
    perform 1
    from public.crm_teams team
    where team.organization_id = route_row.organization_id
      and team.id = route_row.team_id
      and team.active
      and (
        (
          route_row.assignment_role = 'sdr'
          and lower(team.team_type) in ('sdr', 'pre_vendas', 'pre-vendas')
        )
        or (
          route_row.assignment_role = 'broker'
          and lower(team.team_type) in (
            'corretor', 'corretores', 'vendas', 'comercial'
          )
        )
      )
    for share;
    if not found then
      raise exception 'META_ROUTE_TEAM_INVALID';
    end if;
  end if;

  perform 1
  from public.organization_members fallback_member
  where fallback_member.organization_id = route_row.organization_id
    and fallback_member.user_id = route_row.fallback_owner_user_id
    and fallback_member.active
  for share;
  if not found then
    raise exception 'META_ROUTE_NO_ACTIVE_OWNER';
  end if;

  -- Ordem de locks: rota/catalogos -> inbox. Rele o evento sob lock e repete
  -- todo o fencing antes da primeira escrita canonica; reclaim/fail ocorrido
  -- durante a espera nunca consegue materializar com token antigo.
  select locked_inbox.* into inbox_row
  from crm_integration_private.integration_inbox_events locked_inbox
  where locked_inbox.id = p_event_id
  for update;
  if not found then
    raise exception 'META_EVENT_NOT_FOUND';
  end if;

  if inbox_row.status = 'processed' then
    if inbox_row.lock_token is distinct from p_lock_token then
      raise exception 'META_STALE_LEASE';
    end if;
    return query
    select
      inbox_row.id,
      inbox_row.organization_id,
      inbox_row.contact_id,
      inbox_row.crm_record_id,
      inbox_row.attribution_id,
      inbox_row.owner_user_id,
      inbox_row.outcome,
      true,
      inbox_row.contact_match;
    return;
  end if;

  if inbox_row.status <> 'processing'
     or inbox_row.lock_token is distinct from p_lock_token
     or inbox_row.lease_expires_at is null
     or inbox_row.lease_expires_at <= clock_timestamp()
     or inbox_row.organization_id is distinct from route_row.organization_id
     or inbox_row.route_id is distinct from route_row.id
     or inbox_row.page_id is distinct from route_row.page_id
     or inbox_row.form_id is distinct from route_row.form_id then
    raise exception 'META_STALE_LEASE';
  end if;

  if p_lead is null
     or jsonb_typeof(p_lead) <> 'object'
     or pg_column_size(p_lead) > 786432 then
    raise exception 'META_LEAD_INPUT_INVALID';
  end if;

  raw_payload := p_lead -> 'raw_payload';
  person_data := coalesce(p_lead -> 'person', '{}'::jsonb);
  attribution_data := coalesce(
    p_lead -> 'attribution', '{}'::jsonb
  );
  if raw_payload is null
     or jsonb_typeof(raw_payload) <> 'object'
     or pg_column_size(raw_payload) > 524288
     or jsonb_typeof(person_data) <> 'object'
     or jsonb_typeof(attribution_data) <> 'object' then
    raise exception 'META_LEAD_PAYLOAD_INVALID';
  end if;

  if attribution_data ? 'attribution_incomplete'
     and jsonb_typeof(
       attribution_data -> 'attribution_incomplete'
     ) <> 'boolean' then
    raise exception 'META_ATTRIBUTION_INCOMPLETE_INVALID';
  end if;
  attribution_incomplete := coalesce(
    (attribution_data ->> 'attribution_incomplete')::boolean,
    false
  );
  enrichment_warnings := coalesce(
    attribution_data -> 'enrichment_warnings',
    '[]'::jsonb
  );
  if jsonb_typeof(enrichment_warnings) <> 'array'
     or jsonb_array_length(enrichment_warnings) > 8
     or exists (
       select 1
       from jsonb_array_elements(enrichment_warnings) warning(value)
       where jsonb_typeof(warning.value) <> 'string'
          or warning.value #>> '{}' not in (
            'META_AD_ENRICHMENT_UNAVAILABLE',
            'META_FORM_ENRICHMENT_UNAVAILABLE'
          )
     ) then
    raise exception 'META_ENRICHMENT_WARNINGS_INVALID';
  end if;
  if jsonb_array_length(enrichment_warnings) > 0 then
    attribution_incomplete := true;
  end if;

  person_name_value := left(
    coalesce(
      nullif(trim(person_data ->> 'name'), ''),
      'Lead Meta ' || right(inbox_row.meta_lead_id, 8)
    ),
    180
  );
  phone_value := nullif(trim(person_data ->> 'phone_e164'), '');
  email_value := lower(nullif(trim(person_data ->> 'email'), ''));

  if phone_value is not null
     and phone_value !~ '^[+][1-9][0-9]{7,14}$' then
    raise exception 'META_PHONE_E164_INVALID';
  end if;
  if email_value is not null and (
    char_length(email_value) > 320
    or email_value !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  ) then
    raise exception 'META_EMAIL_INVALID';
  end if;
  if phone_value is null and email_value is null then
    raise exception 'META_CONTACT_IDENTITY_REQUIRED';
  end if;

  consent_status_value := coalesce(
    nullif(trim(person_data ->> 'marketing_consent_status'), ''),
    'unknown'
  );
  if consent_status_value not in ('unknown', 'granted', 'denied', 'revoked') then
    raise exception 'META_CONSENT_STATUS_INVALID';
  end if;
  consent_source_value := left(
    nullif(trim(person_data ->> 'marketing_consent_source'), ''),
    255
  );
  if nullif(trim(person_data ->> 'marketing_consent_at'), '') is not null then
    consent_at_value :=
      (person_data ->> 'marketing_consent_at')::timestamptz;
  end if;
  if consent_status_value = 'unknown' then
    consent_at_value := null;
    consent_source_value := null;
  elsif consent_at_value is null then
    consent_at_value := inbox_row.event_occurred_at;
  end if;

  if nullif(trim(attribution_data ->> 'captured_at'), '') is not null then
    captured_at_value :=
      (attribution_data ->> 'captured_at')::timestamptz;
  else
    captured_at_value := inbox_row.event_occurred_at;
  end if;
  if captured_at_value < inbox_row.first_received_at - interval '90 days'
     or captured_at_value > inbox_row.first_received_at + interval '5 minutes' then
    raise exception 'META_CAPTURED_AT_INVALID';
  end if;

  provider_account_value := left(
    regexp_replace(coalesce(
      nullif(trim(attribution_data ->> 'provider_account_id'), ''),
      route_row.provider_account_id
    ), '^act_', '', 'i'),
    255
  );
  if provider_account_value is not null
     and provider_account_value !~ '^[0-9]{1,64}$' then
    raise exception 'META_PROVIDER_ACCOUNT_INVALID';
  end if;
  if route_row.provider_account_id is not null
     and nullif(trim(attribution_data ->> 'provider_account_id'), '')
         is not null
     and route_row.provider_account_id is distinct from
         regexp_replace(
           trim(attribution_data ->> 'provider_account_id'),
           '^act_',
           '',
           'i'
         ) then
    raise exception 'META_PROVIDER_ACCOUNT_MISMATCH';
  end if;

  campaign_id_value := left(
    nullif(trim(attribution_data ->> 'campaign_id'), ''), 255
  );
  campaign_name_value := left(
    nullif(trim(attribution_data ->> 'campaign_name'), ''), 500
  );
  adset_id_value := left(
    nullif(trim(attribution_data ->> 'adset_id'), ''), 255
  );
  adset_name_value := left(
    nullif(trim(attribution_data ->> 'adset_name'), ''), 500
  );
  ad_id_value := left(
    nullif(trim(attribution_data ->> 'ad_id'), ''), 255
  );
  ad_name_value := left(
    nullif(trim(attribution_data ->> 'ad_name'), ''), 500
  );
  creative_id_value := left(
    nullif(trim(attribution_data ->> 'creative_id'), ''), 255
  );
  creative_name_value := left(
    nullif(trim(attribution_data ->> 'creative_name'), ''), 500
  );
  form_name_value := left(
    nullif(trim(attribution_data ->> 'form_name'), ''), 500
  );
  page_name_value := left(
    nullif(trim(attribution_data ->> 'page_name'), ''), 500
  );
  placement_value := left(
    nullif(trim(attribution_data ->> 'placement'), ''), 255
  );
  publisher_platform_value := left(
    nullif(trim(attribution_data ->> 'publisher_platform'), ''), 255
  );
  platform_position_value := left(
    nullif(trim(attribution_data ->> 'platform_position'), ''), 255
  );
  device_platform_value := left(
    nullif(trim(attribution_data ->> 'device_platform'), ''), 255
  );

  -- Idempotencia definitiva por meta_lead_id no ledger restrito da Stage 1.
  select
    attribution.id,
    attribution.crm_record_id,
    record.contact_id,
    coalesce(
      record.owner_user_id, record.sdr_user_id, record.broker_user_id
    ),
    coalesce(
      (attribution.metadata ->> 'attribution_incomplete')::boolean,
      false
    )
  into
    attribution_key, record_key, contact_key, owner_key,
    existing_attribution_incomplete
  from public.crm_opportunity_attributions attribution
  left join public.crm_records record
    on record.organization_id = attribution.organization_id
   and record.id = attribution.crm_record_id
  where attribution.organization_id = route_row.organization_id
    and attribution.provider = 'meta'
    and attribution.external_lead_id = inbox_row.meta_lead_id;

  if found then
    outcome_kind := case
      when existing_attribution_incomplete
        then 'idempotent_with_incomplete_attribution'
      else 'duplicate'
    end;
    update crm_integration_private.integration_inbox_events inbox
    set lead_payload = case
          when inbox.raw_retention_until > now()
               and inbox.raw_purged_at is null then raw_payload
          else null
        end,
        lead_payload_sha256 = encode(
          extensions.digest(convert_to(raw_payload::text, 'UTF8'), 'sha256'),
          'hex'
        ),
        status = 'processed',
        contact_id = contact_key,
        crm_record_id = record_key,
        attribution_id = attribution_key,
        owner_user_id = owner_key,
        outcome = outcome_kind,
        contact_match = 'existing_attribution',
        processed_at = now(),
        last_error_code = null,
        last_error_message = null,
        last_error_details = '{}'::jsonb,
        last_error_at = null,
        lease_owner = null,
        lease_expires_at = null,
        updated_at = now()
    where inbox.id = inbox_row.id;

    insert into crm_integration_private.integration_inbox_transitions (
      event_id, organization_id, attempt_number, transition,
      worker_id, lock_token, details
    ) values (
      inbox_row.id, route_row.organization_id, inbox_row.attempt_count,
      'processed', inbox_row.lease_owner, p_lock_token,
      jsonb_build_object(
        'idempotent', true,
        'attribution_incomplete', existing_attribution_incomplete
      )
    )
    on conflict (event_id, attempt_number, transition) do nothing;

    return query
    select
      inbox_row.id, route_row.organization_id, contact_key, record_key,
      attribution_key, owner_key, outcome_kind, true,
      'existing_attribution'::text;
    return;
  end if;

  -- Serializa por identidade antes do lookup. As chaves sao ordenadas para
  -- que duas transacoes com telefone+email nao adquiram locks em ordem
  -- divergente. Isso fecha a corrida 0-match -> dois contatos duplicados.
  perform pg_advisory_xact_lock(
    hashtextextended(identity_lock.lock_key, 0)
  )
  from (
    select
      route_row.organization_id::text || ':contact:phone:' || phone_value
        as lock_key
    where phone_value is not null
    union all
    select
      route_row.organization_id::text || ':contact:email:' || email_value
        as lock_key
    where email_value is not null
  ) identity_lock
  order by identity_lock.lock_key;

  -- Telefone legado (`phone`) e WhatsApp sao o mesmo sinal normalizado.
  -- Todos os sinais sao avaliados juntos: telefone de A + email de B nunca
  -- anexa silenciosamente a identidade de um contato ao outro.
  select
    count(*),
    (array_agg(candidate.contact_id order by candidate.contact_id))[1]
  into match_count, contact_key
  from (
    select identity.contact_id
    from public.crm_contact_identities identity
    join public.contacts contact
      on contact.organization_id = identity.organization_id
     and contact.id = identity.contact_id
     and contact.active
    where identity.organization_id = route_row.organization_id
      and identity.active
      and (
        (
          phone_value is not null
          and identity.identity_type in ('phone', 'whatsapp')
          and identity.normalized_value = phone_value
        )
        or (
          email_value is not null
          and identity.identity_type = 'email'
          and identity.normalized_value = email_value
        )
      )
    union
    select contact.id
    from public.contacts contact
    where contact.organization_id = route_row.organization_id
      and contact.active
      and (
        (
          phone_value is not null
          and crm_integration_private.normalize_phone_e164(
            contact.phone,
            route_row.default_country_calling_code
          ) = phone_value
        )
        or (
          email_value is not null
          and lower(nullif(trim(contact.email), '')) = email_value
        )
      )
  ) candidate;

  if match_count = 1 then
    match_kind := case
      when phone_value is not null and email_value is not null
        then 'phone_email'
      when phone_value is not null then 'phone'
      else 'email'
    end;
  elsif match_count > 1 then
    contact_key := null;
    identity_ambiguous := true;
    match_kind := 'ambiguous_identity_new';
  end if;

  if contact_key is null then
    match_kind := coalesce(match_kind, 'new');
    insert into public.contacts (
      organization_id, contact_type, name, email, phone,
      preferred_channel, marketing_consent_status,
      marketing_consent_at, marketing_consent_source,
      data_processing_basis, person_type, active
    ) values (
      route_row.organization_id, 'prospect', person_name_value,
      email_value, phone_value,
      case when phone_value is not null then 'whatsapp'
           when email_value is not null then 'email'
           else null end,
      consent_status_value, consent_at_value, consent_source_value,
      'pre_contract', 'fisica', true
    ) returning id into contact_key;
  else
    update public.contacts contact
    set name = case
          when nullif(trim(contact.name), '') is null then person_name_value
          else contact.name
        end,
        email = coalesce(nullif(trim(contact.email), ''), email_value),
        phone = coalesce(nullif(trim(contact.phone), ''), phone_value),
        preferred_channel = coalesce(
          contact.preferred_channel,
          case when phone_value is not null then 'whatsapp'
               when email_value is not null then 'email'
               else null end
        ),
        marketing_consent_status = case
          when contact.do_not_contact_at is null
               and contact.marketing_consent_status <> 'revoked'
               and consent_status_value <> 'unknown'
            then consent_status_value
          else contact.marketing_consent_status
        end,
        marketing_consent_at = case
          when contact.do_not_contact_at is null
               and contact.marketing_consent_status <> 'revoked'
               and consent_status_value <> 'unknown'
            then consent_at_value
          else contact.marketing_consent_at
        end,
        marketing_consent_source = case
          when contact.do_not_contact_at is null
               and contact.marketing_consent_status <> 'revoked'
               and consent_status_value <> 'unknown'
            then consent_source_value
          else contact.marketing_consent_source
        end,
        data_processing_basis = coalesce(
          contact.data_processing_basis, 'pre_contract'
        ),
        updated_at = now()
    where contact.organization_id = route_row.organization_id
      and contact.id = contact_key;
  end if;

  select
    contact.do_not_contact_at is not null
    or contact.marketing_consent_status = 'revoked'
  into contact_blocked
  from public.contacts contact
  where contact.organization_id = route_row.organization_id
    and contact.id = contact_key;

  -- Em caso ambiguo, a pessoa nova preserva os dados submetidos para revisao,
  -- mas nao amplia o conjunto de identidades ativas conflitantes.
  if phone_value is not null and not identity_ambiguous then
    insert into public.crm_contact_identities (
      organization_id, contact_id, identity_type, normalized_value,
      last_seen_at, active, source, metadata
    ) values (
      route_row.organization_id, contact_key, 'whatsapp', phone_value,
      now(), true, 'meta_lead_ads',
      jsonb_build_object(
        'route_id', route_row.id,
        'inbox_event_id', inbox_row.id
      )
    )
    on conflict (
      organization_id, contact_id, identity_type, normalized_value
    ) do update
    set last_seen_at = excluded.last_seen_at,
        active = true,
        source = 'meta_lead_ads',
        updated_at = now();
  end if;

  if email_value is not null and not identity_ambiguous then
    insert into public.crm_contact_identities (
      organization_id, contact_id, identity_type, normalized_value,
      last_seen_at, active, source, metadata
    ) values (
      route_row.organization_id, contact_key, 'email', email_value,
      now(), true, 'meta_lead_ads',
      jsonb_build_object(
        'route_id', route_row.id,
        'inbox_event_id', inbox_row.id
      )
    )
    on conflict (
      organization_id, contact_id, identity_type, normalized_value
    ) do update
    set last_seen_at = excluded.last_seen_at,
        active = true,
        source = 'meta_lead_ads',
        updated_at = now();
  end if;

  -- Continuidade conserva owner/papeis/equipe, mas cada meta_lead_id gera uma
  -- oportunidade nova. Isso preserva atribuicao, conversao e ROI por lead sem
  -- fundir jornadas comerciais distintas da mesma pessoa.
  select record.* into continuity_row
  from public.crm_records record
  where record.organization_id = route_row.organization_id
    and record.contact_id = contact_key
    and record.project_id = route_row.project_id
    and record.product_id is not distinct from route_row.product_id
    and record.record_status = 'aberta'
    and exists (
      select 1
      from public.organization_members member
      where member.organization_id = record.organization_id
        and member.user_id = any(array[
          record.owner_user_id, record.sdr_user_id, record.broker_user_id
        ])
        and member.active
    )
  order by
    (record.lead_source_id = route_row.lead_source_id) desc,
    record.updated_at desc nulls last,
    record.created_at desc
  limit 1
  for update;

  if found then
    select candidate.user_id into owner_key
    from (values
      (continuity_row.owner_user_id, 1),
      (continuity_row.sdr_user_id, 2),
      (continuity_row.broker_user_id, 3)
    ) candidate(user_id, priority_order)
    join public.organization_members member
      on member.organization_id = route_row.organization_id
     and member.user_id = candidate.user_id
     and member.active
    order by candidate.priority_order
    limit 1;

    select member.user_id into sdr_key
    from public.organization_members member
    where member.organization_id = route_row.organization_id
      and member.user_id = continuity_row.sdr_user_id
      and member.active
    for share;

    select member.user_id into broker_key
    from public.organization_members member
    where member.organization_id = route_row.organization_id
      and member.user_id = continuity_row.broker_user_id
      and member.active
    for share;

    select team.id into team_key
    from public.crm_teams team
    where team.organization_id = route_row.organization_id
      and team.id = continuity_row.team_id
      and team.active
      and (
        (
          route_row.assignment_role = 'sdr'
          and lower(team.team_type) in ('sdr', 'pre_vendas', 'pre-vendas')
        )
        or (
          route_row.assignment_role = 'broker'
          and lower(team.team_type) in (
            'corretor', 'corretores', 'vendas', 'comercial'
          )
        )
      )
    for share;

    outcome_kind := 'created_continuity';
  end if;

  if owner_key is null
     and route_row.assignment_strategy <> 'fallback_only'
     and route_row.team_id is not null then
    select team_member.user_id into owner_key
    from public.crm_team_members team_member
    join public.organization_members member
      on member.organization_id = team_member.organization_id
     and member.user_id = team_member.user_id
     and member.active
    cross join lateral (
      select count(*) as open_count
      from public.crm_records open_record
      where open_record.organization_id = route_row.organization_id
        and open_record.record_status = 'aberta'
        and (
          open_record.owner_user_id = team_member.user_id
          or open_record.sdr_user_id = team_member.user_id
          or open_record.broker_user_id = team_member.user_id
        )
    ) queue
    where team_member.organization_id = route_row.organization_id
      and team_member.team_id = route_row.team_id
      and team_member.active
      and queue.open_count < team_member.capacity
    order by
      case when route_row.assignment_strategy = 'least_queue'
        then queue.open_count else 0 end,
      case when route_row.assignment_strategy = 'round_robin'
        then team_member.last_assigned_at end nulls first,
      team_member.user_id::text
    limit 1
    for update of team_member skip locked;
    selected_team_member := owner_key is not null;
    if selected_team_member then
      team_key := route_row.team_id;
    end if;
  end if;

  if owner_key is null then
    select member.user_id into owner_key
    from public.organization_members member
    where member.organization_id = route_row.organization_id
      and member.user_id = route_row.fallback_owner_user_id
      and member.active;
  end if;
  if owner_key is null then
    raise exception 'META_ROUTE_NO_ACTIVE_OWNER';
  end if;

  -- Mesmo um owner herdado precisa continuar ativo no tenant e fica travado
  -- ate o commit para nao ser desativado entre a selecao e o INSERT.
  perform 1
  from public.organization_members member
  where member.organization_id = route_row.organization_id
    and member.user_id = owner_key
    and member.active
  for share;
  if not found then
    raise exception 'META_OWNER_INACTIVE';
  end if;

  team_key := coalesce(team_key, route_row.team_id);
  if route_row.assignment_role = 'sdr' then
    assignment_owner_key := coalesce(sdr_key, owner_key, broker_key);
    sdr_key := coalesce(sdr_key, assignment_owner_key);
  else
    assignment_owner_key := coalesce(broker_key, owner_key, sdr_key);
    broker_key := coalesce(broker_key, assignment_owner_key);
  end if;
  if assignment_owner_key is null then
    raise exception 'META_ROUTE_NO_ACTIVE_ASSIGNEE';
  end if;
  perform 1
  from public.organization_members member
  where member.organization_id = route_row.organization_id
    and member.user_id = assignment_owner_key
    and member.active
  for share;
  if not found then
    raise exception 'META_ROUTE_NO_ACTIVE_ASSIGNEE';
  end if;

  -- Campaign Control e CRM sao conciliados automaticamente sob lock por
  -- conta+campanha. A oportunidade nunca fica sem a ponte quando a Meta
  -- entrega ambos os identificadores.
  if provider_account_value is not null
     and campaign_id_value is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      route_row.organization_id::text || ':meta_campaign:' ||
      provider_account_value || ':' || campaign_id_value,
      0
    ));

    select
      mapping.crm_campaign_id,
      campaign.project_id,
      campaign.marketing_campaign_id,
      control_campaign.project_id
    into
      crm_campaign_key,
      mapped_campaign_project_key,
      campaign_control_key,
      mapped_control_project_key
    from public.crm_campaign_mappings mapping
    join public.crm_campaigns campaign
      on campaign.organization_id = mapping.organization_id
     and campaign.id = mapping.crm_campaign_id
    left join public.marketing_campaigns control_campaign
      on control_campaign.organization_id = campaign.organization_id
     and control_campaign.id = campaign.marketing_campaign_id
    where mapping.organization_id = route_row.organization_id
      and mapping.provider = 'meta'
      and mapping.provider_account_id = provider_account_value
      and mapping.external_campaign_id = campaign_id_value;

    campaign_display_name := left(
      coalesce(
        campaign_name_value,
        'Meta campaign ' || campaign_id_value
      ),
      180
    );

    if found then
      if mapped_campaign_project_key is distinct from route_row.project_id
         or (
           campaign_control_key is not null
           and mapped_control_project_key is distinct from route_row.project_id
         ) then
        raise exception 'META_CAMPAIGN_PROJECT_MISMATCH';
      end if;

      if campaign_control_key is null then
        insert into public.marketing_campaigns (
          organization_id, project_id, name, strategy
        ) values (
          route_row.organization_id,
          route_row.project_id,
          campaign_display_name,
          'Conciliada automaticamente a partir de Meta Lead Ads.'
        ) returning id into campaign_control_key;

        update public.crm_campaigns campaign
        set marketing_campaign_id = campaign_control_key,
            updated_at = now()
        where campaign.organization_id = route_row.organization_id
          and campaign.id = crm_campaign_key;
      end if;

      update public.crm_campaign_mappings mapping
      set external_campaign_name = coalesce(
            campaign_name_value,
            mapping.external_campaign_name
          ),
          last_synced_at = now(),
          updated_at = now()
      where mapping.organization_id = route_row.organization_id
        and mapping.provider = 'meta'
        and mapping.provider_account_id = provider_account_value
        and mapping.external_campaign_id = campaign_id_value;
    else
      insert into public.marketing_campaigns (
        organization_id, project_id, name, strategy
      ) values (
        route_row.organization_id,
        route_row.project_id,
        campaign_display_name,
        'Conciliada automaticamente a partir de Meta Lead Ads.'
      ) returning id into campaign_control_key;

      insert into public.crm_campaigns (
        organization_id, name, campaign_type, channel, status,
        project_id, marketing_campaign_id,
        utm_source, utm_medium, utm_campaign, notes
      ) values (
        route_row.organization_id,
        campaign_display_name,
        'digital',
        'meta_lead_ads',
        'planejada',
        route_row.project_id,
        campaign_control_key,
        'meta',
        'paid_social',
        campaign_display_name,
        'Conciliada automaticamente a partir de Meta Lead Ads.'
      ) returning id into crm_campaign_key;

      insert into public.crm_campaign_mappings (
        organization_id, crm_campaign_id, provider,
        provider_account_id, external_campaign_id,
        external_campaign_name, provider_metadata, last_synced_at
      ) values (
        route_row.organization_id,
        crm_campaign_key,
        'meta',
        provider_account_value,
        campaign_id_value,
        campaign_name_value,
        jsonb_build_object(
          'auto_reconciled', true,
          'route_id', route_row.id
        ),
        now()
      );
    end if;
  end if;

  perform set_config('app.crm_event_source', 'meta', true);
  perform set_config(
    'app.correlation_id', inbox_row.correlation_id, true
  );

  outcome_kind := coalesce(outcome_kind, 'created');
  if attribution_incomplete then
    outcome_kind := outcome_kind || '_with_incomplete_attribution';
  end if;

  insert into public.crm_records (
    organization_id, contact_id, person_name, email, phone,
    project_id, product_id, lead_source_id,
    stage, record_status, source, source_channel,
    estimated_value, probability, next_action_at,
    owner_user_id, pipeline_id, stage_id, team_id,
    sdr_user_id, broker_user_id, campaign_id,
    lead_score, temperature, priority,
    utm_source, utm_medium, utm_campaign, utm_content,
    sla_due_at, stagnation_at, tags, originated_at
  ) values (
    route_row.organization_id, contact_key, person_name_value,
    email_value, phone_value,
    route_row.project_id, route_row.product_id, route_row.lead_source_id,
    stage_row.code, 'aberta', source_row.name, source_row.channel,
    0, stage_row.probability,
    case when contact_blocked or identity_ambiguous
      then now() + interval '1 minute'
      else now()
    end,
    owner_key, route_row.pipeline_id, route_row.initial_stage_id,
    team_key, sdr_key, broker_key, crm_campaign_key,
    0, 'morno', 'alta',
    'meta', 'paid_social', campaign_name_value,
    coalesce(ad_name_value, ad_id_value),
    case when contact_blocked or identity_ambiguous then null
      else captured_at_value + make_interval(
        mins => route_row.first_contact_sla_minutes
      )
    end,
    captured_at_value + make_interval(
      mins => route_row.first_contact_sla_minutes
    ),
    array_remove(array[
      'meta',
      'meta_lead_ads',
      case when identity_ambiguous then 'identity_review' end,
      case when contact_blocked then 'do_not_contact_review' end,
      case when attribution_incomplete then 'attribution_incomplete' end
    ]::text[], null),
    captured_at_value
  ) returning id into record_key;

  insert into public.crm_opportunity_attributions (
    organization_id, crm_record_id, opportunity_key,
    lead_source_id, project_id, product_id,
    crm_campaign_id, campaign_control_campaign_id,
    provider, channel, provider_account_id,
    external_lead_id, meta_lead_id,
    campaign_id, campaign_name, adset_id, adset_name,
    ad_id, ad_name, creative_id, creative_name,
    form_id, form_name, page_id, page_name,
    placement, publisher_platform, platform_position, device_platform,
    attribution_model, captured_at, received_at, is_primary, metadata
  ) values (
    route_row.organization_id, record_key, record_key,
    route_row.lead_source_id, route_row.project_id, route_row.product_id,
    crm_campaign_key, campaign_control_key,
    'meta', source_row.channel, provider_account_value,
    inbox_row.meta_lead_id, inbox_row.meta_lead_id,
    campaign_id_value, campaign_name_value, adset_id_value, adset_name_value,
    ad_id_value, ad_name_value, creative_id_value, creative_name_value,
    inbox_row.form_id, form_name_value, inbox_row.page_id, page_name_value,
    placement_value, publisher_platform_value,
    platform_position_value, device_platform_value,
    'source_capture', captured_at_value, inbox_row.first_received_at,
    true,
    jsonb_build_object(
      'inbox_event_id', inbox_row.id,
      'route_id', route_row.id,
      'raw_payload_restricted', true,
      'attribution_incomplete', attribution_incomplete,
      'enrichment_warnings', enrichment_warnings
    )
  ) returning id into attribution_key;

  assignment_role_value := case
    when route_row.assignment_role = 'broker' then 'corretor'
    else 'sdr'
  end;
  if contact_blocked or identity_ambiguous then
    assignment_due_at := greatest(
      now() + interval '1 minute',
      captured_at_value + make_interval(
        mins => route_row.first_contact_sla_minutes
      )
    );

    insert into public.crm_actions (
      organization_id, crm_record_id, action_type, subject,
      scheduled_at, action_status, notes, created_by,
      channel, assigned_to, metadata
    ) values (
      route_row.organization_id,
      record_key,
      'tarefa',
      case when contact_blocked
        then 'Revisao LGPD - contato bloqueado'
        else 'Revisao de identidade do lead Meta'
      end,
      now() + interval '1 minute',
      'pendente',
      case when contact_blocked
        then 'Nao contatar. Validar base legal ou registrar novo consentimento valido antes de qualquer comunicacao.'
        else 'Nao mesclar contatos nem enviar mensagem. Confirmar telefone/e-mail e resolver a identidade primeiro.'
      end,
      null,
      'interno',
      assignment_owner_key,
      jsonb_build_object(
        'source', 'meta_lead_ads',
        'inbox_event_id', inbox_row.id,
        'route_id', route_row.id,
        'review_due_at', assignment_due_at,
        'requires_human_review', true,
        'no_external_delivery', true,
        'contact_blocked', contact_blocked,
        'identity_ambiguous', identity_ambiguous
      )
    );
  else
    select exists (
      select 1
      from public.crm_lead_assignments assignment
      where assignment.crm_record_id = record_key
        and assignment.assignment_role = assignment_role_value
        and assignment.assigned_user_id = assignment_owner_key
        and assignment.status in ('atribuida', 'aceita', 'em_atendimento')
    ) into existing_assignment;

    if not existing_assignment then
      assignment_due_at := greatest(
        now() + interval '1 minute',
        captured_at_value + make_interval(
          mins => route_row.first_contact_sla_minutes
        )
      );
      perform private.create_crm_assignment(
        record_key,
        assignment_role_value,
        assignment_owner_key,
        'alta',
        assignment_due_at,
        'Lead recebido automaticamente via Meta Lead Ads. Revisar o contexto e realizar o primeiro atendimento dentro do SLA.',
        null,
        'automation',
        true
      );
    end if;
  end if;

  if selected_team_member and (contact_blocked or identity_ambiguous) then
    update public.crm_team_members team_member
    set last_assigned_at = now()
    where team_member.organization_id = route_row.organization_id
      and team_member.team_id = route_row.team_id
      and team_member.user_id = owner_key;
  end if;

  insert into public.crm_opportunity_events (
    organization_id, crm_record_id, opportunity_key,
    contact_id, project_id, product_id, lead_source_id,
    actor_type, event_type, event_source, channel,
    occurred_at, idempotency_key, correlation_id, data
  ) values (
    route_row.organization_id, record_key, record_key,
    contact_key, route_row.project_id, route_row.product_id,
    route_row.lead_source_id,
    'integration', 'lead.ingested', 'meta', source_row.channel,
    now(), 'meta_ingest:' || inbox_row.id::text,
    inbox_row.correlation_id,
    jsonb_build_object(
      'inbox_event_id', inbox_row.id,
      'route_id', route_row.id,
      'attribution_id', attribution_key,
      'outcome', outcome_kind,
      'contact_match', match_kind,
      'owner_user_id', owner_key,
      'assigned_user_id', assignment_owner_key,
      'contact_blocked', contact_blocked,
      'identity_review_required', identity_ambiguous,
      'attribution_incomplete', attribution_incomplete,
      'enrichment_warnings', enrichment_warnings,
      'details_restricted', true
    )
  ) on conflict (organization_id, idempotency_key)
    where idempotency_key is not null do nothing;

  update crm_integration_private.integration_inbox_events inbox
  set lead_payload = case
        when inbox.raw_retention_until > now()
             and inbox.raw_purged_at is null then raw_payload
        else null
      end,
      lead_payload_sha256 = encode(
        extensions.digest(convert_to(raw_payload::text, 'UTF8'), 'sha256'),
        'hex'
      ),
      status = 'processed',
      contact_id = contact_key,
      crm_record_id = record_key,
      attribution_id = attribution_key,
      owner_user_id = owner_key,
      outcome = outcome_kind,
      contact_match = match_kind,
      processed_at = now(),
      last_error_code = null,
      last_error_message = null,
      last_error_details = '{}'::jsonb,
      last_error_at = null,
      lease_owner = null,
      lease_expires_at = null,
      updated_at = now()
  where inbox.id = inbox_row.id;

  insert into crm_integration_private.integration_inbox_transitions (
    event_id, organization_id, attempt_number, transition,
    worker_id, lock_token, details
  ) values (
    inbox_row.id, route_row.organization_id, inbox_row.attempt_count,
    'processed', inbox_row.lease_owner, p_lock_token,
    jsonb_build_object(
      'outcome', outcome_kind,
      'contact_match', match_kind,
      'details_restricted', true
    )
  )
  on conflict (event_id, attempt_number, transition) do nothing;

  return query
  select
    inbox_row.id, route_row.organization_id, contact_key, record_key,
    attribution_key, owner_key, outcome_kind, false, match_kind;
end
$function$;

revoke all on function public.ingest_meta_lead(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_meta_lead(uuid, uuid, jsonb)
  to service_role;

-- Falha cercada pelo mesmo fencing token do claim. Um worker cujo lease
-- expirou nunca consegue reagendar ou dead-letter um evento retomado por
-- outro worker.
create or replace function public.fail_meta_lead_event(
  p_event_id uuid,
  p_lock_token uuid,
  p_error_code text,
  p_error_message text,
  p_retryable boolean default true,
  p_retry_after_seconds integer default null,
  p_error_details jsonb default '{}'::jsonb
)
returns table (
  event_id uuid,
  event_status text,
  next_attempt_at timestamptz,
  attempt_count integer,
  max_attempts integer
)
language plpgsql
security definer
set search_path = ''
as $function$
#variable_conflict use_column
declare
  inbox_row crm_integration_private.integration_inbox_events%rowtype;
  next_status text;
  next_attempt_value timestamptz;
  retry_delay_seconds integer;
begin
  if p_event_id is null or p_lock_token is null then
    raise exception 'META_LEASE_TOKEN_REQUIRED';
  end if;
  if p_error_code is null
     or trim(p_error_code) !~ '^[A-Z0-9][A-Z0-9_.:-]{1,99}$' then
    raise exception 'META_ERROR_CODE_INVALID';
  end if;
  if p_error_message is null
     or char_length(trim(p_error_message)) not between 1 and 1000 then
    raise exception 'META_ERROR_MESSAGE_INVALID';
  end if;
  if p_error_details is null
     or jsonb_typeof(p_error_details) <> 'object'
     or pg_column_size(p_error_details) > 16384 then
    raise exception 'META_ERROR_DETAILS_INVALID';
  end if;
  if p_retry_after_seconds is not null
     and p_retry_after_seconds not between 1 and 86400 then
    raise exception 'META_RETRY_AFTER_INVALID';
  end if;

  select inbox.* into inbox_row
  from crm_integration_private.integration_inbox_events inbox
  where inbox.id = p_event_id
  for update;

  if not found then
    raise exception 'META_EVENT_NOT_FOUND';
  end if;
  if inbox_row.status <> 'processing'
     or inbox_row.lock_token is distinct from p_lock_token
     or inbox_row.lease_expires_at is null
     or inbox_row.lease_expires_at <= clock_timestamp() then
    raise exception 'META_STALE_LEASE';
  end if;

  if p_retryable and inbox_row.attempt_count < inbox_row.max_attempts then
    next_status := 'retry';
    retry_delay_seconds := coalesce(
      p_retry_after_seconds,
      least(
        3600,
        30 * (2 ^ least(inbox_row.attempt_count - 1, 7))
      )::integer
    );
    next_attempt_value := now() + make_interval(secs => retry_delay_seconds);
  else
    next_status := 'dead_letter';
    next_attempt_value := inbox_row.next_attempt_at;
  end if;

  update crm_integration_private.integration_inbox_events inbox
  set status = next_status,
      next_attempt_at = next_attempt_value,
      last_error_code = trim(p_error_code),
      last_error_message = trim(p_error_message),
      last_error_details = p_error_details,
      last_error_at = now(),
      lock_token = null,
      lease_owner = null,
      lease_expires_at = null,
      updated_at = now()
  where inbox.id = inbox_row.id;

  insert into crm_integration_private.integration_inbox_transitions (
    event_id, organization_id, attempt_number, transition,
    worker_id, lock_token, error_code, error_message, details
  ) values (
    inbox_row.id,
    inbox_row.organization_id,
    inbox_row.attempt_count,
    case when next_status = 'retry'
      then 'retry_scheduled' else 'dead_lettered' end,
    inbox_row.lease_owner,
    p_lock_token,
    trim(p_error_code),
    trim(p_error_message),
    jsonb_build_object(
      'retryable', p_retryable,
      'retry_delay_seconds', case
        when next_status = 'retry' then retry_delay_seconds
        else null
      end,
      'safe_details', p_error_details
    )
  )
  on conflict (event_id, attempt_number, transition) do nothing;

  return query
  select
    inbox_row.id,
    next_status,
    next_attempt_value,
    inbox_row.attempt_count,
    inbox_row.max_attempts;
end
$function$;

revoke all on function public.fail_meta_lead_event(
  uuid, uuid, text, text, boolean, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.fail_meta_lead_event(
  uuid, uuid, text, text, boolean, integer, jsonb
) to service_role;

-- Snapshot operacional sem payload, identificadores externos ou PII.
create or replace function public.get_meta_lead_integration_status(
  p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  result_value jsonb;
begin
  if p_organization_id is null
     or not public.has_app_permission(
       p_organization_id,
       'crm.integrations.manage'
     ) then
    raise exception 'Seu perfil nao pode gerenciar integracoes do CRM.';
  end if;

  select jsonb_build_object(
    'routes', jsonb_build_object(
      'total', (
        select count(*)
        from public.crm_meta_lead_routes route
        where route.organization_id = p_organization_id
      ),
      'active', (
        select count(*)
        from public.crm_meta_lead_routes route
        where route.organization_id = p_organization_id
          and route.active
      )
    ),
    'events', jsonb_build_object(
      'total', count(*),
      'unmapped', count(*) filter (where inbox.status = 'unmapped'),
      'pending', count(*) filter (where inbox.status = 'pending'),
      'processing', count(*) filter (where inbox.status = 'processing'),
      'retry', count(*) filter (where inbox.status = 'retry'),
      'processed', count(*) filter (where inbox.status = 'processed'),
      'processed_attribution_incomplete', count(*) filter (
        where inbox.status = 'processed'
          and inbox.outcome like '%incomplete_attribution'
      ),
      'dead_letter', count(*) filter (where inbox.status = 'dead_letter')
    ),
    'timestamps', jsonb_build_object(
      'last_received_at', max(inbox.last_received_at),
      'last_processed_at', max(inbox.processed_at),
      'oldest_pending_at', min(inbox.first_received_at) filter (
        where inbox.status in ('pending', 'retry')
      )
    ),
    'errors', jsonb_build_object(
      'last_error_at', (
        select error_inbox.last_error_at
        from crm_integration_private.integration_inbox_events error_inbox
        where error_inbox.organization_id = p_organization_id
          and error_inbox.last_error_at is not null
        order by error_inbox.last_error_at desc, error_inbox.id
        limit 1
      ),
      'last_error_code', (
        select error_inbox.last_error_code
        from crm_integration_private.integration_inbox_events error_inbox
        where error_inbox.organization_id = p_organization_id
          and error_inbox.last_error_at is not null
        order by error_inbox.last_error_at desc, error_inbox.id
        limit 1
      )
    )
  ) into result_value
  from crm_integration_private.integration_inbox_events inbox
  where inbox.organization_id = p_organization_id;

  return result_value;
end
$function$;

revoke all on function public.get_meta_lead_integration_status(uuid)
  from public, anon, service_role;
grant execute on function public.get_meta_lead_integration_status(uuid)
  to authenticated;

-- Recuperacao operacional depois de corrigir credencial/configuracao. So
-- reabre itens do tenant, com rota ativa e payload ainda dentro da retencao.
create or replace function public.requeue_meta_lead_failures(
  p_organization_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  requeued_count integer;
begin
  if p_organization_id is null
     or not public.has_app_permission(
       p_organization_id,
       'crm.integrations.manage'
     ) then
    raise exception 'Seu perfil nao pode gerenciar integracoes do CRM.';
  end if;

  with requeued as (
    update crm_integration_private.integration_inbox_events inbox
    set status = 'pending',
        -- attempt_count e monotono: reutilizar numero quebraria a unicidade
        -- das transicoes e poderia deixar um claim omitido no RETURNING.
        max_attempts = least(
          100,
          inbox.attempt_count + inbox.attempts_per_cycle
        ),
        requeue_count = inbox.requeue_count + 1,
        next_attempt_at = now(),
        lock_token = null,
        lease_owner = null,
        lease_expires_at = null,
        last_error_code = null,
        last_error_message = null,
        last_error_details = '{}'::jsonb,
        last_error_at = null,
        updated_at = now()
    from public.crm_meta_lead_routes route,
         crm_integration_private.integration_webhook_deliveries delivery
    where inbox.organization_id = p_organization_id
      and inbox.status = 'dead_letter'
      and inbox.route_id = route.id
      and route.organization_id = inbox.organization_id
      and route.active
      and inbox.first_delivery_id = delivery.id
      and inbox.raw_retention_until > now()
      and inbox.raw_purged_at is null
      and delivery.raw_retention_until > now()
      and delivery.raw_purged_at is null
      and inbox.requeue_count < 100
      and inbox.attempt_count < 100
    returning
      inbox.id, inbox.organization_id, inbox.requeue_count
  ), transitions as (
    insert into crm_integration_private.integration_inbox_transitions (
      event_id, organization_id, attempt_number, transition, details
    )
    select
      requeued.id,
      requeued.organization_id,
      requeued.requeue_count,
      'requeued',
      jsonb_build_object('manual_admin_requeue', true)
    from requeued
    on conflict (event_id, attempt_number, transition) do nothing
    returning event_id
  )
  select count(*)::integer into requeued_count
  from requeued;

  return requeued_count;
end
$function$;

revoke all on function public.requeue_meta_lead_failures(uuid)
  from public, anon, service_role;
grant execute on function public.requeue_meta_lead_failures(uuid)
  to authenticated;

-- Pausa atomica usada antes do ResetCenter iniciar deletes em varias
-- requisicoes. O enqueue toma SHARE na rota: ou conclui antes deste lock
-- e seu inbox e removido, ou enxerga a rota inativa e preserva o lead como
-- unmapped para remapeamento automatico depois da reativacao.
create or replace function public.pause_meta_lead_ingress(
  p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  active_route_ids uuid[] := array[]::uuid[];
  delivery_ids uuid[];
  transition_count integer := 0;
  inbox_count integer := 0;
  paused_count integer := 0;
  delivery_count integer := 0;
begin
  if p_organization_id is null
     or not public.has_app_permission(
       p_organization_id,
       'platform.manage'
     ) then
    raise exception 'Seu perfil nao pode pausar a entrada de leads Meta.';
  end if;

  perform 1
  from public.crm_meta_lead_routes route
  where route.organization_id = p_organization_id
  order by route.id
  for update;

  select coalesce(
    array_agg(route.id order by route.id),
    array[]::uuid[]
  ) into active_route_ids
  from public.crm_meta_lead_routes route
  where route.organization_id = p_organization_id
    and route.active;

  with paused as (
    update public.crm_meta_lead_routes route
    set active = false,
        updated_at = now(),
        updated_by = coalesce(auth.uid(), route.updated_by)
    where route.organization_id = p_organization_id
      and route.active
    returning 1
  ) select count(*)::integer into paused_count from paused;

  select array_agg(distinct candidate.delivery_id)
  into delivery_ids
  from (
    select inbox.first_delivery_id as delivery_id
    from crm_integration_private.integration_inbox_events inbox
    where inbox.organization_id = p_organization_id
    union
    select inbox.last_delivery_id as delivery_id
    from crm_integration_private.integration_inbox_events inbox
    where inbox.organization_id = p_organization_id
  ) candidate;

  perform 1
  from crm_integration_private.integration_webhook_deliveries delivery
  where delivery.id = any(coalesce(delivery_ids, array[]::uuid[]))
  order by delivery.id
  for update;

  select count(*)::integer into transition_count
  from crm_integration_private.integration_inbox_transitions transition_row
  where transition_row.organization_id = p_organization_id;

  with removed as (
    delete from crm_integration_private.integration_inbox_events inbox
    where inbox.organization_id = p_organization_id
    returning 1
  ) select count(*)::integer into inbox_count from removed;

  with removed as (
    delete from crm_integration_private.integration_webhook_deliveries delivery
    where delivery.id = any(coalesce(delivery_ids, array[]::uuid[]))
      and not exists (
        select 1
        from crm_integration_private.integration_inbox_events inbox
        where inbox.first_delivery_id = delivery.id
           or inbox.last_delivery_id = delivery.id
      )
    returning 1
  ) select count(*)::integer into delivery_count from removed;

  return jsonb_build_object(
    'active_route_ids', to_jsonb(active_route_ids),
    'counts', jsonb_build_object(
      'routes_paused', paused_count,
      'inbox_events', inbox_count,
      'inbox_transitions', transition_count,
      'webhook_deliveries', delivery_count
    )
  );
end
$function$;

revoke all on function public.pause_meta_lead_ingress(uuid)
  from public, anon, service_role;
grant execute on function public.pause_meta_lead_ingress(uuid)
  to authenticated;

-- Boundary atomico usado pelo RestoreCenter. O lock das rotas precede a
-- limpeza do inbox: um enqueue concorrente que ja referencie uma rota aguarda
-- e falha pela FK depois do commit, deixando o retry da Meta reenfileirar no
-- catalogo restaurado. Nenhuma tabela canonica Stage 1 e removida aqui.
create or replace function public.prepare_meta_lead_restore(
  p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  delivery_ids uuid[];
  transition_count integer := 0;
  inbox_count integer := 0;
  route_count integer := 0;
  delivery_count integer := 0;
begin
  if p_organization_id is null
     or not public.has_app_permission(
       p_organization_id,
       'platform.manage'
     )
     or not public.crm_canonical_restore_active(p_organization_id) then
    raise exception
      'Restore Meta exige permissao platform.manage e janela canonica ativa.';
  end if;

  -- FOR UPDATE conflita com o SHARE explicito do roteamento e o KEY SHARE da
  -- FK do inbox. O lock
  -- acontece antes da leitura/delecao para fechar a corrida restore x enqueue.
  perform 1
  from public.crm_meta_lead_routes route
  where route.organization_id = p_organization_id
  order by route.id
  for update;

  select array_agg(distinct candidate.delivery_id)
  into delivery_ids
  from (
    select inbox.first_delivery_id as delivery_id
    from crm_integration_private.integration_inbox_events inbox
    where inbox.organization_id = p_organization_id
    union
    select inbox.last_delivery_id as delivery_id
    from crm_integration_private.integration_inbox_events inbox
    where inbox.organization_id = p_organization_id
  ) candidate;

  perform 1
  from crm_integration_private.integration_webhook_deliveries delivery
  where delivery.id = any(coalesce(delivery_ids, array[]::uuid[]))
  order by delivery.id
  for update;

  select count(*)::integer into transition_count
  from crm_integration_private.integration_inbox_transitions transition_row
  where transition_row.organization_id = p_organization_id;

  with removed as (
    delete from crm_integration_private.integration_inbox_events inbox
    where inbox.organization_id = p_organization_id
    returning 1
  ) select count(*)::integer into inbox_count from removed;

  with removed as (
    delete from public.crm_meta_lead_routes route
    where route.organization_id = p_organization_id
    returning 1
  ) select count(*)::integer into route_count from removed;

  with removed as (
    delete from crm_integration_private.integration_webhook_deliveries delivery
    where delivery.id = any(coalesce(delivery_ids, array[]::uuid[]))
      and not exists (
        select 1
        from crm_integration_private.integration_inbox_events inbox
        where inbox.first_delivery_id = delivery.id
           or inbox.last_delivery_id = delivery.id
      )
    returning 1
  ) select count(*)::integer into delivery_count from removed;

  return jsonb_build_object(
    'meta_inbox_events', inbox_count,
    'meta_inbox_transitions', transition_count,
    'meta_webhook_deliveries', delivery_count,
    'meta_lead_routes', route_count
  );
end
$function$;

revoke all on function public.prepare_meta_lead_restore(uuid)
  from public, anon, service_role;
grant execute on function public.prepare_meta_lead_restore(uuid)
  to authenticated;

-- Minimizacao LGPD: os hashes e o estado operacional ficam para auditoria e
-- idempotencia, mas corpos/headers/payloads deixam de permanecer apos 90 dias.
create or replace function
  crm_integration_private.purge_meta_lead_raw_payloads()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  delivery_count integer;
  event_count integer;
begin
  with candidates as (
    select delivery.id
    from crm_integration_private.integration_webhook_deliveries delivery
    where delivery.raw_purged_at is null
      and delivery.raw_retention_until <= now()
    order by delivery.id
    for update
  ), purged as (
    update crm_integration_private.integration_webhook_deliveries delivery
    set raw_body = '{}'::jsonb,
        request_headers = '{}'::jsonb,
        raw_purged_at = now()
    from candidates candidate
    where delivery.id = candidate.id
    returning 1
  ) select count(*)::integer into delivery_count from purged;

  with candidates as (
    select inbox.id
    from crm_integration_private.integration_inbox_events inbox
    where inbox.raw_purged_at is null
      and inbox.raw_retention_until <= now()
    order by inbox.id
    for update
  ), purged as (
    update crm_integration_private.integration_inbox_events inbox
    set event_payload = '{}'::jsonb,
        lead_payload = null,
        raw_purged_at = now(),
        updated_at = now()
    from candidates candidate
    where inbox.id = candidate.id
    returning 1
  ) select count(*)::integer into event_count from purged;

  return jsonb_build_object(
    'deliveries_minimized', delivery_count,
    'events_minimized', event_count
  );
end
$function$;

revoke all on function
  crm_integration_private.purge_meta_lead_raw_payloads()
  from public, anon, authenticated, service_role;

-- Dispatcher sem segredo no catalogo do cron. URL e credencial sao lidas
-- exclusivamente do Vault a cada execucao; ausencia/invalidez e no-op seguro.
create or replace function
  crm_integration_private.dispatch_meta_lead_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  worker_url text;
  worker_secret text;
  request_id bigint;
begin
  select secret.decrypted_secret
  into worker_url
  from vault.decrypted_secrets secret
  where secret.name = 'evora_meta_worker_url'
  order by secret.created_at desc
  limit 1;

  select secret.decrypted_secret
  into worker_secret
  from vault.decrypted_secrets secret
  where secret.name = 'evora_meta_worker_secret'
  order by secret.created_at desc
  limit 1;

  worker_url := nullif(trim(worker_url), '');
  worker_secret := nullif(trim(worker_secret), '');
  if worker_url is null
     or worker_secret is null
     or worker_url !~ '^https://'
     or char_length(worker_url) > 2048
     or char_length(worker_secret) > 4096 then
    return null;
  end if;

  select net.http_post(
    url := worker_url,
    body := jsonb_build_object(
      'source', 'pg_cron',
      'requested_at', now()
    ),
    params := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || worker_secret
    ),
    timeout_milliseconds := 5000
  ) into request_id;

  return request_id;
end
$function$;

revoke all on function
  crm_integration_private.dispatch_meta_lead_worker()
  from public, anon, authenticated, service_role;

-- Idempotente em replay de migration local/branch.
do $schedule_meta_jobs$
begin
  perform cron.unschedule(job.jobid)
  from cron.job job
  where job.jobname in (
    'evora-meta-lead-dispatch-5m',
    'evora-meta-lead-retention-daily'
  );

  perform cron.schedule(
    'evora-meta-lead-dispatch-5m',
    '*/5 * * * *',
    'select crm_integration_private.dispatch_meta_lead_worker()'
  );
  perform cron.schedule(
    'evora-meta-lead-retention-daily',
    '17 3 * * *',
    'select crm_integration_private.purge_meta_lead_raw_payloads()'
  );
end
$schedule_meta_jobs$;

-- Estende o boundary canonico de reset sem conceder DELETE browser-side nas
-- tabelas restritas. O wrapper publico Stage 1 continua chamando exatamente
-- o mesmo nome interno.
alter function
  crm_private.purge_crm_canonical_data_internal(uuid, boolean)
  rename to purge_crm_canonical_data_stage1_internal;

revoke all on function
  crm_private.purge_crm_canonical_data_stage1_internal(uuid, boolean)
  from public, anon, authenticated, service_role;

create or replace function crm_private.purge_crm_canonical_data_internal(
  p_organization_id uuid,
  p_include_catalogs boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  stage1_result jsonb;
  delivery_ids uuid[];
  transition_count integer := 0;
  inbox_count integer := 0;
  delivery_count integer := 0;
  route_count integer := 0;
begin
  -- A validacao vem antes de qualquer delete novo. A funcao Stage 1 repete
  -- a mesma verificacao como defesa em profundidade.
  if p_organization_id is null
     or not public.has_app_permission(
       p_organization_id,
       'platform.manage'
     ) then
    raise exception 'Seu perfil nao pode limpar os dados canonicos do CRM.';
  end if;

  -- No reset completo as rotas tambem serao removidas. O lock antecede a
  -- leitura do inbox e fecha a corrida FK entre enqueue e delete da rota.
  if p_include_catalogs then
    perform 1
    from public.crm_meta_lead_routes route
    where route.organization_id = p_organization_id
    order by route.id
    for update;
  end if;

  select array_agg(distinct candidate.delivery_id)
  into delivery_ids
  from (
    select inbox.first_delivery_id as delivery_id
    from crm_integration_private.integration_inbox_events inbox
    where inbox.organization_id = p_organization_id
    union
    select inbox.last_delivery_id as delivery_id
    from crm_integration_private.integration_inbox_events inbox
    where inbox.organization_id = p_organization_id
  ) candidate;

  perform 1
  from crm_integration_private.integration_webhook_deliveries delivery
  where delivery.id = any(coalesce(delivery_ids, array[]::uuid[]))
  order by delivery.id
  for update;

  select count(*)::integer into transition_count
  from crm_integration_private.integration_inbox_transitions transition_row
  where transition_row.organization_id = p_organization_id;

  with removed as (
    delete from crm_integration_private.integration_inbox_events inbox
    where inbox.organization_id = p_organization_id
    returning 1
  ) select count(*)::integer into inbox_count from removed;

  if p_include_catalogs then
    with removed as (
      delete from public.crm_meta_lead_routes route
      where route.organization_id = p_organization_id
      returning 1
    ) select count(*)::integer into route_count from removed;
  end if;

  with removed as (
    delete from crm_integration_private.integration_webhook_deliveries delivery
    where delivery.id = any(coalesce(delivery_ids, array[]::uuid[]))
      and not exists (
        select 1
        from crm_integration_private.integration_inbox_events inbox
        where inbox.first_delivery_id = delivery.id
           or inbox.last_delivery_id = delivery.id
      )
    returning 1
  ) select count(*)::integer into delivery_count from removed;

  stage1_result :=
    crm_private.purge_crm_canonical_data_stage1_internal(
      p_organization_id,
      p_include_catalogs
    );

  return stage1_result || jsonb_build_object(
    'meta_inbox_events', inbox_count,
    'meta_inbox_transitions', transition_count,
    'meta_webhook_deliveries', delivery_count,
    'meta_lead_routes', route_count
  );
end
$function$;

revoke all on function
  crm_private.purge_crm_canonical_data_internal(uuid, boolean)
  from public, anon, service_role;
grant execute on function
  crm_private.purge_crm_canonical_data_internal(uuid, boolean)
  to authenticated;

-- O backup canonico inclui designacoes e seus eventos. Mutacoes autenticadas
-- continuam fechadas no uso cotidiano e so abrem durante a janela de restore
-- aprovada. As FKs compostas impedem referencias cruzadas entre tenants.
create unique index crm_lead_assignments_org_id_uidx
  on public.crm_lead_assignments (organization_id, id);
create index crm_lead_assignments_record_org_fk_idx
  on public.crm_lead_assignments (organization_id, crm_record_id);
create index crm_lead_assignment_events_assignment_org_fk_idx
  on public.crm_lead_assignment_events (organization_id, assignment_id);

alter table public.crm_lead_assignments
  drop constraint crm_lead_assignments_crm_record_id_fkey,
  add constraint crm_lead_assignments_record_org_fk
    foreign key (organization_id, crm_record_id)
    references public.crm_records(organization_id, id)
    on delete cascade not valid;

alter table public.crm_lead_assignment_events
  drop constraint crm_lead_assignment_events_assignment_id_fkey,
  add constraint crm_lead_assignment_events_assignment_org_fk
    foreign key (organization_id, assignment_id)
    references public.crm_lead_assignments(organization_id, id)
    on delete cascade not valid;

alter table public.crm_lead_assignments
  validate constraint crm_lead_assignments_record_org_fk;
alter table public.crm_lead_assignment_events
  validate constraint crm_lead_assignment_events_assignment_org_fk;

create policy crm_lead_assignments_restore_insert
on public.crm_lead_assignments
for insert to authenticated
with check (public.crm_canonical_restore_active(organization_id));

create policy crm_lead_assignments_restore_update
on public.crm_lead_assignments
for update to authenticated
using (public.crm_canonical_restore_active(organization_id))
with check (public.crm_canonical_restore_active(organization_id));

create policy crm_lead_assignments_restore_delete
on public.crm_lead_assignments
for delete to authenticated
using (public.crm_canonical_restore_active(organization_id));

create policy crm_lead_assignment_events_restore_insert
on public.crm_lead_assignment_events
for insert to authenticated
with check (public.crm_canonical_restore_active(organization_id));

create policy crm_lead_assignment_events_restore_update
on public.crm_lead_assignment_events
for update to authenticated
using (public.crm_canonical_restore_active(organization_id))
with check (public.crm_canonical_restore_active(organization_id));

create policy crm_lead_assignment_events_restore_delete
on public.crm_lead_assignment_events
for delete to authenticated
using (public.crm_canonical_restore_active(organization_id));

grant insert, update, delete on table public.crm_lead_assignments
  to authenticated;
grant insert, update, delete on table public.crm_lead_assignment_events
  to authenticated;

-- O backend pode acrescentar fatos ao ledger, nunca reescrever/apagar fatos
-- existentes. Restore autenticado continua restrito pelas policies acima.
revoke all on table public.crm_lead_assignment_events
  from public, anon, service_role;
grant select, insert on table public.crm_lead_assignment_events
  to service_role;

-- Somente a configuracao nao secreta e administravel pela UI. Inbox,
-- deliveries e transicoes nao recebem policy nem privilegio de tabela.
alter table public.crm_meta_lead_routes enable row level security;

create policy crm_meta_lead_routes_select
on public.crm_meta_lead_routes
for select to authenticated
using (
  public.has_app_permission(organization_id, 'crm.integrations.manage')
);

create policy crm_meta_lead_routes_insert
on public.crm_meta_lead_routes
for insert to authenticated
with check (
  public.has_app_permission(organization_id, 'crm.integrations.manage')
);

create policy crm_meta_lead_routes_update
on public.crm_meta_lead_routes
for update to authenticated
using (
  public.has_app_permission(organization_id, 'crm.integrations.manage')
)
with check (
  public.has_app_permission(organization_id, 'crm.integrations.manage')
);

create policy crm_meta_lead_routes_delete
on public.crm_meta_lead_routes
for delete to authenticated
using (
  public.has_app_permission(organization_id, 'crm.integrations.manage')
);

revoke all on table public.crm_meta_lead_routes
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.crm_meta_lead_routes
  to authenticated;

comment on table public.crm_meta_lead_routes is
  'Configuracao nao secreta Meta page/form -> contexto canonico do CRM; alteracoes entram em audit_logs.';
comment on table
  crm_integration_private.integration_webhook_deliveries is
  'Delivery Meta restrito, assinatura verificada, raw unico e minimizado apos 90 dias.';
comment on table crm_integration_private.integration_inbox_events is
  'Inbox Meta restrito com idempotencia, retries, lease e referencias canonicas; sem acesso Data API.';
comment on function public.enqueue_meta_lead_delivery(
  text, jsonb, jsonb, boolean, jsonb, text, timestamptz, integer
) is
  'Persiste delivery e ate 1000 notificacoes Meta na mesma transacao antes do ACK HTTP.';
comment on function public.ingest_meta_lead(uuid, uuid, jsonb) is
  'Revalida/locka catalogos e materializa pessoa, nova oportunidade por meta_lead_id, atribuicao, campanha e assignment sob lease cercado.';
comment on function public.prepare_meta_lead_restore(uuid) is
  'Remove atomica e exclusivamente rotas/inbox Meta da organizacao durante uma janela canonica de restore ativa.';
comment on function public.pause_meta_lead_ingress(uuid) is
  'Pausa rotas e limpa o inbox Meta atomicamente antes de um reset multi-request; retorna somente IDs de rotas e contagens.';

do $postflight$
declare
  table_oid oid;
  role_name text;
  worker_function regprocedure;
  function_row record;
  dispatcher_definition text;
  restore_definition text;
  pause_definition text;
  purge_definition text;
  enqueue_definition text;
  phone_normalizer_definition text;
  ingest_definition text;
  claim_definition text;
  retention_definition text;
  route_validator_definition text;
begin
  if not exists (
    select 1
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'crm_meta_lead_routes'
      and relation.relrowsecurity
  ) or (
    select count(*)
    from pg_policy policy
    where policy.polrelid = 'public.crm_meta_lead_routes'::regclass
  ) <> 4 then
    raise exception 'RLS/policies das rotas Meta divergem do contrato.';
  end if;

  foreach table_oid in array array[
    'crm_integration_private.integration_webhook_deliveries'::regclass::oid,
    'crm_integration_private.integration_inbox_events'::regclass::oid,
    'crm_integration_private.integration_inbox_transitions'::regclass::oid
  ] loop
    if not (select relation.relrowsecurity from pg_class relation
            where relation.oid = table_oid)
       or exists (
         select 1 from pg_policy policy where policy.polrelid = table_oid
       ) then
      raise exception 'Tabela privada Meta sem RLS deny-by-default.';
    end if;

    foreach role_name in array array[
      'anon', 'authenticated', 'service_role'
    ] loop
      if has_table_privilege(role_name, table_oid, 'SELECT')
         or has_table_privilege(role_name, table_oid, 'INSERT')
         or has_table_privilege(role_name, table_oid, 'UPDATE')
         or has_table_privilege(role_name, table_oid, 'DELETE')
         or has_table_privilege(role_name, table_oid, 'TRUNCATE')
         or has_table_privilege(role_name, table_oid, 'REFERENCES')
         or has_table_privilege(role_name, table_oid, 'TRIGGER') then
        raise exception 'ACL de tabela privada Meta diverge do contrato.';
      end if;
    end loop;
  end loop;

  if has_schema_privilege('anon', 'crm_integration_private', 'USAGE')
     or has_schema_privilege(
       'authenticated', 'crm_integration_private', 'USAGE'
     )
     or has_schema_privilege(
       'service_role', 'crm_integration_private', 'USAGE'
     ) then
    raise exception 'Schema privado Meta exposto a papeis da Data API.';
  end if;

  if not has_table_privilege(
       'authenticated', 'public.crm_meta_lead_routes', 'SELECT'
     )
     or not has_table_privilege(
       'authenticated', 'public.crm_meta_lead_routes', 'INSERT'
     )
     or not has_table_privilege(
       'authenticated', 'public.crm_meta_lead_routes', 'UPDATE'
     )
     or not has_table_privilege(
       'authenticated', 'public.crm_meta_lead_routes', 'DELETE'
     )
     or has_table_privilege(
       'anon', 'public.crm_meta_lead_routes', 'SELECT'
     )
     or has_table_privilege(
       'service_role', 'public.crm_meta_lead_routes', 'SELECT'
     ) then
    raise exception 'ACL da configuracao Meta diverge do contrato.';
  end if;

  foreach worker_function in array array[
    'public.enqueue_meta_lead_delivery(text,jsonb,jsonb,boolean,jsonb,text,timestamp with time zone,integer)'::regprocedure,
    'public.claim_meta_lead_events(text,integer,integer)'::regprocedure,
    'public.ingest_meta_lead(uuid,uuid,jsonb)'::regprocedure,
    'public.fail_meta_lead_event(uuid,uuid,text,text,boolean,integer,jsonb)'::regprocedure
  ] loop
    if not has_function_privilege(
         'service_role', worker_function, 'EXECUTE'
       )
       or has_function_privilege(
         'anon', worker_function, 'EXECUTE'
       )
       or has_function_privilege(
         'authenticated', worker_function, 'EXECUTE'
       ) then
      raise exception 'ACL de RPC worker Meta diverge do contrato.';
    end if;
  end loop;

  foreach worker_function in array array[
    'public.get_meta_lead_integration_status(uuid)'::regprocedure,
    'public.requeue_meta_lead_failures(uuid)'::regprocedure,
    'public.pause_meta_lead_ingress(uuid)'::regprocedure,
    'public.prepare_meta_lead_restore(uuid)'::regprocedure
  ] loop
    if not has_function_privilege(
         'authenticated', worker_function, 'EXECUTE'
       )
       or has_function_privilege(
         'anon', worker_function, 'EXECUTE'
       )
       or has_function_privilege(
         'service_role', worker_function, 'EXECUTE'
       ) then
      raise exception 'ACL de RPC administrativa Meta diverge do contrato.';
    end if;
  end loop;

  for function_row in
    select
      procedure.oid::regprocedure as signature,
      procedure.prosecdef,
      procedure.proconfig,
      pg_get_userbyid(procedure.proowner) as owner_name
    from pg_proc procedure
    where procedure.oid = any(array[
      'public.enqueue_meta_lead_delivery(text,jsonb,jsonb,boolean,jsonb,text,timestamp with time zone,integer)'::regprocedure::oid,
      'public.claim_meta_lead_events(text,integer,integer)'::regprocedure::oid,
      'public.ingest_meta_lead(uuid,uuid,jsonb)'::regprocedure::oid,
      'public.fail_meta_lead_event(uuid,uuid,text,text,boolean,integer,jsonb)'::regprocedure::oid,
      'public.get_meta_lead_integration_status(uuid)'::regprocedure::oid,
      'public.requeue_meta_lead_failures(uuid)'::regprocedure::oid,
      'public.pause_meta_lead_ingress(uuid)'::regprocedure::oid,
      'public.prepare_meta_lead_restore(uuid)'::regprocedure::oid,
      'crm_integration_private.normalize_phone_e164(text,text)'::regprocedure::oid,
      'crm_integration_private.validate_meta_lead_route()'::regprocedure::oid,
      'crm_integration_private.purge_meta_lead_raw_payloads()'::regprocedure::oid,
      'crm_integration_private.dispatch_meta_lead_worker()'::regprocedure::oid,
      'crm_private.purge_crm_canonical_data_internal(uuid,boolean)'::regprocedure::oid
    ])
  loop
    if not function_row.prosecdef
       or function_row.owner_name <> 'postgres'
       or not (
         coalesce(function_row.proconfig, array[]::text[])
         @> array['search_path=""']::text[]
       ) then
      raise exception
        'Boundary Meta % possui hardening divergente.',
        function_row.signature;
    end if;
  end loop;

  if not exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.crm_meta_lead_routes'::regclass
      and trigger_row.tgname = 'crm_meta_lead_routes_audit'
      and trigger_row.tgfoid =
        'public.audit_business_entity()'::regprocedure
      and not trigger_row.tgisinternal
  ) then
    raise exception 'Trigger de auditoria da configuracao Meta ausente.';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
          'crm_integration_private.integration_inbox_events'::regclass
      and constraint_row.conname = 'integration_inbox_events_route_fk'
      and constraint_row.confdeltype = 'r'
      and constraint_row.convalidated
  ) then
    raise exception 'FK route->inbox nao esta em RESTRICT.';
  end if;

  select lower(pg_get_functiondef(
    'public.prepare_meta_lead_restore(uuid)'::regprocedure
  )) into restore_definition;
  if position('for update' in restore_definition) = 0
     or position(
       'crm_canonical_restore_active(p_organization_id)'
       in restore_definition
     ) = 0
     or position(
       'delete from crm_integration_private.integration_inbox_events'
       in restore_definition
     ) = 0
     or position(
       'delete from public.crm_meta_lead_routes'
       in restore_definition
     ) = 0
     or position('order by route.id' in restore_definition) = 0
     or position('order by delivery.id' in restore_definition) = 0
     or position('order by route.id' in restore_definition) >=
        position('order by delivery.id' in restore_definition)
     or position('order by delivery.id' in restore_definition) >=
        position(
          'delete from crm_integration_private.integration_inbox_events'
          in restore_definition
        ) then
    raise exception 'Boundary atomico do restore Meta diverge do contrato.';
  end if;

  select lower(pg_get_functiondef(
    'public.pause_meta_lead_ingress(uuid)'::regprocedure
  )) into pause_definition;
  if position('for update' in pause_definition) = 0
     or position('set active = false' in pause_definition) = 0
     or position(
       'delete from crm_integration_private.integration_inbox_events'
       in pause_definition
     ) = 0
     or position('active_route_ids' in pause_definition) = 0
     or position('order by route.id' in pause_definition) = 0
     or position('order by delivery.id' in pause_definition) = 0
     or position('order by route.id' in pause_definition) >=
        position('order by delivery.id' in pause_definition)
     or position('order by delivery.id' in pause_definition) >=
        position(
          'delete from crm_integration_private.integration_inbox_events'
          in pause_definition
        ) then
    raise exception 'Boundary atomico do reset Meta diverge do contrato.';
  end if;

  select lower(pg_get_functiondef(
    'public.enqueue_meta_lead_delivery(text,jsonb,jsonb,boolean,jsonb,text,timestamp with time zone,integer)'::regprocedure
  )) into enqueue_definition;
  if position('for share' in enqueue_definition) = 0
     or position('order by route.id' in enqueue_definition) = 0
     or position(
       'insert into crm_integration_private.integration_webhook_deliveries'
       in enqueue_definition
     ) = 0
     or position(
       'insert into crm_integration_private.integration_inbox_events'
       in enqueue_definition
     ) = 0
     or position('order by route.id' in enqueue_definition) >=
        position(
          'insert into crm_integration_private.integration_webhook_deliveries'
          in enqueue_definition
        )
     or position(
          'insert into crm_integration_private.integration_webhook_deliveries'
          in enqueue_definition
        ) >= position(
          'insert into crm_integration_private.integration_inbox_events'
          in enqueue_definition
        ) then
    raise exception 'Enqueue Meta nao participa do fencing de pause/reset.';
  end if;

  select lower(pg_get_functiondef(
    'public.claim_meta_lead_events(text,integer,integer)'::regprocedure
  )) into claim_definition;
  if position('order by route.id' in claim_definition) = 0
     or position('for share' in claim_definition) = 0
     or position('order by route.id' in claim_definition) >=
        position(
          'update crm_integration_private.integration_inbox_events inbox'
          in claim_definition
        ) then
    raise exception 'Remapeamento Meta nao segue route antes de inbox.';
  end if;

  select lower(pg_get_functiondef(
    'crm_integration_private.normalize_phone_e164(text,text)'::regprocedure
  )) into phone_normalizer_definition;
  if position(
       'left(trimmed_value, 2) = ''00'''
       in phone_normalizer_definition
     ) = 0
     or position(
       'char_length(digits) in (11, 12)'
       in phone_normalizer_definition
     ) = 0
     or position(
       'char_length(digits) between 10 and 11'
       in phone_normalizer_definition
     ) = 0
     or (
       select procedure.provolatile
       from pg_proc procedure
       where procedure.oid =
         'crm_integration_private.normalize_phone_e164(text,text)'::regprocedure
     ) <> 'i' then
    raise exception 'Normalizador E.164 diverge do contrato server-side.';
  end if;

  foreach role_name in array array[
    'anon', 'authenticated', 'service_role'
  ] loop
    if has_function_privilege(
      role_name,
      'crm_integration_private.normalize_phone_e164(text,text)'::regprocedure,
      'EXECUTE'
    ) then
      raise exception 'Normalizador privado E.164 ficou exposto a Data API.';
    end if;
  end loop;

  select lower(pg_get_functiondef(
    'public.ingest_meta_lead(uuid,uuid,jsonb)'::regprocedure
  )) into ingest_definition;
  if position('meta_project_inactive' in ingest_definition) = 0
     or position('meta_product_inactive' in ingest_definition) = 0
     or position('meta_pipeline_inactive' in ingest_definition) = 0
     or position('meta_initial_stage_inactive' in ingest_definition) = 0
     or position('meta_route_team_invalid' in ingest_definition) = 0
     or position('from public.projects project' in ingest_definition) = 0
     or position('from public.crm_products product' in ingest_definition) = 0
     or position('from public.crm_pipelines pipeline' in ingest_definition) = 0
     or position('from public.crm_teams team' in ingest_definition) = 0
     or position('for share' in ingest_definition) = 0
     or position('select route.* into route_row' in ingest_definition) = 0
     or position(
       'from crm_integration_private.integration_inbox_events locked_inbox'
       in ingest_definition
     ) = 0
     or position('select route.* into route_row' in ingest_definition) >=
        position(
          'from crm_integration_private.integration_inbox_events locked_inbox'
          in ingest_definition
        )
     or position(
       'inbox_row.route_id is distinct from route_row.id'
       in ingest_definition
     ) = 0 then
    raise exception 'Revalidacao runtime dos catalogos Meta esta incompleta.';
  end if;

  if position(
       'and member.user_id = continuity_row.sdr_user_id'
       in ingest_definition
     ) = 0
     or position(
       'for share'
       in substring(
         ingest_definition
         from position(
           'and member.user_id = continuity_row.sdr_user_id'
           in ingest_definition
         )
         for 220
       )
     ) = 0
     or position(
       'and member.user_id = continuity_row.broker_user_id'
       in ingest_definition
     ) = 0
     or position(
       'for share'
       in substring(
         ingest_definition
         from position(
           'and member.user_id = continuity_row.broker_user_id'
           in ingest_definition
         )
         for 220
       )
     ) = 0
     or position(
       'and team.id = continuity_row.team_id'
       in ingest_definition
     ) = 0
     or position(
       'for share'
       in substring(
         ingest_definition
         from position(
           'and team.id = continuity_row.team_id'
           in ingest_definition
         )
         for 850
       )
     ) = 0 then
    raise exception
      'Continuidade Meta nao trava equipe/papeis secundarios ativos.';
  end if;

  select lower(pg_get_functiondef(
    'crm_private.purge_crm_canonical_data_internal(uuid,boolean)'::regprocedure
  )) into purge_definition;
  if position('if p_include_catalogs then' in purge_definition) = 0
     or position('for update' in purge_definition) = 0
     or position('order by route.id' in purge_definition) = 0
     or position('order by delivery.id' in purge_definition) = 0
     or position('order by route.id' in purge_definition) >=
        position('order by delivery.id' in purge_definition)
     or position('order by delivery.id' in purge_definition) >=
        position(
          'delete from crm_integration_private.integration_inbox_events'
          in purge_definition
        ) then
    raise exception 'Reset completo Meta nao possui lock preventivo.';
  end if;

  select lower(pg_get_functiondef(
    'crm_integration_private.purge_meta_lead_raw_payloads()'::regprocedure
  )) into retention_definition;
  if position('order by delivery.id' in retention_definition) = 0
     or position('order by inbox.id' in retention_definition) = 0
     or position('order by delivery.id' in retention_definition) >=
        position('order by inbox.id' in retention_definition) then
    raise exception 'Retencao Meta nao segue delivery antes de inbox.';
  end if;

  select lower(pg_get_functiondef(
    'crm_integration_private.validate_meta_lead_route()'::regprocedure
  )) into route_validator_definition;
  if position('if new.active then' in route_validator_definition) = 0
     or position(
       'from public.crm_lead_sources source'
       in route_validator_definition
     ) <= position('if new.active then' in route_validator_definition)
     or position('from public.projects project' in route_validator_definition)
        <= position('if new.active then' in route_validator_definition) then
    raise exception 'Rota Meta inativa ainda depende de catalogo ativo.';
  end if;

  if not exists (
    select 1 from pg_constraint constraint_row
    where constraint_row.conrelid =
          'public.crm_lead_assignments'::regclass
      and constraint_row.conname =
          'crm_lead_assignments_record_org_fk'
      and constraint_row.convalidated
  ) or not exists (
    select 1 from pg_constraint constraint_row
    where constraint_row.conrelid =
          'public.crm_lead_assignment_events'::regclass
      and constraint_row.conname =
          'crm_lead_assignment_events_assignment_org_fk'
      and constraint_row.convalidated
  ) then
    raise exception 'FKs multitenant das designacoes nao foram validadas.';
  end if;

  if (
    select count(*)
    from pg_policy policy
    where policy.polrelid in (
      'public.crm_lead_assignments'::regclass,
      'public.crm_lead_assignment_events'::regclass
    )
      and policy.polname in (
        'crm_lead_assignments_restore_insert',
        'crm_lead_assignments_restore_update',
        'crm_lead_assignments_restore_delete',
        'crm_lead_assignment_events_restore_insert',
        'crm_lead_assignment_events_restore_update',
        'crm_lead_assignment_events_restore_delete'
      )
  ) <> 6
  or not has_table_privilege(
    'authenticated', 'public.crm_lead_assignments', 'INSERT'
  )
  or not has_table_privilege(
    'authenticated', 'public.crm_lead_assignments', 'UPDATE'
  )
  or not has_table_privilege(
    'authenticated', 'public.crm_lead_assignments', 'DELETE'
  )
  or not has_table_privilege(
    'authenticated', 'public.crm_lead_assignment_events', 'INSERT'
  )
  or not has_table_privilege(
    'authenticated', 'public.crm_lead_assignment_events', 'UPDATE'
  )
  or not has_table_privilege(
    'authenticated', 'public.crm_lead_assignment_events', 'DELETE'
  ) then
    raise exception 'Boundary de restore das designacoes esta incompleto.';
  end if;

  if not has_table_privilege(
       'service_role', 'public.crm_lead_assignment_events', 'SELECT'
     )
     or not has_table_privilege(
       'service_role', 'public.crm_lead_assignment_events', 'INSERT'
     )
     or has_table_privilege(
       'service_role', 'public.crm_lead_assignment_events', 'UPDATE'
     )
     or has_table_privilege(
       'service_role', 'public.crm_lead_assignment_events', 'DELETE'
     )
     or has_table_privilege(
       'service_role', 'public.crm_lead_assignment_events', 'TRUNCATE'
     ) then
    raise exception 'Ledger de eventos de designacao nao e append-only.';
  end if;

  if exists (
    select 1
    from pg_attribute attribute
    where attribute.attrelid = 'public.crm_meta_lead_routes'::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped
      and attribute.attname ~* '(token|secret|password|access_key|api_key)'
  ) then
    raise exception 'Configuracao Meta contem coluna com aparencia de segredo.';
  end if;

  if (
    select count(*)
    from cron.job job
    where job.jobname in (
      'evora-meta-lead-dispatch-5m',
      'evora-meta-lead-retention-daily'
    )
  ) <> 2
  or not exists (
    select 1 from cron.job job
    where job.jobname = 'evora-meta-lead-dispatch-5m'
      and job.schedule = '*/5 * * * *'
      and job.command =
        'select crm_integration_private.dispatch_meta_lead_worker()'
  )
  or not exists (
    select 1 from cron.job job
    where job.jobname = 'evora-meta-lead-retention-daily'
      and job.schedule = '17 3 * * *'
      and job.command =
        'select crm_integration_private.purge_meta_lead_raw_payloads()'
  )
  or exists (
    select 1 from cron.job job
    where job.jobname in (
      'evora-meta-lead-dispatch-5m',
      'evora-meta-lead-retention-daily'
    )
      and job.command ~* '(secret|authorization|https?://|vault)'
  ) then
    raise exception 'Agendamentos Meta ausentes ou contem material sensivel.';
  end if;

  select pg_get_functiondef(
    'crm_integration_private.dispatch_meta_lead_worker()'::regprocedure
  ) into dispatcher_definition;
  if position('''Authorization''' in dispatcher_definition) = 0
     or position('''Bearer '' || worker_secret' in dispatcher_definition) = 0
     or position('x-evora-worker-secret' in dispatcher_definition) > 0 then
    raise exception 'Dispatcher nao usa o contrato Bearer seguro do worker.';
  end if;
end
$postflight$;
