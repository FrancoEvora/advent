import { createClient } from "npm:@supabase/supabase-js@2";

type Obj = Record<string, unknown>;
type Reasoning = "none" | "low" | "medium" | "high" | "xhigh";
type Runtime = {
  apiKey: string;
  model: string;
  reasoning: Reasoning;
  vectorStoreId: string | null;
};
type ToolKind =
  | "inventory"
  | "commercial"
  | "simulation"
  | "media"
  | "visit"
  | "contact"
  | "hold"
  | "handoff"
  | "unsupported";
type ToolCall = {
  name: string;
  kind: ToolKind;
  callId: string;
  arguments: Obj;
  signature: string;
};
type ToolState = {
  commercial: Obj | null;
  simulation: Obj | null;
  selectedUnitCode: string | null;
  action: string;
  handoff: boolean;
  toolRounds: number;
  toolCalls: number;
};

const MAX_BYTES = 3_500_000;
const MODEL_TIMEOUT_MS = 24_000;
const INFRA_TIMEOUT_MS = 65_000;
const MAX_TOOL_ROUNDS = 3;
const MAX_EXECUTED_TOOL_CALLS = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/i;
const VECTOR_STORE = /^vs_[A-Za-z0-9_-]{6,}$/;
const UNIT_CODE = /^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$/;
const HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const TOOL_MAP: Record<string, Exclude<ToolKind, "unsupported">> = {
  consultar_estoque: "inventory",
  consultar_condicoes_comerciais: "commercial",
  simular_pagamento: "simulation",
  buscar_materiais: "media",
  agendar_visita: "visit",
  registrar_contato: "contact",
  bloquear_lote: "hold",
  transferir_especialista: "handoff",
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
const str = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const integer = (value: unknown) => {
  const parsed = num(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
};

function supabaseBase() {
  const raw = Deno.env.get("SUPABASE_URL") || "";
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new GatewayError("BIA_CONFIG_INVALID");
  return url;
}

function legacyUrl() {
  return new URL("/functions/v1/enterprise-vitoria-agent-gateway", supabaseBase());
}

function constantTimeEqual(a: string, b: string) {
  let difference = a.length ^ b.length;
  for (let index = 0; index < 512; index += 1) {
    difference |= (index < a.length ? a.charCodeAt(index) : 0)
      ^ (index < b.length ? b.charCodeAt(index) : 0);
  }
  return difference === 0;
}

function configuredPublishableKeys() {
  const raw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "";
  try {
    const parsed = JSON.parse(raw);
    if (!obj(parsed)) return [];
    return Object.values(parsed)
      .filter((value): value is string =>
        typeof value === "string"
        && value.length >= 32
        && value.length <= 512
        && !/\s/.test(value))
      .slice(0, 64);
  } catch {
    return [];
  }
}

function ingressAuthorized(request: Request) {
  const candidate = request.headers.get("apikey") || "";
  if (candidate.length < 32 || candidate.length > 512 || /\s/.test(candidate)) return false;
  let valid = 0;
  for (const key of configuredPublishableKeys()) {
    valid |= Number(constantTimeEqual(key, candidate));
  }
  return valid === 1;
}

async function rpc(admin: any, name: string, args: Obj = {}) {
  const result = await admin.rpc(name, args);
  if (result.error) {
    console.error("bia-rpc", {
      name,
      code: result.error.code,
      message: result.error.message,
    });
    throw new GatewayError(`BIA_RPC_${name}`, 503);
  }
  return result.data;
}

function runtimeCredentials(value: unknown): Runtime | null {
  if (!obj(value) || value.enabled !== true || str(value.mode) !== "autonomous") return null;
  const apiKey = str(value.api_key);
  const model = str(value.agent_model);
  const rawReasoning = str(value.agent_reasoning) || "low";
  const vectorStoreId = str(value.knowledge_vector_store_id);
  if (!apiKey || apiKey.length < 32 || /\s/.test(apiKey) || !model) return null;
  const reasoning = (["none", "low", "medium", "high", "xhigh"] as const)
    .includes(rawReasoning as Reasoning)
    ? rawReasoning as Reasoning
    : "low";
  return {
    apiKey,
    model,
    reasoning,
    vectorStoreId: vectorStoreId && VECTOR_STORE.test(vectorStoreId) ? vectorStoreId : null,
  };
}

function cleanStrings(value: unknown, limit: number, maxLength: number) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().slice(0, maxLength))
      .filter(Boolean),
  )].slice(0, limit);
}

