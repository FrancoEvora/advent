// Meta signs the exact HTTP bytes. No parsed field is trusted before HMAC verification.
type Obj = Record<string, unknown>;
export type WebhookRpc = (name: string, args: Obj) => Promise<unknown>;
type Runtime = {
  organization_id: string;
  enabled: boolean;
  legacy_crm_enabled: boolean;
  waba_id: string;
  phone_number_id: string;
  app_secret: string;
  verify_token: string;
};
type Message = {
  provider_message_id: string;
  from_phone: string;
  profile_name: string | null;
  content: string;
  message_type: string;
  occurred_at: string;
  metadata: Obj;
};
type Status = {
  provider_message_id: string;
  status: string;
  occurred_at: string;
  error_code: string | null;
  operation_id?: string;
  recipient_phone?: string;
};

const MAX_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const META_ID = /^\d{1,64}$/;
const PHONE = /^\d{8,20}$/;
const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const object = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });

export function createWhatsAppWebhookRpc(supabaseUrl: string, serviceKey: string): WebhookRpc {
  return async (name, args) => {
    if (!supabaseUrl || !serviceKey) throw new Error("SUPABASE_RUNTIME_UNAVAILABLE");
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST", headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, "content-type": "application/json" },
      body: JSON.stringify(args), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("WHATSAPP_WEBHOOK_UNAVAILABLE");
    return response.json();
  };
}

export function whatsAppWebhookServiceKey(secretKeys: string | undefined, legacyKey: string | undefined) {
  try {
    const keys: unknown = JSON.parse(secretKeys || "{}");
    if (object(keys) && typeof keys.default === "string" && keys.default.trim()) return keys.default.trim();
  } catch { /* Legacy service role remains supported. */ }
  return legacyKey?.trim() || "";
}

class WebhookError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}

function text(value: unknown, max = 512): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0") ? value : null;
}

function secureEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

export async function verifyWhatsAppSignature(raw: Uint8Array, header: string | null, secret: string) {
  if (!header || !/^sha256=[a-fA-F0-9]{64}$/.test(header) || !secret) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signature = Uint8Array.from(header.slice(7).match(/../g)!, byte => parseInt(byte, 16));
  return crypto.subtle.verify("HMAC", key, signature, new Uint8Array(raw));
}

function runtime(value: unknown): Runtime | null {
  if (!object(value) || !UUID.test(String(value.organization_id || ""))) return null;
  if (!META_ID.test(String(value.phone_number_id || "")) || !META_ID.test(String(value.waba_id || ""))) return null;
  if (!text(value.app_secret) || !text(value.verify_token)) return null;
  return {
    organization_id: String(value.organization_id), phone_number_id: String(value.phone_number_id), waba_id: String(value.waba_id),
    enabled: value.enabled === true, legacy_crm_enabled: value.legacy_crm_enabled === true,
    app_secret: String(value.app_secret), verify_token: String(value.verify_token),
  };
}

async function rawBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) throw new WebhookError("PAYLOAD_TOO_LARGE", 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel(); throw new WebhookError("PAYLOAD_TOO_LARGE", 413); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const raw = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
  return raw;
}

function changes(payload: unknown): { waba: string; value: Obj }[] {
  if (!object(payload) || payload.object !== "whatsapp_business_account" || !Array.isArray(payload.entry) || payload.entry.length > 100) throw new WebhookError("INVALID_WHATSAPP_PAYLOAD", 400);
  const out: { waba: string; value: Obj }[] = [];
  for (const entry of payload.entry) {
    if (!object(entry) || !META_ID.test(String(entry.id || "")) || !Array.isArray(entry.changes) || entry.changes.length > 100) throw new WebhookError("INVALID_WHATSAPP_PAYLOAD", 400);
    for (const change of entry.changes) {
      if (!object(change) || change.field !== "messages") continue;
      if (!object(change.value) || !object(change.value.metadata) || !META_ID.test(String(change.value.metadata.phone_number_id || ""))) throw new WebhookError("WHATSAPP_PHONE_CONTEXT_INVALID", 400);
      if (change.value.messaging_product !== undefined && change.value.messaging_product !== "whatsapp") throw new WebhookError("INVALID_WHATSAPP_PAYLOAD", 400);
      out.push({ waba: String(entry.id), value: change.value });
    }
  }
  return out;
}

function occurredAt(value: unknown): string | null {
  const seconds = typeof value === "string" && /^\d{1,12}$/.test(value) ? Number(value) : value;
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 253402300799) return null;
  return new Date(seconds * 1000).toISOString();
}

