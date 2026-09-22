import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const queueView = read("src/components/erp/crm-v5/bia-queue-view.tsx");
const migration = read("supabase/migrations/20260922084500_bia_queue_dispatch_visibility.sql");
const worker = read("supabase/functions/_shared/bia-campaign-outreach.ts");

test("assignment activities do not falsely pause WhatsApp outreach", () => {
  assert.doesNotMatch(migration, /requires_human_review/);
  assert.doesNotMatch(migration, /no_external_delivery/);
  assert.match(migration, /marketing_consent_status in\('denied','revoked'\)/);
  assert.match(migration, /t\.opted_out_at is not null or t\.human_requested/);
});

test("queue previews eligibility before enabling dispatch", () => {
  assert.match(migration, /bia_strategy_queue_preview/);
  assert.match(queueView, /readyCount < 1/);
  assert.match(queueView, /Disparar · \$\{readyCount\}\/\$\{selectedCount\}/);
  assert.match(queueView, /Nenhum selecionado está apto/);
  assert.match(queueView, /Já houve contato anterior/);
});

test("queue shows delivery lifecycle after a dispatch", () => {
  assert.match(migration, /bia_strategy_queue_delivery/);
  for (const label of [
    "Aguardando",
    "Validando Meta",
    "Aceito pela Meta",
    "Entregue",
    "Lido",
    "Falhou",
  ]) assert.match(queueView, new RegExp(label));
  assert.match(queueView, /setStatus\("all"\)/);
});

test("initial outbound remains a live-approved Meta template, never free text", () => {
  assert.match(worker, /biaApprovedTemplate\(credentials, string\(job\.template_name\), http\)/);
  assert.match(worker, /type: "template"/);
  assert.match(worker, /template: \{ name: template\.name/);
  assert.match(queueView, /worker consulta novamente a Meta/);
});
