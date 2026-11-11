// Render actual React components with synthetic data; no authentication or network.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire, Module } from "node:module";
const require = createRequire(import.meta.url);
const ts = require("typescript"), React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (name, ...args) { return originalResolve.call(this, name.startsWith("@/") ? path.resolve("src", name.slice(2)) : name, ...args); };
const compile = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, filename);
require.extensions[".ts"] = compile;
require.extensions[".tsx"] = compile;
require.extensions[".css"] = module => { module.exports = new Proxy({}, { get: (_, key) => String(key) }); };
const { BrokerProposalModal } = require("../src/components/erp/broker/broker-proposal-modal.tsx");
const loaded = {
  units: [{ id: "unit", project_id: "project", unit_code: "TEST-A01", area: 300, list_price: 360000, price_per_sqm: 1200 }],
  crm: { records: [{ id: "lead", project_id: "project", person_name: "Cliente sintético", record_status: "aberta" }] },
  data: { projects: [{ id: "project", name: "Projeto sintético" }] },
  commerce: { lead_policies: [], policies: [{ id: "policy", project_id: "project", is_default: true, name: "Política sintética", min_down_payment_pct: 0.1, max_installments: 180, monthly_interest_rate: 0.0033, max_down_payment_installments: 6, down_payment_frequency_days: 30, down_payment_interest_rate: 0.0033, balloon_limit_pct: 0.4, balloon_frequency_months: 12, grace_months: 0, indexer: "IPCA", reservation_validity_hours: 24, parameters: { annual_balloon_max_count: 4, interest_rate_tiers: [{ max_installments: 96, monthly_interest_rate: 0.0033 }, { max_installments: 120, monthly_interest_rate: 0.005 }, { max_installments: 180, monthly_interest_rate: 0.006 }] } }] },
};
const html = renderToStaticMarkup(React.createElement(BrokerProposalModal, { loaded, initialLeadId: "lead", initialUnitId: "unit", close() {}, async done() {} }));
for (const text of ["Tabela Price", "SACOC", "Juros automáticos", "0,60%", "36.000,00", "Entrada (%)", "Balões anuais", "Conferir com o cliente", "Encaminhar proposta e reservar lote", "Ver cronograma completo"]) assert.ok(html.includes(text), text);
assert.ok(!html.includes('name="monthly_rate"'), "No editable interest field");
assert.ok(html.includes('type="radio" name="amortization_method"'));
assert.ok(html.includes('min="1" max="180"'));
assert.ok(html.includes('role="dialog"'));
assert.ok(html.includes('aria-label="Resumo da simulação"'));
console.log("Broker proposal initial render passed; real React tree, synthetic data, no network");