function recent(context: Obj) {
  const messages = Array.isArray(context.messages) ? context.messages : [];
  return messages.slice(-16).flatMap((message) => {
    if (!obj(message)) return [];
    const content = str(message.content)?.slice(0, 1_200);
    return content
      ? [{ role: message.direction === "assistant" ? "assistant" : "user", content }]
      : [];
  });
}

function modelContext(context: Obj, gateway: Obj, message: string) {
  const experience = obj(context.experience) ? context.experience : {};
  const knowledge = obj(context.knowledge) ? context.knowledge : {};
  return {
    identidade: {
      nome: "Bia",
      empresa: "Futura Casa",
      papel: "Especialista imobiliária",
      parceira: "Évora Urbanismo",
      foco: "Solaris Residencial Resort",
      cidade: "Monte Carmelo/MG",
    },
    empreendimento: {
      nome: str(experience.name),
      titulo: str(experience.title),
      subtitulo: str(experience.subtitle),
    },
    etapa: str(context.stage) || "discovery",
    perfil: obj(context.profile) ? context.profile : {},
    fatos_aprovados: cleanStrings(knowledge.approvedFacts, 32, 600),
    guardrails: cleanStrings(knowledge.guardrails, 24, 600),
    historico_recente: recent(context),
    visita_em_andamento: obj(gateway.visitState) ? gateway.visitState : null,
    bloqueio_atual: obj(gateway.holdStatus) ? gateway.holdStatus : null,
    mensagem_atual: message,
  };
}

const TOOLS: any[] = [
  {
    type: "function",
    name: "consultar_estoque",
    description: "Consultar disponibilidade real, metragem e preço atual dos lotes no ERP.",
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
    description: "Consultar preço e política comercial vigente no ERP, sem calcular manualmente.",
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
    description: "Calcular uma simulação canônica no ERP. Para a menor parcela, use objective=lowest_monthly_payment, deixe requested_months nulo e não invente cálculos. Se unit_code for nulo, o sistema usa o lote disponível de menor preço.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        unit_code: { type: ["string", "null"] },
        requested_down_payment_pct: { type: ["number", "null"] },
        requested_months: { type: ["integer", "null"] },
        down_payment_installments: { type: ["integer", "null"] },
        balloon_count: { type: ["integer", "null"] },
        balloon_amount: { type: ["number", "null"] },
        objective: {
          type: "string",
          enum: ["lowest_monthly_payment", "compare_terms", "custom"],
        },
      },
      required: [
        "unit_code",
        "requested_down_payment_pct",
        "requested_months",
        "down_payment_installments",
        "balloon_count",
        "balloon_amount",
        "objective",
      ],
    },
    strict: true,
  },
  {
    type: "function",
    name: "buscar_materiais",
    description: "Consultar materiais e conhecimento aprovado disponíveis no ERP.",
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
    description: "Agendar visita somente quando houver data e hora inequívocas. requested_when deve ser ISO 8601 com fuso -03:00 quando exato.",
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
    description: "Registrar dados de contato fornecidos explicitamente pelo cliente.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: ["string", "null"] },
        phone: { type: ["string", "null"] },
        email: { type: ["string", "null"] },
        city: { type: ["string", "null"] },
      },
      required: ["name", "phone", "email", "city"],
    },
    strict: true,
  },
  {
    type: "function",
    name: "bloquear_lote",
    description: "Consultar o bloqueio atual ou iniciar o fluxo seguro de bloqueio; nunca confirmar sem retorno positivo do ERP.",
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
    description: "Solicitar atendimento humano quando o cliente pedir expressamente.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
    strict: true,
  },
];

