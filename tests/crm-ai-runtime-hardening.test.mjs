import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("tenant runtime table has explicit restrictive deny policy", async () => {
  const sql = await source(
    "supabase/migrations/20260814221600_crm_ai_runtime_security_performance_hardening.sql",
  );

  assert.match(sql, /ai_runtime_settings_deny_client_access/i);
  assert.match(sql, /as restrictive/i);
  assert.match(sql, /to anon, authenticated/i);
  assert.match(sql, /using \(false\)/i);
  assert.match(sql, /with check \(false\)/i);
});

test("tenant runtime audit foreign keys stay indexed", async () => {
  const sql = await source(
    "supabase/migrations/20260814221600_crm_ai_runtime_security_performance_hardening.sql",
  );

  assert.match(sql, /ai_runtime_settings_created_by_idx/i);
  assert.match(sql, /ai_runtime_settings_updated_by_idx/i);
  assert.match(sql, /revoke all on schema crm_private from public, anon, authenticated/i);
  assert.match(sql, /to service_role/i);
});
