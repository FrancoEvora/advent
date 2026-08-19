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
    assert.match(
      sql,
      new RegExp(`alter table public\\.${table} enable row level security`, "i"),
    );
    assert.match(
      sql,
      new RegExp(
        `revoke all on table public\\.${table} from public, anon, authenticated`,
        "i",
      ),
    );
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
  assert.match(
    sql,
    /Colisao de chave de idempotencia IA entre contextos distintos/i,
  );
});

test("AI table hardening keeps clients denied and FK paths indexed", async () => {
  const sql = await source(
    "supabase/migrations/20260814211000_crm_ai_security_performance_hardening.sql",
  );

  for (const table of ["crm_ai_jobs", "crm_conversations", "crm_messages"]) {
    assert.match(sql, new RegExp(`${table}_deny_client_access`, "i"));
  }
  assert.match(sql, /as restrictive/i);
  assert.match(sql, /to anon, authenticated/i);
  assert.match(sql, /using \(false\)/i);
  assert.match(sql, /with check \(false\)/i);
  assert.match(sql, /crm_ai_jobs_contact_idx/i);
  assert.match(sql, /crm_conversations_contact_idx/i);
  assert.match(sql, /crm_conversations_assigned_idx/i);
});

test("tenant AI runtime stores only a Vault binding and defaults disabled", async () => {
  const sql = await source(
    "supabase/migrations/20260814220000_crm_ai_runtime_vault.sql",
  );

  assert.match(sql, /crm_private\.ai_runtime_settings/);
  assert.match(sql, /openai_api_key_vault_id uuid/);
  assert.match(sql, /enabled boolean not null default false/);
  assert.match(sql, /mode text not null default 'shadow'/);
  assert.match(sql, /vault\.create_secret/);
  assert.match(sql, /vault\.update_secret/);
  assert.match(sql, /vault\.decrypted_secrets/);
  assert.match(sql, /coalesce\(auth\.jwt\(\) ->> 'role', ''\) <> 'service_role'/);
  assert.match(sql, /get_crm_ai_runtime_credentials/);
  assert.match(sql, /cancel_crm_ai_job/);
  assert.doesNotMatch(
    sql,
    /create table[\s\S]{0,1500}openai_api_key\s+text/i,
    "raw OpenAI key must never be a table column",
  );
});

test("tenant runtime admin wrappers are definer-protected and internals are hidden", async () => {
  const sql = await source(
    "supabase/migrations/20260814220500_crm_ai_runtime_acl_hardening.sql",
  );
  assert.match(sql, /alter function public\.get_crm_ai_runtime_status\(uuid\)[\s\n]+security definer/i);
  assert.match(sql, /alter function public\.configure_crm_ai_runtime[\s\S]+security definer/i);
  assert.match(sql, /revoke all on function crm_private\.configure_crm_ai_runtime_internal/i);
  assert.match(sql, /from public, anon, authenticated/i);
});

test("canonical Meta attribution trigger is fail-open and dispatches resiliently", async () => {
  const sql = await source(
    "supabase/migrations/20260814221000_crm_ai_meta_trigger_and_worker_dispatch.sql",
  );

  assert.match(sql, /after insert on public\.crm_opportunity_attributions/i);
  assert.match(sql, /new\.provider <> 'meta'/i);
  assert.match(sql, /public\.enqueue_crm_ai_job/i);
  assert.match(sql, /'lead-created:' \|\| new\.crm_record_id::text/i);
  assert.match(sql, /exception when others/i);
  assert.match(sql, /fail-open/i);
  assert.match(sql, /crm_private\.dispatch_crm_ai_worker/i);
  assert.match(sql, /net\.http_post/i);
  assert.match(sql, /evora-crm-ai-dispatch-1m/);
  assert.match(sql, /'\* \* \* \* \*'/);
  assert.match(sql, /verify_crm_ai_worker_bearer/);
});

test("runtime readiness exposes no secret and remains service-only", async () => {
  const sql = await source(
    "supabase/migrations/20260814221200_crm_ai_runtime_readiness.sql",
  );
  assert.match(sql, /get_crm_ai_runtime_readiness/);
  assert.match(sql, /openai_api_key_vault_id is not null/i);
  assert.doesNotMatch(sql, /decrypted_secret/i);
  assert.match(sql, /from public, anon, authenticated/i);
  assert.match(sql, /to service_role/i);
});

test("OpenAI shadow request minimizes data and never persists provider state", async () => {
  const code = await source("src/lib/ai/openai.ts");

  assert.match(code, /store:\s*false/);
  assert.match(code, /paymentCapacity:\s*_paymentCapacity/);
  assert.match(code, /doNotContact/);
  assert.match(code, /marketingConsentStatus/);
  assert.ok(code.includes("/R\\$\\s*\\d/i"), "price gate must remain enabled");
  assert.ok(code.includes("/https?:\\/\\//i"), "external-link gate must remain enabled");
  assert.match(code, /Supervisor de Excelência Comercial e Governança/);
  assert.match(code, /runtime\.apiKey/);
});

