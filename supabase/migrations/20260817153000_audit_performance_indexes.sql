-- Auditoria 2026-08-17: índices de chaves estrangeiras em módulos novos.
-- As tabelas de campaign_control estão vazias nesta data e public_agent_experiences possui 1 registro,
-- reduzindo o risco de lock durante a criação dos índices.

create index if not exists campaigns_project_id_idx
  on campaign_control_private.campaigns (project_id);
create index if not exists campaigns_product_id_idx
  on campaign_control_private.campaigns (product_id);
create index if not exists campaigns_marketing_campaign_id_idx
  on campaign_control_private.campaigns (marketing_campaign_id);
create index if not exists campaigns_crm_campaign_id_idx
  on campaign_control_private.campaigns (crm_campaign_id);

create index if not exists creatives_organization_id_idx
  on campaign_control_private.creatives (organization_id);
create index if not exists creatives_campaign_control_campaign_id_idx
  on campaign_control_private.creatives (campaign_control_campaign_id);

create index if not exists forms_project_id_idx
  on campaign_control_private.forms (project_id);
create index if not exists forms_product_id_idx
  on campaign_control_private.forms (product_id);

create index if not exists sync_runs_organization_id_idx
  on campaign_control_private.sync_runs (organization_id);

create index if not exists public_agent_experiences_organization_id_idx
  on crm_private.public_agent_experiences (organization_id);
create index if not exists public_agent_experiences_project_id_idx
  on crm_private.public_agent_experiences (project_id);
create index if not exists public_agent_experiences_product_id_idx
  on crm_private.public_agent_experiences (product_id);
create index if not exists public_agent_experiences_pipeline_id_idx
  on crm_private.public_agent_experiences (pipeline_id);
create index if not exists public_agent_experiences_initial_stage_id_idx
  on crm_private.public_agent_experiences (initial_stage_id);
create index if not exists public_agent_experiences_lead_source_id_idx
  on crm_private.public_agent_experiences (lead_source_id);
create index if not exists public_agent_experiences_team_id_idx
  on crm_private.public_agent_experiences (team_id);
create index if not exists public_agent_experiences_fallback_owner_user_id_idx
  on crm_private.public_agent_experiences (fallback_owner_user_id);
