-- Evora Enterprise - integridade de campanha, perda normalizada e ledgers.

set lock_timeout = '5s';
set statement_timeout = '120s';

do $preflight$
begin
  if to_regclass('public.crm_records') is null
     or to_regclass('public.crm_campaigns') is null
     or to_regclass('public.marketing_campaigns') is null
     or to_regclass('public.crm_opportunity_attributions') is null
     or to_regclass('public.crm_opportunity_events') is null
     or to_regprocedure('public.crm_canonical_restore_active(uuid)') is null
     or to_regprocedure('public.purge_crm_canonical_data(uuid,boolean)') is null
     or to_regprocedure('private.touch_crm_canonical_updated_at()') is null then
    raise exception 'A fundacao canonica do CRM ainda nao foi aplicada.';
  end if;

  if exists (
    select 1
    from public.marketing_campaigns campaign
    join public.projects project on project.id = campaign.project_id
    where campaign.organization_id <> project.organization_id
  ) or exists (
    select 1
    from public.crm_campaigns crm_campaign
    join public.marketing_campaigns control_campaign
      on control_campaign.id = crm_campaign.marketing_campaign_id
    where crm_campaign.project_id is distinct from control_campaign.project_id
  ) or exists (
    select 1
    from public.crm_records record
    join public.crm_campaigns campaign on campaign.id = record.campaign_id
    where record.project_id is distinct from campaign.project_id
  ) or exists (
    select 1
    from public.crm_opportunity_attributions attribution
    join public.crm_campaigns campaign
      on campaign.id = attribution.crm_campaign_id
    where attribution.project_id is distinct from campaign.project_id
  ) or exists (
    select 1
    from public.crm_opportunity_attributions attribution
    join public.marketing_campaigns campaign
      on campaign.id = attribution.campaign_control_campaign_id
    where attribution.project_id is distinct from campaign.project_id
  ) then
    raise exception 'Existem campanhas com empreendimento ou tenant divergente.';
  end if;
end
$preflight$;

-- Campaign Control e CRM continuam dominios distintos, mas um vinculo passa a
-- exigir o mesmo tenant e o mesmo empreendimento em todas as pontas.
create unique index if not exists marketing_campaigns_org_project_id_uidx
  on public.marketing_campaigns (organization_id, project_id, id);
create unique index if not exists crm_campaigns_org_project_id_uidx
  on public.crm_campaigns (organization_id, project_id, id);

alter table public.marketing_campaigns
  add constraint marketing_campaigns_project_organization_fk
    foreign key (organization_id, project_id)
    references public.projects(organization_id, id)
    on delete set null (project_id) not valid;

alter table public.crm_campaigns
  drop constraint crm_campaigns_marketing_campaign_fk,
  add constraint crm_campaigns_marketing_project_check
    check (marketing_campaign_id is null or project_id is not null) not valid,
  add constraint crm_campaigns_marketing_campaign_fk
    foreign key (organization_id, project_id, marketing_campaign_id)
    references public.marketing_campaigns(organization_id, project_id, id)
    on delete set null (marketing_campaign_id) not valid;

alter table public.crm_records
  drop constraint crm_records_campaign_organization_fk,
  add constraint crm_records_campaign_project_check
    check (campaign_id is null or project_id is not null) not valid,
  add constraint crm_records_campaign_organization_fk
    foreign key (organization_id, project_id, campaign_id)
    references public.crm_campaigns(organization_id, project_id, id)
    on delete set null (campaign_id) not valid;

alter table public.crm_opportunity_attributions
  drop constraint crm_opportunity_attributions_crm_campaign_fk,
  drop constraint crm_opportunity_attributions_control_campaign_fk,
  add constraint crm_opportunity_attributions_crm_campaign_project_check
    check (crm_campaign_id is null or project_id is not null) not valid,
  add constraint crm_opportunity_attributions_control_campaign_project_check
    check (campaign_control_campaign_id is null or project_id is not null) not valid,
  add constraint crm_opportunity_attributions_crm_campaign_fk
    foreign key (organization_id, project_id, crm_campaign_id)
    references public.crm_campaigns(organization_id, project_id, id)
    on delete set null (crm_campaign_id) not valid,
  add constraint crm_opportunity_attributions_control_campaign_fk
    foreign key (organization_id, project_id, campaign_control_campaign_id)
    references public.marketing_campaigns(organization_id, project_id, id)
    on delete set null (campaign_control_campaign_id) not valid;

