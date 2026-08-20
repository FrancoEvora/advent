import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const activity = await readFile("src/components/erp/crm-v5/activity-modal.tsx", "utf8");
const settings = await readFile("src/components/erp/crm-v5/admin-settings.tsx", "utf8");
const knowledge = await readFile("src/app/api/ai/knowledge/route.ts", "utf8");
const migration = await readFile("supabase/migrations/20260820193000_crm_bia_knowledge_and_broker_calendar.sql", "utf8");
const gateway = await readFile("supabase/functions/enterprise-bia-agent-gateway/index.ts", "utf8");

test("atividade comercial exige corretor e agenda para visitas", () => {
  assert.match(activity, /get_crm_broker_availability/);
  assert.match(activity, /create_crm_activity_with_broker/);
  assert.match(activity, /Atribua um corretor antes de agendar/);
  assert.match(activity, /conflictingIntervals/);
  assert.match(activity, /canAssignBroker/);
});

test("banco protege conflito e cria compromisso do corretor", () => {
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /O corretor já possui compromisso neste horário/);
  assert.match(migration, /calendar_user_activity_id/);
  assert.match(migration, /private\.create_crm_assignment/);
  assert.match(migration, /get_crm_broker_availability/);
});

test("base da Bia é administrativa e tenant-scoped", () => {
  assert.match(settings, /BiaKnowledgeBase/);
  assert.match(knowledge, /crm\.integrations\.manage/);
  assert.match(knowledge, /organizationId/);
  assert.match(knowledge, /MAX_FILE_BYTES = 10 \* 1024 \* 1024/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /crm_ai_knowledge_documents/);
});

test("conteúdo indexado usa o vector store já consumido pela Bia", () => {
  assert.match(knowledge, /vector_stores/);
  assert.match(knowledge, /set_crm_ai_knowledge_vector_store/);
  assert.match(gateway, /type:"file_search"/);
  assert.match(gateway, /vector_store_ids:\[runtime\.vectorStoreId\]/);
});

test("credencial OpenAI não é retornada ao navegador", () => {
  assert.match(migration, /get_crm_ai_knowledge_runtime_credentials/);
  assert.match(migration, /service_role/);
  assert.doesNotMatch(knowledge, /NextResponse\.json\([^\n]*apiKey/);
});
