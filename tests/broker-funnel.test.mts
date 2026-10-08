import test from "node:test";
import assert from "node:assert/strict";
import { buildBrokerFunnel, normalizeBrokerSearch, APPROVED_PROPOSALS_COLUMN } from "../src/lib/broker-funnel.ts";
import type { CrmRecord } from "../src/components/erp/types.ts";
import type { CrmStage } from "../src/components/erp/crm-v5/types.ts";
import type { BrokerProposal } from "../src/components/erp/broker/load-broker-data.ts";

const stages = [
  ["novo", "Novo lead"], ["contato", "Tentativa de contato"], ["qualificacao", "Qualificação SDR"],
  ["visita", "Visita agendada"], ["proposta", "Proposta enviada"], ["negociacao", "Negociação"], ["ganho", "Venda concluída"],
].map(([code, name], position) => ({ id: code, code, name, position, pipeline_id: "pipeline", active: true, is_won: code === "ganho", is_lost: false }) as CrmStage);
const lead = (id: string, changes: Partial<CrmRecord> = {}) => ({ id, person_name: id, stage_id: "qualificacao", stage: "qualificacao", pipeline_id: "pipeline", broker_user_id: "broker", record_status: "aberta", ...changes }) as CrmRecord;
const proposal = (crm_record_id: string, status: string, approval_status = "aprovada") => ({ id: crm_record_id + status, crm_record_id, status, approval_status }) as BrokerProposal;
const funnel = (records: CrmRecord[], proposals: BrokerProposal[] = [], selectedStages = stages) => buildBrokerFunnel(records, selectedStages, proposals, "broker", "pipeline");
const lane = (result: ReturnType<typeof funnel>, id: string) => result.columns.find(column => column.id === id)!.leads.map(row => row.id);

test("name search ignores case, accents and surrounding spaces", () => {
  assert.equal(normalizeBrokerSearch("  ANTÔNIO Conceição "), "antonio conceicao");
});
test("SDR cards remain visible in service without exposing the SDR stage or mutating global stages", () => {
  const result = funnel([lead("SDR"), lead("Contact", { stage_id: "contato" })]);
  assert.deepEqual(lane(result, "contato"), ["SDR", "Contact"]);
  assert.equal(result.columns.find(column => column.id === "contato")!.name, "Em atendimento");
  assert.ok(result.columns.every(column => !column.name.includes("SDR")));
  assert.ok(result.movableStages.every(stage => stage.code !== "qualificacao"));
  assert.equal(stages[2].name, "Qualificação SDR");
});
test("approved lane uses actual approval and never pending, rejected, cancelled, expired or contracted proposals", () => {
  const records = ["approved", "sent", "accepted", "pending", "rejected", "cancelled", "expired", "contracted"].map(id => lead(id));
  const result = funnel(records, [proposal("approved", "aprovada"), proposal("sent", "enviada"), proposal("accepted", "aceita"), proposal("pending", "aprovada", "pendente"), proposal("rejected", "rejeitada"), proposal("cancelled", "cancelada"), proposal("expired", "expirada"), proposal("contracted", "contratada")]);
  assert.deepEqual(lane(result, APPROVED_PROPOSALS_COLUMN), ["approved", "sent", "accepted"]);
  assert.equal(result.columns.flatMap(column => column.leads).length, records.length);
  assert.ok(!result.movableStages.some(stage => stage.id === APPROVED_PROPOSALS_COLUMN));
});
test("multiple approved proposals count a lead once; closed sales are not moved back into approval", () => {
  const result = funnel([lead("active"), lead("won", { record_status: "ganha", stage_id: "ganho" })], [proposal("active", "aprovada"), proposal("active", "enviada"), proposal("won", "aprovada")]);
  assert.deepEqual(lane(result, APPROVED_PROPOSALS_COLUMN), ["active"]);
  assert.equal(result.approvedByLead.get("active")!.length, 2);
  assert.deepEqual(lane(result, "ganho"), ["won"]);
});
test("individual funnel excludes agency-only leads, other pipelines and archived records", () => {
  const result = funnel([lead("own"), lead("agency", { broker_user_id: "other" }), lead("another pipeline", { pipeline_id: "other" }), lead("archived", { record_status: "arquivada" }), lead("legacy", { broker_user_id: null, owner_user_id: "broker", pipeline_id: null, stage_id: null })]);
  assert.deepEqual(result.rows.map(row => row.id), ["own", "legacy"]);
});
test("explicit stage IDs override stale legacy codes and unknown IDs stay visible exactly once", () => {
  const result = funnel([lead("visit", { stage_id: "visita", stage: "qualificacao" }), lead("unknown", { stage_id: "missing" })]);
  assert.deepEqual(lane(result, "visita"), ["visit"]);
  assert.deepEqual(lane(result, "broker-unclassified"), ["unknown"]);
  assert.deepEqual(lane(result, "contato"), []);
});
test("pipelines without a contact stage keep SDR leads in a safe virtual lane", () => {
  const result = funnel([lead("SDR")], [], stages.filter(stage => stage.code !== "contato"));
  assert.deepEqual(lane(result, "broker-service"), ["SDR"]);
  assert.ok(!result.movableStages.some(stage => stage.id === "broker-service"));
});
test("approval lane is always present after proposal submission, even when empty", () => {
  const result = funnel([]);
  const proposalPosition = result.columns.findIndex(column => column.id === "proposta");
  assert.equal(result.columns[proposalPosition + 1].id, APPROVED_PROPOSALS_COLUMN);
  assert.deepEqual(lane(result, APPROVED_PROPOSALS_COLUMN), []);
});
