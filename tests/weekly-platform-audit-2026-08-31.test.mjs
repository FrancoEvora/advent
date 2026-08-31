import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  "supabase/migrations/20260831124500_weekly_platform_audit_hardening.sql",
  "utf8",
);
const metaWorker = await readFile(
  "supabase/functions/enterprise-meta-worker/index.ts",
  "utf8",
);

test("Meta worker bearer verifier is service-role only", () => {
  assert.match(metaWorker, /createClient\(url,sk/);
  assert.match(metaWorker, /rpc\("verify_meta_worker_bearer"/);
  assert.match(
    migration,
    /revoke execute on function public\.verify_meta_worker_bearer\(text, text\)[\s\S]*from public, anon, authenticated;/,
  );
  assert.match(
    migration,
    /grant execute on function public\.verify_meta_worker_bearer\(text, text\)[\s\S]*to service_role;/,
  );
});

test("public-agent and Bia foreign keys receive covering indexes", () => {
  for (const expected of [
    "public_agent_experiences_org_owner_idx",
    "public_agent_experiences_org_product_idx",
    "public_agent_experiences_org_source_idx",
    "public_agent_generated_assets_org_idx",
    "public_agent_generated_assets_project_idx",
    "public_agent_knowledge_items_org_idx",
    "public_agent_knowledge_items_project_idx",
    "public_agent_usage_events_experience_idx",
    "public_agent_usage_events_org_idx",
    "crm_ai_knowledge_documents_created_by_idx",
    "crm_ai_knowledge_documents_updated_by_idx",
  ]) {
    assert.match(migration, new RegExp(`create index if not exists ${expected}`));
  }
});

test("RLS auth.uid calls are converted to statement initplans", () => {
  for (const policy of [
    "profiles_admin_update",
    "post_sale_collection_actions_org_access",
    "post_sale_communications_org_access",
    "post_sale_deeds_org_access",
    "post_sale_inspections_org_access",
    "post_sale_journeys_org_access",
    "post_sale_milestones_org_access",
    "post_sale_renegotiations_org_access",
    "post_sale_surveys_org_access",
    "post_sale_tickets_org_access",
  ]) {
    assert.match(migration, new RegExp(`alter policy ${policy}`));
  }
  assert.match(migration, /m\.user_id = \(select auth\.uid\(\)\)/);
  assert.match(migration, /administrator\.user_id = \(select auth\.uid\(\)\)/);
  assert.doesNotMatch(migration, /= auth\.uid\(\)/);
});
