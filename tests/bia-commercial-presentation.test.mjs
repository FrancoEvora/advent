import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const route = fs.readFileSync("src/app/api/public-agent/message/route.ts", "utf8");
const css = fs.readFileSync("src/app/styles/v6-26-bia-commercial-presentation.css", "utf8");
const layout = fs.readFileSync("src/app/layout.tsx", "utf8");
const gateway = fs.readFileSync("supabase/functions/enterprise-bia-agent-gateway/index.ts", "utf8");

test("Bia exibe status de escrita durante o processamento", () => {
  assert.match(css, /Bia está escrevendo/u);
  assert.match(css, /public-agent-typing::after/u);
});
test("condições comerciais são preparadas antes da resposta complementar", () => {
  for (const label of ["Condições comerciais:", "• Entrada:", "• Parcelas:", "• Juros:", "• Correção:", "• Balões:"]) assert.ok(route.includes(label));
  assert.match(route, /\$\{prelude\}\\n\\n\$\{reply\}/u);
});
test("anexos são deduplicados e apenas um PDF de simulação é preservado", () => {
  assert.match(route, /dedupeAttachments/u);
  assert.match(route, /simulationDocumentKept/u);
  assert.match(route, /if \(seen\.has\(key\)\) return false/u);
});
test("folha final da apresentação comercial é carregada depois da base do agente", () => {
  const base = layout.indexOf('import "./styles/v6-26-public-agent.css"');
  const final = layout.indexOf('import "./styles/v6-26-bia-commercial-presentation.css"');
  assert.ok(base >= 0 && final > base);
});
test("gateway entrega saída para todas as ferramentas e usa cálculo canônico", () => {
  assert.match(gateway, /function toolCalls\(/u);
  assert.doesNotMatch(gateway, /function findTool\(/u);
  assert.match(gateway, /for\s*\(const call of calls\)/u);
  assert.match(gateway, /type\s*:\s*"function_call_output"/u);
  assert.match(gateway, /call_id\s*:\s*call\.callId/u);
  assert.match(gateway, /calculate_public_agent_payment_simulation_v4/u);
  assert.match(gateway, /objective=lowest_monthly_payment/u);
  assert.match(gateway, /unitCode\s*:\s*code\(args\.unit_code\)/u);
  assert.match(gateway, /areaMin\s*:\s*num\(args\.area_min\)/u);
  assert.match(gateway, /budgetMax\s*:\s*num\(args\.budget_max\)/u);
});
test("respostas comerciais são persistidas como texto limpo", () => {
  assert.match(gateway, /function cleanReply\(/u);
  assert.match(gateway, /sem Markdown, sem asteriscos/u);
  assert.match(gateway, /\.replace\(\/\\\*\\\*\(\[\^\*\]\+\)\\\*\\\*\/g/u);
  assert.match(gateway, /reply\s*:\s*cleanReply\(reply\)/u);
});
