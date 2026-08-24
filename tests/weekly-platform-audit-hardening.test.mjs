import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  "supabase/migrations/20260824133500_weekly_platform_audit_hardening.sql",
  "utf8",
);

test("Bia diagnostic RPC is restricted to service role", () => {
  assert.match(
    migration,
    /revoke execute on function public\.record_bia_openai_diagnostic[\s\S]*from anon, authenticated;/,
  );
  assert.match(
    migration,
    /grant execute on function public\.record_bia_openai_diagnostic[\s\S]*to service_role;/,
  );
});

test("hot CRM and public-agent foreign keys receive covering indexes", () => {
  for (const expected of [
    "enterprise_outbox_campaign_control_campaign_idx",
    "enterprise_outbox_crm_record_idx",
    "public_agent_sessions_contact_idx",
    "public_agent_sessions_conversation_idx",
    "public_agent_sessions_crm_record_idx",
    "crm_records_org_owner_idx",
    "crm_records_org_project_idx",
    "crm_records_org_stage_id_idx",
    "crm_records_org_team_idx",
    "crm_records_org_project_campaign_idx",
    "crm_records_org_project_product_idx",
    "crm_team_members_org_team_idx",
    "crm_team_members_org_user_idx",
  ]) {
    assert.match(migration, new RegExp(`create index if not exists ${expected}`));
  }
});

test("only confirmed exact duplicate indexes are removed", () => {
  assert.match(
    migration,
    /drop index if exists crm_private\.public_agent_generated_session_idx;/,
  );
  assert.match(
    migration,
    /drop index if exists public\.crm_unit_one_active_reservation_idx;/,
  );
  assert.doesNotMatch(
    migration,
    /drop index if exists public\.crm_unit_reservations_one_active_per_unit_idx;/,
  );
});
