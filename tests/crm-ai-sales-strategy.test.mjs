import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const engine = readFileSync(
  new URL("../src/components/erp/crm-v5/strategy-engine.ts", import.meta.url),
  "utf8",
);
const view = readFileSync(
  new URL("../src/components/erp/crm-v5/strategy-view.tsx", import.meta.url),
  "utf8",
);
const enterprise = readFileSync(
  new URL("../src/components/erp/crm-v5/enterprise.tsx", import.meta.url),
  "utf8",
);

test("strategy engine only prioritizes open CRM opportunities", () => {
  assert.match(engine, /record_status === "aberta"/);
  assert.match(engine, /lead_score/);
  assert.match(engine, /first_response_at/);
  assert.match(engine, /sla_due_at/);
  assert.match(engine, /preferred_area_min/);
});

test("next best offer stays grounded in canonical CRM data", () => {
  assert.match(engine, /record\.product_id/);
  assert.match(engine, /record\.project_id/);
  assert.match(engine, /Não recomendar produto ainda/);
  assert.match(engine, /Qualifique empreendimento, orçamento e metragem/);
});

test("objection analysis covers the main commercial barriers", () => {
  for (const key of [
    "preco",
    "parcela",
    "entrada",
    "financiamento",
    "localizacao",
    "momento",
    "confianca",
  ]) {
    assert.match(engine, new RegExp(key));
  }
});

test("CRM exposes the AI strategy command center without autonomous dispatch", () => {
  assert.match(enterprise, /id:"strategy",label:"Estratégia IA"/);
  assert.match(enterprise, /<StrategyView/);
  assert.match(view, /não uma\s+probabilidade estatística de compra/i);
  assert.match(view, /não dispara contato/i);
});
