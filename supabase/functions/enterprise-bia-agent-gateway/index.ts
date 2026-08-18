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
type Reasoning = "none" | "low" | "medium" | "high" | "xhigh";
type Runtime = {
  apiKey: string;
  model: string;
  reasoning: Reasoning;
  vectorStoreId: string | null;
};

const MAX_BYTES = 3_500_000;
const MODEL_TIMEOUT_MS = 28_000;
const DELEGATE_TIMEOUT_MS = 125_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/i;
const VECTOR_STORE = /^vs_[A-Za-z0-9_-]{6,}$/;
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
    super(code);
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: HEADERS });
const obj = (value: unknown): value is Obj =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

function supabaseBase() {
  const raw = Deno.env.get("SUPABASE_URL") || "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") throw new Error("protocol");
    return url;
  } catch {
    throw new GatewayError("BIA_AI_FIRST_CONFIG_INVALID");
  }
}
function enterpriseGatewayUrl() {
  return new URL("/functions/v1/enterprise-vitoria-agent-gateway", supabaseBase());
}

function constantTimeEqual(left: string, right: string) {
  let difference = left.length ^ right.length;
  for (let index = 0; index < 512; index += 1) {
    difference |= (index < left.length ? left.charCodeAt(index) : 0)
      ^ (index < right.length ? right.charCodeAt(index) : 0);
  }
  return difference === 0;
}
function configuredPublishableKeys() {
  const raw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "";
  if (!raw || raw.length > 65_536) return [] as string[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!obj(parsed)) return [];
    return Object.values(parsed).filter((value): value is string =>
      typeof value === "string"
      && value.length >= 32
      && value.length <= 512
      && !/\s/.test(value)
    ).slice(0, 64);
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

async function rpc(admin: AdminClient, name: string, args: Obj = {}) {
  const result = await admin.rpc(name, args);
  if (result.error) {
    console.error("bia-ai-first-rpc", {
      name,
      code: result.error.code,
      message: result.error.message,
    });
    throw new GatewayError(`BIA_AI_FIRST_RPC_FAILED_${name}`, 503);
  }
  return result.data;
}

function runtimeCredentials(value: unknown): Runtime | null {
  if (!obj(value) || value.enabled !== true) return null;
  const apiKey = str(value.api_key);
  const model = str(value.agent_model);
  const rawReasoning = str(value.agent_reasoning) || "low";
  const vectorStore = str(value.knowledge_vector_store_id);
  if (!apiKey || apiKey.length < 32 || /\s/.test(apiKey) || !model) return null;
  const reasoning = (["none", "low", "medium", "high", "xhigh"] as const)
    .includes(rawReasoning as never)
    ? rawReasoning as Reasoning
    : "low";
  return {
    apiKey,
    model,
    reasoning,
    vectorStoreId: vectorStore && VECTOR_STORE.test(vectorStore) ? vectorStore : null,
  };
}

function cleanStringArray(value: unknown, limit: number, maxLength: number) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().slice(0, maxLength))
      .filter(Boolean),
  )].slice(0, limit);
}
function recentConversation(context: Obj) {
  const messages = Array.isArray(context.messages) ? context.messages : [];
  return messages.slice(-20).flatMap((message) => {
    if (!obj(message)) return [];
    const content = str(message.content)?.slice(0, 1_500);
    if (!content) return [];
    return [{
      role: message.direction === "assistant" ? "assistant" : "user",
      content,
    }];
  });
}
function modelContext(context: Obj, gatewayContext: Obj, message: string) {
  const experience = obj(context.experience) ? context.experience : {};
  const knowledge = obj(context.knowledge) ? context.knowledge : {};
  return {
    empreendimento: {
      nome: str(experience.name),
      titulo: str(experience.title),
      subtitulo: str(experience.subtitle),
    },
    etapa: str(context.stage) || "discovery",
    perfil: obj(context.profile) ? context.profile : {},
    fatos_aprovados: cleanStringArray(knowledge.approvedFacts, 32, 600),
    guardrails: cleanStringArray(knowledge.guardrails, 24, 600),
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

const FUNCTION_TOOLS = [
  {
    type: "function",
    name: "consultar_estoque",
    description: "Consultar disponibilidade real e atual de lotes ou unidades no ERP.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        unit_code: { type: ["string", "null"] },
        area_min: { type: ["number", "null"] },
        area_max: { type: ["number", "null"] },
        budget_max: { type: ["number", "null"] },
      },
      required: ["unit_code", "area_min", "area_max", "budget_max"],
    },
    strict: true,
  },
  {
    type: "function",
    name: "consultar_condicoes_comerciais",
    description: "Consultar preço, entrada, prazo, juros, correção, balões ou condição comercial vigente no ERP.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { unit_code: { type: ["string", "null"] } },
      required: ["unit_code"],
    },
    strict: true,
  },
  {
    type: "function",
    name: "simular_pagamento",
    description: "Executar uma simulação financeira exata usando as regras comerciais do ERP.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { unit_code: { type: ["string", "null"] } },
      required: ["unit_code"],
    },
    strict: true,
  },
  {
    type: "function",
    name: "buscar_materiais",
    description: "Buscar fotos, vídeos, plantas, PDFs e documentos existentes na base oficial.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: ["string", "null"] } },
      required: ["query"],
    },
    strict: true,
  },
  {
    type: "function",
    name: "agendar_visita",
    description: "Iniciar, continuar, confirmar, remarcar ou cancelar uma visita no ERP.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        unit_code: { type: ["string", "null"] },
        requested_when: { type: ["string", "null"] },
      },
      required: ["unit_code", "requested_when"],
    },
    strict: true,
  },
  {
    type: "function",
    name: "registrar_contato",
    description: "Registrar ou atualizar dados de contato do lead quando isso for necessário para uma ação solicitada.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
    strict: true,
  },
  {
    type: "function",
    name: "bloquear_lote",
    description: "Bloquear ou reservar um lote, confirmar um bloqueio ou consultar o estado atual de um bloqueio.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { unit_code: { type: ["string", "null"] } },
      required: ["unit_code"],
    },
    strict: true,
  },
  {
    type: "function",
    name: "transferir_especialista",
    description: "Transferir para uma pessoa da equipe quando o cliente pedir explicitamente atendimento humano.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
    strict: true,
  },
];

