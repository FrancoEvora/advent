import { createClient } from "npm:@supabase/supabase-js@2";

type JsonObject = Record<string, unknown>;

const MAX_BYTES = 3_500_000;
const MODEL_TIMEOUT_MS = 42_000;
const DELEGATE_TIMEOUT_MS = 125_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/i;
const STAGES = new Set(["welcome", "discovery", "qualification", "contact", "handoff", "completed"]);
const TOOLS = new Set(["none", "inventory", "commercial", "simulation", "media", "visit", "contact", "hold", "handoff"]);
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
    if (!object(parsed)) return [];
    return Object.values(parsed).filter((value): value is string => (
      typeof value === "string" && value.length >= 32 && value.length <= 512 && !/\s/.test(value)
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

async function rpc(admin: ReturnType<typeof createClient>, name: string, args: JsonObject = {}) {
  const result = await admin.rpc(name, args);
  if (result.error) {
    console.error("bia-agentic-rpc", { name, code: result.error.code, message: result.error.message });
    throw new GatewayError(`BIA_AGENTIC_RPC_FAILED_${name}`, 503);
  }
  return result.data;
}

async function delegateToEnterprise(request: Request, bytes: Uint8Array, tool: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELEGATE_TIMEOUT_MS);
  try {
    const original = JSON.parse(new TextDecoder().decode(bytes)) as JsonObject;
    const body = JSON.stringify({ ...original, agentToolHint: tool });
    console.info("bia-agent-tool", { tool });
    const response = await fetch(legacyGatewayUrl(), {
      method: "POST",
      headers: {
        apikey: request.headers.get("apikey") || "",
        "content-type": "application/json",
      },
      body,
      signal: controller.signal,
    });
    const responseBody = await response.arrayBuffer();
    const headers = new Headers(HEADERS);
    headers.set("content-type", response.headers.get("content-type") || "application/json; charset=utf-8");
    return new Response(responseBody, { status: response.status, headers });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return json({ ok: false, error: "BIA_AGENTIC_TOOL_TIMEOUT" }, 504);
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
  return messages.slice(-16).flatMap((message) => {
    if (!object(message)) return [];
    const content = text(message.content)?.slice(0, 1_400);
    if (!content) return [];
    return [{ role: message.direction === "assistant" ? "bia" : "cliente", content }];
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
    fatos_aprovados: cleanStringArray(knowledge.approvedFacts, 28, 550),
    historico_recente: recentConversation(context),
    visita_em_andamento: object(gatewayContext.visitState) ? gatewayContext.visitState : null,
    bloqueio_atual: object(gatewayContext.holdStatus) ? gatewayContext.holdStatus : null,
    mensagem_atual: message,
  };
}

const AGENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    tool: { type: "string", enum: ["none", "inventory", "commercial", "simulation", "media", "visit", "contact", "hold", "handoff"] },
    reply: { type: "string", maxLength: 1_200 },
    stage: { type: "string", enum: ["welcome", "discovery", "qualification", "contact", "handoff", "completed"] },
    intent: { type: "string", enum: ["unchanged", "morar", "investir", "conhecer", "unknown"] },
    summary: { type: ["string", "null"], maxLength: 900 },
  },
  required: ["tool", "reply", "stage", "intent", "summary"],
};

const RECOVERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reply: { type: "string", minLength: 1, maxLength: 1_200 },
    stage: { type: "string", enum: ["welcome", "discovery", "qualification", "contact", "handoff", "completed"] },
    intent: { type: "string", enum: ["unchanged", "morar", "investir", "conhecer", "unknown"] },
    summary: { type: ["string", "null"], maxLength: 900 },
  },
  required: ["reply", "stage", "intent", "summary"],
};

