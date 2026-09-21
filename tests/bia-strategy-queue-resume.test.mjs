import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const queueView = readFileSync(
  new URL("../src/components/erp/crm-v5/bia-queue-view.tsx", import.meta.url),
  "utf8",
);
const enterprise = readFileSync(
  new URL("../src/components/erp/crm-v5/enterprise.tsx", import.meta.url),
  "utf8",
);
const strategy = readFileSync(
  new URL("../src/components/erp/crm-v5/strategy-view.tsx", import.meta.url),
  "utf8",
);
const panel = readFileSync(
  new URL("../src/components/assistants/AssistantWhatsAppPanel.tsx", import.meta.url),
  "utf8",
);
const clientTypes = readFileSync(
  new URL("../src/components/assistants/whatsapp-panel-client.ts", import.meta.url),
  "utf8",
);
const queueMigration = readFileSync(
  new URL("../supabase/migrations/20260921201656_bia_strategy_queue_staging.sql", import.meta.url),
  "utf8",
);
const resumeMigration = readFileSync(
  new URL("../supabase/migrations/20260921201820_bia_whatsapp_resume_automation.sql", import.meta.url),
  "utf8",
);
const stagingAcceptanceMigration = readFileSync(
  new URL("../supabase/migrations/20260921202930_bia_queue_staging_acceptance.sql", import.meta.url),
  "utf8",
);

test("strategy action stages a lead instead of dispatching WhatsApp immediately", () => {
  assert.match(queueMigration, /create table if not exists crm_private\.bia_strategy_queue/);
  assert.match(queueMigration, /status text not null default 'staged'/);
  const enqueueStart = queueMigration.indexOf(
    "create or replace function public.bia_strategy_enqueue_lead",
  );
  const queueAdminStart = queueMigration.indexOf(
    "create or replace function public.bia_strategy_queue_admin",
  );
  const enqueueBody = queueMigration.slice(enqueueStart, queueAdminStart);
  assert.match(enqueueBody, /insert into crm_private\.bia_strategy_queue/);
  assert.doesNotMatch(enqueueBody, /bia_campaign_outreach_jobs/);
  assert.doesNotMatch(enqueueBody, /bia_bulk_campaigns/);
  assert.match(
    strategy,
    /Nenhuma mensagem foi enviada ainda/,
  );
});

test("Bia queue supports select all, approved-message selection and explicit firing", () => {
  assert.match(enterprise, /id:"bia_queue",label:"Fila da Bia"/);
  assert.match(enterprise, /<BiaQueueView/);
  assert.match(queueView, /Selecionar todos/);
  assert.match(queueView, /Mensagem \/ modelo inicial/);
  assert.match(queueView, /Disparar ·/);
  assert.match(queueView, /window\.confirm/);
  assert.match(queueMigration, /p_action='fire'/);
  assert.match(queueMigration, /p_args->>'settingsId'/);
  assert.match(queueMigration, /bia_bulk_candidate_reason/);
  assert.match(queueMigration, /bia_bulk_consent_for_record/);
  assert.match(queueMigration, /insert into crm_private\.bia_campaign_outreach_jobs/);
  assert.match(queueMigration, /perform private\.bia_dispatch_campaign_outreach\(\)/);
});

test("queue RPC remains admin-only and private tables remain hidden", () => {
  assert.match(queueMigration, /lower\(member\.role\)='admin'/);
  assert.match(
    queueMigration,
    /revoke all on table crm_private\.bia_strategy_queue from public, anon, authenticated/,
  );
  assert.match(
    queueMigration,
    /revoke all on function public\.bia_strategy_queue_admin\(uuid,text,jsonb\)[\s\S]*from public, anon/,
  );
});

test("resume restores a real skipped inbound job and never fabricates a customer turn", () => {
  assert.match(resumeMigration, /p_action in \('resume','reactivate'\)/);
  assert.match(resumeMigration, /m\.direction='inbound'/);
  assert.match(
    resumeMigration,
    /j\.status='skipped'[\s\S]*'HUMAN_ATTENDING'[\s\S]*'OPERATOR_CHANGED_MODE'/,
  );
  assert.match(resumeMigration, /set status='pending'/);
  assert.match(resumeMigration, /perform private\.bia_dispatch_whatsapp_replies\(\)/);
  assert.doesNotMatch(resumeMigration, /insert into crm_private\.bia_whatsapp_messages[\s\S]*direction.*inbound/);
});

test("resume respects opt-out, blocked sessions, archived leads and service window", () => {
  assert.match(resumeMigration, /BIA_CONTACT_OPTED_OUT/);
  assert.match(resumeMigration, /BIA_SESSION_BLOCKED/);
  assert.match(resumeMigration, /record_status='arquivada'/);
  assert.match(resumeMigration, /23 hours 55 minutes/);
  assert.match(resumeMigration, /status=case when crm_record_id is null then 'active' else 'converted' end/);
});

test("Bia panel reopens expired conversations only through approved-message flow", () => {
  assert.match(clientTypes, /service_window_open\?: boolean/);
  assert.match(panel, /Retomar Bia agora/);
  assert.match(panel, /Retomar com mensagem aprovada/);
  assert.match(panel, /Reabrir conversa/);
  assert.match(panel, /p_action: 'reactivate'/);
  assert.match(panel, /initialPhone=\{openingPhone\}/);
  assert.match(
    panel,
    /A janela de atendimento livre terminou[\s\S]*mensagem aprovada pela Meta/,
  );
});


test("staging accepts open leads even when dispatch guardrails currently warn", () => {
  assert.match(stagingAcceptanceMigration, /crm_private\.bia_bulk_candidate_reason/);
  assert.match(stagingAcceptanceMigration, /insert into crm_private\.bia_strategy_queue/);
  assert.match(stagingAcceptanceMigration, /'warning',queued\.last_error/);
  assert.doesNotMatch(
    stagingAcceptanceMigration,
    /if v_reason is not null then[\s\S]*return jsonb_build_object\('ok',false/,
  );
  assert.match(
    stagingAcceptanceMigration,
    /lead\.record_status<>'aberta'[\s\S]*BIA_CAMPAIGN_LEAD_INACTIVE/,
  );
});