const SYSTEM = `Você é a Bia, especialista imobiliária digital da Futura Casa, parceira da Évora Urbanismo. Neste canal, sua atuação principal é o atendimento do Solaris Residencial Resort, em Monte Carmelo/MG. Nunca se apresente como funcionária, especialista ou representante direta da Évora; explique, quando necessário, que a Futura Casa realiza o atendimento comercial em parceria com a Évora Urbanismo. Toda mensagem textual chega primeiro a você. Converse de modo natural, consultivo e contextual; não aja como chatbot de menus. Responda diretamente quando a pergunta puder ser respondida com raciocínio e fatos aprovados. Para preço, estoque, condições, simulação, visita, bloqueio ou documento, use as ferramentas do ERP e aguarde os retornos. Pode chamar mais de uma ferramenta no mesmo turno quando necessário. Para simulação, nunca faça contas por conta própria: use simular_pagamento. Quando o cliente pedir a menor parcela, use objective=lowest_monthly_payment; a ferramenta retornará os cenários válidos e você deve indicar o de menor parcela, com entrada, prazo, juros e correção. A Évora Urbanismo e seu ERP são fontes oficiais para preço, estoque, condições, propostas, visitas, bloqueios e documentos; a Futura Casa conduz o relacionamento comercial. Nunca invente preço, disponibilidade, condição, cálculo, visita, bloqueio ou documento. Nunca prometa valorização ou retorno. Preserve o contexto e não faça o cliente repetir dados. Use texto puro, sem Markdown, sem asteriscos, sem títulos com # e sem blocos de código. Para listas, use o marcador •. No máximo uma pergunta útil ao final. Português brasileiro natural e comercial.`;

function cleanReply(value: string) {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 1_200);
}

