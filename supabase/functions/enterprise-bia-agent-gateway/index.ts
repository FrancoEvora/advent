import { createClient as createSupabaseClient } from "npm:@supabase/supabase-js@2";

type JsonObject = Record<string, unknown>;
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

const MAX_BYTES = 3_500_000;
const MODEL_TIMEOUT_MS = 42_000;
const DELEGATE_TIMEOUT_MS = 125_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/i;
const HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const STAGES = new Set(["welcome", "discovery", "qualification", "contact", "handoff", "completed"]);

class GatewayError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 503) {
    super(code);
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanStringArray(value: unknown, limit: number, maxLength: number) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean))].slice(0, limit);
}

function supabaseBase(): URL {
  const raw = Deno.env.get("SUPABASE_URL") || "";
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    throw new GatewayError("BIA_AGENTIC_CONFIG_INVALID");
  }
  if (base.protocol !== "https:") throw new GatewayError("BIA_AGENTIC_CONFIG_INVALID");
  return base;
}

function legacyGatewayUrl() {
  return new URL("/functions/v1/enterprise-vitoria-agent-gateway", supabaseBase());
}

function constantTimeEqual(left: string, right: string) {
  let difference = left.length ^ right.length;
  for (let index = 0; index < 512; index += 1) {
    const leftCode = index < left.length ? left.charCodeAt(index) : 0;
    const rightCode = index < right.length ? right.charCodeAt(index) : 0;
    difference |= leftCode ^ rightCode;
  }
  return difference === 0;
}

function configuredPublishableKeys() {
  const raw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "";
  if (!raw || raw.length > 65_536) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.values(parsed).filter((value): value is string => (
      typeof value === "string"
      && value.length >= 32
      && value.length <= 512
      && !/\s/.test(value)
    )).slice(0, 64);
  } catch {
    return [];
  }
}

function ingressAuthorized(request: Request) {
  const candidate = request.headers.get("apikey") || "";
  if (candidate.length < 32 || candidate.length > 512 || /\s/.test(candidate)) return false;
  let authorized = 0;
  for (const configured of configuredPublishableKeys()) {
    authorized |= Number(constantTimeEqual(configured, candidate));
  }
  return authorized === 1;
}

async function rpc(admin: AdminClient, name: string, args: JsonObject = {}) {
  const result = await admin.rpc(name, args);
  if (result.error) {
    console.error("bia-agentic-rpc", { name, code: result.error.code });
    throw new GatewayError("BIA_AGENTIC_RPC_FAILED", 503);
  }
  return result.data;
}

async function delegate(request: Request, bytes: Uint8Array) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELEGATE_TIMEOUT_MS);
  try {
    const response = await fetch(legacyGatewayUrl(), {
      method: "POST",
      headers: {
        apikey: request.headers.get("apikey") || "",
        "content-type": "application/json",
      },
      body: new TextDecoder().decode(bytes),
      signal: controller.signal,
    });
    const responseBody = await response.arrayBuffer();
    const headers = new Headers(HEADERS);
    headers.set("content-type", response.headers.get("content-type") || "application/json; charset=utf-8");
    return new Response(responseBody, { status: response.status, headers });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return json({ ok: false, error: "BIA_AGENTIC_DELEGATE_TIMEOUT" }, 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function runtimeCredentials(value: unknown) {
  if (!object(value) || value.enabled !== true) return null;
  const apiKey = text(value.api_key);
  const model = text(value.agent_model);
  const reasoning = text(value.agent_reasoning) || "medium";
  if (!apiKey || apiKey.length < 32 || /\s/.test(apiKey) || !model) return null;
  const allowed = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
  return {
    apiKey,
    model,
    reasoning: allowed.has(reasoning) ? (reasoning === "max" ? "high" : reasoning) : "medium",
  };
}

function safeProfile(value: unknown): JsonObject {
  return object(value) ? { ...value } : {};
}

function recentConversation(context: JsonObject) {
  const messages = Array.isArray(context.messages) ? context.messages : [];
  return messages.slice(-14).flatMap((message) => {
    if (!object(message)) return [];
    const content = text(message.content)?.slice(0, 1_200);
    if (!content) return [];
    return [{
      role: message.direction === "assistant" ? "bia" : "cliente",
      content,
    }];
  });
}

function modelContext(context: JsonObject, gatewayContext: JsonObject, message: string) {
  const experience = object(context.experience) ? context.experience : {};
  const knowledge = object(context.knowledge) ? context.knowledge : {};
  return {
    empreendimento: {
      nome: text(experience.name),
      titulo: text(experience.title),
      subtitulo: text(experience.subtitle),
    },
    etapa: text(context.stage) || "discovery",
    perfil: safeProfile(context.profile),
    fatos_aprovados: cleanStringArray(knowledge.approvedFacts, 24, 500),
    historico_recente: recentConversation(context),
    bloqueio_atual: object(gatewayContext.holdStatus) ? gatewayContext.holdStatus : null,
    mensagem_atual: message,
  };
}

const ROUTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    delegate: { type: "boolean" },
    reply: { type: "string", maxLength: 1_100 },
    stage: {
      type: "string",
      enum: ["welcome", "discovery", "qualification", "contact", "handoff", "completed"],
    },
    intent: {
      type: "string",
      enum: ["unchanged", "morar", "investir", "conhecer", "unknown"],
    },
    summary: { type: ["string", "null"], maxLength: 900 },
    quick_replies: {
      type: "array",
      maxItems: 2,
      items: { type: "string", maxLength: 90 },
    },
  },
  required: ["delegate", "reply", "stage", "intent", "summary", "quick_replies"],
};