alter table public.marketing_campaigns
  validate constraint marketing_campaigns_project_organization_fk;
alter table public.crm_campaigns
  validate constraint crm_campaigns_marketing_project_check,
  validate constraint crm_campaigns_marketing_campaign_fk;
alter table public.crm_records
  validate constraint crm_records_campaign_project_check,
  validate constraint crm_records_campaign_organization_fk;
alter table public.crm_opportunity_attributions
  validate constraint crm_opportunity_attributions_crm_campaign_project_check,
  validate constraint crm_opportunity_attributions_control_campaign_project_check,
  validate constraint crm_opportunity_attributions_crm_campaign_fk,
  validate constraint crm_opportunity_attributions_control_campaign_fk;

-- Uma oportunidade que ja recebeu atribuicao nao pode ser movida para outro
-- empreendimento; a continuidade da mesma pessoa deve gerar outra oportunidade.
create or replace function private.enforce_crm_attribution_record_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  record_project_id uuid;
begin
  if new.crm_record_id is null then
    return new;
  end if;

  select record.project_id into record_project_id
  from public.crm_records record
  where record.organization_id = new.organization_id
    and record.id = new.crm_record_id;

  if not found then
    raise exception 'Oportunidade canonica nao encontrada para a atribuicao.';
  end if;
  if new.project_id is null then
    new.project_id := record_project_id;
  elsif new.project_id is distinct from record_project_id then
    raise exception 'Empreendimento da atribuicao diverge da oportunidade.';
  end if;

  return new;
end
$function$;

revoke all on function private.enforce_crm_attribution_record_project()
  from public, anon, authenticated;

create trigger crm_opportunity_attributions_enforce_record_project
before insert or update of organization_id, crm_record_id, project_id
on public.crm_opportunity_attributions
for each row execute function private.enforce_crm_attribution_record_project();

create or replace function private.guard_attributed_crm_record_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if old.project_id is distinct from new.project_id
     and exists (
       select 1
       from public.crm_opportunity_attributions attribution
       where attribution.organization_id = old.organization_id
         and attribution.opportunity_key = old.id
     ) then
    raise exception
      'Oportunidade com atribuicao nao pode mudar de empreendimento; crie outra oportunidade.';
  end if;
  return new;
end
$function$;

revoke all on function private.guard_attributed_crm_record_project()
  from public, anon, authenticated;

create trigger crm_records_guard_attributed_project
before update of project_id on public.crm_records
for each row execute function private.guard_attributed_crm_record_project();

-- O texto livre legado continua na oportunidade canonica, mas o ledger usa um
-- codigo controlado. Isso preserva o motivo de perda sem copiar observacoes ou
-- dados pessoais para o historico operacional e para o futuro outbox.
create table public.crm_loss_reasons (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  code text not null,
  name text not null,
  active boolean not null default true,
  sort_order integer not null default 0,
  system_reason boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_loss_reasons_code_check
    check (code = upper(trim(code)) and code ~ '^[A-Z0-9_]+$'
      and char_length(code) between 2 and 80),
  constraint crm_loss_reasons_name_check
    check (char_length(trim(name)) between 2 and 180),
  constraint crm_loss_reasons_sort_order_check
    check (sort_order between 0 and 10000),
  constraint crm_loss_reasons_system_code_check
    check (
      not system_reason
      or code in ('NAO_INFORMADO', 'LEGADO_NAO_CLASSIFICADO')
    ),
  constraint crm_loss_reasons_metadata_object_check
    check (jsonb_typeof(metadata) = 'object'),
  constraint crm_loss_reasons_metadata_size_check
    check (pg_column_size(metadata) <= 16384),
  constraint crm_loss_reasons_org_code_key
    unique (organization_id, code),
  constraint crm_loss_reasons_org_id_key
    unique (organization_id, id)
);