function outputText(payload: unknown) {
  if (!obj(payload) || !Array.isArray(payload.output)) return null;
  for (const item of payload.output) {
    if (!obj(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (obj(content) && content.type === "output_text" && typeof content.text === "string") {
        const reply = cleanReply(content.text);
        if (reply) return reply;
      }
    }
  }
  return null;
}

function responseOutput(payload: unknown) {
  return obj(payload) && Array.isArray(payload.output) ? payload.output : [];
}

function toolCalls(payload: unknown): ToolCall[] {
  if (!obj(payload) || !Array.isArray(payload.output)) return [];
  const calls: ToolCall[] = [];
  for (const item of payload.output) {
    if (!obj(item) || item.type !== "function_call") continue;
    const name = str(item.name) || "unsupported_tool";
    const callId = str(item.call_id);
    if (!callId) continue;
    let args: Obj = {};
    try {
      const parsed = JSON.parse(typeof item.arguments === "string" ? item.arguments : "{}");
      if (obj(parsed)) args = parsed;
    } catch {
      args = {};
    }
    calls.push({
      name,
      kind: TOOL_MAP[name] || "unsupported",
      callId,
      arguments: args,
      signature: `${name}:${JSON.stringify(args)}`,
    });
  }
  return calls;
}

function details(payload: unknown) {
  if (!obj(payload)) return { status: null, reason: null, error: null };
  return {
    status: str(payload.status),
    reason: obj(payload.incomplete_details) ? str(payload.incomplete_details.reason) : null,
    error: obj(payload.error) ? str(payload.error.code) || str(payload.error.message) : null,
  };
}

async function persistOpenAiDiagnostic(
  runtime: Runtime,
  response: Response,
  payload: unknown,
  detail: { status: string | null; reason: string | null; error: string | null },
  requestId: string | null,
) {
  try {
    const url = Deno.env.get("SUPABASE_URL") || "";
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!url || !key) return;
    const admin = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const errorObject = obj(payload) && obj(payload.error) ? payload.error : {};
    await admin.rpc("record_bia_openai_diagnostic", {
      p_organization_id: null,
      p_model: runtime.model,
      p_http_status: response.status,
      p_error_code: str(errorObject.code) || detail.reason || detail.error,
      p_error_type: str(errorObject.type),
      p_request_id: requestId,
      p_limit_requests: response.headers.get("x-ratelimit-limit-requests"),
      p_remaining_requests: response.headers.get("x-ratelimit-remaining-requests"),
      p_reset_requests: response.headers.get("x-ratelimit-reset-requests"),
      p_limit_tokens: response.headers.get("x-ratelimit-limit-tokens"),
      p_remaining_tokens: response.headers.get("x-ratelimit-remaining-tokens"),
      p_reset_tokens: response.headers.get("x-ratelimit-reset-tokens"),
    });
  } catch (error) {
    console.error("bia-openai-diagnostic-write", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

async function openai(runtime: Runtime, input: any[], tools: any[], maxOutputTokens = 900) {
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
        input,
        tools,
        tool_choice: "auto",
        max_output_tokens: maxOutputTokens,
        store: false,
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    const detail = details(payload);
    const requestId = response.headers.get("x-request-id");
    if (!response.ok || detail.status === "incomplete" || detail.status === "failed") {
      console.error("bia-openai", {
        httpStatus: response.status,
        status: detail.status,
        code: detail.reason || detail.error,
        requestId,
        limitRequests: response.headers.get("x-ratelimit-limit-requests"),
        remainingRequests: response.headers.get("x-ratelimit-remaining-requests"),
        resetRequests: response.headers.get("x-ratelimit-reset-requests"),
        limitTokens: response.headers.get("x-ratelimit-limit-tokens"),
        remainingTokens: response.headers.get("x-ratelimit-remaining-tokens"),
        resetTokens: response.headers.get("x-ratelimit-reset-tokens"),
      });
      await persistOpenAiDiagnostic(runtime, response, payload, detail, requestId);
      const suffix = String(detail.reason || detail.error || `HTTP_${response.status}`)
        .replace(/[^A-Za-z0-9_-]/g, "")
        .slice(0, 80);
      throw new GatewayError(`BIA_OPENAI_${suffix}`, response.status === 429 ? 429 : 503);
    }
    return { payload, requestId };
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new GatewayError("BIA_OPENAI_TIMEOUT", 503);
    }
    throw new GatewayError("BIA_OPENAI_NETWORK", 503);
  } finally {
    clearTimeout(timer);
  }
}

function safeFilters(args: Obj) {
  return {
    unitCode: str(args.unit_code)?.toUpperCase() || null,
    areaMin: num(args.area_min),
    areaMax: num(args.area_max),
    budgetMax: num(args.budget_max),
    limit: 6,
  };
}

function safeUnitCode(value: unknown) {
  const code = str(value)?.toUpperCase() || null;
  return code && UNIT_CODE.test(code) ? code : null;
}

function unitCodeFromRow(value: Obj) {
  return safeUnitCode(value.unitCode ?? value.unit_code);
}

function unitPriceFromRow(value: Obj) {
  const price = num(value.listPrice) ?? num(value.list_price);
  return price !== null && price > 0 ? price : Number.POSITIVE_INFINITY;
}

function cheapestUnitCode(commercial: unknown) {
  if (!obj(commercial) || !Array.isArray(commercial.units)) return null;
  const units = commercial.units.filter(obj);
  units.sort((left, right) => {
    const priceDifference = unitPriceFromRow(left) - unitPriceFromRow(right);
    if (priceDifference !== 0) return priceDifference;
    return (num(left.area) || 0) - (num(right.area) || 0);
  });
  for (const unit of units) {
    const code = unitCodeFromRow(unit);
    if (code) return code;
  }
  return null;
}

function selectedUnitFromContext(context: Obj) {
  const profile = obj(context.profile) ? context.profile : {};
  return safeUnitCode(profile.selected_unit_code ?? profile.selectedUnitCode);
}

function compactCommercial(value: unknown): Obj | null {
  if (!obj(value)) return null;
  const units = Array.isArray(value.units)
    ? value.units.filter(obj).slice(0, 6).flatMap((unit) => {
      const unitCode = unitCodeFromRow(unit);
      if (!unitCode) return [];
      return [{
        unitCode,
        area: num(unit.area),
        frontage: num(unit.frontage),
        depth: num(unit.depth),
        corner: unit.corner === true,
        topography: str(unit.topography),
        orientation: str(unit.orientation),
        listPrice: num(unit.listPrice) ?? num(unit.list_price),
        pricePerSqm: num(unit.pricePerSqm) ?? num(unit.price_per_sqm),
      }];
    })
    : [];
  return {
    realTime: value.realTime === true,
    asOf: str(value.asOf),
    project: obj(value.project) ? value.project : null,
    summary: obj(value.summary) ? value.summary : null,
    policy: obj(value.policy) ? value.policy : null,
    units,
  };
}

function toolResultOutput(value: unknown) {
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= 60_000
      ? serialized
      : JSON.stringify({ ok: false, error: "TOOL_RESULT_TOO_LARGE" });
  } catch {
    return JSON.stringify({ ok: false, error: "TOOL_RESULT_INVALID" });
  }
}

