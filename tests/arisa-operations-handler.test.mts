import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const root = new URL("../", import.meta.url);
const orgId = "11111111-1111-4111-8111-111111111111", userId = "22222222-2222-4222-8222-222222222222", itemId = "33333333-3333-4333-8333-333333333333", lease = "44444444-4444-4444-8444-444444444444";
type Obj = Record<string, unknown>;
type State = { auth: boolean; permissions: boolean; visible: boolean; claimError: Obj | null; terminal: boolean; badHash: boolean; runtimeEnabled: boolean; calls: { name: string; args: Obj }[]; file: string; fileName: string; mime: string; kind: string };
let state: State;
const { sha256 } = await import(new URL("supabase/functions/_shared/arisa-document.ts", root).href);
function reset() {
  state = { auth: true, permissions: true, visible: true, claimError: null, terminal: false, badHash: false, runtimeEnabled: false, calls: [], file: "Data;Valor;Descrição\n2026-09-04;-123,45;Materiais", fileName: "extrato.csv", mime: "text/csv", kind: "bank_statement" };
}
function client(key: string) {
  return {
    auth: { getUser: async () => state.auth ? { error: null, data: { user: { id: userId } } } : { error: {}, data: { user: null } } },
    rpc: async (name: string, args: Obj) => {
      state.calls.push({ name, args });
      if (name === "has_app_permission") { assert.equal(key, "public-test"); return { error: null, data: state.permissions }; }
      assert.equal(key, "service-test");
      if (name === "arisa_claim_operation") {
        if (state.claimError) return { error: state.claimError, data: null };
        const item = { id: itemId, organization_id: orgId, input_kind: state.kind, storage_path: `${orgId}/${userId}/file`, file_hash: state.badHash ? "0".repeat(64) : await sha256(new TextEncoder().encode(state.file)), file_name: state.fileName, mime_type: state.mime, status: state.terminal ? "completed" : "processing" };
        return { error: null, data: { item, lease_token: state.terminal ? null : lease } };
      }
      if (name === "arisa_finish_extraction") return { error: null, data: { id: itemId, status: "review", extracted: args.p_extracted } };
      if (name === "arisa_fail_operation") return { error: null, data: { id: itemId, status: "failed" } };
      if (name === "get_crm_ai_runtime_credentials") return { error: null, data: { enabled: state.runtimeEnabled } };
      throw new Error(`Unexpected RPC ${name}`);
    },
    from: (name: string) => {
      assert.equal(key, "public-test"); assert.equal(name, "arisa_operation_items");
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ error: null, data: state.visible ? { id: itemId, organization_id: orgId } : null }) };
      return query;
    },
    storage: { from: (name: string) => { assert.equal(name, "arisa-operations"); return { download: async () => ({ error: null, data: new Blob([state.file], { type: state.mime }) }) }; } },
  };
}
const globalTest = globalThis as unknown as { __arisaCreateClient: (_url: string, key: string) => unknown; Deno: { env: { get: (name: string) => string | undefined } } };
globalTest.__arisaCreateClient = (_url, key) => client(key);
globalTest.Deno = { env: { get: name => ({ SUPABASE_URL: "https://test.invalid", SUPABASE_ANON_KEY: "public-test", SUPABASE_SERVICE_ROLE_KEY: "service-test" } as Record<string, string>)[name] } };
const source = readFileSync(new URL("supabase/functions/arisa-operations/index.ts", root), "utf8")
  .replace(/import \{ createClient, type SupabaseClient \} from [^;]+;/, "const createClient = globalThis.__arisaCreateClient; type SupabaseClient = any;")
  .replaceAll('"../_shared/arisa-document.ts"', JSON.stringify(new URL("supabase/functions/_shared/arisa-document.ts", root).href))
  .replace("Deno.serve(handleRequest);", "");
