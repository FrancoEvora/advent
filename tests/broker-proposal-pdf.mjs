// Generate synthetic PDFs only; no customer records or external deliveries.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
for (const months of [3, 96, 360]) {
  const balloonCount = months >= 96 ? 8 : 0, balloonTotal = balloonCount ? 60000 : 0;
  const payment_plan = buildBrokerPlan({ salePrice: 150000, downPayment: 30000, downCount: 3, downDue: "2027-01-31", downRate: 0, downFrequencyDays: 30, months, monthlyRate: 0.0033, method: "sacoc", firstDue: "2027-04-30", graceMonths: 0, balloonTotal, balloonCount, balloonFrequency: 12 });
  const bytes = await createBrokerProposalPdf({ customer_name: "João Sintético de Oliveira", project_name: "Empreendimento de teste", unit_code: "TEST-A01", area: 300, sale_price: 150000, down_payment: 30000, balloon_total: balloonTotal, monthly_interest_rate: 0.0033, indexer: "IPCA", amortization_method: "sacoc", payment_plan, conditions_text: "Condições sujeitas à aprovação. Nenhum envio foi efetuado." });
  const file = path.join(output, `conferencia-${months}.pdf`);
  fs.writeFileSync(file, bytes);
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() >= 1 && pdf.getPageCount() < 25);
  assert.match(pdf.getTitle(), /simples conferência/);
  const text = execFileSync("pdftotext", [file, "-"], { encoding: "utf8" }).replace(/\s+/g, " ");
  assert.match(text, /Índice de correção monetária: IPCA/);
  assert.match(text, /Índice Nacional de Preços ao Consumidor Amplo/);
  assert.equal((text.match(/\bBalão\b/g) || []).length, balloonCount);
  if (balloonCount) assert.match(text, /30\/03\/2035/);
  console.log(JSON.stringify({ file, pages: pdf.getPageCount(), bytes: bytes.length }));
}
