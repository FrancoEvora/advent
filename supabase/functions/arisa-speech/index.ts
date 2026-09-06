import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import { partForReply, synthesize, SpeechError, SPEECH_ERRORS, SPEECH_VERSION, type StoredReply } from "../_shared/arisa-speech.ts";
const HEADERS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, apikey, content-type, x-client-info", "access-control-allow-methods": "POST, OPTIONS", "cache-control": "no-store, private", "x-content-type-options": "nosniff" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function key(name: string) { try { const value: unknown = JSON.parse(Deno.env.get(name) || "{}"); return object(value) && typeof value.default === "string" ? value.default : ""; } catch { return ""; } }
export async function handleRequest(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: HEADERS });
  try {
    const authorization = request.headers.get("authorization") || "";
    if (!/^Bearer \S+$/i.test(authorization) || authorization.length > 9000) throw new SpeechError("SESSION_REQUIRED", 401);
    if (Number(request.headers.get("content-length") || 0) > 2048) throw new SpeechError("SPEECH_INVALID", 400);
    const raw = await request.text(); if (raw.length > 2048) throw new SpeechError("SPEECH_INVALID", 400);
    let body: unknown; try { body = JSON.parse(raw); } catch { throw new SpeechError("SPEECH_INVALID", 400); }
    if (!object(body) || Object.keys(body).some(k => !["organizationId","messageId","partIndex","version"].includes(k)) || typeof body.organizationId !== "string" || !UUID.test(body.organizationId) || typeof body.messageId !== "string" || !UUID.test(body.messageId)) throw new SpeechError("SPEECH_INVALID", 400);
    const url = Deno.env.get("SUPABASE_URL") || "";
    const publicKey = key("SUPABASE_PUBLISHABLE_KEYS") || Deno.env.get("SUPABASE_ANON_KEY") || "";
    const secret = key("SUPABASE_SECRET_KEYS") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!url || !publicKey || !secret) throw new SpeechError("SPEECH_UNAVAILABLE");
    const caller = createClient(url, publicKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
    const auth = await caller.auth.getUser(); if (auth.error || !auth.data.user) throw new SpeechError("SESSION_REQUIRED", 401);
    const userId = auth.data.user.id, org = body.organizationId;
    const access = await caller.rpc("arisa_admin_catalog", { p_organization_id: org });
    if (access.error) throw new SpeechError("ADMIN_REQUIRED", 403);
    // RLS + explicit ownership: no arbitrary user text can be sent to the TTS provider.
    const result = await caller.from("arisa_chat_messages").select("id,content,role,status,parent_id")
      .eq("id", body.messageId).eq("organization_id", org).eq("owner_user_id", userId).eq("role", "assistant").maybeSingle();
    if (result.error || !result.data) throw new SpeechError("NOT_FOUND", 404);
    const part = partForReply(result.data as StoredReply, body.partIndex, body.version);
    const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
    const config = await admin.rpc("get_crm_ai_runtime_credentials", { p_organization_id: org });
    if (config.error || !object(config.data) || config.data.enabled !== true || typeof config.data.api_key !== "string" || config.data.api_key.length < 32 || /\s/.test(config.data.api_key)) throw new SpeechError("SPEECH_DISABLED", 409);
    const quota = await admin.rpc("arisa_speech_consume", { p_organization_id: org, p_user_id: userId, p_characters: part.text.length });
    if (quota.error) throw new SpeechError("SPEECH_UNAVAILABLE");
    if (quota.data !== true) throw new SpeechError("SPEECH_LIMIT", 429);
    const bytes = await synthesize(part.text, config.data.api_key, fetch, request.signal);
    return new Response(bytes, { headers: { ...HEADERS, "content-type": "application/octet-stream", "x-arisa-speech-version": SPEECH_VERSION } });
  } catch (error) {
    const safe = error instanceof SpeechError ? error : new SpeechError("SPEECH_UNAVAILABLE");
    // Deliberately no provider body, message text, tokens, or user credentials in logs.
    return new Response(JSON.stringify({ ok: false, error: safe.code, message: SPEECH_ERRORS[safe.code] || SPEECH_ERRORS.SPEECH_UNAVAILABLE }), { status: safe.status, headers: { ...HEADERS, "content-type": "application/json; charset=utf-8" } });
  }
}
if (import.meta.main) Deno.serve(handleRequest);