function normalizedMessage(message: unknown, contacts: unknown[]): Message | null {
  if (!object(message)) return null;
  const id = text(message.id), phone = text(message.from, 20), timestamp = occurredAt(message.timestamp), type = text(message.type, 64);
  if (!id || !phone || !PHONE.test(phone) || !timestamp || !type) return null;
  const metadata: Obj = {};
  let content: string | null = null;
  if (type === "text" && object(message.text)) content = text(message.text.body, 12000);
  else if (["document", "image", "audio", "video", "sticker"].includes(type)) {
    const media = message[type];
    if (!object(media) || !text(media.id, 256)) return null;
    metadata.media_id = media.id;
    for (const key of ["mime_type", "filename", "caption", "sha256"]) {
      const value = text(media[key], key === "caption" ? 4096 : 512);
      if (value) metadata[key] = value;
    }
    content = text(media.caption, 4096) || (type === "document" ? "Documento recebido" + (text(media.filename) ? `: ${media.filename}` : "") : ({ image: "Imagem recebida", audio: "Áudio recebido", video: "Vídeo recebido", sticker: "Figurinha recebida" }[type] || "Arquivo recebido"));
  } else if (type === "button" && object(message.button)) {
    content = text(message.button.text, 4096);
    const payload = text(message.button.payload, 4096);
    if (payload) metadata.button_payload = payload;
  } else if (type === "interactive" && object(message.interactive)) {
    const interactiveType = message.interactive.type;
    const reply = interactiveType === "button_reply" ? message.interactive.button_reply : interactiveType === "list_reply" ? message.interactive.list_reply : null;
    if (object(reply)) {
      content = text(reply.title, 4096);
      if (text(reply.id, 4096)) metadata.reply_id = reply.id;
      metadata.interactive_type = interactiveType;
      if (text(reply.description, 4096)) metadata.description = reply.description;
    }
  }
  if (!content) return null;
  if (object(message.context) && text(message.context.id)) metadata.context_message_id = message.context.id;
  const contact = contacts.find(item => object(item) && item.wa_id === phone);
  const profile = object(contact) && object(contact.profile) ? text(contact.profile.name, 512) : null;
  return { provider_message_id: id, from_phone: phone, profile_name: profile, content, message_type: type, occurred_at: timestamp, metadata };
}

export function normalizeWhatsAppWebhook(payload: unknown, phoneNumberId: string, wabaId: string): { messages: Message[]; statuses: Status[] } {
  const messages: Message[] = [], statuses: Status[] = [];
  for (const { waba, value } of changes(payload)) {
    if (!object(value.metadata) || value.metadata.phone_number_id !== phoneNumberId || waba !== wabaId) throw new WebhookError("WHATSAPP_PHONE_CONTEXT_INVALID", 403);
    const inbound = Array.isArray(value.messages) ? value.messages : [], updates = Array.isArray(value.statuses) ? value.statuses : [];
    if (inbound.length > 100 || updates.length > 200) throw new WebhookError("INVALID_WHATSAPP_PAYLOAD", 400);
    const contacts = Array.isArray(value.contacts) ? value.contacts : [];
    for (const message of inbound) {
      const normalized = normalizedMessage(message, contacts);
      if (normalized) messages.push(normalized);
    }
    for (const status of updates) {
      if (!object(status)) continue;
      const id = text(status.id), timestamp = occurredAt(status.timestamp);
      if (!id || !timestamp || !["sent", "delivered", "read", "failed"].includes(String(status.status))) continue;
      const error = Array.isArray(status.errors) && object(status.errors[0]) ? status.errors[0] : null;
      const errorCode = error && (typeof error.code === "string" || typeof error.code === "number") ? String(error.code).slice(0, 100) : null;
      const normalized: Status = { provider_message_id: id, status: String(status.status), occurred_at: timestamp, error_code: errorCode };
      if (typeof status.biz_opaque_callback_data === "string" && UUID.test(status.biz_opaque_callback_data)) normalized.operation_id = status.biz_opaque_callback_data;
      if (typeof status.recipient_id === "string" && PHONE.test(status.recipient_id)) normalized.recipient_phone = status.recipient_id;
      statuses.push(normalized);
    }
  }
  return { messages, statuses };
}