const { handleRequest } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source, { mode: "strip" })).toString("base64")}`);
const request = (authorization = "Bearer test-token") => new Request("https://test.invalid/arisa-operations", { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ action: "process", organizationId: orgId, itemId }) });
test("worker authenticates and checks both permissions before claiming any document", async () => {
  reset(); state.auth = false;
  const response = await handleRequest(request()); assert.equal(response.status, 401); assert.equal(state.calls.length, 0);
  reset(); state.permissions = false;
  const denied = await handleRequest(request()); assert.equal(denied.status, 403);
  assert.deepEqual(state.calls.map(call => call.args.p_permission_key).sort(), ["documents.manage", "financial.manage"]);
});
test("worker requires RLS visibility in the requested organization before service-role claim", async () => {
  reset(); state.visible = false;
  const response = await handleRequest(request()); assert.equal(response.status, 404);
  assert.equal(state.calls.some(call => call.name === "arisa_claim_operation"), false);
});
test("worker completes a real CSV extraction through the agreed claim/finish DTO", async () => {
  reset();
  const response = await handleRequest(request()); assert.equal(response.status, 200);
  const claim = state.calls.find(call => call.name === "arisa_claim_operation")!;
  assert.deepEqual(claim.args, { p_item_id: itemId, p_actor_user_id: userId });
  const finish = state.calls.find(call => call.name === "arisa_finish_extraction")!;
  assert.equal(finish.args.p_lease_token, lease);
  const extracted = finish.args.p_extracted as { document_type: string; transactions: { posted_on: string; amount: number }[]; warnings: string[] };
  assert.equal(extracted.document_type, "bank_statement");
  assert.deepEqual(extracted.transactions.map(t => [t.posted_on, t.amount]), [["2026-09-04", -123.45]]);
  assert.deepEqual(extracted.warnings, []);
  assert.equal(state.calls.some(call => call.name === "get_crm_ai_runtime_credentials"), false);
});
test("worker hash mismatch fails claimed lease without parsing or finishing", async () => {
  reset(); state.badHash = true;
  const response = await handleRequest(request()); assert.equal(response.status, 409);
  const failed = state.calls.find(call => call.name === "arisa_fail_operation")!;
  assert.equal(failed.args.p_error_code, "FILE_HASH_MISMATCH"); assert.equal(failed.args.p_lease_token, lease);
  assert.equal(state.calls.some(call => call.name === "arisa_finish_extraction"), false);
});
test("worker terminal retry is idempotent and never re-extracts", async () => {
  reset(); state.terminal = true;
  const response = await handleRequest(request()); assert.equal(response.status, 200);
  assert.equal((await response.json()).alreadyProcessed, true);
  assert.equal(state.calls.some(call => ["arisa_finish_extraction", "arisa_fail_operation"].includes(call.name)), false);
});
test("worker exposes actionable conflict, permission and retry errors from Portuguese SQL messages", async () => {
  for (const [dbError, status, code] of [
    [{ code: "55P03", message: "Documento já está em processamento." }, 409, "OPERATION_IN_PROGRESS"],
    [{ code: "42501", message: "Permissão insuficiente." }, 403, "PERMISSION_REQUIRED"],
    [{ code: "P0001", message: "Limite de tentativas atingido." }, 409, "RETRY_LIMIT_REACHED"],
  ] as const) {
    reset(); state.claimError = dbError;
    const response = await handleRequest(request()); assert.equal(response.status, status); assert.equal((await response.json()).error, code);
    assert.equal(state.calls.some(call => call.name === "arisa_fail_operation"), false);
  }
});
test("worker disabled model configuration provides a recoverable message and never calls provider", async () => {
  reset(); state.kind = "payable"; state.file = "%PDF-1.7\nfixture"; state.fileName = "documento.pdf"; state.mime = "application/pdf";
  const response = await handleRequest(request()); assert.equal(response.status, 409);
  const body = await response.json(); assert.equal(body.error, "AI_RUNTIME_DISABLED"); assert.match(body.message, /XML NF-e, CSV e OFX/);
  assert.equal(state.calls.find(call => call.name === "arisa_fail_operation")?.args.p_error_code, "AI_RUNTIME_DISABLED");
  assert.equal(state.calls.some(call => call.name === "arisa_finish_extraction"), false);
});
