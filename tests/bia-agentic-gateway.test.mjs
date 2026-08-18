import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const gateway = fs.readFileSync("supabase/functions/enterprise-bia-agent-gateway/index.ts", "utf8");
const server = fs.readFileSync("src/lib/public-agent/server.ts", "utf8");

test("public agent uses the agentic gateway", () => {
  assert.match(server, /enterprise-bia-agent-gateway/u);
});

test("every valid text turn reaches the model before an ERP tool", () => {
  assert.match(gateway, /runAgentTurn/u);
  assert.match(gateway, /Every valid text conversation turn reaches the model first/u);
  assert.match(gateway, /const decision = await runAgentTurn/u);
  assert.match(gateway, /const tool = text\(decision\.tool\) \|\| "none"/u);
  assert.match(gateway, /if \(tool !== "none"\)/u);
});

test("qualitative investment conversation stays with the model", () => {
  assert.match(gateway, /'Quero investir' => tool=none/u);
  assert.match(gateway, /comprar para vender daqui alguns anos/u);
  assert.match(gateway, /Nunca escolha uma ferramenta apenas porque o assunto é imóvel, investimento ou Solaris/u);
  assert.match(gateway, /não um chatbot de menus/u);
});

test("canonical and transactional capabilities are explicit ERP tools", () => {
  assert.match(gateway, /"inventory"/u);
  assert.match(gateway, /"commercial"/u);
  assert.match(gateway, /"simulation"/u);
  assert.match(gateway, /"visit"/u);
  assert.match(gateway, /"hold"/u);
  assert.match(gateway, /enterprise-vitoria-agent-gateway/u);
  assert.match(gateway, /delegateToEnterprise/u);
});

test("ordinary conversation is persisted without forcing buttons or actions", () => {
  assert.match(gateway, /commit_public_agent_gateway_turn_v1/u);
  assert.match(gateway, /action:\s*"none"/u);
  assert.match(gateway, /quickReplies:\s*\[\]/u);
  assert.match(gateway, /requestContact:\s*false/u);
  assert.match(gateway, /handoffRequested:\s*false/u);
});
