import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const migration = await readFile(
  "supabase/migrations/20260907140000_platform_audit_incremental_hardening.sql",
  "utf8",
);

test("PostCSS usa versão corrigida acima da faixa vulnerável", () => {
  assert.equal(pkg.overrides?.postcss, "8.5.23");
});

test("políticas RLS evitam auth.uid por linha sem ampliar autorização", () => {
  const expectedPolicies = [
    "communication_links_access",
    "signature_events_select_org",
    "equipment_meter_readings_insert",
  ];
  for (const policy of expectedPolicies) assert.match(migration, new RegExp(policy));

  for (const table of [
    "marketing_channels",
    "marketing_requests",
    "portal_messages",
    "restore_jobs",
  ]) {
    assert.match(migration, new RegExp(`ON public\\.${table}`));
  }

  assert.match(migration, /\(SELECT auth\.uid\(\)\)/g);
  assert.doesNotMatch(migration, /user_id\s*=\s*auth\.uid\(\)/);
  assert.doesNotMatch(migration, /created_by\s*=\s*auth\.uid\(\)/);
  assert.match(migration, /TO authenticated/);
  assert.match(migration, /public\.has_app_permission\(organization_id, 'contracts\.manage'\)/);
});

test("índices cobrem caminhos de agenda, Arisa e sessões web", () => {
  for (const index of [
    "user_activities_acknowledged_by_fk_idx",
    "user_activities_parent_activity_id_fk_idx",
    "user_activities_project_id_fk_idx",
    "arisa_whatsapp_operations_contact_id_fk_idx",
    "vitoria_web_events_session_id_fk_idx",
    "vitoria_web_sessions_lead_record_id_fk_idx",
  ]) {
    assert.match(migration, new RegExp(index));
  }
  assert.match(migration, /CREATE INDEX IF NOT EXISTS/g);
});