const SYSTEM_PROMPT = [
  "Você é a Bia, agente comercial digital da Évora Urbanismo. Você conversa com a naturalidade e a inteligência de uma excelente consultora imobiliária usando o modelo como cérebro e o ERP como ferramenta.",
  "Sua primeira decisão é simples: este turno é CONVERSA ou precisa ser DELEGADO ao sistema transacional?",
  "CONVERSA: saudações; intenção de morar, investir ou pesquisar; preferências; dúvidas gerais; objeções; comentários; contexto pessoal; comparação qualitativa; perguntas exploratórias que podem ser respondidas apenas com os fatos aprovados fornecidos.",
  "DELEGUE quando a resposta ou ação depender de qualquer dado canônico/tempo real ou causar efeito no sistema: preço, disponibilidade, estoque, unidade específica, condição de pagamento vigente, cálculo/simulação exata, fotos/documentos/vídeos, visita/agendamento, cadastro/contato, reserva/bloqueio/status, handoff para equipe ou geração de imagem.",
  "Se houver dúvida se um fato exige confirmação no ERP, delegue. Nunca invente preço, metragem, disponibilidade, condição, prazo ou documento.",
  "Quando for CONVERSA, responda diretamente ao que a pessoa disse. Não transforme a conversa em menu, não use frases como 'não consegui confirmar esse detalhe' para uma intenção compreensível e não obrigue o cliente a clicar em botões.",
  "Para 'quero investir', acolha a intenção e conduza consultivamente. Você pode falar qualitativamente de critérios como perfil do lote, liquidez, horizonte, forma de pagamento e adequação do produto, mas nunca prometa valorização, rentabilidade ou retorno.",
  "Use no máximo uma pergunta útil por resposta. Quick replies são opcionais; normalmente deixe a lista vazia. Não peça dados pessoais em conversa aberta.",
  "Leia o histórico recente e preserve o contexto. Não repita perguntas ou apresentações já feitas.",
  "Se delegate=true, deixe reply vazio e quick_replies vazio. O gateway transacional fará a resposta final.",
  "Responda em português brasileiro natural, cordial e comercial, sem jargão de sistema.",
].join("\n");

