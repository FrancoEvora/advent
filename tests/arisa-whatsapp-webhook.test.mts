import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { handleWhatsAppWebhook, normalizeWhatsAppWebhook, verifyWhatsAppSignature, type WebhookRpc } from "../supabase/functions/_shared/arisa-whatsapp-webhook.ts";

const org = "11111111-1111-4111-8111-111111111111", operation = "22222222-2222-4222-8222-222222222222";
const phoneId = "123456789012345", waba = "998877665544332", phone = "5534999999999";
const secret = "only-a-test-app-secret-never-production", verifyToken = "only-a-test-verify-token-never-production";
type Obj = Record<string, unknown>;
function fixture(messages: Obj[] = [], statuses: Obj[] = []) {
  return { object: "whatsapp_business_account", entry: [{ id: waba, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: phoneId }, contacts: [{ wa_id: "5534888888888", profile: { name: "Outro contato" } }, { wa_id: phone, profile: { name: "Carlos da Zenith" } }], messages, statuses } }] }] };
}
const inbound = (id = "wamid.admin", extra: Obj = {}) => ({ id, from: phone, timestamp: "1788656400", type: "text", text: { body: "Confirmo a reunião sobre drenagem às 10h." }, ...extra });
function signature(raw: string | Uint8Array) { return "sha256=" + createHmac("sha256", secret).update(raw).digest("hex"); }
function post(payload: unknown, suffix = "", alteredSignature?: string) {
  const raw = JSON.stringify(payload);
  return new Request("https://example.invalid/functions/v1/enterprise-whatsapp-webhook" + suffix, { method: "POST", headers: { "x-hub-signature-256": alteredSignature || signature(raw) }, body: raw });
}
function dependencies(options: { enabled?: boolean; legacy?: boolean; handled?: string[]; handledStatuses?: string[]; fail?: string; runtime?: Obj } = {}) {
  const calls: { name: string; args: Obj }[] = [];
  const rpc: WebhookRpc = async (name, args) => {
    calls.push({ name, args });
    if (name === options.fail) throw new Error("DO_NOT_EXPOSE_DATABASE_DETAILS");
    if (["arisa_whatsapp_credentials", "arisa_whatsapp_credentials_by_phone_number_id"].includes(name)) return {
      organization_id: org, waba_id: waba, phone_number_id: phoneId, enabled: options.enabled ?? true,
      legacy_crm_enabled: options.legacy ?? false, app_secret: secret, verify_token: verifyToken, ...options.runtime,
    };
    if (name === "arisa_whatsapp_webhook") return { handled_message_ids: options.handled || [], handled_status_ids: options.handledStatuses || [] };
    return { ok: true };
  };
  return { rpc, calls };
}
const mutations = (calls: { name: string }[]) => calls.filter(call => !call.name.includes("credentials"));

test("HMAC covers exact UTF-8 bytes, including accents, whitespace, and final newlines", async () => {
  const raw = new TextEncoder().encode('{"text":"Olá, reunião às 10h"}\n');
  assert.equal(await verifyWhatsAppSignature(raw, signature(raw), secret), true);
  assert.equal(await verifyWhatsAppSignature(raw.slice(0, -1), signature(raw), secret), false);
  assert.equal(await verifyWhatsAppSignature(raw, signature(raw), "wrong-secret"), false);
  for (const header of [null, "sha256=00", "sha1=" + "0".repeat(64), "sha256=" + "x".repeat(64)]) assert.equal(await verifyWhatsAppSignature(raw, header, secret), false);
});

test("Meta verification works while delivery is disabled and only records verified binding", async () => {
  const { rpc, calls } = dependencies({ enabled: false, legacy: false });
  const query = new URLSearchParams({ organizationId: org, "hub.mode": "subscribe", "hub.verify_token": verifyToken, "hub.challenge": "12345" });
  const response = await handleWhatsAppWebhook(new Request("https://example.invalid/?" + query), rpc);
  assert.equal(response.status, 200); assert.equal(await response.text(), "12345");
  assert.deepEqual(mutations(calls), [{ name: "arisa_whatsapp_verify_webhook", args: { p_organization_id: org, p_phone_number_id: phoneId } }]);
});

