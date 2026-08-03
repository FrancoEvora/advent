-- Indices de cobertura das chaves estrangeiras usadas nos acessos diretos
-- entre a trilha de importacao, os insights da Arisa e o CRM.

create index if not exists crm_lead_import_sources_record_id_idx
  on public.crm_lead_import_sources (crm_record_id);

create index if not exists insight_crm_context_record_id_idx
  on public.insight_crm_context (crm_record_id);
