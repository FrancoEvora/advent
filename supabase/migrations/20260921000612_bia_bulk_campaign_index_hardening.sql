create index if not exists bia_bulk_campaigns_settings_idx
  on crm_private.bia_bulk_campaigns(settings_id);
create index if not exists bia_bulk_campaigns_created_by_idx
  on crm_private.bia_bulk_campaigns(created_by);