const SYSTEM_PROMPT = `Você é a Bia, agente comercial digital da Évora Urbanismo.
Você é uma IA conversacional completa, consultiva e natural — não um chatbot de menus.

ARQUITETURA DE DECISÃO
1. Toda mensagem textual do cliente chega primeiro a você.
2. Responda diretamente quando puder responder com raciocínio, contexto da conversa ou conhecimento aprovado.
3. Use uma ferramenta somente quando precisar consultar um dado canônico/vivo do ERP ou executar uma ação real.
4. Para conhecimento institucional e materiais de apoio, use a busca na base de conhecimento quando ela estiver disponível.

CONVERSA ABERTA
Mensagens como “Quero investir”, “Estou pensando em comprar para vender daqui alguns anos”, “O que você acha?”, objeções, preferências e dúvidas conceituais devem ser respondidas por você, sem abrir menus e sem chamar ferramenta apenas porque o tema é imobiliário.

FERRAMENTAS
- estoque/disponibilidade real: consultar_estoque
- preço e condição comercial vigente: consultar_condicoes_comerciais
- cálculo exato: simular_pagamento
- fotos, vídeos, PDFs e plantas: buscar_materiais
- visita: agendar_visita
- cadastro necessário para uma ação: registrar_contato
- reserva/bloqueio: bloquear_lote
- humano: transferir_especialista

SEGURANÇA
Nunca invente preço, disponibilidade, metragem, condição comercial, cálculo, confirmação de visita, bloqueio ou documento. Para esses pontos, use a ferramenta apropriada.
Nunca prometa valorização, rentabilidade ou retorno garantido.
Preserve o contexto e não faça o cliente repetir informações já fornecidas.
Não ofereça menu automático após cada resposta. Faça no máximo uma pergunta útil ao final.
Responda em português brasileiro natural, cordial, claro e comercial.`;

