import test from "node:test";
import assert from "node:assert/strict";
import { runWhatsAppTool } from "../supabase/functions/_shared/arisa-whatsapp-runtime.ts";
import { templateComponents, renderedTemplate, metaWhatsApp, normalizeWhatsAppPhone } from "../supabase/functions/_shared/arisa-whatsapp.ts";

type Obj = Record<string, unknown>;
const org = "11111111-1111-4111-8111-111111111111", actor = "22222222-2222-4222-8222-222222222222", contact = "33333333-3333-4333-8333-333333333333", id = "44444444-4444-4444-8444-444444444444", requestId = "55555555-5555-4555-8555-555555555555";
const phone = "5534999998888";
const runtime = { enabled: true, waba_id: "12345678", phone_number_id: "87654321", graph_api_version: "v26.0", access_token: "fake-test-only-token" };
function fixture(options: { enabled?: boolean; failFinish?: boolean; failResolve?: boolean; provider?: (url: string, body: Obj | null) => Promise<Response> } = {}) {
  const calls: { action: string; args: Obj }[] = [], posts: Obj[] = [], prepared = new Map<string, Obj>();
  let current: Obj | null = null;
  const db = { rpc: async (name: string, input: Obj) => {
    if (name === "arisa_whatsapp_credentials") return { data: { ...runtime, enabled: options.enabled ?? true }, error: null };
    const action = String(input.p_action), args = input.p_args as Obj; calls.push({ action, args });
    if (action === "resolve") return options.failResolve ? { data: null, error: { code: "P0001", message: "WHATSAPP_CONTACT_PHONE_MISMATCH" } } : { data: { phone, contact_id: contact }, error: null };
    if (action === "prepare") {
      const existing = prepared.get(String(args.operation_key));
      if (existing && existing.payload_hash !== args.payload_hash) return { data: null, error: { code: "P0001", message: "WHATSAPP_REQUEST_CHANGED" } };
      if (existing) return { data: { ...existing, proceed: false }, error: null };
      current = { ...args, id, phone, phone_number_id: runtime.phone_number_id, status: "prepared", send_mode: args.template_name ? "template" : "freeform", content: args.content, proceed: true };
      prepared.set(String(args.operation_key), current); return { data: current, error: null };
    }
    if (action === "claim") { current!.status = "queued"; return { data: { ...current, proceed: true }, error: null }; }
    if (action === "finish") {
      if (options.failFinish) return { data: null, error: { code: "P0001", message: "WHATSAPP_REQUEST_CHANGED" } };
      current!.status = "completed"; current!.delivery_status = "accepted"; current!.provider_message_id = args.provider_message_id;
      current!.result = { ok: true, operation_id: id, phone, accepted_by_meta: true, delivery_status: "accepted" };
      return { data: current!.result, error: null };
    }
    if (action === "fail") { current!.status = args.status; current!.delivery_status = args.status; return { data: { ok: true }, error: null }; }
    if (action === "get") return { data: current, error: null };
    if (action === "list") return { data: { messages: [], has_more: false, next_offset: 50 }, error: null };
    return { data: {}, error: null };
  } } as unknown as Parameters<typeof runWhatsAppTool>[0];
  const request: typeof fetch = async (input, init) => {
    const url = String(input), body = init?.body ? JSON.parse(String(init.body)) as Obj : null;
    if (body) posts.push(body);
    if (options.provider) return options.provider(url, body);
    return Response.json({ messages: [{ id: "wamid.test-accepted" }] });
  };
  return { db, calls, posts, request, current: () => current };
}
const args = { contact_id: contact, phone, content: "Carlos, nossa reunião será às 10h para tratar da drenagem. Arisa · Évora." };
const context = { requestId };

