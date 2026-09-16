import { createClient } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { metaErrorMessage, type MetaChannel } from "./onboarding-contract";

export const onboardingHeaders = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", Vary: "Authorization" };
export const onboardingCookie = "evora_meta_onboarding";
export class OnboardingError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function metaId(value: unknown) { if (typeof value !== "string" || !/^\d{1,64}$/.test(value)) throw new OnboardingError("Identificador da Meta inválido."); return value; }
export function onboardingConfig() {
  const origin = process.env.META_ONBOARDING_ORIGIN?.trim() || "";
  let validOrigin = "";
  try { const url = new URL(origin); if (url.protocol === "https:" && url.origin === origin) validOrigin = origin; } catch { /* Pending configuration is displayed to the administrator. */ }
  const secret = process.env.META_ONBOARDING_STATE_SECRET?.trim() || "";
  const graphVersion = process.env.META_GRAPH_API_VERSION?.trim() || "v26.0";
  return {
    origin: validOrigin, secret, graphVersion: /^v\d+\.\d+$/.test(graphVersion) ? graphVersion : "v26.0",
    appId: process.env.META_APP_ID?.trim() || "", appSecret: process.env.META_APP_SECRET?.trim() || "",
    configId: process.env.META_WHATSAPP_CONFIG_ID?.trim() || "",
    instagramAppId: process.env.META_INSTAGRAM_APP_ID?.trim() || "", instagramSecret: process.env.META_INSTAGRAM_APP_SECRET?.trim() || "",
  };
}
export function configured(channel: MetaChannel) {
  const c = onboardingConfig();
  return Boolean(c.origin && c.secret.length >= 32 && (channel === "whatsapp" ? /^\d+$/.test(c.appId) && /^\d+$/.test(c.configId) && c.appSecret.length >= 24 : /^\d+$/.test(c.instagramAppId) && c.instagramSecret.length >= 24));
}
export async function onboardingAuth(request: NextRequest, organizationId: unknown) {
  if (typeof organizationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organizationId)) throw new OnboardingError("Organização inválida.");
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") || "")?.[1];
  if (!token) throw new OnboardingError("Entre novamente no Enterprise.", 401);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new OnboardingError("Conexão com o Enterprise indisponível.", 503);
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
  const user = await client.auth.getUser(token);
  if (user.error || !user.data.user) throw new OnboardingError("Sua sessão expirou. Entre novamente.", 401);
  const permission = await client.rpc("has_app_permission", { p_organization_id: organizationId, p_permission_key: "crm.integrations.manage" });
  if (permission.error || permission.data !== true) throw new OnboardingError("Seu perfil não pode gerenciar integrações.", 403);
  return { client, organizationId, userId: user.data.user.id };
}
export async function onboardingBody(request: NextRequest) {
  if (request.headers.get("sec-fetch-site") === "cross-site" || request.headers.get("sec-fetch-site") === "same-site") throw new OnboardingError("Solicitação de outra origem recusada.", 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new OnboardingError("Formato inválido.", 415);
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) throw new OnboardingError("Origem inválida.", 403);
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 16384) throw new OnboardingError("Solicitação muito grande.", 413);
  try { return asObject(JSON.parse(raw)); } catch { throw new OnboardingError("Solicitação inválida."); }
}
export async function metaRequest(url: URL, init: RequestInit = {}) {
  if (!["graph.facebook.com", "graph.instagram.com", "api.instagram.com"].includes(url.hostname) || url.protocol !== "https:") throw new OnboardingError("Endereço da Meta inválido.");
  let response: Response;
  try { response = await fetch(url, { ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20000) }); }
  catch { throw new OnboardingError("Não foi possível consultar a Meta. Tente novamente.", 503); }
  const result = asObject(await response.json().catch(() => null));
  if (!response.ok || result.error || result.error_message) throw new OnboardingError(metaErrorMessage(asObject(result.error).code as number | undefined), 502);
  return result;
}
export function onboardingFailure(error: unknown) {
  const message = error instanceof OnboardingError ? error.message : error instanceof Error && error.message === "INVALID_ONBOARDING_STATE" ? "Esta autorização expirou ou pertence a outra sessão. Inicie a conexão novamente." : "A conexão não foi concluída. Verifique a configuração da integração.";
  return NextResponse.json({ error: message }, { status: error instanceof OnboardingError ? error.status : 400, headers: onboardingHeaders });
}
