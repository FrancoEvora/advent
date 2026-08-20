import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [
  historyRoute,
  archiveRoute,
  leadsView,
  publicExperience,
  publicLoading,
  publicError,
  publicPage,
  humanReplies,
  archiveGuard,
  greetingMigration,
  vitoriaRuntime,
  legacyPublicRuntime,
  publicSessionRoute,
] =
  await Promise.all([
    readFile("src/app/api/crm/conversations/route.ts", "utf8"),
    readFile("src/app/api/crm/leads/archive/route.ts", "utf8"),
    readFile("src/components/erp/crm-v5/leads-view.tsx", "utf8"),
    readFile("src/components/public-agent/PublicAgentExperience.tsx", "utf8"),
    readFile("src/app/atendimento/[slug]/loading.tsx", "utf8"),
    readFile("src/app/atendimento/[slug]/error.tsx", "utf8"),
    readFile("src/app/atendimento/[slug]/page.tsx", "utf8"),
    readFile(
      "supabase/migrations/20260817154000_vitoria_humanized_action_replies.sql",
      "utf8",
    ),
    readFile(
      "supabase/migrations/20260817154200_crm_admin_lead_archival_guard.sql",
      "utf8",
    ),
    readFile(
      "supabase/migrations/20260817154400_vitoria_persist_initial_greeting.sql",
      "utf8",
    ),
    readFile("supabase/functions/enterprise-vitoria-agent/index.ts", "utf8"),
    readFile("supabase/functions/enterprise-public-agent/index.ts", "utf8"),
    readFile("src/app/api/public-agent/session/route.ts", "utf8"),
  ]);

test("histórico do CRM exige sessão, crm.view e escopo do lead", () => {
  assert.match(historyRoute, /auth\.getUser\(token\)/);
  assert.match(historyRoute, /p_permission_key:\s*"crm\.view"/);
  assert.match(historyRoute, /\.eq\("organization_id", organizationId\)/);
  assert.match(historyRoute, /\.eq\("crm_record_id", crmRecordId\)/);
  assert.match(historyRoute, /Cache-Control":\s*"private, no-store/);
});

test("exclusão administrativa arquiva sem apagar o histórico", () => {
  assert.match(archiveRoute, /membership\.data\?\.role !== "admin"/);
  assert.match(archiveRoute, /archive_crm_lead_v1/);
  assert.match(archiveGuard, /set record_status = 'arquivada'/);
  assert.doesNotMatch(archiveRoute, /\.delete\s*\(/);
  assert.match(leadsView, /archiveConfirmation !== "EXCLUIR"/);
  assert.match(leadsView, /record\.record_status !== "arquivada"/);
  assert.match(archiveGuard, /member\.role = 'admin'/);
  assert.match(archiveGuard, /revoke delete on table public\.crm_records/);
  assert.match(archiveGuard, /before update on public\.crm_records/);
  assert.match(archiveGuard, /set search_path = ''/);
});

test("Bia conversa naturalmente sem esconder o uso de IA", () => {
  assert.match(
    publicExperience,
    /Oi! Tudo bem\? Eu sou a \$\{publicAgentName\(experience\.agentName\)\}, especialista da Futura Casa, parceira da Évora Urbanismo/,
  );
  assert.match(publicExperience, /PUBLIC_AGENT_DISPLAY_NAME = "Bia"/);
  assert.match(
    publicExperience,
    /PUBLIC_AGENT_BRAND_LINE = "Especialista da Futura Casa · Parceira da Évora Urbanismo"/,
  );
  assert.match(
    publicExperience,
    /metadata\.initial_greeting === true[\s\S]*initialGreeting\(experience\)/,
  );
  assert.match(publicLoading, /Futura Casa · Parceira da Évora Urbanismo/);
  assert.match(publicLoading, /Solaris Residencial Resort/);
  assert.doesNotMatch(publicLoading, /<span>Évora Urbanismo<\/span>/);
  assert.match(publicError, /Futura Casa · Parceira da Évora Urbanismo/);
  assert.doesNotMatch(publicError, /<span>Évora Urbanismo<\/span>/);
  assert.match(
    publicPage,
    /appleWebApp:\s*\{[\s\S]*title:\s*"Bia — Futura Casa"/,
  );
  assert.doesNotMatch(
    publicExperience,
    /assistente virtual da Évora Urbanismo\. Posso te ajudar/,
  );
  assert.match(publicExperience, /Atendimento comercial com IA/);
  assert.match(
    legacyPublicRuntime,
    /Não se apresente espontaneamente como assistente virtual/,
  );
  assert.doesNotMatch(
    legacyPublicRuntime,
    /Apresente-se naturalmente como assistente virtual/,
  );
  assert.match(publicExperience, /dados enviados[\s\S]*ficam registrados/);
  assert.match(publicExperience, /relacionamento@evoraurbanismo\.com\.br/);
  assert.match(publicSessionRoute, /PUBLIC_CONVERSATION_MAX_AGE/);
  assert.doesNotMatch(publicSessionRoute, /\* 365/);
  assert.match(greetingMigration, /initial_greeting', true/);
  assert.match(greetingMigration, /not exists[\s\S]*public_agent_messages/);
  assert.match(vitoriaRuntime, /open_public_agent_session_v4/g);
});

test("respostas humanizadas permanecem idempotentes no chat e no CRM", () => {
  assert.match(humanReplies, /commit_public_agent_action_message_v4/);
  assert.match(humanReplies, /update crm_private\.public_agent_messages/);
  assert.match(humanReplies, /update public\.crm_messages/);
  assert.match(humanReplies, /update crm_private\.public_agent_requests/);
  assert.match(humanReplies, /grant execute[\s\S]*to service_role/);
  assert.match(humanReplies, /from public, anon, authenticated, service_role/);
});
