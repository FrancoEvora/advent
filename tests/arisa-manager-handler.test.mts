import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

type Obj = Record<string, unknown>;
const root = new URL("../", import.meta.url), org = "11111111-1111-4111-8111-111111111111", user = "22222222-2222-4222-8222-222222222222", messageId = "33333333-3333-4333-8333-333333333333", threadId = "44444444-4444-4444-8444-444444444444", lease = "55555555-5555-4555-8555-555555555555";
let auth = true, adminAccess = true, visible = true, terminal = false, mutation = false, round = 0;
let calls: { key: string; name: string; args: Obj }[] = [];
const reset = () => { auth = true; adminAccess = true; visible = true; terminal = false; mutation = false; round = 0; calls = []; };
function createClient(_url: string, key: string) {
  return {
    auth: { getUser: async () => ({ error: auth ? null : {}, data: { user: auth ? { id: user } : null } }) },
    rpc: async (name: string, args: Obj) => {
      calls.push({ key, name, args });
      if (name === "arisa_admin_catalog") return { error: adminAccess ? null : { code: "42501", message: "ADMIN_REQUIRED" }, data: { entities: [] } };
      if (name === "get_crm_ai_runtime_credentials") return { error: null, data: { enabled: true, api_key: "private-test-key-".repeat(4), agent_model: "test-model" } };
      if (name === "arisa_chat_claim") return { error: null, data: { lease: terminal ? null : lease, message: { id: messageId, content: "Cadastre o fornecedor Teste", created_at: "2026-09-05T12:00:00Z", file_ids: [] } } };
      if (name === "arisa_admin_execute") return { error: null, data: { ok: true, record_id: "created" } };
      if (name === "arisa_recall") return { error: null, data: [] };
      if (name === "arisa_trace") return { error: null, data: "archived-trace" };
      if (name === "arisa_chat_finish") return { error: null, data: { id: "reply", content: args.p_content, status: "completed" } };
      throw new Error("Unexpected RPC " + name);
    },
    from: (name: string) => {
      assert.equal(key, "public-test");
      const query = { select: () => query, eq: () => query, lte: () => query, order: () => query, limit: () => query,
        maybeSingle: async () => ({ error: null, data: visible ? { id: messageId, thread_id: threadId, content: "Resposta anterior" } : null }),
        then: (resolve: (result: unknown) => unknown) => Promise.resolve({ error: null, data: name === "arisa_chat_actions" ? [] : [{ id: messageId, role: "user", content: "Teste", file_ids: [], created_at: "2026-09-05T12:00:00Z" }] }).then(resolve),
      }; return query;
    },
  };
}
const target = globalThis as unknown as { __arisaManagerClient: typeof createClient; Deno: { env: { get: (name: string) => string | undefined } } };
target.__arisaManagerClient = createClient;
target.Deno = { env: { get: name => ({ SUPABASE_URL: "https://test.invalid", SUPABASE_ANON_KEY: "public-test", SUPABASE_SERVICE_ROLE_KEY: "service-test" } as Record<string, string>)[name] } };
const source = readFileSync(new URL("supabase/functions/arisa-manager/index.ts", root), "utf8")
  .replace(/import \{ createClient, type SupabaseClient \} from [^;]+;/, "const createClient = globalThis.__arisaManagerClient; type SupabaseClient = any;")
  .replaceAll('"../_shared/arisa-document.ts"', JSON.stringify(new URL("supabase/functions/_shared/arisa-document.ts", root).href))
  .replaceAll('"../_shared/arisa-manager.ts"', JSON.stringify(new URL("supabase/functions/_shared/arisa-manager.ts", root).href))
  .replaceAll('"../_shared/arisa-mail-runtime.ts"', JSON.stringify(new URL("supabase/functions/_shared/arisa-mail-runtime.ts", root).href))
  .replaceAll('"../_shared/arisa-calendar.ts"', JSON.stringify(new URL("supabase/functions/_shared/arisa-calendar.ts", root).href))
  .replaceAll('"../_shared/arisa-calendar-runtime.ts"', JSON.stringify(new URL("supabase/functions/_shared/arisa-calendar-runtime.ts", root).href))
  .replaceAll('"../_shared/arisa-whatsapp.ts"', JSON.stringify(new URL("supabase/functions/_shared/arisa-whatsapp.ts", root).href))
  .replaceAll('"../_shared/arisa-whatsapp-runtime.ts"', JSON.stringify(new URL("supabase/functions/_shared/arisa-whatsapp-runtime.ts", root).href))
  .replace("Deno.serve(handleRequest);", "");
const { handleRequest } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source, { mode: "strip" })).toString("base64")}`);
const originalFetch = globalThis.fetch;
const request = (token = "Bearer test-token") => new Request("https://test.invalid/arisa-manager", { method: "POST", headers: { authorization: token }, body: JSON.stringify({ action: "chat", organizationId: org, messageId }) });
test.beforeEach(() => {
  reset(); globalThis.fetch = async () => {
    const output = mutation && !round++ ? [{ type: "function_call", call_id: "call_1", name: "execute", arguments: JSON.stringify({ action: "create", entity: "contacts", values: { name: "Teste" }, summary: "Fornecedor cadastrado" }) }] : [{ type: "message", content: [{ type: "output_text", text: "Resposta concluída." }] }];
    return new Response(JSON.stringify({ status: "completed", output, usage: { input_tokens: 1, output_tokens: 1 } }));
  };
});
test.afterEach(() => { globalThis.fetch = originalFetch; });
test("anonymous and expired sessions cannot read credentials or claim work", async () => {
  assert.equal((await handleRequest(request(""))).status, 401); assert.equal(calls.length, 0);
  auth = false; assert.equal((await handleRequest(request())).status, 401); assert.equal(calls.length, 0);
});
test("admin authorization is enforced before service-role credentials are read", async () => {
  adminAccess = false; assert.equal((await handleRequest(request())).status, 403);
  assert.deepEqual(calls.map(call => call.name), ["arisa_admin_catalog"]); assert.equal(calls[0].key, "public-test");
});
test("RLS visibility is required before a service-role claim", async () => {
  visible = false; assert.equal((await handleRequest(request())).status, 404); assert.equal(calls.some(call => call.name === "arisa_chat_claim"), false);
});
test("an already completed message is returned without new generation or mutation", async () => {
  terminal = true; const response = await handleRequest(request()); assert.equal(response.status, 200); assert.equal((await response.json()).replayed, true); assert.equal(calls.some(call => call.name === "arisa_chat_finish"), false);
});
test("administrative mutation uses the CALLER token, actual message lease, and server-enforced organization", async () => {
  mutation = true; const response = await handleRequest(request()); assert.equal(response.status, 200);
  const executed = calls.find(call => call.name === "arisa_admin_execute")!;
  assert.equal(executed.key, "public-test"); assert.equal(executed.args.p_organization_id, org); assert.equal(executed.args.p_message_id, messageId); assert.equal(executed.args.p_lease, lease); assert.match(String(executed.args.p_operation_key), /^[a-f0-9]{64}$/);
  const finish = calls.find(call => call.name === "arisa_chat_finish")!; assert.equal(finish.key, "service-test"); assert.equal(finish.args.p_lease, lease); assert.equal((finish.args.p_metadata as Obj).model, "test-model");
  assert.equal(JSON.stringify(await response.json()).includes("private-test-key"), false);
});