test("tenant runtime is authoritative before queue/provider execution", async () => {
  const store = await source("src/lib/ai/runtime-store.ts");
  const runner = await source("src/lib/ai/runner.ts");
  const meta = await source("src/lib/integrations/meta/processor.ts");

  assert.match(store, /get_crm_ai_runtime_credentials/);
  assert.match(store, /cancel_crm_ai_job/);
  assert.match(runner, /fetchCrmAiRuntime\(job\.organizationId\)/);
  assert.match(runner, /cancelCrmAiJobForDisabledRuntime/);
  assert.ok(
    runner.indexOf("fetchCrmAiRuntime(job.organizationId)") <
      runner.indexOf("loadCrmAiLeadContext(job)"),
    "tenant runtime must be validated before loading lead context",
  );
  assert.match(meta, /isCrmAiRuntimeEnabled\(ingest\.organizationId\)/);
  assert.match(meta, /CRM AI shadow enqueue skipped after Meta ingest/);
});

test("legacy Vercel AI worker remains bearer-protected fallback", async () => {
  const route = await source("src/app/api/ai/leads/process/route.ts");
  const config = await source("src/lib/ai/config.ts");

  assert.match(route, /PROCESS_AUTHORIZATION_REQUIRED/);
  assert.match(config, /CRM_AI_WORKER_TOKEN/);
  assert.match(config, /compatibilidade legada/i);
});

test("AI shadow read model is permissioned, tenant-aware, scoped and read-only", async () => {
  const route = await source("src/app/api/ai/leads/shadow/route.ts");

  assert.match(route, /crm\.copilot\.use/);
  assert.match(route, /get_crm_ai_runtime_readiness/);
  assert.match(route, /RECORD_SCOPE_REJECTED/);
  assert.match(route, /\.from\("crm_conversations"\)/);
  assert.match(route, /\.from\("crm_messages"\)/);
  assert.doesNotMatch(route, /\.insert\(/);
  assert.doesNotMatch(route, /\.update\(/);
  assert.doesNotMatch(route, /\.delete\(/);
  assert.doesNotMatch(route, /crm\.copilot\.approve_send/);
});

test("Enterprise AI Edge worker is supervised and has no delivery capability", async () => {
  const worker = await source("supabase/functions/enterprise-ai-worker/index.ts");

  assert.match(worker, /verify_crm_ai_worker_bearer/);
  assert.match(worker, /get_crm_ai_runtime_credentials/);
  assert.match(worker, /claim_crm_ai_jobs/);
  assert.match(worker, /complete_crm_ai_shadow_job/);
  assert.match(worker, /fail_crm_ai_job/);
  assert.match(worker, /cancel_crm_ai_job/);
  assert.match(worker, /Supervisor de Excelência Comercial e Governança/);
  assert.match(worker, /store:\s*false/);
  assert.doesNotMatch(worker, /graph\.facebook\.com/);
  assert.doesNotMatch(worker, /wa\.me/);
  assert.doesNotMatch(worker, /messages\/send/i);
});

test("AI runtime admin API never returns secrets and prepares worker only on enable", async () => {
  const route = await source("src/app/api/ai/runtime/route.ts");
  assert.match(route, /crm_ai_worker_runtime/);
  assert.match(route, /if \(enabled === true\) await configureWorkerRuntime\(\)/);
  assert.match(route, /api_key:\s*_[A-Za-z0-9]*ApiKey/);
  assert.match(route, /secret: _secret/);
  assert.doesNotMatch(route, /console\.log\([^)]*apiKey/i);
});

test("settings UI never displays a stored OpenAI key and has no shadow mode", async () => {
  const view = await source("src/components/erp/crm-v5/ai-runtime-settings.tsx");
  assert.match(view, /type="password"/);
  assert.match(view, /Protegida no Vault/);
  assert.match(view, /Ativar Bia/);
  assert.match(view, /Bia ativa/);
  assert.doesNotMatch(view, /modo sombra/i);
  assert.doesNotMatch(view, /sem enviar mensagens ao cliente/i);
  assert.doesNotMatch(view, /runtime\?\.api_key\?\.(value|key|secret)/i);
});

test("lead portfolio only surfaces Bia when tenant runtime is enabled", async () => {
  const view = await source("src/components/erp/crm-v5/leads-view.tsx");

  assert.match(view, /aiEnabled && <span>Atendimento IA<\/span>/);
  assert.match(view, /Bloqueado pelo supervisor/);
  assert.match(view, /Rascunho pronto/);
  assert.match(view, /Qualidade \$\{ai\.qualityScore\}\/100/);
});