function markToolState(state: ToolState, kind: ToolKind) {
  if (kind === "inventory") state.action = "show_inventory";
  if (kind === "commercial" || kind === "simulation") state.action = "show_policy";
  if (kind === "media") state.action = "show_documents";
  if (kind === "visit") state.action = "request_visit";
  if (kind === "hold") state.action = "request_hold";
  if (kind === "handoff") state.action = "handoff";
}

async function executeTool(
  admin: any,
  tool: ToolCall,
  body: Obj,
  context: Obj,
  gateway: Obj,
  state: ToolState,
) {
  markToolState(state, tool.kind);

  if (tool.kind === "unsupported") {
    return { ok: false, error: "TOOL_NOT_SUPPORTED", tool: tool.name };
  }

  if (tool.kind === "inventory" || tool.kind === "commercial") {
    const commercial = await rpc(admin, "get_public_agent_commercial_context", {
      p_slug: body.slug,
      p_filters: safeFilters(tool.arguments),
    });
    if (obj(commercial)) state.commercial = commercial;
    state.selectedUnitCode = safeUnitCode(tool.arguments.unit_code) || state.selectedUnitCode;
    return commercial;
  }

  if (tool.kind === "simulation") {
    let unitCode = safeUnitCode(tool.arguments.unit_code)
      || state.selectedUnitCode
      || selectedUnitFromContext(context);
    let commercial = state.commercial;
    if (!commercial || !unitCode) {
      const filters = safeFilters(tool.arguments);
      commercial = await rpc(admin, "get_public_agent_commercial_context", {
        p_slug: body.slug,
        p_filters: filters,
      });
      if (obj(commercial)) state.commercial = commercial;
    }
    if (!unitCode) unitCode = cheapestUnitCode(commercial);
    if (!unitCode) {
      return {
        ok: false,
        simulated: false,
        needs: "unidade_disponivel",
        commercial: compactCommercial(commercial),
      };
    }
    state.selectedUnitCode = unitCode;
    const simulation = await rpc(admin, "calculate_public_agent_payment_simulation_v4", {
      p_slug: body.slug,
      p_session_token_hash: body.tokenHash,
      p_fingerprint_hash: body.fingerprintHash,
      p_unit_code: unitCode,
      p_requested_down_payment_pct: num(tool.arguments.requested_down_payment_pct),
      p_requested_months: integer(tool.arguments.requested_months),
      p_down_payment_installments: integer(tool.arguments.down_payment_installments) || 1,
      p_balloon_count: integer(tool.arguments.balloon_count) || 0,
      p_balloon_amount: num(tool.arguments.balloon_amount) || 0,
    });
    if (obj(simulation)) state.simulation = simulation;
    return {
      ok: true,
      objective: str(tool.arguments.objective) || "custom",
      simulation,
    };
  }

  if (tool.kind === "media") {
    const knowledge = obj(context.knowledge) ? context.knowledge : {};
    return {
      approvedFacts: cleanStrings(knowledge.approvedFacts, 32, 600),
      query: str(tool.arguments.query),
    };
  }

  if (tool.kind === "visit") {
    const requestedWhen = str(tool.arguments.requested_when);
    const unitCode = safeUnitCode(tool.arguments.unit_code);
    if (!requestedWhen) return { scheduled: false, needs: "data_e_horario" };
    const date = new Date(requestedWhen);
    if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now() + 15 * 60_000) {
      return { scheduled: false, needs: "data_e_horario_valido" };
    }
    if (gateway.serviceConsented !== true) {
      return {
        scheduled: false,
        needs: "consentimento_e_contato",
        contact: obj(gateway.contactCapture) ? gateway.contactCapture : {},
      };
    }
    try {
      return await rpc(admin, "schedule_public_agent_visit_v1", {
        p_slug: body.slug,
        p_session_token_hash: body.tokenHash,
        p_fingerprint_hash: body.fingerprintHash,
        p_client_action_id: body.clientMessageId,
        p_scheduled_at: date.toISOString(),
        p_unit_code: unitCode,
      });
    } catch {
      return { scheduled: false, needs: "validacao_do_erp" };
    }
  }

  if (tool.kind === "contact") {
    const patch = {
      name: str(tool.arguments.name),
      phone: str(tool.arguments.phone),
      email: str(tool.arguments.email),
      city: str(tool.arguments.city),
    };
    return await rpc(admin, "update_public_agent_contact_capture_v3", {
      p_slug: body.slug,
      p_session_token_hash: body.tokenHash,
      p_fingerprint_hash: body.fingerprintHash,
      p_patch: patch,
      p_service_consent: null,
      p_marketing_consent: null,
      p_consent_copy_version: null,
    });
  }

  if (tool.kind === "hold") {
    const status = await rpc(admin, "get_public_agent_hold_status", {
      p_slug: body.slug,
      p_session_token_hash: body.tokenHash,
      p_fingerprint_hash: body.fingerprintHash,
    });
    return {
      requestedUnit: safeUnitCode(tool.arguments.unit_code),
      status,
      actionExecuted: false,
      reason: "bloqueio_exige_fluxo_transacional_confirmado",
    };
  }

  state.handoff = true;
  return { handoffRequested: true };
}

