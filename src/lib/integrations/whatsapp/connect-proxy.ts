import { record } from "./connect-policy.ts";
const EDGE = "https://qsdffayasuzsmngteika.supabase.co/functions/v1/arisa-whatsapp-connect";
const HEADERS = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
export async function forwardConnect(request: Request, action: string, requestFetch: typeof fetch = fetch, bytes?: Uint8Array): Promise<Response> {
  try {
    if (action === "callback" && request.method !== "POST") return Response.json({ ok: false, error: "INVALID_REQUEST" }, { status: 405, headers: HEADERS });
    if (!/^(status|begin|callback|account-events|webhook\/[0-9a-f-]{36})$/i.test(action)) return new Response("Not found", { status: 404, headers: HEADERS });
    const target = new URL(`${EDGE}/${action}`), original = new URL(request.url);
    for (const name of action.startsWith("webhook/") ? ["hub.mode", "hub.verify_token", "hub.challenge"] : ["organizationId"]) {
      const value = original.searchParams.get(name); if (value) target.searchParams.set(name, value);
    }
    const headers = new Headers();
    for (const name of ["authorization", "origin", "content-type", "sec-fetch-site", "x-hub-signature-256"]) { const value = request.headers.get(name); if (value) headers.set(name, value); }
    let body = bytes;
    if (!body && request.method === "POST") {
      const reader = request.body?.getReader(), parts: Uint8Array[] = []; let size = 0;
      if (reader) try { for (;;) { const p = await reader.read(); if (p.done) break; size += p.value.length;
        if (size > (action.startsWith("webhook/") ? 2097152 : 16384)) { await reader.cancel(); return new Response("Payload too large", { status: 413, headers: HEADERS }); } parts.push(p.value); }
      } finally { reader.releaseLock(); }
      body = new Uint8Array(size); let offset = 0; for (const part of parts) { body.set(part, offset); offset += part.length; }
    }
    const response = await requestFetch(target, { method: request.method, headers, ...(body ? { body: new Uint8Array(body).buffer } : {}), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(115000) });
    return new Response(response.status === 204 ? null : await response.arrayBuffer(), { status: response.status, headers: { ...HEADERS, "content-type": response.headers.get("content-type") || "application/json" } });
  } catch {
    return Response.json({ ok: false, error: "UNAVAILABLE", message: "Não foi possível consultar a conexão. Atualize o estado para tentar novamente." }, { status: 503, headers: HEADERS });
  }
}
export async function routeCoexistenceAccountEventProxy(request: Request, raw: Uint8Array, requestFetch: typeof fetch = fetch) {
  let payload: unknown; try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { return null; }
  if (!record(payload) || payload.object !== "whatsapp_business_account" || !Array.isArray(payload.entry) || payload.entry.length !== 1) return null;
  const entry = payload.entry[0];
  if (!record(entry) || !Array.isArray(entry.changes) || !entry.changes.some(c => record(c) && ["account_update", "history", "smb_app_state_sync", "smb_message_echoes"].includes(String(c.field)))) return null;
  const response = await forwardConnect(request, "account-events", requestFetch, raw);
  return response.status === 204 ? null : response;
}
