import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [
  archiveRoute,
  archiveMigration,
  enterprise,
  leadsView,
  leadModal,
  leadPayload,
  activityModal,
  operationalData,
] = await Promise.all([
  source("src/app/api/crm/leads/archive/route.ts"),
  source("supabase/migrations/20260817154200_crm_admin_lead_archival_guard.sql"),
  source("src/components/erp/crm-v5/enterprise.tsx"),
  source("src/components/erp/crm-v5/leads-view.tsx"),
  source("src/components/erp/crm-v5/lead-modal-v52.tsx"),
  source("src/components/erp/crm-v5/lead-form-payload.ts"),
  source("src/components/erp/crm-v5/activity-modal.tsx"),
  source("src/components/erp/operational-data.ts"),
]);

test("arquivamento falha fechado diante de vínculos comerciais ativos", () => {
  assert.match(archiveRoute, /activeReservations/);
  assert.match(archiveRoute, /activeProposals/);
  assert.match(archiveRoute, /activeContracts/);
  assert.match(archiveRoute, /archiveAllowed:\s*blockers\.allowed/);
  assert.match(archiveRoute, /LEAD_HAS_ACTIVE_COMMERCIAL_LINKS/);
  assert.match(leadsView, /archivePreview\.archiveAllowed !== true/);
  assert.match(leadsView, /Exclusão bloqueada por segurança comercial/);
});

test("RPC arquiva e encerra canais na mesma transação com fencing concorrente", () => {
  assert.match(archiveMigration, /function public\.archive_crm_lead_v1/);
  assert.match(
    archiveMigration,
    /create policy crm_records_delete[\s\S]*crm_canonical_restore_active\(organization_id\)/,
  );
  assert.match(archiveMigration, /for update;/);
  assert.match(
    archiveMigration,
    /update public\.crm_actions action[\s\S]*action_status = 'cancelada'/,
  );
  assert.match(
    archiveMigration,
    /update public\.crm_lead_assignments assignment[\s\S]*status = 'cancelada'/,
  );
  assert.match(
    archiveMigration,
    /update public\.crm_alerts alert[\s\S]*status = 'resolvido'/,
  );
  assert.match(
    archiveMigration,
    /update public\.crm_ai_jobs job[\s\S]*status = 'cancelled'[\s\S]*lock_token = null/,
  );
  assert.match(archiveMigration, /update public\.crm_conversations conversation/);
  assert.match(archiveMigration, /update crm_private\.public_agent_sessions session/);
  assert.match(archiveMigration, /set record_status = 'arquivada'/);
  const recordArchive = archiveMigration.indexOf("set record_status = 'arquivada'");
  for (const childUpdate of [
    "update public.crm_actions action",
    "update public.crm_lead_assignments assignment",
    "update public.crm_alerts alert",
    "update public.crm_ai_jobs job",
    "update public.crm_conversations conversation",
    "update crm_private.public_agent_sessions session",
  ]) {
    assert.ok(
      archiveMigration.indexOf(childUpdate) < recordArchive,
      `${childUpdate} precisa encerrar antes do arquivamento`,
    );
  }
  assert.match(archiveRoute, /\.rpc\("archive_crm_lead_v1"/);
  assert.doesNotMatch(archiveRoute, /\.from\("crm_records"\)\s*\.update\(/);
});

test("filhos não podem reabrir operação nem criar negociação em lead arquivado", () => {
  assert.match(archiveMigration, /for key share;/);
  assert.match(archiveMigration, /guard_archived_lead_reservation/);
  assert.match(archiveMigration, /guard_archived_lead_proposal/);
  assert.match(archiveMigration, /guard_archived_lead_contract/);
  assert.match(archiveMigration, /guard_archived_lead_action/);
  assert.match(archiveMigration, /guard_archived_lead_conversation/);
  assert.match(archiveMigration, /guard_archived_lead_assignment/);
  assert.match(archiveMigration, /guard_archived_lead_alert/);
  assert.match(archiveMigration, /guard_archived_lead_ai_job/);
  assert.match(archiveMigration, /guard_archived_lead_document/);
  assert.match(
    archiveMigration,
    /before insert or update or delete on public\.document_attachments/,
  );
  assert.match(
    archiveMigration,
    /before insert or update or delete on public\.crm_actions/,
  );
  assert.match(archiveMigration, /tg_op = 'DELETE'/);
  assert.match(archiveMigration, /public\.crm_document_storage_write_allowed/);
  assert.match(archiveMigration, /drop policy if exists erp_documents_delete/);
  assert.match(archiveMigration, /record_status_value <> 'arquivada'/);
  assert.ok(
    archiveMigration.match(/crm_canonical_restore_active/g)?.length >= 2,
    "guards de registro e storage precisam respeitar a janela formal de restore",
  );
  assert.match(archiveMigration, /CRM_ARCHIVED_LEAD_CHILD_WRITE_BLOCKED/);
  assert.match(enterprise, /useSalesData\(activeData\)/);
  assert.match(activityModal, /record_status === "arquivada"/);
});

test("inbound tardio é preservado sem reativar ficha ou tarefa arquivada", () => {
  assert.match(
    archiveMigration,
    /and record_status <> 'arquivada';[\s\S]*get diagnostics updated_records = row_count;/,
  );
  assert.match(
    archiveMigration,
    /if updated_records = 0 then\s+return new;/,
  );
});

test("lead arquivado fica somente leitura e não é desarquivado pelo payload", () => {
  assert.match(archiveMigration, /CRM_LEAD_ARCHIVED_READ_ONLY/);
  assert.match(archiveMigration, /before update on public\.crm_records/);
  assert.match(leadModal, /disabled=\{archived\}/);
  assert.match(leadModal, /readOnly=\{archived\}/);
  assert.match(leadModal, /Cadastro arquivado e protegido contra alterações/);
  assert.match(
    leadPayload,
    /lead\?\.record_status === "arquivada"[\s\S]*\? "arquivada"/,
  );
});

test("arquivados saem imediatamente de métricas, filas e seletores", () => {
  assert.match(enterprise, /markRecordArchived/);
  assert.match(enterprise, /const activeCrm = useMemo/);
  assert.match(enterprise, /const activeData = useMemo/);
  assert.match(enterprise, /onArchived=\{markRecordArchived\}/);
  assert.match(operationalData, /neq\("record_status", "arquivada"\)/);
  assert.match(leadsView, /onArchived\(archiveLead\.id\)/);
  assert.match(leadsView, /lead\.record_status !== "arquivada" &&/);
});
