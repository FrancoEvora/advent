import { createClient as createSupabaseClient } from "npm:@supabase/supabase-js@2";

type Obj = Record<string, unknown>;
type Database = {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Record<string, { Args: Record<string, unknown>; Returns: unknown }>;
  };
};
function createClient(
  supabaseUrl: string,
  supabaseKey: string,
  options?: Parameters<typeof createSupabaseClient<Database>>[2],
) {
  return createSupabaseClient<Database>(supabaseUrl, supabaseKey, options);
}
type AdminClient = ReturnType<typeof createClient>;

type Runtime = { apiKey: string; model: string; reasoning: "none"|"low"|"medium"|"high"|"xhigh" };

const MAX_BYTES = 3_500_000;
const MODEL_TIMEOUT_MS = 18_000;
const DELEGATE_TIMEOUT_MS = 125_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/i;
const HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

class GatewayError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 503) {
    super(code); this.name = "GatewayError"; this.code = code; this.status = status;
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const obj = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

function supabaseBase() {
  const raw = Deno.env.get("SUPABASE_URL") || "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") throw new Error("protocol");
    return url;
  } catch {
    throw new GatewayError("BIA_AGENTIC_CONFIG_INVALID");
  }
}
function legacyGatewayUrl() { return new URL("/functions/v1/enterprise-vitoria-agent-gateway", supabaseBase()); }

function constantTimeEqual(left: string, right: string) {
  let difference = left.length ^ right.length;
  for (let i = 0; i < 512; i += 1) {
    difference |= (i < left.length ? left.charCodeAt(i) : 0) ^ (i < right.length ? right.charCodeAt(i) : 0);
  }
  return difference === 0;
}
function configuredPublishableKeys() {
  const raw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "";
  if (!raw || raw.length > 65_536) return [] as string[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!obj(parsed)) return [];
    return Object.values(parsed).filter((value): value is string => typeof value === "string" && value.length >= 32 && value.length <= 512 && !/\s/.test(value)).slice(0, 64);
  } catch { return []; }
}
function ingressAuthorized(request: Request) {
  const candidate = request.headers.get("apikey") || "";
  if (candidate.length < 32 || candidate.length > 512 || /\s/.test(candidate)) return false;
  let authorized = 0;
  for (const configured of configuredPublishableKeys()) authorized |= Number(constantTimeEqual(configured, candidate));
  return authorized === 1;
}

async function rpc(admin: AdminClient, name: string, args: Obj = {}) {
  const result = await admin.rpc(name, args);
  if (result.error) {
    console.error("bia-agent-rpc", { name, code: result.error.code, message: result.error.message });
    throw new GatewayError(`BIA_AGENT_RPC_FAILED_${name}`, 503);
  }
  return result.data;
}

async function delegateToEnterprise(request: Request, bytes: Uint8Array, tool: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELEGATE_TIMEOUT_MS);
  try {
    const original = JSON.parse(new TextDecoder().decode(bytes)) as Obj;
    const response = await fetch(legacyGatewayUrl(), {
      method: "POST",
      headers: { apikey: request.headers.get("apikey") || "", "content-type": "application/json" },
      body: JSON.stringify({ ...original, agentToolHint: tool }),
      signal: controller.signal,
    });
    const body = await response.arrayBuffer();
    const headers = new Headers(HEADERS);
    headers.set("content-type", response.headers.get("content-type") || "application/json; charset=utf-8");
    return new Response(body, { status: response.status, headers });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return json({ ok: false, error: "BIA_AGENT_TOOL_TIMEOUT" }, 504);
    throw error;
  } finally { clearTimeout(timer); }
}

function runtimeCredentials(value: unknown): Runtime | null {
  if (!obj(value) || value.enabled !== true) return null;
  const apiKey = str(value.api_key);
  const model = str(value.agent_model);
  const rawReasoning = str(value.agent_reasoning) || "medium";
  if (!apiKey || apiKey.length < 32 || /\s/.test(apiKey) || !model) return null;
  const reasoning = (["none","low","medium","high","xhigh"] as const).includes(rawReasoning as never)
    ? rawReasoning as Runtime["reasoning"] : "medium";
  return { apiKey, model, reasoning };
}