const SYSTEM_PROMPT = [
  "Você é a Bia, agente comercial digital da Évora Urbanismo. Você é uma IA conversacional completa, não um chatbot de menus.",
  "Toda mensagem do cliente chega primeiro a você. Compreenda sentido, histórico e contexto. O Enterprise/ERP é uma caixa de ferramentas usada somente para dado canônico ou ação real.",
  "A escolha padrão é tool=none. Use ferramenta apenas quando o pedido atual realmente exigir consulta ou efeito no sistema.",
  "tool=inventory: disponibilidade ou estoque real de lotes/unidades.",
  "tool=commercial: preço vigente, condição de pagamento vigente, juros, correção, entrada ou política comercial canônica.",
  "tool=simulation: cálculo ou simulação numérica exata.",
  "tool=media: fotos, vídeos, PDFs, plantas ou documentos existentes.",
  "tool=visit: iniciar, continuar, confirmar ou alterar visita/agendamento.",
  "tool=contact: registrar ou atualizar dados de contato.",
  "tool=hold: bloquear, reservar, confirmar ou consultar bloqueio de unidade.",
  "tool=handoff: pedido explícito para falar com corretor, especialista ou pessoa da equipe.",
  "NÃO use ferramenta para opinião, conversa, intenção, preferências, objeções, comparação qualitativa, horizonte de investimento, estratégia de compra, dúvidas conceituais ou perguntas exploratórias sem dado em tempo real.",
  "'Quero investir' => tool=none e resposta consultiva natural.",
  "'Estou pensando em comprar para vender daqui alguns anos. O que você acha?' => tool=none. Responda sobre horizonte, liquidez, perfil do lote, risco e critérios de decisão, sem prometer valorização ou retorno.",
  "'Qual lote está disponível agora?' => tool=inventory.",
  "'Quanto custa o SOL-C-14?' => tool=commercial.",
  "'Quero visitar amanhã às 10h' => tool=visit.",
  "Se tool=none, reply DEVE conter uma resposta completa, humana e útil. Nunca deixe reply vazio. Não ofereça menu automático.",
  "Se tool for diferente de none, deixe reply vazio; a ferramenta produzirá a resposta final com dados reais.",
  "Preserve o contexto. Não repita apresentação e não use 'não consegui confirmar esse detalhe' para uma pergunta compreensível que não dependa do ERP.",
  "Nunca invente preço, disponibilidade, metragem, prazo, condição comercial, documento ou confirmação de ação.",
  "Responda em português brasileiro natural, cordial, consultivo e comercial.",
].join("\n");

const RECOVERY_PROMPT = [
  "Você é a Bia, agente comercial digital da Évora Urbanismo.",
  "A decisão anterior classificou este turno como conversa aberta, sem necessidade de ferramenta, mas não produziu texto.",
  "Agora responda diretamente ao cliente de forma natural, útil e consultiva. Não use menu, não peça para tentar novamente e não invente dados canônicos.",
  "Se a mensagem falar de investimento ou revenda futura, discuta qualitativamente horizonte, liquidez, perfil do lote, riscos e critérios de decisão, sem prometer valorização ou rentabilidade.",
  "Faça no máximo uma pergunta útil ao final.",
].join("\n");