create index crm_loss_reasons_org_active_order_idx
  on public.crm_loss_reasons (organization_id, active, sort_order, name);

create or replace function private.seed_crm_loss_reasons(
  p_organization_id uuid
)
returns void
language sql
security definer
set search_path = ''
as $function$
  insert into public.crm_loss_reasons (
    organization_id, code, name, active, sort_order, system_reason
  )
  select p_organization_id, reason.code, reason.name, true,
         reason.sort_order, reason.system_reason
  from (values
    ('NAO_INFORMADO', 'Nao informado', 10, true),
    ('SEM_CONTATO', 'Sem contato', 20, false),
    ('SEM_INTERESSE', 'Sem interesse', 30, false),
    ('PRECO_CONDICOES', 'Preco ou condicoes', 40, false),
    ('CREDITO_FINANCIAMENTO', 'Credito ou financiamento', 50, false),
    ('LOCALIZACAO', 'Localizacao', 60, false),
    ('PRODUTO_INDISPONIVEL', 'Produto indisponivel', 70, false),
    ('CONCORRENCIA', 'Escolheu concorrente', 80, false),
    ('PRAZO_MOMENTO', 'Prazo ou momento de compra', 90, false),
    ('DUPLICIDADE', 'Lead duplicado', 100, false),
    ('OUTRO', 'Outro motivo', 110, false),
    ('LEGADO_NAO_CLASSIFICADO', 'Legado nao classificado', 900, true)
  ) as reason(code, name, sort_order, system_reason)
  on conflict (organization_id, code) do nothing;
$function$;

revoke all on function private.seed_crm_loss_reasons(uuid)
  from public, anon, authenticated, service_role;

select private.seed_crm_loss_reasons(organization.id)
from public.organizations organization;

create or replace function private.seed_crm_loss_reasons_after_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.seed_crm_loss_reasons(new.id);
  return new;
end
$function$;

revoke all on function private.seed_crm_loss_reasons_after_organization()
  from public, anon, authenticated, service_role;

create trigger organizations_seed_crm_loss_reasons
after insert on public.organizations
for each row execute function private.seed_crm_loss_reasons_after_organization();

alter table public.crm_records
  add column loss_reason_id uuid;

update public.crm_records record
set loss_reason_id = reason.id
from public.crm_loss_reasons reason
where reason.organization_id = record.organization_id
  and reason.code = case
    when record.lost_reason is not null then 'LEGADO_NAO_CLASSIFICADO'
    else 'NAO_INFORMADO'
  end
  and record.record_status = 'perdida'
  and record.loss_reason_id is null;

alter table public.crm_records
  add constraint crm_records_loss_reason_fk
    foreign key (organization_id, loss_reason_id)
    references public.crm_loss_reasons(organization_id, id)
    deferrable initially deferred,
  add constraint crm_records_lost_requires_reason_check
    check (record_status is distinct from 'perdida' or loss_reason_id is not null);

create index crm_records_loss_reason_status_idx
  on public.crm_records (organization_id, loss_reason_id, record_status)
  where loss_reason_id is not null;

create or replace function private.guard_crm_system_loss_reason()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  organization_key uuid;
begin
  organization_key := case when tg_op = 'DELETE'
    then old.organization_id else new.organization_id end;

  if current_user in ('postgres', 'supabase_admin')
     or public.crm_canonical_restore_active(organization_key) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'INSERT' and new.system_reason then
    raise exception 'Motivos sistemicos so podem ser criados pela migracao.';
  end if;
  if tg_op = 'DELETE' and old.system_reason then
    raise exception 'Motivo sistemico nao pode ser removido.';
  end if;
  if tg_op = 'UPDATE' and old.system_reason and (
    new.code is distinct from old.code
    or not new.active
    or not new.system_reason
  ) then
    raise exception 'Codigo e ativacao do motivo sistemico sao imutaveis.';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$;

