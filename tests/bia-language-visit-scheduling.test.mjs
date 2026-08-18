import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const gateway = fs.readFileSync("supabase/functions/enterprise-vitoria-agent-gateway/index.ts", "utf8");
const migration = fs.readFileSync("supabase/migrations/20260818103000_bia_gateway_language_and_visit_scheduling.sql", "utf8");

test("saudações são tratadas antes do fallback do agente", () => {
  assert.match(gateway, /function isGreeting\(/u);
  assert.match(gateway, /Bom dia! 😊 Estou por aqui/u);
  const greeting = gateway.indexOf("if (isGreeting(message))");
  const proxy = gateway.indexOf("return await proxyUpstream(admin, bytes)");
  assert.ok(greeting >= 0 && proxy > greeting);
});

test("quick reply de lotes disponíveis usa estoque real", () => {
  assert.match(gateway, /function wantsInventory\(/u);
  assert.match(gateway, /get_public_agent_commercial_context/u);
  assert.match(gateway, /action: "show_inventory"/u);
});

test("pedido de visita não é devolvido ao hold status", () => {
  assert.match(gateway, /function wantsVisit\(/u);
  assert.match(gateway, /Agendar visita/u);
  assert.match(gateway, /visitState/u);
  assert.match(gateway, /phase: "when"/u);
});

test("visita concluída grava crm_actions com data e idempotência", () => {
  assert.match(gateway, /schedule_public_agent_visit_v1/u);
  assert.match(migration, /insert into public\.crm_actions/u);
  assert.match(migration, /'visita'/u);
  assert.match(migration, /public_agent_visit_action_id/u);
  assert.match(migration, /scheduled_at/u);
  assert.match(migration, /duration_minutes/u);
});

test("agenda é vinculada ao CRM e atualiza a próxima ação", () => {
  assert.match(migration, /session_row\.crm_record_id/u);
  assert.match(migration, /update public\.crm_records record/u);
  assert.match(migration, /next_action_at/u);
  assert.match(migration, /assigned_to/u);
});