function outputText(payload: unknown) {
  if (!object(payload) || !Array.isArray(payload.output)) return null;
  for (const item of payload.output) {
    if (!object(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (object(content) && content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return null;
}

async function callStructuredModel(
  runtime: { apiKey: string; model: string; reasoning: string },
  context: JsonObject,
  prompt: string,
  schema: JsonObject,
  schemaName: string,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${runtime.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: runtime.model,
        reasoning: { effort: runtime.reasoning },
        input: [
          { role: "system", content: prompt },
          { role: "user", content: JSON.stringify(context) },
        ],
        text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
        max_output_tokens: 1_500,
        store: false,
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      console.error("bia-agentic-openai", { status: response.status, schemaName });
      return null;
    }
    const raw = outputText(payload);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return object(parsed) ? parsed : null;
  } catch (error) {
    console.error("bia-agentic-model", { schemaName, name: error instanceof Error ? error.name : "UnknownError" });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function runAgentTurn(runtime: { apiKey: string; model: string; reasoning: string }, context: JsonObject) {
  const decision = await callStructuredModel(runtime, context, SYSTEM_PROMPT, AGENT_SCHEMA, "bia_agent_turn");
  if (!decision) return null;
  const tool = text(decision.tool) || "none";
  if (!TOOLS.has(tool)) return null;
  return decision;
}

async function recoverConversationalReply(runtime: { apiKey: string; model: string; reasoning: string }, context: JsonObject) {
  return await callStructuredModel(runtime, context, RECOVERY_PROMPT, RECOVERY_SCHEMA, "bia_agent_reply_recovery");
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
  admin: ReturnType<typeof createClient>,
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
  const selectedUnitCode = text(profile.selected_unit_code)?.toUpperCase() || null;
  const reply = text(decision.reply)?.slice(0, 1_200);
  if (!reply) throw new GatewayError("BIA_AGENT_REPLY_EMPTY_AFTER_RECOVERY", 503);

  const response = {
    status: "completed",
    reply,
    stage,
    profile,
    contactCapture: object(gatewayContext.contactCapture) ? gatewayContext.contactCapture : {},
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
  if (!object(committed)) throw new GatewayError("BIA_AGENTIC_COMMIT_INVALID", 503);
  return committed;
}

Deno.serve(async (request: Request) => {
  try {
    if (request.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ ok: false, error: "JSON_REQUIRED" }, 415);
    if (!ingressAuthorized(request)) return json({ ok: false, error: "BIA_AGENTIC_AUTH_REQUIRED" }, 401);

    const declared = request.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) return json({ ok: false, error: "PAYLOAD_TOO_LARGE" }, 413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) return json({ ok: false, error: bytes.byteLength ? "PAYLOAD_TOO_LARGE" : "JSON_REQUIRED" }, bytes.byteLength ? 413 : 415);

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return json({ ok: false, error: "INVALID_JSON" }, 400);
    }
    if (!object(parsed)) return json({ ok: false, error: "INVALID_REQUEST" }, 400);

    if (parsed.action !== "message" || parsed.source === "audio") return await delegateToEnterprise(request, bytes, "infrastructure");

    const message = text(parsed.message);
    const clientMessageId = text(parsed.clientMessageId);
    const slug = text(parsed.slug);
    const tokenHash = text(parsed.tokenHash);
    const fingerprintHash = text(parsed.fingerprintHash);
    if (!message || message.length > 800 || !clientMessageId || !UUID.test(clientMessageId) || !slug || !tokenHash || !HASH.test(tokenHash) || !fingerprintHash || !HASH.test(fingerprintHash)) {
      return json({ ok: false, error: "BIA_AGENTIC_INPUT_INVALID" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceRole) throw new GatewayError("BIA_AGENTIC_CONFIG_INVALID", 503);
    const admin = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });

    const [gatewayContextRaw, contextRaw] = await Promise.all([
      rpc(admin, "get_public_agent_gateway_context_v1", { p_slug: slug, p_session_token_hash: tokenHash, p_fingerprint_hash: fingerprintHash }),
      rpc(admin, "get_public_agent_v3_context", { p_slug: slug, p_session_token_hash: tokenHash, p_fingerprint_hash: fingerprintHash }),
    ]);
    if (!object(contextRaw)) throw new GatewayError("BIA_AGENTIC_CONTEXT_INVALID", 503);
    const context = contextRaw;
    const gatewayContext = object(gatewayContextRaw) ? gatewayContextRaw : {};
    const organizationId = text(context.organizationId);
    if (!organizationId) throw new GatewayError("BIA_AGENTIC_CONTEXT_INVALID", 503);

    const runtimeRaw = await rpc(admin, "get_crm_ai_runtime_credentials", { p_organization_id: organizationId });
    const runtime = runtimeCredentials(runtimeRaw);
    if (!runtime) throw new GatewayError("BIA_AGENT_MODEL_UNAVAILABLE", 503);

    const contextForModel = modelContext(context, gatewayContext, message);
    let decision = await runAgentTurn(runtime, contextForModel);
    if (!decision) throw new GatewayError("BIA_AGENT_MODEL_UNAVAILABLE", 503);

    const tool = text(decision.tool) || "none";
    if (tool !== "none") return await delegateToEnterprise(request, bytes, tool);

    if (!text(decision.reply)) {
      console.warn("bia-agent-empty-reply", { clientMessageId });
      const recovered = await recoverConversationalReply(runtime, contextForModel);
      if (!recovered || !text(recovered.reply)) throw new GatewayError("BIA_AGENT_REPLY_RECOVERY_FAILED", 503);
      decision = { ...decision, ...recovered, tool: "none" };
    }

    const committed = await commitConversation(admin, parsed, context, gatewayContext, decision);
    return json({ ok: true, data: committed });
  } catch (error) {
    const code = error instanceof GatewayError ? error.code : "BIA_AGENTIC_GATEWAY_UNAVAILABLE";
    const status = error instanceof GatewayError ? error.status : 503;
    console.error("enterprise-bia-agent-gateway", { code, name: error instanceof Error ? error.name : "UnknownError" });
    return json({ ok: false, error: code }, status);
  }
});