export async function handleWhatsAppWebhook(request: Request, rpc: WebhookRpc, mode: "shared" | "arisa" = "shared"): Promise<Response> {
  try {
    const url = new URL(request.url), organizationId = url.searchParams.get("organizationId") || "";
    if (request.method === "GET") {
      const token = url.searchParams.get("hub.verify_token") || "", challenge = url.searchParams.get("hub.challenge") || "";
      if (url.searchParams.get("hub.mode") !== "subscribe" || !UUID.test(organizationId) || !token || token.length > 512 || !challenge || challenge.length > 2048) return json({ ok: false, error: "FORBIDDEN" }, 403);
      // Setup must work with both delivery switches disabled.
      const stored = runtime(await rpc("arisa_whatsapp_credentials", { p_organization_id: organizationId }));
      if (!stored || stored.organization_id !== organizationId || !secureEqual(token, stored.verify_token)) return json({ ok: false, error: "FORBIDDEN" }, 403);
      await rpc("arisa_whatsapp_verify_webhook", { p_organization_id: stored.organization_id, p_phone_number_id: stored.phone_number_id });
      return new Response(challenge, { headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" } });
    }
    if (request.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    const signature = request.headers.get("x-hub-signature-256");
    if (!signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return json({ ok: false, error: "WHATSAPP_SIGNATURE_INVALID" }, 401);
    const raw = await rawBody(request);
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { return json({ ok: false, error: "INVALID_JSON" }, 400); }
    const values = changes(payload), ids = new Set(values.map(({ value }) => String((value.metadata as Obj).phone_number_id)));
    if (ids.size !== 1) return json({ ok: false, error: "WHATSAPP_PHONE_CONTEXT_INVALID" }, 400);
    const phoneNumberId = [...ids][0];
    let stored: Runtime | null;
    if (mode === "arisa") {
      if (!UUID.test(organizationId)) return json({ ok: false, error: "WHATSAPP_PHONE_CONTEXT_INVALID" }, 400);
      stored = runtime(await rpc("arisa_whatsapp_credentials", { p_organization_id: organizationId }));
    } else stored = runtime(await rpc("arisa_whatsapp_credentials_by_phone_number_id", { p_phone_number_id: phoneNumberId }));
    if (!stored) return json({ ok: false, error: "WHATSAPP_RUNTIME_NOT_FOUND" }, 404);
    if ((organizationId && stored.organization_id !== organizationId) || stored.phone_number_id !== phoneNumberId) return json({ ok: false, error: "WHATSAPP_PHONE_CONTEXT_INVALID" }, 403);
    if (!(await verifyWhatsAppSignature(raw, signature, stored.app_secret))) return json({ ok: false, error: "WHATSAPP_SIGNATURE_INVALID" }, 401);
    const normalized = normalizeWhatsAppWebhook(payload, stored.phone_number_id, stored.waba_id);
    // The Arisa flag controls sending. Receiving remains available so signed replies are retained
    // and an administrative contact cannot fall through to Bia while Arisa sending is disabled.
    const result = await rpc("arisa_whatsapp_webhook", { p_organization_id: stored.organization_id, p_phone_number_id: stored.phone_number_id, p_payload: normalized });
    if (!object(result) || !Array.isArray(result.handled_message_ids) || !Array.isArray(result.handled_status_ids)) throw new WebhookError("WHATSAPP_WEBHOOK_UNAVAILABLE", 503);
    const handledMessages = new Set(result.handled_message_ids.filter((id): id is string => typeof id === "string"));
    const handledStatuses = new Set(result.handled_status_ids.filter((id): id is string => typeof id === "string"));
    let inbound = 0, statuses = 0;
    // Preserve the existing Bia/CRM receiver, but never submit an administrative conversation to it.
    if (mode === "shared" && stored.legacy_crm_enabled) {
      for (const message of normalized.messages) {
        if (handledMessages.has(message.provider_message_id) || message.message_type !== "text") continue;
        await rpc("ingest_whatsapp_inbound_message", {
          p_organization_id: stored.organization_id, p_provider_message_id: message.provider_message_id,
          p_from_phone: message.from_phone, p_profile_name: message.profile_name, p_content: message.content,
          p_occurred_at: message.occurred_at, p_phone_number_id: stored.phone_number_id, p_message_type: "text",
        });
        inbound++;
      }
      for (const status of normalized.statuses) {
        if (handledStatuses.has(status.provider_message_id)) continue;
        await rpc("apply_whatsapp_message_status", {
          p_organization_id: stored.organization_id, p_provider_message_id: status.provider_message_id,
          p_status: status.status, p_occurred_at: status.occurred_at, p_error_code: status.error_code,
        });
        statuses++;
      }
    }
    return json({ ok: true, inbound, statuses, arisa_inbound: handledMessages.size, arisa_statuses: handledStatuses.size });
  } catch (error) {
    const code = error instanceof WebhookError ? error.code : "WHATSAPP_WEBHOOK_UNAVAILABLE", status = error instanceof WebhookError ? error.status : 503;
    // Never log message bodies, contact data, tokens, or database response bodies.
    if (status >= 500) console.error("WhatsApp webhook", { code, status });
    return json({ ok: false, error: code }, status);
  }
}
