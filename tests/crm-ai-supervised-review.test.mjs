import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("human preparation is service-only, audited and never delivers externally", async () => {
  const sql = await source(
    "supabase/migrations/20260814233000_crm_ai_shadow_human_prepare.sql",
  );

  assert.match(sql, /prepare_crm_ai_shadow_message/);
  assert.match(sql, /coalesce\(auth\.jwt\(\)->>'role', ''\) <> 'service_role'/);
  assert.match(sql, /delivery_status = 'prepared'/);
  assert.match(sql, /status = 'human_active'/);
  assert.match(sql, /ai_enabled = false/);
  assert.match(sql, /ai_shadow_draft_prepared/);
  assert.match(sql, /'external_delivery', false/);
  assert.match(sql, /to service_role/);
  assert.match(sql, /from public, anon, authenticated/);
  assert.doesNotMatch(sql, /net\.http_post/i);
  assert.doesNotMatch(sql, /graph\.facebook\.com/i);
  assert.doesNotMatch(sql, /wa\.me/i);
});

test("preparation API requires explicit copilot approval permission", async () => {
  const route = await source(
    "src/app/api/ai/leads/shadow/prepare/route.ts",
  );

  assert.match(route, /crm\.copilot\.approve_send/);
  assert.match(route, /enforceSameOrigin/);
  assert.match(route, /prepare_crm_ai_shadow_message/);
  assert.match(route, /AI_DRAFT_PREPARE_FORBIDDEN/);
  assert.match(route, /deliveryStatus: row\.delivery_status/);
  assert.doesNotMatch(route, /graph\.facebook\.com/i);
  assert.doesNotMatch(route, /wa\.me/i);
  assert.doesNotMatch(route, /messages\/send/i);
});

test("shadow read model exposes blocked supervisor outcomes and preparation state", async () => {
  const route = await source("src/app/api/ai/leads/shadow/route.ts");

  assert.match(route, /\.from\("crm_ai_jobs"\)/);
  assert.match(route, /messageId: stringOrNull\(message\?\.id\)/);
  assert.match(route, /deliveryStatus/);
  assert.match(route, /stringOrNull\(result\?\.decision\)/);
  assert.match(route, /numberOrNull\(result\?\.quality_score\)/);
  assert.doesNotMatch(route, /\.insert\(/);
  assert.doesNotMatch(route, /\.update\(/);
  assert.doesNotMatch(route, /\.delete\(/);
});

test("lead review remains human-confirmed through the existing WhatsApp handoff", async () => {
  const view = await source("src/components/erp/crm-v5/leads-view.tsx");

  assert.match(view, /Aprovar e abrir WhatsApp/);
  assert.match(view, /Nenhum envio automático será realizado/);
  assert.match(view, /\/api\/ai\/leads\/shadow\/prepare/);
  assert.match(view, /window\.open\("", "_blank"\)/);
  assert.match(view, /https:\/\/wa\.me\//);
  assert.match(view, /encodeURIComponent/);
  assert.doesNotMatch(view, /graph\.facebook\.com/i);
  assert.doesNotMatch(view, /messages\/send/i);
});