revoke all on function private.guard_crm_system_loss_reason()
  from public, anon, authenticated;

create trigger crm_loss_reasons_guard_system
before insert or update or delete on public.crm_loss_reasons
for each row execute function private.guard_crm_system_loss_reason();

create or replace function private.normalize_crm_record_loss_reason()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  reason_active boolean;
begin
  if new.record_status is distinct from 'perdida' then
    new.loss_reason_id := null;
    return new;
  end if;

  if new.loss_reason_id is null then
    select reason.id into new.loss_reason_id
    from public.crm_loss_reasons reason
    where reason.organization_id = new.organization_id
      and reason.code = 'NAO_INFORMADO'
      and reason.active;
  end if;

  if new.loss_reason_id is null then
    raise exception 'Motivo de perda padrao nao configurado para a organizacao.';
  end if;

  select reason.active into reason_active
  from public.crm_loss_reasons reason
  where reason.organization_id = new.organization_id
    and reason.id = new.loss_reason_id;

  if not found then
    raise exception 'Motivo de perda nao pertence a organizacao.';
  end if;
  if not reason_active
     and not public.crm_canonical_restore_active(new.organization_id) then
    if tg_op <> 'UPDATE' then
      raise exception 'Motivo de perda inativo.';
    end if;
    if old.loss_reason_id is distinct from new.loss_reason_id then
      raise exception 'Motivo de perda inativo.';
    end if;
  end if;

  return new;
end
$function$;

revoke all on function private.normalize_crm_record_loss_reason()
  from public, anon, authenticated;

create trigger crm_records_normalize_loss_reason
before insert or update of organization_id, record_status, loss_reason_id
on public.crm_records
for each row execute function private.normalize_crm_record_loss_reason();

create or replace function private.capture_crm_opportunity_context_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  source_name text;
  actor_name text;
  event_name text;
  old_reason_code text;
  new_reason_code text;
  correlation_value text;
  context_data jsonb;
begin
  if public.crm_canonical_restore_active(new.organization_id) then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.pipeline_id is not distinct from new.pipeline_id
     and old.team_id is not distinct from new.team_id
     and old.loss_reason_id is not distinct from new.loss_reason_id
     and old.record_status is not distinct from new.record_status then
    return new;
  end if;

  if tg_op = 'UPDATE' and old.loss_reason_id is not null then
    select reason.code into old_reason_code
    from public.crm_loss_reasons reason
    where reason.organization_id = old.organization_id
      and reason.id = old.loss_reason_id;
  end if;
  if new.loss_reason_id is not null then
    select reason.code into new_reason_code
    from public.crm_loss_reasons reason
    where reason.organization_id = new.organization_id
      and reason.id = new.loss_reason_id;
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
    event_name := 'opportunity.context_snapshot';
    context_data := jsonb_strip_nulls(jsonb_build_object(
      'pipeline_id', new.pipeline_id,
      'team_id', new.team_id,
      'loss_reason_code', new_reason_code
    ));
  else
    event_name := case
      when old.loss_reason_id is distinct from new.loss_reason_id
           or (
             old.record_status is distinct from new.record_status
             and new.record_status = 'perdida'
           ) then 'opportunity.loss_reason_changed'
      when old.pipeline_id is distinct from new.pipeline_id
        then 'opportunity.pipeline_changed'
      when old.team_id is distinct from new.team_id
        then 'opportunity.assignment_changed'
      else 'opportunity.context_changed'
    end;
    context_data := jsonb_strip_nulls(jsonb_build_object(
      'pipeline_id', case when old.pipeline_id is distinct from new.pipeline_id
        then jsonb_build_object('old', old.pipeline_id, 'new', new.pipeline_id) end,
      'team_id', case when old.team_id is distinct from new.team_id
        then jsonb_build_object('old', old.team_id, 'new', new.team_id) end,
      'loss_reason_code', case
        when old.loss_reason_id is distinct from new.loss_reason_id
          or old.record_status is distinct from new.record_status
        then jsonb_build_object('old', old_reason_code, 'new', new_reason_code)
      end
    ));
  end if;

  insert into public.crm_opportunity_events (
    organization_id, crm_record_id, opportunity_key, contact_id,
    project_id, product_id, lead_source_id, actor_type, actor_user_id,
    event_type, event_source, channel, occurred_at, idempotency_key,
    correlation_id, data
  ) values (
    new.organization_id, new.id, new.id, new.contact_id,
    new.project_id, new.product_id, new.lead_source_id,
    actor_name, auth.uid(), event_name, source_name,
    lower(trim(new.source_channel)), now(),
    case when tg_op = 'INSERT'
      then 'crm_record:' || new.id::text || ':context_created'
      else null
    end,
    correlation_value, context_data
  );
  return new;
