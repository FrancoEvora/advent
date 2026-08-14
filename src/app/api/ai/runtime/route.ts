import { createClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { parseMetaCredentialBearer } from "@/lib/integrations/meta/credential-contract";
import { getSupabaseIntegrationConfig } from "@/lib/integrations/meta/server-config";

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
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new ApiError("Requisição entre origens recusada.", 403, "CROSS_ORIGIN_REJECTED");
  }
}

function organizationId(request: NextRequest, body?: Obj) {
  const value = body?.organizationId ?? request.nextUrl.searchParams.get("organizationId");
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ApiError("Organização inválida.", 400, "INVALID_ORGANIZATION");
  }
  return value;
}

async function userClient(request: NextRequest) {
  const token = parseMetaCredentialBearer(request.headers.get("authorization"));
  if (!token) throw new ApiError("Sessão necessária.", 401, "SESSION_REQUIRED");
  const cfg = publicConfig();
  const client = createClient(cfg.url, cfg.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const user = await client.auth.getUser(token);
  if (user.error || !user.data.user) throw new ApiError("Sessão expirada.", 401, "SESSION_EXPIRED");
  return client;
}

function sanitizedStatus(data: unknown) {
  if (!isObj(data)) throw new ApiError("Contrato de runtime inválido.", 503, "AI_RUNTIME_INVALID_CONTRACT");
  // Defesa adicional: mesmo que a RPC mude no futuro, campos com segredo nunca
  // atravessam esta API administrativa.
  const { api_key: _apiKey, access_token: _accessToken, secret: _secret, ...safe } = data;
  void _apiKey;
  void _accessToken;
  void _secret;
  return safe;
}

async function configureWorkerRuntime() {
  const cfg = getSupabaseIntegrationConfig();
  const service = createClient(cfg.url, cfg.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const workerUrl = `${cfg.url.replace(/\/$/, "")}/functions/v1/enterprise-ai-worker`;
  const result = await service.rpc("configure_crm_ai_worker_runtime", {
    p_worker_url: workerUrl,
    p_rotate_secret: false,
  });
  if (result.error) {
    throw new ApiError("Worker da Vitória não pôde ser preparado.", 503, "AI_WORKER_RUNTIME_UNAVAILABLE");
  }
}

export async function GET(request: NextRequest) {
  try {
    enforceSameOrigin(request);
    const org = organizationId(request);
    const client = await userClient(request);
    const result = await client.rpc("get_crm_ai_runtime_status", { p_organization_id: org });
    if (result.error) {
      const forbidden = result.error.code === "42501";
      throw new ApiError(
        forbidden ? "Seu perfil não pode gerenciar a Vitória." : "Status da Vitória indisponível.",
        forbidden ? 403 : 503,
        forbidden ? "AI_RUNTIME_PERMISSION_REQUIRED" : "AI_RUNTIME_STATUS_FAILED",
      );
    }
    return NextResponse.json({ ok: true, runtime: sanitizedStatus(result.data) }, { status: 200, headers: HEADERS });
  } catch (error) {
    const known = error instanceof ApiError ? error : null;
    return NextResponse.json(
      { ok: false, error: known?.code || "AI_RUNTIME_STATUS_UNAVAILABLE" },
      { status: known?.status || 503, headers: HEADERS },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    enforceSameOrigin(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new ApiError("Envie os dados em JSON.", 415, "JSON_REQUIRED");
    }
    const body = (await request.json()) as unknown;
    if (!isObj(body)) throw new ApiError("Dados inválidos.", 400, "INVALID_REQUEST");
    const org = organizationId(request, body);
    const client = await userClient(request);

    const apiKey = body.apiKey === undefined || body.apiKey === null || body.apiKey === ""
      ? null
      : typeof body.apiKey === "string" ? body.apiKey : (() => { throw new ApiError("Chave OpenAI inválida.", 400, "INVALID_OPENAI_KEY"); })();
    if (apiKey && (apiKey !== apiKey.trim() || apiKey.length < 32 || apiKey.length > 512 || /\s/.test(apiKey))) {
      throw new ApiError("Chave OpenAI inválida.", 400, "INVALID_OPENAI_KEY");
    }

    const enabled = body.enabled === undefined || body.enabled === null
      ? null
      : typeof body.enabled === "boolean" ? body.enabled : (() => { throw new ApiError("Estado inválido.", 400, "INVALID_ENABLED_STATE"); })();
    const agentModel = body.agentModel === undefined || body.agentModel === null
      ? null
      : typeof body.agentModel === "string" && MODEL.test(body.agentModel) ? body.agentModel : (() => { throw new ApiError("Modelo inválido.", 400, "INVALID_AGENT_MODEL"); })();
    const supervisorModel = body.supervisorModel === undefined || body.supervisorModel === null
      ? null
      : typeof body.supervisorModel === "string" && MODEL.test(body.supervisorModel) ? body.supervisorModel : (() => { throw new ApiError("Modelo inválido.", 400, "INVALID_SUPERVISOR_MODEL"); })();
    const agentReasoning = body.agentReasoning === undefined || body.agentReasoning === null
      ? null
      : typeof body.agentReasoning === "string" && REASONING.has(body.agentReasoning) ? body.agentReasoning : (() => { throw new ApiError("Raciocínio inválido.", 400, "INVALID_AGENT_REASONING"); })();
    const supervisorReasoning = body.supervisorReasoning === undefined || body.supervisorReasoning === null
      ? null
      : typeof body.supervisorReasoning === "string" && REASONING.has(body.supervisorReasoning) ? body.supervisorReasoning : (() => { throw new ApiError("Raciocínio inválido.", 400, "INVALID_SUPERVISOR_REASONING"); })();

    if (enabled === true) await configureWorkerRuntime();

    const result = await client.rpc("configure_crm_ai_runtime", {
      p_organization_id: org,
      p_api_key: apiKey,
      p_enabled: enabled,
      p_mode: "shadow",
      p_agent_model: agentModel,
      p_agent_reasoning: agentReasoning,
      p_supervisor_model: supervisorModel,
      p_supervisor_reasoning: supervisorReasoning,
    });
    if (result.error) {
      const forbidden = result.error.code === "42501";
      throw new ApiError(
        forbidden ? "Seu perfil não pode gerenciar a Vitória." : "Configuração da Vitória não pôde ser salva.",
        forbidden ? 403 : 400,
        forbidden ? "AI_RUNTIME_PERMISSION_REQUIRED" : "AI_RUNTIME_CONFIG_FAILED",
      );
    }
    return NextResponse.json({ ok: true, runtime: sanitizedStatus(result.data) }, { status: 200, headers: HEADERS });
  } catch (error) {
    const known = error instanceof ApiError ? error : null;
    return NextResponse.json(
      { ok: false, error: known?.code || "AI_RUNTIME_CONFIG_UNAVAILABLE" },
      { status: known?.status || 503, headers: HEADERS },
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    enforceSameOrigin(request);
    const org = organizationId(request);
    const client = await userClient(request);
    const result = await client.rpc("revoke_crm_ai_runtime_api_key", { p_organization_id: org });
    if (result.error) {
      const forbidden = result.error.code === "42501";
      throw new ApiError(
        forbidden ? "Seu perfil não pode gerenciar a Vitória." : "A chave da Vitória não pôde ser revogada.",
        forbidden ? 403 : 503,
        forbidden ? "AI_RUNTIME_PERMISSION_REQUIRED" : "AI_RUNTIME_REVOKE_FAILED",
      );
    }
    return NextResponse.json({ ok: true, runtime: sanitizedStatus(result.data) }, { status: 200, headers: HEADERS });
  } catch (error) {
    const known = error instanceof ApiError ? error : null;
    return NextResponse.json(
      { ok: false, error: known?.code || "AI_RUNTIME_REVOKE_UNAVAILABLE" },
      { status: known?.status || 503, headers: HEADERS },
    );
  }
}
