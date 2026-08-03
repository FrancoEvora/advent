-- Évora Gestão 6.23 — auditoria incremental de segurança e desempenho.
-- Não altera dados de negócio.

revoke execute on function public.create_operational_contract(jsonb, jsonb) from anon;
grant execute on function public.create_operational_contract(jsonb, jsonb) to authenticated;

revoke execute on function public.record_equipment_meter_reading(jsonb) from anon;
grant execute on function public.record_equipment_meter_reading(jsonb) to authenticated;

create index if not exists backup_runs_organization_id_idx
  on public.backup_runs (organization_id);

create index if not exists crm_records_contact_id_idx
  on public.crm_records (contact_id);
create index if not exists crm_records_project_id_idx
  on public.crm_records (project_id);
create index if not exists crm_records_pipeline_id_idx
  on public.crm_records (pipeline_id);
create index if not exists crm_records_stage_id_idx
  on public.crm_records (stage_id);
create index if not exists crm_records_team_id_idx
  on public.crm_records (team_id);
create index if not exists crm_records_campaign_id_idx
  on public.crm_records (campaign_id);

create index if not exists crm_contracts_contact_id_idx
  on public.crm_contracts (contact_id);
create index if not exists crm_contracts_unit_id_idx
  on public.crm_contracts (unit_id);

create index if not exists crm_proposals_contact_id_idx
  on public.crm_proposals (contact_id);
create index if not exists crm_proposals_unit_id_idx
  on public.crm_proposals (unit_id);
create index if not exists crm_proposals_reservation_id_idx
  on public.crm_proposals (reservation_id);

create index if not exists post_sale_portal_tokens_contract_id_idx
  on public.post_sale_portal_tokens (contract_id);
create index if not exists post_sale_portal_access_logs_token_id_idx
  on public.post_sale_portal_access_logs (token_id);
create index if not exists post_sale_portal_access_logs_organization_id_idx
  on public.post_sale_portal_access_logs (organization_id);
create index if not exists post_sale_portal_access_logs_contract_id_idx
  on public.post_sale_portal_access_logs (contract_id);

create index if not exists restore_jobs_organization_id_idx
  on public.restore_jobs (organization_id);
create index if not exists restore_jobs_backup_run_id_idx
  on public.restore_jobs (backup_run_id);

create index if not exists financial_category_dre_map_category_id_idx
  on public.financial_category_dre_map (category_id);
create index if not exists financial_category_dre_map_dre_group_id_idx
  on public.financial_category_dre_map (dre_group_id);

create index if not exists equipment_meter_readings_project_id_idx
  on public.equipment_meter_readings (project_id);
create index if not exists equipment_meter_readings_contract_id_idx
  on public.equipment_meter_readings (contract_id);
create index if not exists equipment_meter_readings_fuel_request_id_idx
  on public.equipment_meter_readings (fuel_request_id);
create index if not exists equipment_meter_readings_fuel_dispense_id_idx
  on public.equipment_meter_readings (fuel_dispense_id);
create index if not exists equipment_meter_readings_measurement_id_idx
  on public.equipment_meter_readings (measurement_id);
create index if not exists equipment_meter_readings_measurement_item_id_idx
  on public.equipment_meter_readings (measurement_item_id);

create index if not exists partner_portal_links_contact_id_idx
  on public.partner_portal_links (contact_id);
create index if not exists partner_negotiations_contact_id_idx
  on public.partner_negotiations (contact_id);
create index if not exists partner_negotiations_financial_entry_id_idx
  on public.partner_negotiations (financial_entry_id);
create index if not exists partner_negotiations_portal_link_id_idx
  on public.partner_negotiations (portal_link_id);
