-- Évora Gestão 6.7 — índices de apoio aos vínculos comerciais

create index if not exists crm_campaigns_negotiation_policy_fk_idx
  on public.crm_campaigns(negotiation_policy_id)
  where negotiation_policy_id is not null;

create index if not exists crm_negotiation_parameters_updated_by_fk_idx
  on public.crm_negotiation_parameters(updated_by)
  where updated_by is not null;

create index if not exists crm_proposals_campaign_fk_idx
  on public.crm_proposals(campaign_id)
  where campaign_id is not null;

create index if not exists crm_proposals_negotiation_policy_fk_idx
  on public.crm_proposals(negotiation_policy_id)
  where negotiation_policy_id is not null;