test("provider receives only canonical recipient/body claimed by the database and callback operation ID", async () => {
  const f = fixture(); await runWhatsAppTool(f.db, org, actor, "send", args, context, { request: f.request });
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0].to, phone); assert.equal(f.posts[0].biz_opaque_callback_data, id);
  assert.deepEqual(f.posts[0].text, { preview_url: false, body: args.content });
});
test("same request resolved by contact ID then phone is sent once", async () => {
  const f = fixture();
  await runWhatsAppTool(f.db, org, actor, "send", args, context, { request: f.request });
  const result = await runWhatsAppTool(f.db, org, actor, "send", { phone, content: args.content }, context, { request: f.request });
  assert.equal(f.posts.length, 1); assert.equal(result.replayed, true);
  const keys = f.calls.filter(c => c.action === "prepare").map(c => c.args.operation_key); assert.equal(keys[0], keys[1]);
});
test("changed content in same request cannot create another operation", async () => {
  const f = fixture(); await runWhatsAppTool(f.db, org, actor, "send", args, context, { request: f.request });
  await assert.rejects(runWhatsAppTool(f.db, org, actor, "send", { ...args, content: "Outro compromisso." }, context, { request: f.request }), /WHATSAPP_REQUEST_CHANGED/);
  assert.equal(f.posts.length, 1);
});
test("recipient mismatch is rejected before preparing or contacting the provider", async () => {
  const f = fixture({ failResolve: true }); await assert.rejects(runWhatsAppTool(f.db, org, actor, "send", args, context, { request: f.request }), /WHATSAPP_CONTACT_PHONE_MISMATCH/);
  assert.equal(f.posts.length, 0); assert.equal(f.calls.filter(c => c.action === "prepare").length, 0);
});
test("ambiguous transport failure remains unknown and same request never retries", async () => {
  const f = fixture({ provider: async () => { throw new TypeError("network interrupted"); } });
  const result = await runWhatsAppTool(f.db, org, actor, "send", args, context, { request: f.request }); assert.equal(result.status, "unknown");
  await runWhatsAppTool(f.db, org, actor, "send", args, context, { request: f.request }); assert.equal(f.posts.length, 1);
});
test("any audit failure after Meta acceptance remains unknown, including SQL 409", async () => {
  const f = fixture({ failFinish: true });
  const result = await runWhatsAppTool(f.db, org, actor, "send", args, context, { request: f.request });
  assert.equal(result.status, "unknown"); assert.equal(f.calls.at(-1)?.args.status, "unknown");
});
test("explicit Meta rejection is failed without automatic retry", async () => {
  const f = fixture({ provider: async () => Response.json({ error: { code: 131026 } }, { status: 400 }) });
  await assert.rejects(runWhatsAppTool(f.db, org, actor, "send", args, context, { request: f.request }), /WHATSAPP_UNDELIVERABLE/);
  assert.equal(f.current()?.status, "failed");
});
test("templates can be inspected while sending is disabled and only APPROVED are returned", async () => {
  const f = fixture({ enabled: false, provider: async () => Response.json({ data: [{ name: "reuniao", status: "APPROVED", language: "pt_BR", components: [] }, { name: "rascunho", status: "PENDING" }] }) });
  const result = await runWhatsAppTool(f.db, org, actor, "templates", {}, undefined, { request: f.request });
  assert.equal(result.count, 1); assert.equal(f.posts.length, 0);
});
test("named template parameters retain names and audit uses actual approved text", async () => {
  const approved = { name: "reuniao", status: "APPROVED", language: "pt_BR", parameter_format: "NAMED", components: [{ type: "BODY", text: "Olá, {{nome}}. Reunião sobre {{assunto}}. Arisa · Évora." }] };
  const components = [{ type: "body", parameters: [{ type: "text", parameter_name: "nome", text: "Carlos" }, { type: "text", parameter_name: "assunto", text: "drenagem" }] }];
  const f = fixture({ provider: async (_url, body) => Response.json(body ? { messages: [{ id: "wamid.template-accepted" }] } : { data: [approved] }) });
  await runWhatsAppTool(f.db, org, actor, "send", { ...args, template_name: "reuniao", template_components: components }, context, { request: f.request });
  const prepared = f.calls.find(c => c.action === "prepare")!.args;
  assert.equal(prepared.content, "Olá, Carlos. Reunião sobre drenagem. Arisa · Évora.");
  assert.equal(prepared.requested_content, args.content);
  assert.deepEqual((f.posts[0].template as Obj).components, components);
});
test("quick reply payloads survive sanitizing and duplicate components are rejected", () => {
  const component = [{ type: "button", sub_type: "quick_reply", index: 0, parameters: [{ type: "payload", payload: "confirmar_reuniao" }] }];
  assert.deepEqual(templateComponents(component), [{ ...component[0], index: "0" }]);
  assert.throws(() => templateComponents([{ type: "body" }, { type: "body" }]), /WHATSAPP_INVALID/);
});
test("missing named parameter fails before send; E164 bounds enforced", () => {
  assert.throws(() => renderedTemplate({ components: [{ type: "BODY", text: "Olá, {{nome}}" }] }, []), /WHATSAPP_INVALID/);
  assert.equal(normalizeWhatsAppPhone("+55 (34) 99999-8888"), phone);
  assert.throws(() => normalizeWhatsAppPhone("00000000000000000000"), /WHATSAPP_PHONE_INVALID/);
});
test("delivery status reconciliation reflects latest webhook, not original acceptance result", async () => {
  const f = fixture(); await runWhatsAppTool(f.db, org, actor, "send", args, context, { request: f.request });
  f.current()!.delivery_status = "read";
  const result = await runWhatsAppTool(f.db, org, actor, "reconcile", { operation_id: id });
  assert.equal(result.delivery_status, "read"); assert.equal(result.read, true); assert.equal(result.delivered, true);
});
test("Meta window error remains distinct from undeliverable", async () => {
  await assert.rejects(metaWhatsApp(runtime, "87654321/messages", {}, async () => Response.json({ error: { code: 131047 } }, { status: 400 })), /WHATSAPP_TEMPLATE_REQUIRED/);
});