function cleanStringArray(value: unknown, limit: number, maxLength: number) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((x): x is string => typeof x === "string").map(x => x.trim().slice(0, maxLength)).filter(Boolean))].slice(0, limit);
}
function recentConversation(context: Obj) {
  const messages = Array.isArray(context.messages) ? context.messages : [];
  return messages.slice(-16).flatMap((m) => {
    if (!obj(m)) return [];
    const content = str(m.content)?.slice(0, 1500);
    if (!content) return [];
    return [{ role: m.direction === "assistant" ? "assistant" : "user", content }];
  });
}
function modelContext(context: Obj, gatewayContext: Obj, message: string) {
  const experience = obj(context.experience) ? context.experience : {};
  const knowledge = obj(context.knowledge) ? context.knowledge : {};
  return {
    empreendimento: { nome: str(experience.name), titulo: str(experience.title), subtitulo: str(experience.subtitle) },
    etapa: str(context.stage) || "discovery",
    perfil: obj(context.profile) ? context.profile : {},
    fatos_aprovados: cleanStringArray(knowledge.approvedFacts, 28, 550),
    historico_recente: recentConversation(context),
    visita_em_andamento: obj(gatewayContext.visitState) ? gatewayContext.visitState : null,
    bloqueio_atual: obj(gatewayContext.holdStatus) ? gatewayContext.holdStatus : null,
    mensagem_atual: message,
  };
}

const TOOL_MAP: Record<string, string> = {
  consultar_estoque: "inventory",
  consultar_condicoes_comerciais: "commercial",
  simular_pagamento: "simulation",
  buscar_materiais: "media",
  agendar_visita: "visit",
  registrar_contato: "contact",
  bloquear_lote: "hold",
  transferir_especialista: "handoff",
};
const TOOLS = [
  ["consultar_estoque", "Use somente para disponibilidade real de lotes/unidades no ERP."],
  ["consultar_condicoes_comerciais", "Use somente para preço vigente, juros, entrada, correção ou condição comercial canônica."],
  ["simular_pagamento", "Use para cálculo ou simulação numérica exata de pagamento."],
  ["buscar_materiais", "Use para fotos, vídeos, PDFs, plantas e documentos existentes."],
  ["agendar_visita", "Use para iniciar, continuar, confirmar, remarcar ou cancelar uma visita."],
  ["registrar_contato", "Use quando for necessário registrar ou atualizar dados de contato no ERP."],
  ["bloquear_lote", "Use para bloquear/reservar lote ou consultar/confirmar bloqueio."],
  ["transferir_especialista", "Use quando o cliente pedir explicitamente uma pessoa, corretor ou especialista."],
].map(([name, description]) => ({
  type: "function",
  name,
  description,
  parameters: { type: "object", additionalProperties: false, properties: {}, required: [] },
  strict: true,
}));

const SYSTEM_PROMPT = `Você é a Bia, agente comercial digital da Évora Urbanismo. Você é uma IA conversacional completa, consultiva e natural — não um chatbot de menus.
Toda mensagem textual do cliente chega primeiro a você. Responda diretamente quando for conversa, intenção, opinião, preferência, objeção, estratégia de compra, horizonte de investimento ou dúvida conceitual.
Use uma ferramenta SOMENTE quando precisar de um dado canônico do ERP ou executar uma ação real. Não chame ferramenta apenas porque o assunto é imobiliário.
Exemplos: "Quero investir" e "Estou pensando em comprar para vender daqui alguns anos. O que você acha?" são conversa aberta: responda sobre horizonte, liquidez, escolha do lote, riscos e critérios, sem prometer valorização ou retorno. "Quais lotes estão disponíveis agora?" exige consultar_estoque. "Quanto custa o SOL-C-14?" exige consultar_condicoes_comerciais. "Quero visitar amanhã às 10h" exige agendar_visita.
Preserve o contexto da conversa. Não repita apresentação. Não ofereça menu automático depois de toda mensagem. Faça no máximo uma pergunta útil ao final.
Nunca invente preço, disponibilidade, metragem, condição comercial, confirmação de bloqueio, visita ou documento. Para esses dados, use a ferramenta apropriada.
Responda em português brasileiro natural, cordial, claro e comercial.`;

