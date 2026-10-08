import type { CrmRecord } from "../components/erp/types";
import type { CrmStage } from "../components/erp/crm-v5/types";
import type { BrokerProposal } from "../components/erp/broker/load-broker-data";

export const normalizeBrokerSearch = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").trim();
export const personallyAssigned = (lead: CrmRecord, userId: string) => lead.broker_user_id === userId || (!lead.broker_user_id && lead.owner_user_id === userId);
export const APPROVED_PROPOSALS_COLUMN = "broker-approved-proposals";

type BrokerColumn = { id: string; name: string; leads: CrmRecord[] };

/** Presentation only: never changes the shared SDR pipeline or grants approval. */
export function buildBrokerFunnel(records: CrmRecord[], allStages: CrmStage[], proposals: BrokerProposal[], userId: string, pipelineId: string) {
  const stages = allStages.filter(stage => stage.pipeline_id === pipelineId).sort((a, b) => a.position - b.position);
  const isSdr = (stage: CrmStage) => stage.code === "qualificacao" || /\bsdr\b/.test(normalizeBrokerSearch(stage.name));
  const serviceStage = stages.find(stage => stage.active && stage.code === "contato" && !isSdr(stage));
  const hasSdr = stages.some(isSdr);
  const serviceId = serviceStage?.id || "broker-service";
  const visibleStages = stages.filter(stage => !isSdr(stage)).map(stage => ({ ...stage, name: hasSdr && stage.id === serviceId ? "Em atendimento" : stage.name }));
  const rows = records.filter(lead => personallyAssigned(lead, userId) && lead.record_status !== "arquivada" && (!lead.pipeline_id || lead.pipeline_id === pipelineId));
  const approvedByLead = new Map<string, BrokerProposal[]>();
  for (const proposal of proposals) {
    // A stage name alone, pending approval, cancellation or rejection never counts as approval.
    if (proposal.approval_status !== "aprovada" || !["aprovada", "enviada", "aceita"].includes(proposal.status)) continue;
    const items = approvedByLead.get(proposal.crm_record_id) || [];
    items.push(proposal);
    approvedByLead.set(proposal.crm_record_id, items);
  }
  const stageByLead = new Map<string, string>();
  const columnByLead = new Map<string, string>();
  for (const lead of rows) {
    // Explicit IDs take precedence over legacy stage codes, preventing duplicate cards.
    const stage = stages.find(stage => stage.id === lead.stage_id) || (!lead.stage_id ? stages.find(stage => stage.code === lead.stage) : undefined);
    const stageId = stage ? (isSdr(stage) ? serviceId : stage.id) : "broker-unclassified";
    stageByLead.set(lead.id, stageId);
    columnByLead.set(lead.id, lead.record_status === "aberta" && approvedByLead.has(lead.id) ? APPROVED_PROPOSALS_COLUMN : stageId);
  }
  const columns: BrokerColumn[] = visibleStages.map(stage => ({ id: stage.id, name: stage.name, leads: [] }));
  if (hasSdr && !serviceStage) {
    const sdrPosition = stages.find(isSdr)!.position;
    const index = visibleStages.findIndex(stage => stage.position > sdrPosition);
    columns.splice(index < 0 ? columns.length : index, 0, { id: serviceId, name: "Em atendimento", leads: [] });
  }
  const proposalIndex = visibleStages.find(stage => stage.code === "proposta")?.id;
  const index = columns.findIndex(column => column.id === proposalIndex);
  const terminalIndex = columns.findIndex(column => visibleStages.some(stage => stage.id === column.id && (stage.is_won || stage.is_lost)));
  columns.splice(index >= 0 ? index + 1 : terminalIndex >= 0 ? terminalIndex : columns.length, 0, { id: APPROVED_PROPOSALS_COLUMN, name: "Propostas aprovadas", leads: [] });
  if (rows.some(lead => columnByLead.get(lead.id) === "broker-unclassified")) columns.unshift({ id: "broker-unclassified", name: "A classificar", leads: [] });
  for (const lead of rows) columns.find(column => column.id === columnByLead.get(lead.id))!.leads.push(lead);
  return { rows, columns, approvedByLead, stageByLead, movableStages: visibleStages.filter(stage => stage.active && !stage.is_won && !stage.is_lost) };
}