function mergeProfile(current: unknown, message: string) {
  const profile: Obj = obj(current) ? { ...current } : {};
  if (/\binvest(?:ir|imento|idor|idora|indo)\b/i.test(message)) profile.intent = "investir";
  else if (/\bmor(?:ar|adia|ando)\b/i.test(message)) profile.intent = "morar";
  return profile;
}

async function commit(
  admin: any,
  body: Obj,
  context: Obj,
  gateway: Obj,
  reply: string,
  requestId: string | null,
  state: ToolState,
) {
  const message = str(body.message) || "";
  const profile = mergeProfile(context.profile, message);
  const stage = (str(context.stage) || "discovery") === "welcome"
    ? "discovery"
    : str(context.stage) || "discovery";
  const selectedUnitCode = state.selectedUnitCode
    || safeUnitCode(profile.selected_unit_code ?? profile.selectedUnitCode);
  if (selectedUnitCode) profile.selected_unit_code = selectedUnitCode;
  const response = {
    status: "completed",
    reply: cleanReply(reply),
    stage,
    profile,
    contactCapture: obj(gateway.contactCapture) ? gateway.contactCapture : {},
    serviceConsented: gateway.serviceConsented === true,
    marketingConsented: gateway.marketingConsented === true,
    requestContact: false,
    handoffRequested: state.handoff,
    quickReplies: [],
    action: state.action,
    selectedUnitCode,
    commercial: compactCommercial(state.commercial),
    simulation: state.simulation,
    attachments: [],
    holdStatus: obj(gateway.holdStatus) ? gateway.holdStatus : null,
    converted: gateway.converted === true,
    leadProtocol: str(gateway.leadProtocol),
    degraded: false,
    metadata: {
      runtime_contract: "bia-ai-first-v4",
      openai_request_id: requestId,
      ai_first: true,
      legacy_conversation_pipeline: false,
      tool_rounds: state.toolRounds,
      tool_calls: state.toolCalls,
    },
  };
  const saved = await rpc(admin, "commit_public_agent_gateway_turn_v1", {
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
  if (!obj(saved)) throw new GatewayError("BIA_COMMIT_INVALID");
  return saved;
}

async function delegateInfrastructure(request: Request, bytes: Uint8Array) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INFRA_TIMEOUT_MS);
  try {
    const response = await fetch(legacyUrl(), {
      method: "POST",
      headers: {
        apikey: request.headers.get("apikey") || "",
        "content-type": "application/json",
      },
      body: new TextDecoder().decode(bytes),
      signal: controller.signal,
    });
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: {
        ...HEADERS,
        "content-type": response.headers.get("content-type") || HEADERS["content-type"],
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function localRateLimitFallback(message: string) {
  const normalized = message
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[.!?]+$/g, "");
  if (!/^(oi|ola|bom dia|boa tarde|boa noite|tudo bem|oi bia|ola bia)$/.test(normalized)) {
    return null;
  }
  if (normalized.includes("bom dia")) {
    return "Bom dia! 😊 Sou a Bia, especialista da Futura Casa. Como posso te ajudar com o Solaris Residencial Resort?";
  }
  if (normalized.includes("boa tarde")) {
    return "Boa tarde! 😊 Sou a Bia, especialista da Futura Casa. Como posso te ajudar com o Solaris Residencial Resort?";
  }
  if (normalized.includes("boa noite")) {
    return "Boa noite! 😊 Sou a Bia, especialista da Futura Casa. Como posso te ajudar com o Solaris Residencial Resort?";
  }
  return "Oi! 😊 Tudo bem? Sou a Bia, especialista da Futura Casa. Como posso te ajudar com o Solaris Residencial Resort?";
}

async function directExperience(admin: any, body: Obj) {
  const slug = str(body.slug);
  if (!slug) return json({ ok: false, error: "BIA_INPUT_INVALID" }, 400);
  const data = await rpc(admin, "get_public_agent_experience", { p_slug: slug });
  return json({ ok: true, data });
}

async function directSession(admin: any, body: Obj) {
  const slug = str(body.slug);
  const token = str(body.tokenHash);
  const fingerprint = str(body.fingerprintHash);
  if (!slug || !token || !HASH.test(token) || !fingerprint || !HASH.test(fingerprint)) {
    return json({ ok: false, error: "BIA_INPUT_INVALID" }, 400);
  }
  const data = await rpc(admin, "open_public_agent_session_v4", {
    p_slug: slug,
    p_session_token_hash: token,
    p_fingerprint_hash: fingerprint,
    p_utm: obj(body.attribution) ? body.attribution : {},
    p_landing_page: str(body.landingPage),
    p_referrer: str(body.referrer),
    p_user_agent: str(body.userAgent),
  });
  return json({ ok: true, data });
}

Deno.serve(async (request: Request) => {
  try {
    if (request.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return json({ ok: false, error: "JSON_REQUIRED" }, 415);
    }
    if (!ingressAuthorized(request)) return json({ ok: false, error: "BIA_AUTH_REQUIRED" }, 401);

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) {
      return json({ ok: false, error: "PAYLOAD_INVALID" }, 413);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return json({ ok: false, error: "INVALID_JSON" }, 400);
    }
    if (!obj(parsed)) return json({ ok: false, error: "INVALID_REQUEST" }, 400);

    const url = Deno.env.get("SUPABASE_URL") || "";
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!url || !key) throw new GatewayError("BIA_CONFIG_INVALID");
    const admin = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    if (parsed.action === "experience") return await directExperience(admin, parsed);
    if (parsed.action === "session") return await directSession(admin, parsed);
    if (parsed.action !== "message" || parsed.source === "audio") {
      return await delegateInfrastructure(request, bytes);
    }

    const message = str(parsed.message);
    const clientMessageId = str(parsed.clientMessageId);
    const slug = str(parsed.slug);
    const token = str(parsed.tokenHash);
    const fingerprint = str(parsed.fingerprintHash);
    if (
      !message
      || message.length > 1_100
      || !clientMessageId
      || !UUID.test(clientMessageId)
      || !slug
      || !token
      || !HASH.test(token)
      || !fingerprint
      || !HASH.test(fingerprint)
    ) {
      return json({ ok: false, error: "BIA_INPUT_INVALID" }, 400);
    }

    const [gatewayRaw, contextRaw] = await Promise.all([
      rpc(admin, "get_public_agent_gateway_context_v1", {
        p_slug: slug,
        p_session_token_hash: token,
        p_fingerprint_hash: fingerprint,
      }),
      rpc(admin, "get_public_agent_v3_context", {
        p_slug: slug,
        p_session_token_hash: token,
        p_fingerprint_hash: fingerprint,
      }),
    ]);
    if (!obj(contextRaw)) throw new GatewayError("BIA_CONTEXT_INVALID");
    const context = contextRaw;
    const gateway = obj(gatewayRaw) ? gatewayRaw : {};
    const organizationId = str(context.organizationId);
    if (!organizationId) throw new GatewayError("BIA_CONTEXT_INVALID");

    const runtime = runtimeCredentials(await rpc(admin, "get_crm_ai_runtime_credentials", {
      p_organization_id: organizationId,
    }));
    if (!runtime) throw new GatewayError("BIA_MODEL_UNAVAILABLE");

    const tools: any[] = [...TOOLS];
    if (runtime.vectorStoreId) {
      tools.push({
        type: "file_search",
        vector_store_ids: [runtime.vectorStoreId],
        max_num_results: 5,
      });
    }

    let input: any[] = [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify(modelContext(context, gateway, message)) },
    ];
    const state: ToolState = {
      commercial: null,
      simulation: null,
      selectedUnitCode: selectedUnitFromContext(context),
      action: "none",
      handoff: false,
      toolRounds: 0,
      toolCalls: 0,
    };
    const resultCache = new Map<string, unknown>();

    let current;
    try {
      current = await openai(runtime, input, tools, 900);
    } catch (error) {
      if (error instanceof GatewayError && error.status === 429) {
        const fallback = localRateLimitFallback(message);
        if (fallback) {
          const saved = await commit(admin, parsed, context, gateway, fallback, null, state);
          return json({ ok: true, data: saved });
        }
      }
      throw error;
    }

    let requestId = current.requestId;
    let reply = outputText(current.payload);

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const calls = toolCalls(current.payload);
      if (!calls.length) break;
      state.toolRounds += 1;

      const outputs: Obj[] = [];
      for (const call of calls) {
        state.toolCalls += 1;
        let result: unknown;
        if (resultCache.has(call.signature)) {
          result = resultCache.get(call.signature);
        } else if (state.toolCalls > MAX_EXECUTED_TOOL_CALLS) {
          result = { ok: false, error: "TOOL_CALL_LIMIT_REACHED" };
        } else {
          try {
            result = await executeTool(admin, call, parsed, context, gateway, state);
          } catch (error) {
            const code = error instanceof GatewayError ? error.code : "TOOL_EXECUTION_FAILED";
            console.error("bia-tool", { tool: call.name, code });
            result = { ok: false, error: code };
          }
          resultCache.set(call.signature, result);
        }
        outputs.push({
          type: "function_call_output",
          call_id: call.callId,
          output: toolResultOutput(result),
        });
      }

      input = [
        ...input,
        ...responseOutput(current.payload),
        ...outputs,
      ];
      current = await openai(runtime, input, tools, round === 0 ? 800 : 700);
      requestId = current.requestId || requestId;
      reply = outputText(current.payload) || reply;
    }

    if (toolCalls(current.payload).length) {
      throw new GatewayError("BIA_TOOL_ROUND_LIMIT", 503);
    }
    if (!reply) throw new GatewayError("BIA_EMPTY_OUTPUT");

    const saved = await commit(admin, parsed, context, gateway, reply, requestId, state);
    return json({ ok: true, data: saved });
  } catch (error) {
    const code = error instanceof GatewayError ? error.code : "BIA_UNAVAILABLE";
    const status = error instanceof GatewayError ? error.status : 503;
    console.error("enterprise-bia-agent-gateway", {
      code,
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return json({ ok: false, error: code }, status);
  }
});
