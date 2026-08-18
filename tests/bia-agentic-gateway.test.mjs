import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const gateway = fs.readFileSync("supabase/functions/enterprise-bia-agent-gateway/index.ts", "utf8");
const server = fs.readFileSync("src/lib/public-agent/server.ts", "utf8");

test("public agent uses the Bia gateway", () => {
  assert.match(server, /enterprise-bia-agent-gateway/u);
});

test("Bia uses native model function calling instead of a JSON intent router", () => {
  assert.match(gateway, /tool_choice = "auto"/u);
  assert.match(gateway, /type:\s*"function"/u);
  assert.match(gateway, /function_call/u);
  assert.doesNotMatch(gateway, /AGENT_SCHEMA/u);
  assert.doesNotMatch(gateway, /RECOVERY_SCHEMA/u);
});

test("qualitative investment conversation remains model-first", () => {
  assert.match(gateway, /Estou pensando em comprar para vender daqui alguns anos/u);
  assert.match(gateway, /conversa aberta/u);
  assert.match(gateway, /não um chatbot de menus/u);
});

test("canonical operations are explicit tools", () => {
  for (const tool of [
    "consultar_estoque",
    "consultar_condicoes_comerciais",
    "simular_pagamento",
    "buscar_materiais",
    "agendar_visita",
    "registrar_contato",
    "bloquear_lote",
    "transferir_especialista",
  ]) assert.match(gateway, new RegExp(tool, "u"));
  assert.match(gateway, /delegateToEnterprise/u);
});

test("open conversation is persisted without automatic menu buttons", () => {
  assert.match(gateway, /commit_public_agent_gateway_turn_v1/u);
  assert.match(gateway, /quickReplies:\s*\[\]/u);
  assert.match(gateway, /action:\s*"none"/u);
});

test("model failures retry and then fall back to a plain conversational model call", () => {
  assert.match(gateway, /bia-agent-primary-failed/u);
  assert.match(gateway, /callModel\(runtime, contextForModel, false, true\)/u);
  assert.match(gateway, /responseStatus/u);
  assert.match(gateway, /incomplete_details/u);
  assert.match(gateway, /x-request-id/u);
});

test("model output budget is large enough to include reasoning and visible output", () => {
  assert.match(gateway, /max_output_tokens:\s*allowTools \? 4_096 : 3_000/u);
});
