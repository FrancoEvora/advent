import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const queueView = read("src/components/erp/crm-v5/bia-queue-view.tsx");
const outbound = read("supabase/functions/_shared/bia-whatsapp-outbound.ts");
const campaign = read("supabase/functions/_shared/bia-campaign-outreach.ts");
const migration = read("supabase/migrations/20260922151500_bia_meta_template_catalog.sql");

test("queue loads all approved Meta templates from the authenticated WhatsApp function", () => {
  assert.match(queueView, /functions\.invoke\("bia-whatsapp-outbound"/);
  assert.match(queueView, /action:\s*"templates"/);
  assert.match(queueView, /Templates aprovados na Meta/);
  assert.match(queueView, /template\.body/);
  assert.match(queueView, /template\.footer/);
  assert.match(queueView, /template\.buttons/);
  assert.match(queueView, /APPROVED/);
});

test("queue persists the exact selected template into each outreach job", () => {
  assert.match(queueView, /templateName:\s*selectedTemplate\.name/);
  assert.match(migration, /add column if not exists template_name text/);
  assert.match(migration, /v_template_name/);
  assert.match(migration, /template_name,/);
  assert.match(migration, /coalesce\(j\.template_name,cfg\.template_name\)/);
});

test("worker revalidates the selected template against Meta before sending", () => {
  assert.match(campaign, /biaApprovedTemplate\(credentials, string\(job\.template_name\), http\)/);
  assert.match(outbound, /template\.status !== 'APPROVED'|raw\.status !== 'APPROVED'/);
  assert.match(outbound, /message_templates/);
  assert.match(outbound, /fields.*name,status,language,category,components/);
});

test("catalog lists approved pt_BR templates and marks unsupported structures instead of hiding them", () => {
  assert.match(outbound, /raw\.status !== 'APPROVED'/);
  assert.match(outbound, /raw\.language !== 'pt_BR'/);
  assert.match(outbound, /sendable:\s*compatibilityReason === null/);
  assert.match(outbound, /compatibilityReason/);
  assert.match(queueView, /Requer ajuste/);
});

test("assignment tasks do not block the final campaign worker", () => {
  assert.doesNotMatch(migration, /requires_human_review/);
  assert.doesNotMatch(migration, /no_external_delivery/);
});
