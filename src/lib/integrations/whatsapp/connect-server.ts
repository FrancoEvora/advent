import { CONNECT_POLICY, type ConnectSnapshot } from "./connect-policy.ts";

type Env = Record<string, string | undefined>;
type Dependencies = { env?: Env; fetch?: typeof fetch; audit?: (entry: { event: string; status: number; reference: string }) => void };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUPABASE = "https://qsdffayasuzsmngteika.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_nMCXNDXMvU0EbMSSmnEfQg_0uE_lVOW";
const ORIGIN = "https://enterprise.terraragroup.com.br";
const HEADERS = { "cache-control": "private, no-store, max-age=0", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
class ConnectError extends Error {
  status: number;
  constructor(code: string, status: number) { super(code); this.status = status; }
}
const messages: Record<string, string> = {
  SESSION_REQUIRED: "Entre com sua conta administrativa da Évora.",
  ADMIN_REQUIRED: "Este diagnóstico exige um administrador ativo da organização.",
  ORIGIN_INVALID: "Abra esta página pelo endereço oficial da Évora.",
  INVALID_REQUEST: "A solicitação não é válida.",
  RATE_LIMITED: "Limite de cinco diagnósticos por hora atingido. Aguarde antes de tentar novamente.",
  UNAVAILABLE: "Não foi possível consultar o diagnóstico. Nenhuma conexão Meta foi iniciada.",
};

async function readBody(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new ConnectError("INVALID_REQUEST", 415);
  if (!request.body) throw new ConnectError("INVALID_REQUEST", 400);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 1024) { await reader.cancel(); throw new ConnectError("INVALID_REQUEST", 413); }
      parts.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(size); let offset = 0;
  for (const part of parts) { buffer.set(part, offset); offset += part.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)) as unknown; }
  catch { throw new ConnectError("INVALID_REQUEST", 400); }
}

/** Uses the caller's existing Supabase session and public key, never a service credential. */
export async function handleConnect(request: Request, action: "status" | "preflight", dependencies: Dependencies = {}) {
  const env = dependencies.env ?? process.env, requestFetch = dependencies.fetch ?? fetch;
  const reference = crypto.randomUUID();
  const audit = dependencies.audit ?? ((entry) => console.info("arisa_whatsapp_connect", entry));
  try {
    if (request.method !== (action === "status" ? "GET" : "POST")) throw new ConnectError("INVALID_REQUEST", 405);
    const authorization = request.headers.get("authorization") || "";
    if (!/^Bearer [A-Za-z0-9._-]+$/.test(authorization) || authorization.length > 9000) throw new ConnectError("SESSION_REQUIRED", 401);
    if (action === "preflight") {
      const origin = request.headers.get("origin");
      const local = env.NODE_ENV !== "production" && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin || "") && origin === new URL(request.url).origin;
      if (origin !== ORIGIN && !local) throw new ConnectError("ORIGIN_INVALID", 403);
      if (request.headers.get("sec-fetch-site") === "cross-site") throw new ConnectError("ORIGIN_INVALID", 403);
    }
    const body = action === "preflight" ? await readBody(request) : { organizationId: new URL(request.url).searchParams.get("organizationId") };
    if (!object(body) || Object.keys(body).some(k => !["organizationId", "requestId"].includes(k))
      || typeof body.organizationId !== "string" || !UUID.test(body.organizationId)
      || (action === "preflight" && (typeof body.requestId !== "string" || !UUID.test(body.requestId)))) throw new ConnectError("INVALID_REQUEST", 400);
    const headers = { authorization, apikey: PUBLISHABLE_KEY, "content-type": "application/json" };
    // The fixed existing project prevents forwarding a user's bearer token to arbitrary hosts.
    const verified = await requestFetch(`${SUPABASE}/auth/v1/user`, { headers, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!verified.ok) throw new ConnectError(verified.status >= 500 ? "UNAVAILABLE" : "SESSION_REQUIRED", verified.status >= 500 ? 503 : 401);
    const user: unknown = await verified.json();
    if (!object(user) || typeof user.id !== "string" || !UUID.test(user.id)) throw new ConnectError("SESSION_REQUIRED", 401);
    const result = await requestFetch(`${SUPABASE}/rest/v1/rpc/arisa_whatsapp_connect`, {
      method: "POST", headers, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ p_organization_id: body.organizationId, p_action: action, p_request_id: action === "preflight" ? body.requestId : null }),
    });
    const payload: unknown = await result.json().catch(() => null);
    if (!result.ok) {
      const code = object(payload) ? payload.code : null;
      if (code === "42501") throw new ConnectError("ADMIN_REQUIRED", 403);
      if (code === "P0429") throw new ConnectError("RATE_LIMITED", 429);
      throw new ConnectError("UNAVAILABLE", 503);
    }
    if (!object(payload) || !Array.isArray(payload.audit) || !object(payload.primary)) throw new ConnectError("UNAVAILABLE", 503);
    // Explicit allowlist: future database changes cannot add secrets to this response.
    const c = object(payload.connection) ? payload.connection : null;
    const snapshot: ConnectSnapshot = {
      connection: c ? { id: String(c.id), label: String(c.label), onboarding_status: String(c.onboarding_status), coexistence_status: String(c.coexistence_status), updated_at: String(c.updated_at) } : null,
      audit: payload.audit.slice(0, 20).filter(object).map(a => ({ id: String(a.id), event: String(a.event), to_state: String(a.to_state), created_at: String(a.created_at) })),
      primary: { configured: payload.primary.configured === true, enabled: payload.primary.enabled === true },
    };
    audit({ event: action, status: 200, reference });
    return Response.json({ ok: true, ...snapshot, policy: CONNECT_POLICY, configuration: {
      appIdPresent: /^\d{5,32}$/.test(env.ARISA_META_APP_ID || ""),
      configIdPresent: /^\d{5,32}$/.test(env.ARISA_META_EMBEDDED_SIGNUP_CONFIG_ID || ""),
    } }, { headers: HEADERS });
  } catch (error) {
    const status = error instanceof ConnectError ? error.status : 503;
    const code = error instanceof ConnectError ? error.message : "UNAVAILABLE";
    audit({ event: code, status, reference });
    return Response.json({ ok: false, error: code, message: messages[code] || messages.UNAVAILABLE, reference }, { status, headers: { ...HEADERS, ...(status === 429 ? { "retry-after": "3600" } : {}) } });
  }
}

/** Reject before parsing: OAuth codes and raw Meta payloads cannot enter storage or logs. */
export function rejectConnectCallback() {
  return Response.json({ ok: false, error: "ONBOARDING_NOT_AUTHORIZED", message: "O onboarding real está bloqueado. Nenhum código será trocado ou armazenado." }, { status: 423, headers: HEADERS });
}
