import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const gateway = fs.readFileSync("supabase/functions/enterprise-bia-agent-gateway/index.ts", "utf8");
const server = fs.readFileSync("src/lib/public-agent/server.ts", "utf8");

test("public agent uses the agentic gateway", () => {
  assert.match(server, /enterprise-bia-agent-gateway/u);
});

test("open conversation is decided by the model before transaction delegation", () => {
  assert.match(gateway, /routeWithModel/u);
  assert.match(gateway, /CONVERSA: saudações/u);
  assert.match(gateway, /DELEGUE quando/u);
  assert.match(gateway, /quero investir/u);
  assert.match(gateway, /Não transforme a conversa em menu/u);
});

test("canonical and transactional requests stay behind the proven gateway", () => {
  assert.match(gateway, /enterprise-vitoria-agent-gateway/u);
  assert.match(gateway, /get_public_agent_gateway_context_v1/u);
  assert.match(gateway, /visitState/u);
  assert.match(gateway, /return await delegate\(request,\s*bytes\)/u);
});

test("ordinary conversation is persisted without forcing buttons or actions", () => {
  assert.match(gateway, /commit_public_agent_gateway_turn_v1/u);
  assert.match(gateway, /action:\s*"none"/u);
  assert.match(gateway, /requestContact:\s*false/u);
  assert.match(gateway, /handoffRequested:\s*false/u);
});
