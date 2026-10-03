import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import { CONNECT_POLICY, maskPhone, metaId, record, type ConnectSnapshot } from "./connect-policy.ts";

type Env = Record<string, string | undefined>;
type Dependencies = { env?: Env; fetch?: typeof fetch; audit?: (entry: { event: string; status: number; reference: string }) => void };
type RPC = (action: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUPABASE = "https://qsdffayasuzsmngteika.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_nMCXNDXMvU0EbMSSmnEfQg_0uE_lVOW";
const ORIGIN = "https://enterprise.terraragroup.com.br";
const HEADERS = { "cache-control": "private, no-store, max-age=0", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
export class ConnectError extends Error {
  status: number;
  constructor(code: string, status = 409) { super(code); this.status = status; }
}
const messages: Record<string, string> = {
  SESSION_REQUIRED: "Entre com sua conta administrativa da Évora.", ADMIN_REQUIRED: "Esta conexão exige um administrador ativo da organização.",
  ORIGIN_INVALID: "Abra esta página pelo endereço oficial da Évora.", INVALID_REQUEST: "A solicitação não é válida.",
  RATE_LIMITED: "Limite de cinco tentativas por hora atingido. Aguarde antes de tentar novamente.",
  META_CONFIGURATION_REQUIRED: "A configuração do aplicativo Meta precisa ser concluída.",
  SESSION_INVALID: "Esta tentativa expirou ou não pertence à sua sessão. Atualize o estado antes de iniciar outra.",
  SESSION_CONSUMED: "Esta autorização já está sendo processada. Atualize o estado.", SESSION_IN_PROGRESS: "Há uma autorização em processamento. Aguarde e atualize o estado.",
  CONNECTION_EXISTS: "Este canal já possui uma autorização. Atualize o estado da conexão.",
  EXISTING_CHANNEL_PROTECTED: "O número selecionado pertence a um canal já configurado. Selecione seu segundo canal na Meta.",
  COEXISTENCE_NOT_CONFIRMED: "A API da Meta não confirmou a coexistência deste número. Nenhum registro ou migração foi solicitado pelo sistema.",
  SYNC_REVIEW_REQUIRED: "A Meta pode ter recebido a solicitação de sincronização. Ela não será repetida automaticamente; consulte o diagnóstico antes de continuar.",
  META_ERROR: "A Meta não concluiu esta etapa. Confira as permissões da conta administradora e atualize o estado antes de tentar novamente.",
  UNAVAILABLE: "Não foi possível concluir a operação. Atualize o estado para conferir se a autorização foi recebida.",
};
export async function readLimitedBody(request: Request, limit: number) {
  if (!request.body) throw new ConnectError("INVALID_REQUEST", 400);
  const reader = request.body.getReader(), parts: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
    if (size > limit) { await reader.cancel(); throw new ConnectError("INVALID_REQUEST", 413); } parts.push(part.value); }
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts, size);
}
function service(deps: Dependencies, org: string | null, actor: string | null): RPC {
  const env = deps.env ?? process.env, requestFetch = deps.fetch ?? fetch;
  const key = env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key || key.length < 32) throw new ConnectError("META_CONFIGURATION_REQUIRED", 503);
  return async (action, args = {}) => {
    const response = await requestFetch(`${SUPABASE}/rest/v1/rpc/arisa_coexistence_service`, {
      method: "POST", headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ p_org: org, p_actor: actor, p_action: action, p_args: args }),
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(12000),
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok || !record(data)) {
      const code = record(data) && typeof data.message === "string" && Object.hasOwn(messages, data.message) ? data.message : "UNAVAILABLE";
      throw new ConnectError(code, code === "ADMIN_REQUIRED" ? 403 : code === "RATE_LIMITED" ? 429 : code === "SESSION_INVALID" ? 403 : 409);
    }
    return data;
  };
}
export function safeSnapshot(payload: Record<string, unknown>): ConnectSnapshot {
  const c = record(payload.connection) ? payload.connection : null, cfg = record(payload.configuration) ? payload.configuration : {};
  const primary = record(payload.primary) ? payload.primary : {};
  const text = (value: unknown) => typeof value === "string" ? value : null;
  const operations: Record<string, string> = {};
  if (c && record(c.operations)) for (const name of ["subscription", "contacts", "history"]) {
    if (["in_progress", "done", "uncertain"].includes(String(c.operations[name]))) operations[name] = String(c.operations[name]);
  }
  return {
    connection: c ? { id: String(c.id), label: "franco_personal", onboarding_status: String(c.onboarding_status), coexistence_status: String(c.coexistence_status), updated_at: String(c.updated_at),
      phone_number_masked: text(c.phone_number_masked), waba_id: metaId(c.waba_id) ? c.waba_id : null, phone_number_id: metaId(c.phone_number_id) ? c.phone_number_id : null,
      operations, sync_progress: typeof c.sync_progress === "number" ? c.sync_progress : null, history_shared: typeof c.history_shared === "boolean" ? c.history_shared : null, token_expires_at: text(c.token_expires_at) } : null,
    configuration: { appId: metaId(cfg.appId) ? cfg.appId : null, configId: metaId(cfg.configId) ? cfg.configId : null, ready: cfg.ready === true },
    audit: Array.isArray(payload.audit) ? payload.audit.slice(0, 20).filter(record).map(a => ({ id: String(a.id), event: String(a.event), to_state: String(a.to_state), created_at: String(a.created_at) })) : [],
    primary: { configured: primary.configured === true, enabled: primary.enabled === true },
  };
}
async function graph(requestFetch: typeof fetch, path: string, token: string | null, query: Record<string, string> = {}, body?: Record<string, unknown>) {
  const url = new URL(`https://graph.facebook.com/${CONNECT_POLICY.graphVersion}/${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  // No request URL, provider payload, code, token or raw exception is logged.
  const response = await requestFetch(url, { method: body ? "POST" : "GET", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8000) });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok || !record(data) || data.error) throw new ConnectError("META_ERROR", 502);
  return data;
}
async function finalize(rpc: RPC, args: Record<string, unknown>, requestFetch: typeof fetch) {
  const claim = await rpc("claim_complete", args);
  if (claim.completed === true) return rpc("status");
  if (typeof claim.token !== "string" || typeof claim.connectionId !== "string" || !UUID.test(claim.connectionId)) throw new ConnectError("UNAVAILABLE", 503);
  const config = await rpc("config"), token = claim.token;
  if (!metaId(config.appId) || typeof config.appSecret !== "string" || typeof config.verifyToken !== "string") throw new ConnectError("META_CONFIGURATION_REQUIRED");
  const debug = await graph(requestFetch, "debug_token", `${config.appId}|${config.appSecret}`, { input_token: token });
  if (!record(debug.data) || debug.data.is_valid !== true || debug.data.app_id !== config.appId) throw new ConnectError("META_ERROR", 502);
  const scopes = Array.isArray(debug.data.scopes) ? debug.data.scopes : [];
  if (!["whatsapp_business_management", "whatsapp_business_messaging"].every(s => scopes.includes(s))) throw new ConnectError("META_ERROR", 502);
  const phones = await graph(requestFetch, `${args.wabaId}/phone_numbers`, token, { fields: "id,display_phone_number,is_on_biz_app,platform_type", limit: "100" });
  const candidates = Array.isArray(phones.data) ? phones.data.filter(record).filter(p => metaId(p.id) && p.is_on_biz_app === true && p.platform_type === "CLOUD_API" && (!args.phoneNumberId || p.id === args.phoneNumberId)) : [];
  if (candidates.length !== 1) throw new ConnectError("COEXISTENCE_NOT_CONFIRMED");
  const phone = candidates[0];
  await rpc("save_assets", { ...args, phoneNumberId: phone.id, isOnBizApp: true, platformType: "CLOUD_API", maskedPhone: maskPhone(phone.display_phone_number) });
  const operation = async (name: string, path: string, body: Record<string, unknown>) => {
    const intent = await rpc("operation", { ...args, name, state: "start" });
    if (intent.execute !== true) { if (intent.status !== "done") throw new ConnectError("SYNC_REVIEW_REQUIRED"); return; }
    try {
      const result = await graph(requestFetch, path, token, {}, body);
      if (name === "subscription" ? result.success !== true : typeof result.request_id !== "string") throw new ConnectError("META_ERROR", 502);
      await rpc("operation", { ...args, name, state: "done" });
    } catch { await rpc("operation", { ...args, name, state: "uncertain" }).catch(() => undefined); throw new ConnectError("SYNC_REVIEW_REQUIRED"); }
  };
  await operation("subscription", `${args.wabaId}/subscribed_apps`, { override_callback_uri: `${ORIGIN}/api/arisa/whatsapp-connect/webhook/${claim.connectionId}`, verify_token: config.verifyToken });
  await operation("contacts", `${phone.id}/smb_app_data`, { messaging_product: "whatsapp", sync_type: "smb_app_state_sync" });
  await operation("history", `${phone.id}/smb_app_data`, { messaging_product: "whatsapp", sync_type: "history" });
  return rpc("finish", args);
}
export async function handleConnect(request: Request, action: "status" | "begin" | "callback", dependencies: Dependencies = {}) {
  const env = dependencies.env ?? process.env, requestFetch = dependencies.fetch ?? fetch, reference = crypto.randomUUID();
  const audit = dependencies.audit ?? (entry => console.info("arisa_whatsapp_connect", entry));
  let rpc: RPC | undefined, sessionArgs: Record<string, unknown> | undefined, ownsClaim = false;
  try {
    if (request.method !== (action === "status" ? "GET" : "POST")) throw new ConnectError("INVALID_REQUEST", 405);
    const authorization = request.headers.get("authorization") || "";
    if (!/^Bearer [A-Za-z0-9._-]+$/.test(authorization) || authorization.length > 9000) throw new ConnectError("SESSION_REQUIRED", 401);
    let body: unknown;
    if (action !== "status") {
      const origin = request.headers.get("origin");
      const local = env.NODE_ENV !== "production" && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin || "") && origin === new URL(request.url).origin;
      if ((origin !== ORIGIN && !local) || request.headers.get("sec-fetch-site") === "cross-site") throw new ConnectError("ORIGIN_INVALID", 403);
      if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new ConnectError("INVALID_REQUEST", 415);
      try { body = JSON.parse((await readLimitedBody(request, 16384)).toString("utf8")); } catch (error) { if (error instanceof ConnectError) throw error; throw new ConnectError("INVALID_REQUEST", 400); }
    } else body = { organizationId: new URL(request.url).searchParams.get("organizationId") };
    const keys = action === "callback" ? ["organizationId", "action", "sessionId", "nonce", "code", "event", "wabaId", "phoneNumberId"] : ["organizationId"];
    if (!record(body) || Object.keys(body).some(k => !keys.includes(k)) || typeof body.organizationId !== "string" || !UUID.test(body.organizationId)) throw new ConnectError("INVALID_REQUEST", 400);
    const verified = await requestFetch(`${SUPABASE}/auth/v1/user`, { headers: { authorization, apikey: PUBLISHABLE_KEY }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8000) });
    const user: unknown = await verified.json().catch(() => null);
    if (!verified.ok || !record(user) || typeof user.id !== "string" || !UUID.test(user.id)) throw new ConnectError("SESSION_REQUIRED", 401);
    rpc = service(dependencies, body.organizationId, user.id);
    let result: Record<string, unknown>;
    if (action === "status") result = await rpc("status");
    else if (action === "begin") {
      const nonce = randomBytes(32).toString("hex");
      const started = await rpc("begin", { nonceHash: createHash("sha256").update(nonce).digest("hex") });
      audit({ event: "begin", status: 200, reference });
      return Response.json({ ok: true, sessionId: started.sessionId, expiresAt: started.expiresAt, appId: started.appId, configId: started.configId, nonce }, { headers: HEADERS });
    } else {
      if (typeof body.sessionId !== "string" || !UUID.test(body.sessionId) || typeof body.nonce !== "string" || !/^[a-f0-9]{64}$/.test(body.nonce)) throw new ConnectError("INVALID_REQUEST", 400);
      sessionArgs = { sessionId: body.sessionId, nonceHash: createHash("sha256").update(body.nonce).digest("hex") };
      if (body.action === "exchange") {
        if (typeof body.code !== "string" || body.code.length < 8 || body.code.length > 8192 || /\s/.test(body.code)) throw new ConnectError("INVALID_REQUEST", 400);
        const claimed = await rpc("claim", sessionArgs);
        if (claimed.alreadyExchanged !== true) {
          ownsClaim = true;
          const config = await rpc("config");
          if (!metaId(config.appId) || typeof config.appSecret !== "string") throw new ConnectError("META_CONFIGURATION_REQUIRED");
          const exchanged = await graph(requestFetch, "oauth/access_token", null, { client_id: config.appId, client_secret: config.appSecret, code: body.code });
          if (typeof exchanged.access_token !== "string" || exchanged.access_token.length < 20) throw new ConnectError("META_ERROR", 502);
          const seconds = typeof exchanged.expires_in === "number" && exchanged.expires_in > 0 ? exchanged.expires_in : null;
          await rpc("token", { ...sessionArgs, token: exchanged.access_token, expiresAt: seconds ? new Date(Date.now() + seconds * 1000).toISOString() : null });
        }
        return Response.json({ ok: true, exchanged: true }, { headers: HEADERS });
      } else if (body.action === "finalize") {
        if (body.event !== "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" || !metaId(body.wabaId) || (body.phoneNumberId !== undefined && !metaId(body.phoneNumberId))) throw new ConnectError("INVALID_REQUEST", 400);
        // Errors release only this request's lease, never another parallel finalizer.
        const claimedRpc: RPC = async (name, args) => { const value = await rpc!(name, args); if (name === "claim_complete" && value.completed !== true) ownsClaim = true; return value; };
        result = await finalize(claimedRpc, { ...sessionArgs, wabaId: body.wabaId, ...(body.phoneNumberId ? { phoneNumberId: body.phoneNumberId } : {}) }, requestFetch);
      } else if (body.action === "cancel") result = await rpc("cancel", sessionArgs);
      else throw new ConnectError("INVALID_REQUEST", 400);
    }
    audit({ event: action, status: 200, reference });
    return Response.json({ ok: true, ...safeSnapshot(result), policy: CONNECT_POLICY }, { headers: HEADERS });
  } catch (error) {
    if (ownsClaim && rpc && sessionArgs) await rpc("error", sessionArgs).catch(() => undefined);
    const code = error instanceof ConnectError ? error.message : "UNAVAILABLE", status = error instanceof ConnectError ? error.status : 503;
    audit({ event: code, status, reference });
    return Response.json({ ok: false, error: code, message: messages[code] || messages.UNAVAILABLE, reference }, { status, headers: HEADERS });
  }
}
export function validWebhookSignature(raw: Uint8Array, signature: string | null, secret: string) {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(createHmac("sha256", secret).update(raw).digest(), Buffer.from(signature.slice(7), "hex"));
}
export async function handleConnectWebhook(request: Request, connectionId: string, dependencies: Dependencies = {}) {
  try {
    if (!UUID.test(connectionId)) return new Response("Not found", { status: 404, headers: HEADERS });
    const rpc = service(dependencies, null, null), cfg = await rpc("webhook_config", { connectionId });
    if (typeof cfg.verifyToken !== "string" || typeof cfg.appSecret !== "string") throw new ConnectError("UNAVAILABLE");
    if (request.method === "GET") {
      const params = new URL(request.url).searchParams, token = params.get("hub.verify_token") || "", challenge = params.get("hub.challenge") || "";
      const a = Buffer.from(token), b = Buffer.from(cfg.verifyToken);
      if (params.get("hub.mode") !== "subscribe" || a.length !== b.length || !timingSafeEqual(a, b) || !/^\d{1,64}$/.test(challenge)) return new Response("Forbidden", { status: 403, headers: HEADERS });
      return new Response(challenge, { headers: HEADERS });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: HEADERS });
    const raw = await readLimitedBody(request, 2097152);
    if (!validWebhookSignature(raw, request.headers.get("x-hub-signature-256"), cfg.appSecret)) return new Response("Forbidden", { status: 403, headers: HEADERS });
    const payload: unknown = JSON.parse(raw.toString("utf8"));
    if (!record(payload) || payload.object !== "whatsapp_business_account" || !Array.isArray(payload.entry)) return new Response("Invalid event", { status: 400, headers: HEADERS });
    let progress: number | undefined, historyDeclined = false, disconnected = false;
    for (const entry of payload.entry) {
      if (!record(entry) || entry.id !== cfg.wabaId || !Array.isArray(entry.changes)) return new Response("Wrong channel", { status: 403, headers: HEADERS });
      for (const change of entry.changes) {
        if (!record(change) || !record(change.value)) continue;
        const value = change.value;
        if (change.field === "account_update" && ["PARTNER_REMOVED", "ACCOUNT_OFFBOARDED"].includes(String(value.event))) disconnected = true;
        if (record(value.metadata) && value.metadata.phone_number_id && value.metadata.phone_number_id !== cfg.phoneNumberId) return new Response("Wrong channel", { status: 403, headers: HEADERS });
        if (change.field === "history" && Array.isArray(value.history)) for (const item of value.history) {
          if (record(item) && record(item.metadata) && typeof item.metadata.progress === "number" && item.metadata.progress >= 0 && item.metadata.progress <= 100) progress = Math.max(progress ?? 0, item.metadata.progress);
          if (record(item) && Array.isArray(item.errors) && item.errors.some(e => record(e) && e.code === 2593109)) historyDeclined = true;
        }
      }
    }
    await rpc("webhook_ingest", { connectionId, hash: createHash("sha256").update(raw).digest("hex"), payload, ...(progress !== undefined ? { progress } : {}), ...(historyDeclined ? { historyDeclined } : {}), ...(disconnected ? { disconnected } : {}) });
    return Response.json({ ok: true }, { headers: HEADERS });
  } catch (error) { return new Response("Webhook unavailable", { status: error instanceof ConnectError && error.status === 413 ? 413 : 503, headers: HEADERS }); }
}

/** Account-level events cannot use Meta's callback override. Keep the existing
 * callback URL and delegate only events belonging to a verified personal WABA.
 * Returning null preserves the existing Arisa/Bia proxy without changes. */
export async function routeCoexistenceAccountEvent(request: Request, raw: Uint8Array, dependencies: Dependencies = {}): Promise<Response | null> {
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(raw).toString("utf8")); } catch { return null; }
  if (!record(payload) || payload.object !== "whatsapp_business_account" || !Array.isArray(payload.entry) || payload.entry.length !== 1) return null;
  const entry = payload.entry[0];
  if (!record(entry) || !metaId(entry.id) || !Array.isArray(entry.changes) || !entry.changes.some(c => record(c) && ["account_update", "history", "smb_app_state_sync", "smb_message_echoes"].includes(String(c.field)))) return null;
  const env = dependencies.env ?? process.env, key = env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) return new Response("Unavailable", { status: 503 });
  const result = await (dependencies.fetch ?? fetch)(`${SUPABASE}/rest/v1/rpc/arisa_coexistence_webhook_lookup`, { method: "POST", headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ p_waba_id: entry.id }), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!result.ok) return new Response("Unavailable", { status: 503 });
  const data: unknown = await result.json();
  if (!record(data) || !Array.isArray(data.connections)) return new Response("Unavailable", { status: 503 });
  if (!data.connections.length) return null;
  for (const connection of data.connections) {
    if (!record(connection) || typeof connection.id !== "string" || !UUID.test(connection.id)) return new Response("Unavailable", { status: 503 });
    const forwarded = new Request(request.url, { method: "POST", headers: request.headers, body: Buffer.from(raw) });
    const response = await handleConnectWebhook(forwarded, connection.id, dependencies);
    if (!response.ok) return response;
  }
  return Response.json({ ok: true }, { headers: HEADERS });
}
