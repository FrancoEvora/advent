import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const route = fs.readFileSync("src/app/api/public-agent/message/route.ts", "utf8");
const css = fs.readFileSync("src/app/styles/v6-26-bia-commercial-presentation.css", "utf8");
const layout = fs.readFileSync("src/app/layout.tsx", "utf8");

test("Bia exibe status de escrita durante o processamento", () => {
  assert.match(css, /Bia está escrevendo/u);
  assert.match(css, /public-agent-typing::after/u);
});

test("condições comerciais são preparadas antes da resposta complementar", () => {
  assert.match(route, /Condições comerciais:/u);
  assert.match(route, /• Entrada:/u);
  assert.match(route, /• Parcelas:/u);
  assert.match(route, /• Juros:/u);
  assert.match(route, /• Correção:/u);
  assert.match(route, /• Balões:/u);
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