function outputText(payload: unknown) {
  if (!object(payload) || !Array.isArray(payload.output)) return null;
  for (const item of payload.output) {
    if (!object(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (object(content) && content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }
  return null;
}

async function routeWithModel(
  runtime: { apiKey: string; model: string; reasoning: string },
  context: JsonObject,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtime.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: runtime.model,
        reasoning: { effort: runtime.reasoning },
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(context) },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "bia_agentic_router",
            strict: true,
            schema: ROUTER_SCHEMA,
          },
        },
        max_output_tokens: 1_400,
        store: false,
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      console.error("bia-agentic-openai", { status: response.status });
      return null;
    }
    const raw = outputText(payload);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return object(parsed) ? parsed : null;
  } catch (error) {
    console.error("bia-agentic-model", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function safeStage(value: unknown, fallback: string) {
  const stage = text(value) || fallback;
  return STAGES.has(stage) ? stage : "discovery";
}

function mergeProfile(current: unknown, decision: JsonObject) {
  const profile = safeProfile(current);
  const intent = text(decision.intent);
  if (intent && intent !== "unchanged") profile.intent = intent;
  const summary = text(decision.summary);
  if (summary) profile.summary = summary.slice(0, 900);
  return profile;
}

async function commitConversation(
  admin: AdminClient,
  body: JsonObject,
  context: JsonObject,
  gatewayContext: JsonObject,
  decision: JsonObject,
) {
  const message = text(body.message) || "";
  const clientMessageId = text(body.clientMessageId) || "";
  const profile = mergeProfile(context.profile, decision);
  const currentStage = text(context.stage) || "discovery";
  const stage = safeStage(decision.stage, currentStage);
  const quickReplies = cleanStringArray(decision.quick_replies, 2, 90);
  const selectedUnitCode = text(profile.selected_unit_code)?.toUpperCase() || null;
  const response = {
    status: "completed",
    reply: text(decision.reply)?.slice(0, 1_100) || "Entendi. Me conta um pouco mais sobre o que você procura.",
    stage,
    profile,
    contactCapture: object(gatewayContext.contactCapture) ? gatewayContext.contactCapture : {},
    serviceConsented: gatewayContext.serviceConsented === true,
    marketingConsented: gatewayContext.marketingConsented === true,
    requestContact: false,
    handoffRequested: false,
    quickReplies,
    action: "none",
    selectedUnitCode,
    commercial: null,
    simulation: null,
    attachments: [],
    holdStatus: object(gatewayContext.holdStatus) ? gatewayContext.holdStatus : null,
    converted: gatewayContext.converted === true,
    leadProtocol: text(gatewayContext.leadProtocol),
    degraded: false,
  };
  const committed = await rpc(admin, "commit_public_agent_gateway_turn_v1", {
    p_slug: body.slug,
    p_session_token_hash: body.tokenHash,
    p_fingerprint_hash: body.fingerprintHash,
    p_client_request_id: clientMessageId,
    p_user_message: message,
    p_response: response,
    p_visit_state: null,
    p_contact_patch: {},
    p_service_consent: null,
    p_marketing_consent: null,
    p_consent_copy_version: null,
  });
  if (!object(committed)) throw new GatewayError("BIA_AGENTIC_COMMIT_INVALID");
  return committed;
}

Deno.serve(async (request: Request) => {
  try {
    if (request.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return json({ ok: false, error: "JSON_REQUIRED" }, 415);
    }
    if (!ingressAuthorized(request)) return json({ ok: false, error: "BIA_AGENTIC_AUTH_REQUIRED" }, 401);
    const declared = request.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
      return json({ ok: false, error: "PAYLOAD_TOO_LARGE" }, 413);
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) {
      return json({ ok: false, error: bytes.byteLength ? "PAYLOAD_TOO_LARGE" : "JSON_REQUIRED" }, bytes.byteLength ? 413 : 415);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return json({ ok: false, error: "INVALID_JSON" }, 400);
    }
    if (!object(parsed)) return json({ ok: false, error: "INVALID_REQUEST" }, 400);

    if (parsed.action !== "message" || parsed.source === "audio") {
      return await delegate(request, bytes);
    }

    const message = text(parsed.message);
    const clientMessageId = text(parsed.clientMessageId);
    const slug = text(parsed.slug);
    const tokenHash = text(parsed.tokenHash);
    const fingerprintHash = text(parsed.fingerprintHash);
    if (
      !message || message.length > 800
      || !clientMessageId || !UUID.test(clientMessageId)
      || !slug || !tokenHash || !HASH.test(tokenHash)
      || !fingerprintHash || !HASH.test(fingerprintHash)
    ) {
      return await delegate(request, bytes);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceRole) return await delegate(request, bytes);
    const admin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    const gatewayContextRaw = await rpc(admin, "get_public_agent_gateway_context_v1", {
      p_slug: slug,
      p_session_token_hash: tokenHash,
      p_fingerprint_hash: fingerprintHash,
    });
    const gatewayContext = object(gatewayContextRaw) ? gatewayContextRaw : {};

    // A visit already in progress is a transaction. Preserve the proven state machine.
    if (object(gatewayContext.visitState)) return await delegate(request, bytes);

    const contextRaw = await rpc(admin, "get_public_agent_v3_context", {
      p_slug: slug,
      p_session_token_hash: tokenHash,
      p_fingerprint_hash: fingerprintHash,
    });
    if (!object(contextRaw)) return await delegate(request, bytes);
    const context = contextRaw;
    const organizationId = text(context.organizationId);
    if (!organizationId) return await delegate(request, bytes);

    const runtimeRaw = await rpc(admin, "get_crm_ai_runtime_credentials", {
      p_organization_id: organizationId,
    });
    const runtime = runtimeCredentials(runtimeRaw);
    if (!runtime) return await delegate(request, bytes);

    const decision = await routeWithModel(runtime, modelContext(context, gatewayContext, message));
    if (!decision || decision.delegate === true || !text(decision.reply)) {
      return await delegate(request, bytes);
    }

    const committed = await commitConversation(admin, parsed, context, gatewayContext, decision);
    return json({ ok: true, data: committed });
  } catch (error) {
    const code = error instanceof GatewayError ? error.code : "BIA_AGENTIC_GATEWAY_UNAVAILABLE";
    const status = error instanceof GatewayError ? error.status : 503;
    console.error("enterprise-bia-agent-gateway", {
      code,
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return json({ ok: false, error: code }, status);
  }
});