end
$function$;

revoke all on function private.capture_crm_opportunity_context_event()
  from public, anon, authenticated;

create trigger crm_records_capture_context_insert
after insert on public.crm_records
for each row execute function private.capture_crm_opportunity_context_event();

create trigger crm_records_capture_context_update
after update of pipeline_id, team_id, loss_reason_id, record_status
on public.crm_records
for each row execute function private.capture_crm_opportunity_context_event();

-- O snapshot marca somente o estado observado no endurecimento; nao inventa
-- datas historicas anteriores. Eventos futuros registram cada mudanca.
insert into public.crm_opportunity_events (
  organization_id, crm_record_id, opportunity_key, contact_id,
  project_id, product_id, lead_source_id, actor_type, actor_user_id,
  event_type, event_source, channel, occurred_at, idempotency_key,
  correlation_id, data
)
select
  record.organization_id, record.id, record.id, record.contact_id,
  record.project_id, record.product_id, record.lead_source_id,
  'system', null, 'migration.context_snapshot', 'migration',
  lower(trim(record.source_channel)), now(),
  'crm_record:' || record.id::text || ':context_hardening', null,
  jsonb_strip_nulls(jsonb_build_object(
    'pipeline_id', record.pipeline_id,
    'team_id', record.team_id,
    'loss_reason_code', reason.code
  ))
from public.crm_records record
left join public.crm_loss_reasons reason
  on reason.organization_id = record.organization_id
 and reason.id = record.loss_reason_id
on conflict do nothing;

create trigger crm_loss_reasons_touch_updated_at
before update on public.crm_loss_reasons
for each row execute function private.touch_crm_canonical_updated_at();

-- A RPC de limpeza continua sendo o unico boundary que pode remover os
-- ledgers. Motivos so sao apagados quando a organizacao ja nao possui records.
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
  loss_reason_count integer := 0;
begin
  if not public.has_app_permission(p_organization_id, 'platform.manage') then
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

    if not exists (
      select 1 from public.crm_records record
      where record.organization_id = p_organization_id
    ) then
      with removed as (
        delete from public.crm_loss_reasons reason
        where reason.organization_id = p_organization_id
        returning 1
      ) select count(*) into loss_reason_count from removed;

      if exists (
        select 1 from public.organizations organization
        where organization.id = p_organization_id
      ) then
        perform private.seed_crm_loss_reasons(p_organization_id);
      end if;
    end if;
  end if;

  -- Fica por ultimo: delecoes de catalogo podem acionar o ledger por meio das
  -- FKs que limpam referencias de registros remanescentes.
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
    'lead_sources', source_count,
    'loss_reasons', loss_reason_count
  );
end
$function$;

revoke all on function public.purge_crm_canonical_data(uuid, boolean)
  from public, anon, service_role;
grant execute on function public.purge_crm_canonical_data(uuid, boolean)
  to authenticated;

alter table public.crm_loss_reasons enable row level security;