function outputText(payload: unknown): string | null {
  if (!obj(payload) || !Array.isArray(payload.output)) return null;
  for (const item of payload.output) {
    if (!obj(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (
        obj(content)
        && content.type === "output_text"
        && typeof content.text === "string"
        && content.text.trim()
      ) return content.text.trim();
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

async function callModel(runtime: Runtime, context: Obj) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const tools: Obj[] = [...FUNCTION_TOOLS];
    if (runtime.vectorStoreId) {
      tools.push({
        type: "file_search",
        vector_store_ids: [runtime.vectorStoreId],
        max_num_results: 6,
      });
    }
    const body: Obj = {
      model: runtime.model,
      reasoning: { effort: runtime.reasoning },
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(context) },
      ],
      tools,
      tool_choice: "auto",
      max_output_tokens: 3_000,
      store: false,
    };
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtime.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    const details = statusDetails(payload);
    const requestId = response.headers.get("x-request-id");
    if (!response.ok || details.status === "incomplete" || details.status === "failed") {
      const code = details.reason || details.error || `HTTP_${response.status}`;
      console.error("bia-ai-first-openai", {
        httpStatus: response.status,
        responseStatus: details.status,
        code,
        requestId,
        limitRequests: response.headers.get("x-ratelimit-limit-requests"),
        remainingRequests: response.headers.get("x-ratelimit-remaining-requests"),
        resetRequests: response.headers.get("x-ratelimit-reset-requests"),
        limitTokens: response.headers.get("x-ratelimit-limit-tokens"),
        remainingTokens: response.headers.get("x-ratelimit-remaining-tokens"),
        resetTokens: response.headers.get("x-ratelimit-reset-tokens"),
      });
      throw new GatewayError(
        `BIA_AI_FIRST_OPENAI_${String(code).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80)}`,
        response.status === 429 ? 429 : 503,
      );
    }
    const tool = toolCall(payload);
    const reply = outputText(payload);
    if (!tool && !reply) {
      throw new GatewayError("BIA_AI_FIRST_EMPTY_OUTPUT", 503);
    }
    return { tool, reply, requestId };
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new GatewayError("BIA_AI_FIRST_OPENAI_TIMEOUT", 503);
    }
    throw new GatewayError("BIA_AI_FIRST_OPENAI_NETWORK_FAILURE", 503);
  } finally {
    clearTimeout(timer);
  }
}

function mergeProfile(current: unknown, message: string) {
  const profile: Obj = obj(current) ? { ...current } : {};
  if (/\binvest(?:ir|imento|idor|idora|indo)\b/i.test(message)) profile.intent = "investir";
  else if (/\bmor(?:ar|adia|ando)\b/i.test(message)) profile.intent = "morar";
  else if (/\bconhec(?:er|endo)\b/i.test(message)) profile.intent = "conhecer";
  return profile;
}

async function commitConversation(
  admin: AdminClient,
  body: Obj,
  context: Obj,
  gatewayContext: Obj,
  reply: string,
  requestId: string | null,
) {
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
    metadata: {
      runtime_contract: "bia-ai-first-v1",
      openai_request_id: requestId,
      ai_first: true,
    },
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
  if (!obj(committed)) throw new GatewayError("BIA_AI_FIRST_COMMIT_INVALID", 503);
  return committed;
}

