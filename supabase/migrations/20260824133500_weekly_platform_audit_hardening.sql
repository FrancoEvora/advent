begin;

-- Defense in depth: this diagnostic RPC already asserts service_role internally,
-- but it should not be advertised as executable by browser roles.
revoke execute on function public.record_bia_openai_diagnostic(
  uuid, text, integer, text, text, text, text, text, text, text, text, text
) from anon, authenticated;
grant execute on function public.record_bia_openai_diagnostic(
  uuid, text, integer, text, text, text, text, text, text, text, text, text
) to service_role;

-- Hot-path foreign-key coverage. These indexes reduce parent update/delete scans
-- and improve CRM/public-agent lookups without changing business semantics.
create index if not exists enterprise_outbox_campaign_control_campaign_idx
  on campaign_control_private.enterprise_outbox (campaign_control_campaign_id);
create index if not exists enterprise_outbox_crm_record_idx
  on campaign_control_private.enterprise_outbox (crm_record_id);

create index if not exists public_agent_sessions_contact_idx
  on crm_private.public_agent_sessions (contact_id);
create index if not exists public_agent_sessions_conversation_idx
  on crm_private.public_agent_sessions (conversation_id);
create index if not exists public_agent_sessions_crm_record_idx
  on crm_private.public_agent_sessions (crm_record_id);

create index if not exists crm_records_org_owner_idx
  on public.crm_records (organization_id, owner_user_id);
create index if not exists crm_records_org_project_idx
  on public.crm_records (organization_id, project_id);
create index if not exists crm_records_org_stage_id_idx
  on public.crm_records (organization_id, stage_id);
create index if not exists crm_records_org_team_idx
  on public.crm_records (organization_id, team_id);
create index if not exists crm_records_org_project_campaign_idx
  on public.crm_records (organization_id, project_id, campaign_id);
create index if not exists crm_records_org_project_product_idx
  on public.crm_records (organization_id, project_id, product_id);

create index if not exists crm_team_members_org_team_idx
  on public.crm_team_members (organization_id, team_id);
create index if not exists crm_team_members_org_user_idx
  on public.crm_team_members (organization_id, user_id);

-- Remove exact duplicate indexes confirmed by pg_get_indexdef and with no
-- backing constraint. Keep the clearer canonical names.
drop index if exists crm_private.public_agent_generated_session_idx;
drop index if exists public.crm_unit_one_active_reservation_idx;

commit;
