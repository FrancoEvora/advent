-- Évora Gestão 6.23.2 — hardening incremental e índices de FKs/escopo frequentes.
-- Mantém tabelas internas inacessíveis diretamente para anon/authenticated
-- e reduz custo de joins/filtros usados por CRM, marketing e pós-venda.

create policy construction_code_counters_explicit_deny
on public.construction_code_counters
for all
to anon, authenticated
using (false)
with check (false);

create policy partner_landowner_contract_statements_explicit_deny
on public.partner_landowner_contract_statements
for all
to anon, authenticated
using (false)
with check (false);

create policy signature_otp_challenges_explicit_deny
on public.signature_otp_challenges
for all
to anon, authenticated
using (false)
with check (false);

create index if not exists crm_actions_organization_id_idx
  on public.crm_actions (organization_id);

create index if not exists marketing_assets_organization_id_idx
  on public.marketing_assets (organization_id);
create index if not exists marketing_assets_project_id_idx
  on public.marketing_assets (project_id) where project_id is not null;

create index if not exists marketing_calendar_items_organization_id_idx
  on public.marketing_calendar_items (organization_id);
create index if not exists marketing_calendar_items_project_id_idx
  on public.marketing_calendar_items (project_id) where project_id is not null;
create index if not exists marketing_calendar_items_campaign_id_idx
  on public.marketing_calendar_items (campaign_id) where campaign_id is not null;

create index if not exists marketing_campaigns_organization_id_idx
  on public.marketing_campaigns (organization_id);
create index if not exists marketing_campaigns_project_id_idx
  on public.marketing_campaigns (project_id) where project_id is not null;
create index if not exists marketing_campaigns_persona_id_idx
  on public.marketing_campaigns (persona_id) where persona_id is not null;

create index if not exists marketing_performance_snapshots_organization_id_idx
  on public.marketing_performance_snapshots (organization_id);
create index if not exists marketing_performance_snapshots_project_id_idx
  on public.marketing_performance_snapshots (project_id) where project_id is not null;

create index if not exists marketing_personas_organization_id_idx
  on public.marketing_personas (organization_id);
create index if not exists marketing_personas_project_id_idx
  on public.marketing_personas (project_id) where project_id is not null;

create index if not exists marketing_requests_project_id_idx
  on public.marketing_requests (project_id) where project_id is not null;
create index if not exists marketing_requests_campaign_id_idx
  on public.marketing_requests (campaign_id) where campaign_id is not null;

create index if not exists post_sale_collection_actions_organization_id_idx
  on public.post_sale_collection_actions (organization_id);
create index if not exists post_sale_collection_actions_financial_entry_id_idx
  on public.post_sale_collection_actions (financial_entry_id) where financial_entry_id is not null;

create index if not exists post_sale_surveys_organization_id_idx
  on public.post_sale_surveys (organization_id);
create index if not exists post_sale_surveys_contact_id_idx
  on public.post_sale_surveys (contact_id) where contact_id is not null;