async function delegateToEnterprise(
  request: Request,
  bytes: Uint8Array,
  tool: string,
  requestId: string | null,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELEGATE_TIMEOUT_MS);
  try {
    const original = JSON.parse(new TextDecoder().decode(bytes)) as Obj;
    const response = await fetch(enterpriseGatewayUrl(), {
      method: "POST",
      headers: {
        apikey: request.headers.get("apikey") || "",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...original,
        agentToolHint: tool,
        aiFirstRequestId: requestId,
      }),
      signal: controller.signal,
    });
    const responseBody = await response.arrayBuffer();
    const headers = new Headers(HEADERS);
    headers.set(
      "content-type",
      response.headers.get("content-type") || "application/json; charset=utf-8",
    );
    return new Response(responseBody, { status: response.status, headers });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return json({ ok: false, error: "BIA_AI_FIRST_TOOL_TIMEOUT" }, 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (request: Request) => {
  try {
    if (request.method !== "POST") {
      return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    }
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return json({ ok: false, error: "JSON_REQUIRED" }, 415);
    }
    if (!ingressAuthorized(request)) {
      return json({ ok: false, error: "BIA_AI_FIRST_AUTH_REQUIRED" }, 401);
    }

    const declared = request.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
      return json({ ok: false, error: "PAYLOAD_TOO_LARGE" }, 413);
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) {
      return json(
        { ok: false, error: bytes.byteLength ? "PAYLOAD_TOO_LARGE" : "JSON_REQUIRED" },
        bytes.byteLength ? 413 : 415,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return json({ ok: false, error: "INVALID_JSON" }, 400);
    }
    if (!obj(parsed)) return json({ ok: false, error: "INVALID_REQUEST" }, 400);

    // Sessão, experiência e áudio continuam no pipeline estável.
    // Apenas mensagens textuais entram primeiro na IA.
    if (parsed.action !== "message" || parsed.source === "audio") {
      return await delegateToEnterprise(request, bytes, "infrastructure", null);
    }

    const message = str(parsed.message);
    const clientMessageId = str(parsed.clientMessageId);
    const slug = str(parsed.slug);
    const tokenHash = str(parsed.tokenHash);
    const fingerprintHash = str(parsed.fingerprintHash);
    if (
      !message
      || message.length > 1_100
      || !clientMessageId
      || !UUID.test(clientMessageId)
      || !slug
      || !tokenHash
      || !HASH.test(tokenHash)
      || !fingerprintHash
      || !HASH.test(fingerprintHash)
    ) {
      return json({ ok: false, error: "BIA_AI_FIRST_INPUT_INVALID" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceRole) {
      throw new GatewayError("BIA_AI_FIRST_CONFIG_INVALID", 503);
    }
    const admin = createClient(supabaseUrl, serviceRole, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    const [gatewayContextRaw, contextRaw] = await Promise.all([
      rpc(admin, "get_public_agent_gateway_context_v1", {
        p_slug: slug,
        p_session_token_hash: tokenHash,
        p_fingerprint_hash: fingerprintHash,
      }),
      rpc(admin, "get_public_agent_v3_context", {
        p_slug: slug,
        p_session_token_hash: tokenHash,
        p_fingerprint_hash: fingerprintHash,
      }),
    ]);
    if (!obj(contextRaw)) throw new GatewayError("BIA_AI_FIRST_CONTEXT_INVALID", 503);
    const context = contextRaw;
    const gatewayContext = obj(gatewayContextRaw) ? gatewayContextRaw : {};
    const organizationId = str(context.organizationId);
    if (!organizationId) throw new GatewayError("BIA_AI_FIRST_CONTEXT_INVALID", 503);

    const runtimeRaw = await rpc(admin, "get_crm_ai_runtime_credentials", {
      p_organization_id: organizationId,
    });
    const runtime = runtimeCredentials(runtimeRaw);
    if (!runtime) throw new GatewayError("BIA_AI_FIRST_MODEL_UNAVAILABLE", 503);

    const result = await callModel(runtime, modelContext(context, gatewayContext, message));

    if (result.tool) {
      return await delegateToEnterprise(request, bytes, result.tool, result.requestId);
    }
    if (!result.reply) throw new GatewayError("BIA_AI_FIRST_EMPTY_OUTPUT", 503);

    const committed = await commitConversation(
      admin,
      parsed,
      context,
      gatewayContext,
      result.reply,
      result.requestId,
    );
    return json({ ok: true, data: committed });
  } catch (error) {
    const code = error instanceof GatewayError ? error.code : "BIA_AI_FIRST_UNAVAILABLE";
    const status = error instanceof GatewayError ? error.status : 503;
    console.error("enterprise-bia-agent-gateway", {
      code,
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return json({ ok: false, error: code }, status);
  }
});