test("verification rejects missing organization, wrong token, and cross-organization credentials", async () => {
  for (const variant of ["missing", "wrong", "binding"]) {
    const { rpc, calls } = dependencies(variant === "binding" ? { runtime: { organization_id: operation } } : {});
    const query = new URLSearchParams({ organizationId: variant === "missing" ? "" : org, "hub.mode": "subscribe", "hub.verify_token": variant === "wrong" ? "wrong" : verifyToken, "hub.challenge": "12345" });
    assert.equal((await handleWhatsAppWebhook(new Request("https://example.invalid/?" + query), rpc)).status, 403);
    assert.equal(mutations(calls).length, 0);
  }
});

test("shared callback consumes administrative reply before delegating remaining text and statuses to CRM", async () => {
  const statuses = [{ id: "wamid.admin-out", status: "read", timestamp: "1788656401", biz_opaque_callback_data: operation }, { id: "wamid.bia-out", status: "delivered", timestamp: "1788656402" }];
  const { rpc, calls } = dependencies({ legacy: true, handled: ["wamid.admin"], handledStatuses: ["wamid.admin-out"] });
  const response = await handleWhatsAppWebhook(post(fixture([inbound(), inbound("wamid.lead", { from: "5534888888888" })], statuses)), rpc);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, inbound: 1, statuses: 1, arisa_inbound: 1, arisa_statuses: 1 });
  assert.deepEqual(mutations(calls).map(call => call.name), ["arisa_whatsapp_webhook", "ingest_whatsapp_inbound_message", "apply_whatsapp_message_status"]);
  assert.equal(calls.find(call => call.name === "ingest_whatsapp_inbound_message")?.args.p_provider_message_id, "wamid.lead");
  assert.equal(calls.find(call => call.name === "apply_whatsapp_message_status")?.args.p_provider_message_id, "wamid.bia-out");
});

test("administrative receiver persists media metadata and button replies without fetching file URLs", () => {
  const messages = [inbound(), inbound("wamid.document", { type: "document", document: { id: "meta-media-id", mime_type: "application/pdf", filename: "NF-Zenith.pdf", caption: "Nota fiscal da drenagem", sha256: "base64digest", url: "https://untrusted.invalid/private" } }),
    inbound("wamid.image", { type: "image", image: { id: "photo-id", mime_type: "image/jpeg" } }),
    inbound("wamid.audio", { type: "audio", audio: { id: "audio-id", mime_type: "audio/ogg" } }),
    inbound("wamid.video", { type: "video", video: { id: "video-id", mime_type: "video/mp4" } }),
    inbound("wamid.button", { type: "interactive", interactive: { type: "button_reply", button_reply: { id: "confirm", title: "Confirmo presença" } }, context: { id: "wamid.previous" } }),
    inbound("wamid.template-button", { type: "button", button: { payload: "confirm", text: "Confirmar" } })];
  const normalized = normalizeWhatsAppWebhook(fixture(messages), phoneId, waba);
  assert.equal(normalized.messages.length, 7);
  assert.equal(normalized.messages[0].profile_name, "Carlos da Zenith");
  assert.deepEqual(normalized.messages[1].metadata, { media_id: "meta-media-id", mime_type: "application/pdf", filename: "NF-Zenith.pdf", caption: "Nota fiscal da drenagem", sha256: "base64digest" });
  assert.equal(JSON.stringify(normalized).includes("untrusted.invalid"), false);
  assert.equal(normalized.messages[5].content, "Confirmo presença");
  assert.equal(normalized.messages[5].metadata.context_message_id, "wamid.previous");
});

