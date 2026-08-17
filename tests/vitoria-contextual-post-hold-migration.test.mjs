import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDirectory = join(root, "supabase", "migrations");
const migrationFiles = readdirSync(migrationsDirectory).filter((name) =>
  name.endsWith("_vitoria_contextual_post_hold_actions.sql"),
);

assert.equal(migrationFiles.length, 1);

const migrationFile = migrationFiles[0];
const migrationVersion = BigInt(migrationFile.slice(0, 14));
const sql = readFileSync(join(migrationsDirectory, migrationFile), "utf8");

test("contextual post-hold migration is forward-only and atomic", () => {
  assert.ok(migrationVersion > 20260817155000n);
  assert.match(sql, /^begin;/);
  assert.match(sql, /commit;\s*$/);
  assert.match(
    sql,
    /create or replace function public\.commit_public_agent_action_message_v5/,
  );
  assert.doesNotMatch(
    sql,
    /create or replace function public\.commit_public_agent_action_message_v6/,
  );
});

test("successful holds remain in negotiation with concrete next actions", () => {
  assert.match(sql, /'\{stage\}',\s*'"qualification"'::jsonb/s);
  assert.match(sql, /'\{handoffRequested\}',\s*'false'::jsonb/s);
  assert.match(sql, /Calcular condições do /);
  assert.match(sql, /Ver fotos e materiais do /);
  assert.match(sql, /Agendar visita ao /);
  assert.doesNotMatch(
    sql,
    /jsonb_build_array\('Continuar por aqui', 'Ver condições'\)/,
  );
  assert.match(sql, /conversation\.status = 'human_required'/);
  assert.match(sql, /event\.event_type = 'handoff\.requested'/);
});

test("lead completion offers a contextual commercial next step", () => {
  assert.doesNotMatch(sql, /Continuar por aqui/);
  assert.match(sql, /p_profile ->> 'selected_unit_code'/);
  assert.match(sql, /Ver lotes disponíveis/);
  assert.match(sql, /Calcular condições de pagamento/);
  assert.match(sql, /Conhecer o empreendimento/);
  assert.match(sql, /Agendar uma visita/);
});

test("quick replies are sanitized and persisted without widening metadata", () => {
  assert.match(
    sql,
    /create or replace function crm_private\.public_agent_public_response_metadata/,
  );
  assert.match(sql, /item\.position <= 5/);
  assert.match(sql, /char_length\(quick_reply_value\) > 96/);
  assert.match(sql, /quick_reply_value ~ '\[\[:cntrl:\]\]'/);
  assert.match(sql, /quick_replies_value @> jsonb_build_array/);
  assert.match(sql, /'quickReplies'/);
  assert.match(sql, /'\{public_response\}'/);

  for (const allowedAction of [
    "none",
    "show_enterprise",
    "show_inventory",
    "show_policy",
    "show_documents",
    "request_visit",
    "request_hold",
    "hold_status",
    "generate_home_simulation",
  ]) {
    assert.match(sql, new RegExp(`'${allowedAction}'`));
  }
});
