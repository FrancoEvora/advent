import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  "supabase/migrations/20260914143000_platform_audit_incremental_hardening.sql",
  "utf8",
);
const notifications = await readFile(
  "src/components/arisa/ArisaNotificationBell.tsx",
  "utf8",
);
const notificationStyles = await readFile(
  "src/components/arisa/notifications.module.css",
  "utf8",
);

test("Intergeo evita reavaliar auth.uid por linha sem ampliar a autorização", () => {
  for (const table of [
    "intergeo_v2_analysis_runs",
    "intergeo_max_comparables",
    "intergeo_max_sources",
    "intergeo_max_runs",
    "intergeo_max_reviews",
  ]) {
    assert.match(migration, new RegExp(`ON public\\.${table}`));
  }
  assert.match(migration, /created_by = \(SELECT auth\.uid\(\)\)/g);
  assert.doesNotMatch(migration, /created_by\s*=\s*auth\.uid\(\)/);
  assert.match(migration, /TO authenticated/g);
  assert.match(migration, /malha_private\.role_for\(organization_id\)/g);
});

test("índices cobrem formulários públicos e relacionamentos ativos da Bia", () => {
  for (const index of [
    "crm_public_form_submissions_form_slug_fk_idx",
    "crm_public_form_submissions_organization_fk_idx",
    "crm_public_forms_organization_fk_idx",
    "crm_public_forms_project_fk_idx",
    "crm_public_forms_pipeline_fk_idx",
    "crm_public_forms_stage_fk_idx",
    "crm_public_forms_lead_source_fk_idx",
    "bia_customer_files_message_fk_idx",
    "bia_whatsapp_channels_experience_fk_idx",
    "arisa_whatsapp_recipients_user_fk_idx",
  ]) {
    assert.match(migration, new RegExp(index));
  }
  assert.match(migration, /CREATE INDEX IF NOT EXISTS/g);
});

test("popup de notificações expõe semântica e foco adequados", () => {
  assert.match(notifications, /aria-haspopup="dialog"/);
  assert.match(notifications, /role="dialog"/);
  assert.match(notifications, /aria-modal="false"/);
  assert.match(notifications, /aria-labelledby="arisa-notifications-title"/);
  assert.match(notifications, /panel\.current\?\.focus\(\)/);
  assert.match(notifications, /trigger\.current\?\.focus\(\)/);
  assert.match(notifications, /<h2 id="arisa-notifications-title">/);
});

test("popup móvel respeita viewport dinâmica e safe areas", () => {
  assert.match(notificationStyles, /100dvh/);
  assert.match(notificationStyles, /env\(safe-area-inset-left\)/);
  assert.match(notificationStyles, /env\(safe-area-inset-right\)/);
});