test("status correlation accepts only UUID callback data and valid recipient phone, using actual Meta timestamps", () => {
  const updates = [{ id: "wamid.1", status: "failed", timestamp: "1788656400", biz_opaque_callback_data: operation, recipient_id: phone, errors: [{ code: 131047, message: "provider details are not retained" }] },
    { id: "wamid.2", status: "delivered", timestamp: "1788656401", biz_opaque_callback_data: '{"operation_id":"injected"}', recipient_id: "invalid+recipient" },
    { id: "wamid.3", status: "read", timestamp: "not-a-time" }];
  const normalized = normalizeWhatsAppWebhook(fixture([], updates), phoneId, waba);
  assert.equal(normalized.statuses.length, 2); assert.equal(normalized.statuses[0].operation_id, operation);
  assert.equal(normalized.statuses[0].recipient_phone, phone);
  assert.equal(normalized.statuses[0].error_code, "131047"); assert.equal(normalized.statuses[0].occurred_at, new Date(1788656400 * 1000).toISOString());
  assert.equal("operation_id" in normalized.statuses[1], false);
  assert.equal("recipient_phone" in normalized.statuses[1], false);
});

test("invalid inbound timestamps cannot open a fresh 24-hour conversation window", () => {
  for (const timestamp of [undefined, "garbage", "-1", "99999999999999999999999", 0]) assert.equal(normalizeWhatsAppWebhook(fixture([inbound("wamid.bad", { timestamp })]), phoneId, waba).messages.length, 0);
});

test("bad signature, mixed phone IDs, WABA mismatch, and organization mismatch perform no ingestion", async () => {
  const original = fixture([inbound()]);
  const mixed = structuredClone(original); mixed.entry.push({ id: waba, changes: [{ field: "messages", value: { ...mixed.entry[0].changes[0].value, metadata: { phone_number_id: "999999999" } } }] });
  const wrongWaba = structuredClone(original); wrongWaba.entry[0].id = "999999999";
  for (const [request, expected] of [[post(original, "", "sha256=" + "0".repeat(64)), 401], [post(mixed), 400], [post(wrongWaba), 403], [post(original, "?organizationId=" + operation), 403]] as const) {
    const { rpc, calls } = dependencies();
    assert.equal((await handleWhatsAppWebhook(request, rpc)).status, expected);
    assert.equal(mutations(calls).length, 0);
  }
});

test("Arisa-only callback requires bound organization and never delegates to CRM", async () => {
  const { rpc, calls } = dependencies({ legacy: true });
  assert.equal((await handleWhatsAppWebhook(post(fixture([inbound()]), "?organizationId=" + org), rpc, "arisa")).status, 200);
  assert.deepEqual(mutations(calls).map(call => call.name), ["arisa_whatsapp_webhook"]);
  const missing = dependencies();
  assert.equal((await handleWhatsAppWebhook(post(fixture([inbound()])), missing.rpc, "arisa")).status, 400);
  assert.equal(missing.calls.length, 0);
});

test("disabled sending still records administrative replies without activating either runtime or invoking Bia", async () => {
  for (const mode of ["shared", "arisa"] as const) {
    const { rpc, calls } = dependencies({ enabled: false, legacy: true, handled: ["wamid.admin"] });
    assert.equal((await handleWhatsAppWebhook(post(fixture([inbound()]), "?organizationId=" + org), rpc, mode)).status, 200);
    assert.deepEqual(mutations(calls).map(call => call.name), ["arisa_whatsapp_webhook"]);
  }
});

test("administrative ingestion failure returns retryable response and never falls through to Bia", async () => {
  const { rpc, calls } = dependencies({ legacy: true, fail: "arisa_whatsapp_webhook" });
  const response = await handleWhatsAppWebhook(post(fixture([inbound()])), rpc);
  assert.equal(response.status, 503); assert.equal((await response.text()).includes("DO_NOT_EXPOSE"), false);
  assert.deepEqual(mutations(calls).map(call => call.name), ["arisa_whatsapp_webhook"]);
});

test("oversized body is rejected before credentials or database writes", async () => {
  const { rpc, calls } = dependencies();
  const raw = " ".repeat(1024 * 1024 + 1);
  const request = new Request("https://example.invalid", { method: "POST", body: raw, headers: { "x-hub-signature-256": signature(raw) } });
  assert.equal((await handleWhatsAppWebhook(request, rpc)).status, 413); assert.equal(calls.length, 0);
});