function outputText(payload: unknown): string | null {
  if (!obj(payload) || !Array.isArray(payload.output)) return null;
  for (const item of payload.output) {
    if (!obj(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (obj(content) && content.type === "output_text" && typeof content.text === "string" && content.text.trim()) return content.text.trim();
    }
  }
  return null;
}
function toolCall(payload: unknown): string | null {
  if (!obj(payload) || !Array.isArray(payload.output)) return null;
  for (const item of payload.output) {
    if (!obj(item) || item.type !== "function_call") continue;
    const name = str(item.name);
    if (name && TOOL_MAP[name]) return TOOL_MAP[name];
  }
  return null;
}
function statusDetails(payload: unknown) {
  if (!obj(payload)) return { status: null, reason: null, error: null };
  return {
    status: str(payload.status),
    reason: obj(payload.incomplete_details) ? str(payload.incomplete_details.reason) : null,
    error: obj(payload.error) ? str(payload.error.code) || str(payload.error.message) : null,
  };
}
async function sleep(ms: number) { await new Promise(resolve => setTimeout(resolve, ms)); }

async function callModel(runtime: Runtime, context: Obj, allowTools: boolean, forceLowReasoning = false) {
  const attempts = [0, 350];
  let last: { code: string; status: number } | null = null;
  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    if (attempts[attempt]) await sleep(attempts[attempt]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
    try {
      const body: Obj = {
        model: runtime.model,
        reasoning: { effort: forceLowReasoning ? "low" : runtime.reasoning },
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(context) },
        ],
        max_output_tokens: allowTools ? 4_096 : 3_000,
        store: false,
      };
      if (allowTools) { body.tools = TOOLS; body.tool_choice = "auto"; }
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${runtime.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      const details = statusDetails(payload);
      if (response.ok && details.status !== "incomplete" && details.status !== "failed") {
        const tool = allowTools ? toolCall(payload) : null;
        const reply = outputText(payload);
        if (tool || reply) return { tool, reply };
        last = { code: "BIA_AGENT_EMPTY_OUTPUT", status: 503 };
      } else {
        const code = details.reason || details.error || `HTTP_${response.status}`;
        console.error("bia-agent-openai", { attempt: attempt + 1, httpStatus: response.status, responseStatus: details.status, code, requestId: response.headers.get("x-request-id") });
        last = { code: `BIA_AGENT_OPENAI_${String(code).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80)}`, status: response.status === 429 ? 429 : 503 };
        if (![408,409,429,500,502,503,504].includes(response.status) && details.status !== "incomplete") break;
      }
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "AbortError";
      last = { code: isTimeout ? "BIA_AGENT_OPENAI_TIMEOUT" : "BIA_AGENT_OPENAI_NETWORK_FAILURE", status: 503 };
      console.error("bia-agent-openai-exception", { attempt: attempt + 1, name: error instanceof Error ? error.name : "UnknownError" });
    } finally { clearTimeout(timer); }
  }
  throw new GatewayError(last?.code || "BIA_AGENT_MODEL_UNAVAILABLE", last?.status || 503);
}

function mergeProfile(current: unknown, message: string) {
  const profile: Obj = obj(current) ? { ...current } : {};
  if (/\binvest(?:ir|imento|idor|idora|indo)\b/i.test(message)) profile.intent = "investir";
  else if (/\bmor(?:ar|adia|ando)\b/i.test(message)) profile.intent = "morar";
  else if (/\bconhec(?:er|endo)\b/i.test(message)) profile.intent = "conhecer";
  return profile;
}

async function commitConversation(admin: AdminClient, body: Obj, context: Obj, gatewayContext: Obj, reply: string) {
  const message = str(body.message) || "";
  const profile = mergeProfile(context.profile, message);
  const currentStage = str(context.stage) || "discovery";
  const stage = currentStage === "welcome" ? "discovery" : currentStage;
  const selectedUnitCode = str(profile.selected_unit_code)?.toUpperCase() || null;
  const response = {
    status: "completed",
    reply: reply.slice(0, 1_200),
    stage,
    profile,
    contactCapture: obj(gatewayContext.contactCapture) ? gatewayContext.contactCapture : {},
    serviceConsented: gatewayContext.serviceConsented === true,
    marketingConsented: gatewayContext.marketingConsented === true,
    requestContact: false,
    handoffRequested: false,
    quickReplies: [],
    action: "none",
    selectedUnitCode,
    commercial: null,
    simulation: null,
    attachments: [],
    holdStatus: obj(gatewayContext.holdStatus) ? gatewayContext.holdStatus : null,
    converted: gatewayContext.converted === true,
    leadProtocol: str(gatewayContext.leadProtocol),
    degraded: false,
  };
  const committed = await rpc(admin, "commit_public_agent_gateway_turn_v1", {
    p_slug: body.slug,
    p_session_token_hash: body.tokenHash,
    p_fingerprint_hash: body.fingerprintHash,
    p_client_request_id: body.clientMessageId,
    p_user_message: message,
    p_response: response,
    p_visit_state: null,
    p_contact_patch: {},
    p_service_consent: null,
    p_marketing_consent: null,
    p_consent_copy_version: null,
  });
  if (!obj(committed)) throw new GatewayError("BIA_AGENT_COMMIT_INVALID", 503);
  return committed;
}

