// Generate synthetic PDFs only; no customer records or external deliveries.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
const { createBrokerProposalPdf } = require("../src/lib/broker-proposal-pdf.ts");
const { buildBrokerPlan } = require("../src/lib/broker-payment-plan.ts");
const { PDFDocument } = require("pdf-lib");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "broker-pdf-"));
for (const months of [3, 360]) {
  const payment_plan = buildBrokerPlan({ salePrice: 150000, downPayment: 30000, downCount: 3, downDue: "2027-01-31", downRate: 0, downFrequencyDays: 30, months, monthlyRate: 0.0033, method: "sacoc", firstDue: "2027-04-30", graceMonths: 0, balloonTotal: 0, balloonCount: 0, balloonFrequency: 12 });
  const bytes = await createBrokerProposalPdf({ customer_name: "João Sintético de Oliveira", project_name: "Empreendimento de teste", unit_code: "TEST-A01", area: 300, sale_price: 150000, down_payment: 30000, balloon_total: 0, monthly_interest_rate: 0.0033, indexer: "IPCA", amortization_method: "sacoc", payment_plan, conditions_text: "Condições sujeitas à aprovação. Nenhum envio foi efetuado." });
  const file = path.join(output, `conferencia-${months}.pdf`);
  fs.writeFileSync(file, bytes);
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() >= 1 && pdf.getPageCount() < 25);
  assert.match(pdf.getTitle(), /simples conferência/);
  console.log(JSON.stringify({ file, pages: pdf.getPageCount(), bytes: bytes.length }));
}
