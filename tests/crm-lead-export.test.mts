import test from "node:test";
import assert from "node:assert/strict";
import { readAllLeadPages, buildLeadReport, formatExportValue, leadColumns } from "../src/lib/crm-lead-export.ts";

const context = { organization: "Organização de teste", generatedAt: "2026-09-23T11:00:00Z", sourceUrl: "https://example.invalid/crm/relatorios", warnings: [] };

test("exports over 1,000 leads even when the server returns pages smaller than requested", async () => {
  const original = Array.from({ length: 1207 }, (_, i) => ({ id: String(i).padStart(5, "0"), person_name: "Teste sintético" }));
  let calls = 0;
  const result = await readAllLeadPages(async (after, first) => { calls++; return { rows: original.filter(row => !after || row.id > after).slice(0, 83), total: first ? original.length : null }; });
  assert.equal(result.length, 1207); assert.equal(calls, 15); assert.deepEqual(result, original);
});
test("rejects incomplete exports rather than downloading partial data", async () => {
  await assert.rejects(readAllLeadPages(async after => ({ rows: after ? [] : [{ id: "01" }], total: 2 })), /incompleta/);
});
test("rejects repeated IDs, changed counts and unavailable counts", async () => {
  await assert.rejects(readAllLeadPages(async () => ({ rows: [{ id: "01" }, { id: "01" }], total: 2 })), /inconsistentes/);
  await assert.rejects(readAllLeadPages(async () => ({ rows: [{ id: "01" }], total: 0 })), /mudou/);
  await assert.rejects(readAllLeadPages(async () => ({ rows: [], total: null })), /conferir/);
});
test("cancellation stops before any query", async () => {
  const controller = new AbortController(); controller.abort(); let queried = false;
  await assert.rejects(readAllLeadPages(async () => { queried = true; return { rows: [], total: 0 }; }, undefined, controller.signal));
  assert.equal(queried, false);
});
test("preserves text identifiers, leading zeros, formula-like strings and missing values", () => {
  const column = { key: "phone", label: "Telefone" };
  for (const text of ["00345678901", "+5511999999999", "=HYPERLINK(\"x\")", "@exemplo", "-123"]) assert.equal(formatExportValue(text, column), text);
  assert.equal(formatExportValue(null, column), null);
  assert.equal(formatExportValue("", column), "");
  assert.equal(formatExportValue(false, column), "Não");
});
test("keeps numeric money usable and converts dates to Brasilia without changing birthday", () => {
  assert.deepEqual(formatExportValue("1234.50", leadColumns.find(c => c.key === "monthly_income")!), { t: "n", v: 1234.5, z: '"R$" #,##0.00' });
  const time = formatExportValue("2026-09-23T11:00:00Z", leadColumns.find(c => c.key === "created_at")!) as { v: number };
  assert.ok(Math.abs((time.v % 1) - 8 / 24) < 1e-9);
  const birth = formatExportValue("1980-05-12", leadColumns.find(c => c.key === "birth_date")!) as { v: number };
  assert.equal(birth.v % 1, 0);
});
test("includes archived and same-phone leads; linked contacts are separate; does not overwrite missing fields", () => {
  const rows = [{ id: "01", phone: "0011", person_name: null, contact_id: "c1", project_id: "p1", record_status: "arquivada" }, { id: "02", phone: "0011", record_status: "ativa" }];
  const sheets = buildLeadReport(rows, [{ id: "c1", name: "Contato sintético" }], { project_id: { p1: "Empreendimento sintético" } }, context);
  const leads = sheets.find(s => s.name === "Leads")!;
  assert.equal(leads.rows.length, 2);
  assert.equal(leads.rows[0][leads.columns.findIndex(c => c.key === "person_name")], null);
  assert.equal(leads.rows[0][leads.columns.findIndex(c => c.key === "resolved_project_id")], "Empreendimento sintético");
  assert.equal(sheets.find(s => s.name === "Contatos vinculados")!.rows.length, 1);
  assert.equal(new Set(leads.columns.map(c => c.label)).size, leads.columns.length);
});
test("long observations are preserved completely across numbered parts", () => {
  const notes = "Texto extenso sintético. ".repeat(4000);
  const sheets = buildLeadReport([{ id: "01", notes }], [], {}, context);
  const parts = sheets.find(s => s.name === "Textos extensos")!.rows;
  assert.equal(parts.map(row => row[3]).join(""), notes);
  assert.ok(parts.every(row => String(row[3]).length <= 30000));
});
