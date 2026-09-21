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
const app = readFileSync(
  new URL("../src/components/erp/erp-app-v55.tsx", import.meta.url),
  "utf8",
);
const queueMigration = readFileSync(
  new URL("../supabase/migrations/20260921183823_crm_strategy_bia_queue.sql", import.meta.url),
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
  assert.match(engine, /unit\.status !== "disponivel"/);
  assert.match(engine, /unit\.list_price/);
  assert.match(engine, /Revisar filtros da oferta/);
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

test("CRM exposes guarded operational actions from the strategy queue", () => {
  assert.match(enterprise, /id:"strategy",label:"Estratégia IA"/);
  assert.match(enterprise, /<StrategyView/);
  assert.match(view, /não uma\s+probabilidade estatística de compra/i);
  assert.match(view, /Enviar para fila da Bia/);
  assert.match(view, /Enviar material/);
  assert.match(view, /Remarketing · 7 dias/);
  assert.match(view, /Remarketing · 30 dias/);
  assert.match(view, /window\.confirm/);
  assert.match(queueMigration, /bia_bulk_candidate_reason/);
  assert.match(queueMigration, /bia_bulk_consent_for_record/);
  assert.match(queueMigration, /BIA_ALREADY_QUEUED/);
  assert.match(queueMigration, /revoke all on function public\.bia_strategy_enqueue_lead/);
});

test("strategy queue supports search filters sorting and pagination", () => {
  assert.match(view, /Buscar lead/);
  assert.match(view, /Ação recomendada/);
  assert.match(view, /Score · maior primeiro/);
  assert.match(view, /Mais tempo sem contato/);
  assert.match(view, /PAGE_SIZE = 25/);
});

test("Enterprise sidebar has a live menu search", () => {
  assert.match(app, /Buscar no menu/);
  assert.match(app, /normalizeMenuSearch/);
  assert.match(app, /filteredCrmSections/);
  assert.match(app, /filteredPostSaleSections/);
  assert.match(app, /filteredPermitted/);
});