create policy crm_loss_reasons_select
on public.crm_loss_reasons
for select to authenticated
using (
  public.has_app_permission(organization_id, 'crm.view')
  or public.crm_canonical_restore_active(organization_id)
);

create policy crm_loss_reasons_insert
on public.crm_loss_reasons
for insert to authenticated
with check (
  public.has_app_permission(organization_id, 'crm.manage')
  or public.crm_canonical_restore_active(organization_id)
);

create policy crm_loss_reasons_update
on public.crm_loss_reasons
for update to authenticated
using (
  public.has_app_permission(organization_id, 'crm.manage')
  or public.crm_canonical_restore_active(organization_id)
)
with check (
  public.has_app_permission(organization_id, 'crm.manage')
  or public.crm_canonical_restore_active(organization_id)
);

create policy crm_loss_reasons_delete
on public.crm_loss_reasons
for delete to authenticated
using (public.crm_canonical_restore_active(organization_id));

revoke all on table public.crm_loss_reasons
  from public, anon, authenticated;
grant select, insert, update, delete on table public.crm_loss_reasons
  to authenticated;
revoke all on table public.crm_loss_reasons from service_role;
grant select on table public.crm_loss_reasons to service_role;

-- service_role ignora RLS; portanto os privilegios herdados precisam ser
-- retirados explicitamente para manter os snapshots e eventos append-only.
revoke all
  on table public.crm_opportunity_attributions,
           public.crm_opportunity_events
  from service_role;
grant select, insert
  on table public.crm_opportunity_attributions,
           public.crm_opportunity_events
  to service_role;

do $append_only_assertion$
begin
  if has_table_privilege(
       'service_role', 'public.crm_opportunity_attributions', 'UPDATE'
     )
     or has_table_privilege(
       'service_role', 'public.crm_opportunity_attributions', 'DELETE'
     )
     or has_table_privilege(
       'service_role', 'public.crm_opportunity_attributions', 'TRUNCATE'
     )
     or has_table_privilege(
       'service_role', 'public.crm_opportunity_events', 'UPDATE'
     )
     or has_table_privilege(
       'service_role', 'public.crm_opportunity_events', 'DELETE'
     )
     or has_table_privilege(
       'service_role', 'public.crm_opportunity_events', 'TRUNCATE'
     )
     or has_table_privilege(
       'service_role', 'public.crm_opportunity_attributions', 'TRIGGER'
     )
     or has_table_privilege(
       'service_role', 'public.crm_opportunity_events', 'TRIGGER'
     )
     or has_table_privilege(
       'service_role', 'public.crm_loss_reasons', 'INSERT'
     )
     or has_table_privilege(
       'service_role', 'public.crm_loss_reasons', 'UPDATE'
     )
     or has_table_privilege(
       'service_role', 'public.crm_loss_reasons', 'DELETE'
     )
     or has_table_privilege(
       'service_role', 'public.crm_loss_reasons', 'TRUNCATE'
     ) then
    raise exception 'Os ledgers canonicos ainda possuem privilegios mutaveis.';
  end if;

  if not has_table_privilege(
       'service_role', 'public.crm_opportunity_attributions', 'SELECT'
     )
     or not has_table_privilege(
       'service_role', 'public.crm_opportunity_attributions', 'INSERT'
     )
     or not has_table_privilege(
       'service_role', 'public.crm_opportunity_events', 'SELECT'
     )
     or not has_table_privilege(
       'service_role', 'public.crm_opportunity_events', 'INSERT'
     )
     or has_function_privilege(
       'service_role',
       'public.purge_crm_canonical_data(uuid, boolean)',
       'EXECUTE'
     ) then
    raise exception 'ACL canonica do servidor diverge do boundary append-only.';
  end if;
end
$append_only_assertion$;

comment on table public.crm_loss_reasons is
  'Catalogo organizacional de motivos de perda; o ledger registra apenas o codigo.';
comment on column public.crm_records.loss_reason_id is
  'Motivo de perda estruturado e seguro para historico e Campaign Control.';
