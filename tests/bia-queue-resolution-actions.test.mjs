import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const queueView = read("src/components/erp/crm-v5/bia-queue-view.tsx");
const migration = read("supabase/migrations/20260922124500_bia_queue_resolution_actions.sql");

test("queue converts consent and prior-contact blockers into operational actions", () => {
  assert.match(queueView, /Registrar opt-in/);
  assert.match(queueView, /Retomar/);
  assert.match(queueView, /Requer opt-in/);
  assert.match(queueView, /queueStatusLabel/);
  assert.match(queueView, /bia_strategy_queue_record_optin/);
  assert.match(queueView, /bia_strategy_queue_find_thread/);
});

test("manual WhatsApp opt-in is private, auditable and admin-only", () => {
  assert.match(migration, /create table if not exists crm_private\.bia_whatsapp_optins/);
  assert.match(migration, /recorded_by uuid not null/);
  assert.match(migration, /evidence_note text not null/);
  assert.match(migration, /revoked_at timestamptz/);
  assert.match(migration, /lower\(m\.role\)='admin'/);
  assert.match(migration, /revoke all on table crm_private\.bia_whatsapp_optins from public,anon,authenticated/);
  assert.match(migration, /BIA_OPTIN_EVIDENCE_INVALID/);
});

test("manual consent becomes valid campaign evidence without overriding opt-out", () => {
  assert.match(migration, /crm_private\.bia_whatsapp_optins/);
  assert.match(migration, /documented_whatsapp_opt_in/);
  assert.match(migration, /t\.opted_out_at is not null/);
  assert.match(migration, /marketing_consent_status in \('denied','revoked'\)/);
});

test("queue can open the canonical existing WhatsApp conversation by phone key", () => {
  assert.match(migration, /bia_strategy_queue_find_thread/);
  assert.match(migration, /crm_private\.bia_phone_key\(t\.peer_phone\)=v_key/);
  assert.match(queueView, /painel=whatsapp&conversa=/);
});

test("manual opt-in UI requires explicit administrator confirmation and evidence", () => {
  assert.match(queueView, /Confirmo que o lead autorizou receber mensagens da Évora/);
  assert.match(queueView, /Evidência \/ observação/);
  assert.match(queueView, /consentNote\.trim\(\)\.length < 5/);
  assert.match(queueView, /consentConfirmed/);
});
