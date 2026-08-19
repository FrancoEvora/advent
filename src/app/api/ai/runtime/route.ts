import { createClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { parseMetaCredentialBearer } from "@/lib/integrations/meta/credential-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL = /^[A-Za-z0-9._:-]{2,120}$/;
const REASONING = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

type Obj = Record<string, unknown>;

class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "AI_RUNTIME_REQUEST_FAILED") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function publicConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key) throw new ApiError("Supabase público indisponível.", 503, "SUPABASE_PUBLIC_UNAVAILABLE");
  return { url, key };
}
function enforceSameOrigin(request: NextRequest) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") throw new ApiError("Requisição entre origens recusada.", 403, "CROSS_ORIGIN_REJECTED");
}
function organizationId(request: NextRequest, body?: Obj) {
  const value = body?.organizationId ?? request.nextUrl.searchParams.get("organizationId");
  if (typeof value !== "string" || !UUID.test(value)) throw new ApiError("Organização inválida.", 400, "INVALID_ORGANIZATION");
  return value;
}
async function userClient(request: NextRequest) {
  const token = parseMetaCredentialBearer(request.headers.get("authorization"));
  if (!token) throw new ApiError("Sessão necessária.", 401, "SESSION_REQUIRED");
  const cfg = publicConfig();
  const client = createClient(cfg.url, cfg.key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
  const user = await client.auth.getUser(token);
  if (user.error || !user.data.user) throw new ApiError("Sessão expirada.", 401, "SESSION_EXPIRED");
  return client;
}
function safeDate(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function safeVersion(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function sanitizedStatus(data: unknown) {
  if (!isObj(data)) throw new ApiError("Contrato de runtime inválido.", 503, "AI_RUNTIME_INVALID_CONTRACT");
  const rawApiStatus = isObj(data.api_key) ? data.api_key : null;
  const apiStatus = { configured: rawApiStatus?.configured === true, version: safeVersion(rawApiStatus?.version), configured_at: safeDate(rawApiStatus?.configured_at), updated_at: safeDate(rawApiStatus?.updated_at) };
  const { api_key: _rawApiKey, access_token: _accessToken, secret: _secret, decrypted_secret: _decryptedSecret, ...safe } = data;
  void _rawApiKey; void _accessToken; void _secret; void _decryptedSecret;
  return { ...safe, api_key: apiStatus };
}
function optionalBoolean(value: unknown, field: string): boolean | null { if (value === undefined || value === null) return null; if (typeof value !== "boolean") throw new ApiError(`${field} inválido.`, 400, "INVALID_ENABLED_STATE"); return value; }
function optionalModel(value: unknown, code: string): string | null { if (value === undefined || value === null) return null; if (typeof value !== "string" || !MODEL.test(value)) throw new ApiError("Modelo inválido.", 400, code); return value; }
function optionalReasoning(value: unknown, code: string): string | null { if (value === undefined || value === null) return null; if (typeof value !== "string" || !REASONING.has(value)) throw new ApiError("Raciocínio inválido.", 400, code); return value; }
function optionalApiKey(value: unknown): string | null { if (value === undefined || value === null || value === "") return null; if (typeof value !== "string" || value !== value.trim() || value.length < 32 || value.length > 512 || /\s/.test(value)) throw new ApiError("Chave OpenAI inválida.", 400, "INVALID_OPENAI_KEY"); return value; }

// Compatibilidade de contrato: a arquitetura autônoma não usa mais crm_ai_worker_runtime.
// A função permanece como gate explícito e sem efeito colateral para não reintroduzir o worker legado.
async function configureWorkerRuntime() { return; }

export async function GET(request: NextRequest) {
  try {
    enforceSameOrigin(request);
    const org = organizationId(request);
    const client = await userClient(request);
    const result = await client.rpc("get_crm_ai_runtime_status", { p_organization_id: org });
    if (result.error) { const forbidden = result.error.code === "42501"; throw new ApiError(forbidden ? "Seu perfil não pode gerenciar a Bia." : "Status da Bia indisponível.", forbidden ? 403 : 503, forbidden ? "AI_RUNTIME_PERMISSION_REQUIRED" : "AI_RUNTIME_STATUS_FAILED"); }
    return NextResponse.json({ ok: true, runtime: sanitizedStatus(result.data) }, { status: 200, headers: HEADERS });
  } catch (error) { const known = error instanceof ApiError ? error : null; return NextResponse.json({ ok: false, error: known?.code || "AI_RUNTIME_STATUS_UNAVAILABLE" }, { status: known?.status || 503, headers: HEADERS }); }
}

export async function PUT(request: NextRequest) {
  try {
    enforceSameOrigin(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ApiError("Envie os dados em JSON.", 415, "JSON_REQUIRED");
    const body = (await request.json()) as unknown;
    if (!isObj(body)) throw new ApiError("Dados inválidos.", 400, "INVALID_REQUEST");
    const org = organizationId(request, body);
    const client = await userClient(request);
    const apiKey = optionalApiKey(body.apiKey);
    const enabled = optionalBoolean(body.enabled, "Estado");
    const agentModel = optionalModel(body.agentModel, "INVALID_AGENT_MODEL");
    const supervisorModel = optionalModel(body.supervisorModel, "INVALID_SUPERVISOR_MODEL");
    const agentReasoning = optionalReasoning(body.agentReasoning, "INVALID_AGENT_REASONING");
    const supervisorReasoning = optionalReasoning(body.supervisorReasoning, "INVALID_SUPERVISOR_REASONING");
    if (enabled === true) await configureWorkerRuntime();
    const result = await client.rpc("configure_crm_ai_runtime", { p_organization_id: org, p_api_key: apiKey, p_enabled: enabled, p_mode: "autonomous", p_agent_model: agentModel, p_agent_reasoning: agentReasoning, p_supervisor_model: supervisorModel, p_supervisor_reasoning: supervisorReasoning });
    if (result.error) { const forbidden = result.error.code === "42501"; throw new ApiError(forbidden ? "Seu perfil não pode gerenciar a Bia." : "Configuração da Bia não pôde ser salva.", forbidden ? 403 : 400, forbidden ? "AI_RUNTIME_PERMISSION_REQUIRED" : "AI_RUNTIME_CONFIG_FAILED"); }
    return NextResponse.json({ ok: true, runtime: sanitizedStatus(result.data) }, { status: 200, headers: HEADERS });
  } catch (error) { const known = error instanceof ApiError ? error : null; return NextResponse.json({ ok: false, error: known?.code || "AI_RUNTIME_CONFIG_UNAVAILABLE" }, { status: known?.status || 503, headers: HEADERS }); }
}

export async function DELETE(request: NextRequest) {
  try {
    enforceSameOrigin(request);
    const org = organizationId(request);
    const client = await userClient(request);
    const result = await client.rpc("revoke_crm_ai_runtime_api_key", { p_organization_id: org });
    if (result.error) { const forbidden = result.error.code === "42501"; throw new ApiError(forbidden ? "Seu perfil não pode gerenciar a Bia." : "A chave da Bia não pôde ser revogada.", forbidden ? 403 : 503, forbidden ? "AI_RUNTIME_PERMISSION_REQUIRED" : "AI_RUNTIME_REVOKE_FAILED"); }
    return NextResponse.json({ ok: true, runtime: sanitizedStatus(result.data) }, { status: 200, headers: HEADERS });
  } catch (error) { const known = error instanceof ApiError ? error : null; return NextResponse.json({ ok: false, error: known?.code || "AI_RUNTIME_REVOKE_UNAVAILABLE" }, { status: known?.status || 503, headers: HEADERS }); }
}
