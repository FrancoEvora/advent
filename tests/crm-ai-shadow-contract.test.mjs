import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("CRM AI foundation remains server-only and shadow-only", async () => {
  const sql = await source(
    "supabase/migrations/20260814205000_crm_ai_shadow_agent_foundation.sql",
  );

  for (const table of ["crm_ai_jobs", "crm_conversations", "crm_messages"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, "i"));
  }

  assert.match(sql, /delivery_status[\s\S]*?'draft'/i);
  assert.match(sql, /grant execute[\s\S]*?to service_role/i);
  assert.doesNotMatch(sql, /grant execute[\s\S]*?to authenticated/i);
});

test("canonical opportunity audit contract is preserved", async () => {
  const sql = await source(
    "supabase/migrations/20260814205500_crm_ai_shadow_event_contract_alignment.sql",
  );

  assert.match(sql, /opportunity_key/i);
  assert.match(sql, /job\.crm_record_id,[\s\n]+job\.crm_record_id,/i);
  assert.match(sql, /'vitoria'/i);
  assert.doesNotMatch(sql, /'vitoria_supervisor'/i);
  assert.match(sql, /'ai-shadow:' \|\| job\.id::text/i);
});

test("queue hardening recovers exhausted leases and rejects idempotency collisions", async () => {
  const sql = await source(
    "supabase/migrations/20260814210000_crm_ai_queue_recovery_hardening.sql",
  );

  assert.match(sql, /AI_JOB_LEASE_EXHAUSTED/);
  assert.match(sql, /job\.attempt_count >= job\.max_attempts/i);
  assert.match(sql, /job\.locked_at is null/i);
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /Colisao de chave de idempotencia IA entre contextos distintos/i);
});

test("OpenAI shadow request minimizes data and never persists provider state", async () => {
  const code = await source("src/lib/ai/openai.ts");

  assert.match(code, /store:\s*false/);
  assert.match(code, /paymentCapacity:\s*_paymentCapacity/);
  assert.match(code, /doNotContact/);
  assert.match(code, /marketingConsentStatus/);
  assert.match(code, /R\\\$\\s\*\\d/);
  assert.match(code, /https\?:\\\/\\\//);
  assert.match(code, /Supervisor de Excelência Comercial e Governança/);
});

test("Meta ingestion is authoritative and AI enqueue is fail-open", async () => {
  const code = await source("src/lib/integrations/meta/processor.ts");
  const ingestPosition = code.indexOf("ingestMetaLeadEvent");
  const enqueuePosition = code.indexOf("enqueueCrmAiJob");

  assert.ok(ingestPosition >= 0, "canonical Meta ingest must remain present");
  assert.ok(enqueuePosition >= 0, "AI enqueue must remain present");
  assert.ok(
    code.lastIndexOf("ingestMetaLeadEvent") < code.lastIndexOf("enqueueCrmAiJob"),
    "AI work must be enqueued only after canonical ingest",
  );
  assert.match(code, /AI shadow enqueue skipped after successful Meta ingest/);
});

test("AI worker stays behind an explicit feature flag and bearer gate", async () => {
  const route = await source("src/app/api/ai/leads/process/route.ts");
  const config = await source("src/lib/ai/config.ts");

  assert.match(route, /isCrmAiShadowEnabled/);
  assert.match(route, /PROCESS_AUTHORIZATION_REQUIRED/);
  assert.match(route, /CRM_AI_SHADOW_DISABLED/);
  assert.match(config, /CRM_AI_SHADOW_ENABLED/);
  assert.match(config, /CRM_AI_WORKER_TOKEN/);
});