Deno.serve(async (request: Request) => {
  try {
    if (request.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ ok: false, error: "JSON_REQUIRED" }, 415);
    if (!ingressAuthorized(request)) return json({ ok: false, error: "BIA_AGENT_AUTH_REQUIRED" }, 401);

    const declared = request.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) return json({ ok: false, error: "PAYLOAD_TOO_LARGE" }, 413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) return json({ ok: false, error: bytes.byteLength ? "PAYLOAD_TOO_LARGE" : "JSON_REQUIRED" }, bytes.byteLength ? 413 : 415);

    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { return json({ ok: false, error: "INVALID_JSON" }, 400); }
    if (!obj(parsed)) return json({ ok: false, error: "INVALID_REQUEST" }, 400);
    if (parsed.action !== "message" || parsed.source === "audio") return await delegateToEnterprise(request, bytes, "infrastructure");

    const message = str(parsed.message);
    const clientMessageId = str(parsed.clientMessageId);
    const slug = str(parsed.slug);
    const tokenHash = str(parsed.tokenHash);
    const fingerprintHash = str(parsed.fingerprintHash);
    if (!message || message.length > 800 || !clientMessageId || !UUID.test(clientMessageId) || !slug || !tokenHash || !HASH.test(tokenHash) || !fingerprintHash || !HASH.test(fingerprintHash)) {
      return json({ ok: false, error: "BIA_AGENT_INPUT_INVALID" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceRole) throw new GatewayError("BIA_AGENT_CONFIG_INVALID", 503);
    const admin = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });

    const [gatewayContextRaw, contextRaw] = await Promise.all([
      rpc(admin, "get_public_agent_gateway_context_v1", { p_slug: slug, p_session_token_hash: tokenHash, p_fingerprint_hash: fingerprintHash }),
      rpc(admin, "get_public_agent_v3_context", { p_slug: slug, p_session_token_hash: tokenHash, p_fingerprint_hash: fingerprintHash }),
    ]);
    if (!obj(contextRaw)) throw new GatewayError("BIA_AGENT_CONTEXT_INVALID", 503);
    const context = contextRaw;
    const gatewayContext = obj(gatewayContextRaw) ? gatewayContextRaw : {};
    const organizationId = str(context.organizationId);
    if (!organizationId) throw new GatewayError("BIA_AGENT_CONTEXT_INVALID", 503);

    const runtimeRaw = await rpc(admin, "get_crm_ai_runtime_credentials", { p_organization_id: organizationId });
    const runtime = runtimeCredentials(runtimeRaw);
    if (!runtime) throw new GatewayError("BIA_AGENT_MODEL_UNAVAILABLE", 503);

    const contextForModel = modelContext(context, gatewayContext, message);
    let result: { tool: string | null; reply: string | null };
    try {
      result = await callModel(runtime, contextForModel, true, false);
    } catch (firstError) {
      console.warn("bia-agent-primary-failed", { code: firstError instanceof GatewayError ? firstError.code : "unknown", clientMessageId });
      result = await callModel(runtime, contextForModel, false, true);
    }

    if (result.tool) return await delegateToEnterprise(request, bytes, result.tool);
    if (!result.reply) {
      const recovered = await callModel(runtime, contextForModel, false, true);
      if (!recovered.reply) throw new GatewayError("BIA_AGENT_EMPTY_OUTPUT", 503);
      result = recovered;
    }
    const finalReply = result.reply;
    if (!finalReply) throw new GatewayError("BIA_AGENT_EMPTY_OUTPUT", 503);

    const committed = await commitConversation(admin, parsed, context, gatewayContext, finalReply);
    return json({ ok: true, data: committed });
  } catch (error) {
    const code = error instanceof GatewayError ? error.code : "BIA_AGENT_GATEWAY_UNAVAILABLE";
    const status = error instanceof GatewayError ? error.status : 503;
    console.error("enterprise-bia-agent-gateway", { code, name: error instanceof Error ? error.name : "UnknownError" });
    return json({ ok: false, error: code }, status);
  }
});
