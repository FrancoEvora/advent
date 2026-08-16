import { createClient } from "npm:@supabase/supabase-js@2";

import { generateSupervisedReply } from "./openai.ts";
import type { AgentAction, Filters, GeneratedReply, JsonObject, ResponseCard, Runtime } from "./types.ts";
import {
  AgentError,
  brl,
  contactComplete,
  dbFilters,
  filtersFromProfile,
  mergedProfile,
  normalizeBrazilianPhone,
  object,
  parseRuntime,
  ptNumber,
  safeAction,
  safeFilters,
  safeHash,
  safeMessage,
  safeObject,
  safeProfile,
  safeSimulation,
  safeSlug,
  safeUnitCode,
  text,
} from "./utils.ts";

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const MAX_BYTES = 3 * 1024 * 1024;
const INTERNAL_TIMEOUT_MS = 75_000;
const AUDIO_MIMES = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "video/webm",
]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: HEADERS });

function bearer(request: Request): string {
  return /^Bearer\s+([^\s]{32,512})$/i.exec(request.headers.get("authorization") || "")?.[1] || "";
}

function requestUrl(request: Request): string {
  const url = new URL(request.url);
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function rpc(admin: ReturnType<typeof createClient>, name: string, params: JsonObject = {}) {
  const result = await admin.rpc(name, params);
  if (result.error) {
    const message = String(result.error.message || "").toUpperCase();
    if (message.includes("NOT_FOUND")) throw new AgentError("PUBLIC_AGENT_NOT_FOUND", 404);
    if (message.includes("RATE_LIMIT") || message.includes("VOICE_LIMIT") || message.includes("IMAGE_LIMIT")) {
      throw new AgentError("PUBLIC_AGENT_RATE_LIMIT", 429);
    }
    if (message.includes("INACTIVE") || message.includes("UNAVAILABLE") || message.includes("NOT_ACTIVE")) {
      throw new AgentError("PUBLIC_AGENT_CONFLICT", 409);
    }
    if (message.includes("CONTACT_REQUIRED")) throw new AgentError("PUBLIC_AGENT_CONTACT_REQUIRED", 409);
    if (message.includes("CONSENT_REQUIRED")) throw new AgentError("PUBLIC_AGENT_CONSENT_REQUIRED", 400);
    if (
      message.includes("INPUT_INVALID") ||
      message.includes("EMAIL_INVALID") ||
      message.includes("UNIT_CODE_INVALID") ||
      message.includes("FILTER_INVALID") ||
      message.includes("CONTACT_INVALID")
    ) {
      throw new AgentError("PUBLIC_AGENT_INPUT_INVALID", 400);
    }
    if (message.includes("FORBIDDEN") || message.includes("AUTH_REQUIRED")) {
      throw new AgentError("PUBLIC_AGENT_FORBIDDEN", 403);
    }
    console.error("enterprise-vitoria-agent rpc", { name, code: result.error.code });
    throw new AgentError("PUBLIC_AGENT_DATABASE_UNAVAILABLE", 503);
  }
  return result.data;
}

function unit(raw: unknown): JsonObject | null {
  if (!object(raw)) return null;
  const code = safeUnitCode(raw.unitCode ?? raw.unit_code);
  if (!code) return null;
  return {
    unitCode: code,
    blockCode: text(raw.blockCode ?? raw.block_code),
    lotNumber: text(raw.lotNumber ?? raw.lot_number),
    area: typeof raw.area === "number" ? raw.area : Number(raw.area) || null,
    frontage: typeof raw.frontage === "number" ? raw.frontage : Number(raw.frontage) || null,
    depth: typeof raw.depth === "number" ? raw.depth : Number(raw.depth) || null,
    corner: raw.corner === true,
    topography: text(raw.topography),
    orientation: text(raw.orientation),
    listPrice: typeof (raw.listPrice ?? raw.list_price) === "number"
      ? (raw.listPrice ?? raw.list_price)
      : Number(raw.listPrice ?? raw.list_price) || null,
    pricePerSqm: typeof (raw.pricePerSqm ?? raw.price_per_sqm) === "number"
      ? (raw.pricePerSqm ?? raw.price_per_sqm)
      : Number(raw.pricePerSqm ?? raw.price_per_sqm) || null,
    updatedAt: text(raw.updatedAt ?? raw.updated_at),
  };
}

function normalizeCommercial(raw: unknown): JsonObject {
  if (!object(raw)) return {};
  const units = Array.isArray(raw.units)
    ? raw.units.map(unit).filter((value): value is JsonObject => value !== null).slice(0, 24)
    : [];
  return {
    realTime: raw.realTime === true,
    asOf: text(raw.asOf),
    project: object(raw.project) ? raw.project : {},
    summary: object(raw.summary) ? raw.summary : {},
    policy: object(raw.policy) ? raw.policy : null,
    units,
  };
}

async function commercial(admin: ReturnType<typeof createClient>, slug: string, filters: Filters) {
  return normalizeCommercial(
    await rpc(admin, "get_public_agent_commercial_context", {
      p_slug: slug,
      p_filters: dbFilters(filters),
    }),
  );
}

function findUnit(commercialData: JsonObject, code: string | null): JsonObject | null {
  if (!code || !Array.isArray(commercialData.units)) return null;
  return (commercialData.units.find((candidate) => object(candidate) && candidate.unitCode === code) as JsonObject | undefined) || null;
}

function inventoryReply(commercialData: JsonObject, selectedCode: string | null): string {
  const units = Array.isArray(commercialData.units) ? commercialData.units.filter(object) : [];
  const summary = object(commercialData.summary) ? commercialData.summary : {};
  const exact = findUnit(commercialData, selectedCode);
  if (exact) {
    return `Consultei o estoque agora: o lote ${String(exact.unitCode)} aparece disponível, com ${ptNumber(exact.area)} m² e valor de tabela de ${brl(exact.listPrice)}. Posso explicar as condições ou solicitar um bloqueio temporário sujeito à aprovação da Évora.`;
  }
  if (!units.length) {
    return "Não encontrei uma unidade disponível com esses critérios na consulta atual. Posso ajustar a metragem ou a faixa de investimento e verificar novamente em tempo real.";
  }
  const options = units
    .slice(0, 3)
    .map((candidate) => `${String(candidate.unitCode)} · ${ptNumber(candidate.area)} m² · ${brl(candidate.listPrice)}`)
    .join("; ");
  const count = Number(summary.availableCount || 0);
  return `${count > 0 ? `A consulta atual mostra ${count} lotes disponíveis.` : "Encontrei opções disponíveis."} Algumas alternativas: ${options}. Quer filtrar por metragem, valor ou posição do lote?`;
}

function policyReply(commercialData: JsonObject): string {
  const policy = object(commercialData.policy) ? commercialData.policy : null;
  if (!policy) {
    return "As condições comerciais não estão disponíveis para confirmação automática neste momento. Posso registrar seu interesse para um especialista validar a tabela vigente.";
  }
  const pieces: string[] = [];
  if (typeof policy.minimumDownPaymentPct === "number") pieces.push(`entrada mínima de ${ptNumber(policy.minimumDownPaymentPct)}%`);
  if (typeof policy.maximumInstallments === "number") pieces.push(`prazo de até ${Math.round(policy.maximumInstallments)} parcelas`);
  if (typeof policy.monthlyInterestRate === "number") pieces.push(`juros mensais de ${ptNumber(policy.monthlyInterestRate)}%`);
  if (text(policy.indexer)) pieces.push(`correção por ${text(policy.indexer)}`);
  const disclaimer = object(policy.parameters) && text(policy.parameters.disclaimer)
    ? text(policy.parameters.disclaimer)
    : "Condições sujeitas à disponibilidade, análise e aprovação administrativa.";
  return `${text(policy.description) || "A política comercial vigente foi localizada."}${pieces.length ? ` Ela prevê ${pieces.join(", ")}.` : ""} ${disclaimer}`;
}

function enterpriseReply(enterprise: JsonObject): string {
  const organization = object(enterprise.organization) ? enterprise.organization : {};
  const projects = Array.isArray(enterprise.projects) ? enterprise.projects.filter(object) : [];
  const names = projects.slice(0, 5).map((project) => String(project.name || "")).filter(Boolean);
  return `${text(organization.tradeName) || text(organization.name) || "A Évora Urbanismo"} estrutura empreendimentos e soluções urbanísticas com inteligência comercial integrada. ${names.length ? `Na base atual constam ${names.join(", ")}.` : ""} Posso aprofundar o Solaris ou outro projeto específico.`;
}

async function sharedResources(
  admin: ReturnType<typeof createClient>,
  slug: string,
): Promise<Array<JsonObject>> {
  const raw = await rpc(admin, "list_public_agent_shared_resources", { p_slug: slug, p_limit: 10 });
  const resources = Array.isArray(raw) ? raw.filter(object) : [];
  const signed: Array<JsonObject> = [];
  for (const resource of resources) {
    const path = text(resource.storagePath);
    if (!path) continue;
    const signedResult = await admin.storage.from("vitoria-knowledge").createSignedUrl(path, 60 * 60);
    if (signedResult.error || !signedResult.data?.signedUrl) continue;
    signed.push({
      id: resource.id,
      title: resource.title,
      description: resource.description,
      category: resource.category,
      filename: resource.originalFilename,
      mimeType: resource.mimeType,
      bytes: resource.bytes,
      url: signedResult.data.signedUrl,
      expiresIn: 3600,
    });
  }
  return signed;
}

function resourcesReply(resources: Array<JsonObject>): string {
  if (!resources.length) {
    return "Ainda não há um material público adequado para esta solicitação. Posso explicar por aqui ou pedir que a equipe envie o documento correto.";
  }
  const names = resources.slice(0, 4).map((resource) => String(resource.title || "material")).join(", ");
  return `Separei materiais autorizados pela Évora: ${names}. Eles aparecem logo abaixo e os links são temporários por segurança.`;
}

async function holdStatus(
  admin: ReturnType<typeof createClient>,
  slug: string,
  tokenHash: string,
  fingerprintHash: string,
): Promise<JsonObject> {
  const raw = await rpc(admin, "get_public_agent_hold_status", {
    p_slug: slug,
    p_session_token_hash: tokenHash,
    p_fingerprint_hash: fingerprintHash,
  });
  return object(raw) ? raw : {};
}

function holdStatusReply(status: JsonObject): string {
  if (status.hasHold !== true) return "Não há solicitação de bloqueio vinculada a esta conversa.";
  const unitData = object(status.unit) ? status.unit : {};
  const code = text(unitData.unitCode ?? unitData.unit_code) || "lote selecionado";
  const protocol = text(status.protocol) || "sem protocolo";
  const approval = String(status.approvalStatus || "pending");
  const state = String(status.status || "ativa");
  if (state === "expirada") return `A solicitação ${protocol}, referente ao ${code}, expirou. Posso verificar se o lote voltou a ficar disponível.`;
  if (state === "cancelada" || approval === "rejected") return `A solicitação ${protocol}, referente ao ${code}, não foi aprovada e o bloqueio foi liberado.`;
  if (approval === "approved") return `A solicitação ${protocol}, referente ao ${code}, foi aprovada. A equipe comercial seguirá com os próximos passos dentro do prazo do bloqueio.`;
  return `A solicitação ${protocol}, referente ao ${code}, está bloqueada temporariamente e aguarda aprovação administrativa.`;
}

function latestAssistant(context: JsonObject): string {
  const messages = Array.isArray(context.messages) ? context.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (object(message) && message.direction === "assistant") return String(message.content || "");
  }
  return "";
}

function fallbackReply(context: JsonObject, message: string): GeneratedReply {
  const profile = safeProfile(context.profile);
  const lower = message.toLocaleLowerCase("pt-BR");
  let action: AgentAction = "none";
  if (/documento|material|apresentação|apresentacao|folder|catálogo|catalogo|planta/.test(lower)) action = "show_resources";
  else if (/condiç|pagamento|entrada|parcela|juros|ipca|balão/.test(lower)) action = "show_policy";
  else if (/status|protocolo|meu bloqueio|minha reserva/.test(lower)) action = "hold_status";
  else if (/bloque|reserv/.test(lower)) action = "request_hold";
  else if (/imagem|simulação de casa|simulacao de casa|fachada|casa no lote/.test(lower)) action = "generate_home_simulation";
  else if (/lote|terreno|dispon|valor|preço|metragem|m²|m2/.test(lower)) action = "show_inventory";
  else if (/évora|evora|empreendimento|empresa/.test(lower)) action = "show_enterprise";
  return {
    reply: "Posso continuar com segurança usando os dados atuais da Évora. Vou consultar a base e te mostrar a informação correta.",
    stage: "discovery",
    profile,
    contactPatch: {},
    serviceConsent: null,
    marketingConsent: null,
    requestContact: false,
    handoffRequested: false,
    quickReplies: [],
    action,
    selectedUnitCode: safeUnitCode(message.match(/\b[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+\b/i)?.[0]) || profile.selected_unit_code || null,
    filters: filtersFromProfile(profile, message),
    simulation: safeSimulation({ explicit_confirmation: /sim|pode gerar|gere|quero gerar/.test(lower) }),
    factsUsed: [],
    riskFlags: ["model_unavailable"],
    agentResponseId: null,
    supervisorResponseId: null,
    supervisorDecision: "block",
    fileSearchUsed: false,
  };
}

function imagePrompt(input: {
  simulation: ReturnType<typeof safeSimulation>;
  selectedUnit: JsonObject | null;
  profile: ReturnType<typeof safeProfile>;
  enterprise: JsonObject;
}): string {
  const spec = input.simulation;
  const unitData = input.selectedUnit;
  const lot = unitData
    ? `lote ${String(unitData.unitCode)}, área aproximada de ${ptNumber(unitData.area)} m², frente de ${ptNumber(unitData.frontage)} m e profundidade de ${ptNumber(unitData.depth)} m`
    : `lote residencial com área aproximada de ${ptNumber(input.profile.preferred_area_min || 450)} m²`;
  const organization = object(input.enterprise.organization) ? input.enterprise.organization : {};
  return [
    `Crie uma visualização arquitetônica fotorrealista e elegante para estudo conceitual de uma residência no ${lot}.`,
    `Estilo: ${spec.style || "contemporâneo brasileiro, sofisticado e integrado à natureza"}.`,
    `${spec.floors || 1} pavimento(s), ${spec.bedrooms || 3} dormitórios, ${spec.suites || 1} suíte(s), ${spec.garage_spaces || 2} vaga(s) de garagem${spec.pool ? ", piscina integrada ao jardim" : ""}.`,
    spec.notes ? `Preferências adicionais: ${spec.notes}.` : "",
    "Mostre implantação plausível, paisagismo do Cerrado, materiais naturais, iluminação de fim de tarde e linguagem visual premium.",
    "Não inclua textos, logotipos, pessoas identificáveis, cercas que não façam parte do conceito ou elementos urbanos irreais.",
    `A imagem é uma simulação conceitual para ${text(organization.tradeName) || "Évora Urbanismo"}, não um projeto executivo e não deve afirmar aprovação arquitetônica, legal ou construtiva.`,
  ].filter(Boolean).join(" ");
}

async function generateSimulation(input: {
  admin: ReturnType<typeof createClient>;
  runtime: Runtime;
  slug: string;
  tokenHash: string;
  fingerprintHash: string;
  simulation: ReturnType<typeof safeSimulation>;
  selectedUnit: JsonObject | null;
  profile: ReturnType<typeof safeProfile>;
  enterprise: JsonObject;
}): Promise<{ card: ResponseCard; reply: string }> {
  await rpc(input.admin, "consume_public_agent_image_quota", {
    p_slug: input.slug,
    p_session_token_hash: input.tokenHash,
    p_fingerprint_hash: input.fingerprintHash,
  });
  const prompt = imagePrompt(input);
  const assetId = crypto.randomUUID();
  await rpc(input.admin, "register_public_agent_generated_asset", {
    p_slug: input.slug,
    p_session_token_hash: input.tokenHash,
    p_fingerprint_hash: input.fingerprintHash,
    p_asset_id: assetId,
    p_title: "Estudo conceitual de residência",
    p_prompt: prompt,
    p_storage_bucket: null,
    p_storage_path: null,
    p_mime_type: null,
    p_status: "processing",
    p_error_message: null,
    p_metadata: { selected_unit_code: input.selectedUnit?.unitCode || null },
  });

  try {
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.runtime.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt,
        size: "1536x1024",
        quality: "medium",
        output_format: "png",
        n: 1,
      }),
    });
    const payload = await response.json().catch(() => null) as JsonObject | null;
    const first = payload && Array.isArray(payload.data) && object(payload.data[0]) ? payload.data[0] : null;
    const encoded = first && text(first.b64_json);
    if (!response.ok || !encoded) throw new AgentError("PUBLIC_AGENT_IMAGE_GENERATION_FAILED", 503);

    const binary = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const path = `${input.slug}/${new Date().toISOString().slice(0, 10)}/${assetId}.png`;
    const upload = await input.admin.storage.from("vitoria-simulations").upload(path, binary, {
      contentType: "image/png",
      cacheControl: "3600",
      upsert: false,
    });
    if (upload.error) throw new AgentError("PUBLIC_AGENT_IMAGE_STORAGE_FAILED", 503);
    const signed = await input.admin.storage.from("vitoria-simulations").createSignedUrl(path, 60 * 60 * 2);
    if (signed.error || !signed.data?.signedUrl) throw new AgentError("PUBLIC_AGENT_IMAGE_SIGN_FAILED", 503);

    await rpc(input.admin, "register_public_agent_generated_asset", {
      p_slug: input.slug,
      p_session_token_hash: input.tokenHash,
      p_fingerprint_hash: input.fingerprintHash,
      p_asset_id: assetId,
      p_title: "Estudo conceitual de residência",
      p_prompt: prompt,
      p_storage_bucket: "vitoria-simulations",
      p_storage_path: path,
      p_mime_type: "image/png",
      p_status: "completed",
      p_error_message: null,
      p_metadata: {
        selected_unit_code: input.selectedUnit?.unitCode || null,
        model: "gpt-image-1",
        conceptual_only: true,
      },
    });

    return {
      reply: "Preparei um estudo visual conceitual com as preferências informadas. Ele serve para imaginar possibilidades e não substitui projeto arquitetônico, análise de recuos, aprovação do condomínio ou licenciamento.",
      card: {
        type: "simulation",
        title: "Estudo conceitual de residência",
        imageUrl: signed.data.signedUrl,
        caption: "Simulação conceitual gerada por IA · não constitui projeto executivo ou aprovação construtiva.",
        assetId,
      },
    };
  } catch (error) {
    await rpc(input.admin, "register_public_agent_generated_asset", {
      p_slug: input.slug,
      p_session_token_hash: input.tokenHash,
      p_fingerprint_hash: input.fingerprintHash,
      p_asset_id: assetId,
      p_title: "Estudo conceitual de residência",
      p_prompt: prompt,
      p_storage_bucket: null,
      p_storage_path: null,
      p_mime_type: null,
      p_status: "failed",
      p_error_message: error instanceof Error ? error.message : "generation_failed",
      p_metadata: { selected_unit_code: input.selectedUnit?.unitCode || null },
    }).catch(() => undefined);
    throw error;
  }
}

async function transcribe(input: {
  admin: ReturnType<typeof createClient>;
  runtime: Runtime;
  slug: string;
  tokenHash: string;
  fingerprintHash: string;
  audioBase64: string;
  mimeType: string;
}): Promise<string> {
  await rpc(input.admin, "get_public_agent_v3_context", {
    p_slug: input.slug,
    p_session_token_hash: input.tokenHash,
    p_fingerprint_hash: input.fingerprintHash,
  });
  await rpc(input.admin, "consume_public_agent_voice_quota", {
    p_slug: input.slug,
    p_session_token_hash: input.tokenHash,
    p_fingerprint_hash: input.fingerprintHash,
  });
  if (!AUDIO_MIMES.has(input.mimeType)) throw new AgentError("PUBLIC_AGENT_AUDIO_TYPE_INVALID", 400);
  if (!/^[A-Za-z0-9+/=]+$/.test(input.audioBase64) || input.audioBase64.length > 2_700_000) {
    throw new AgentError("PUBLIC_AGENT_AUDIO_INVALID", 400);
  }
  const bytes = Uint8Array.from(atob(input.audioBase64), (character) => character.charCodeAt(0));
  if (bytes.byteLength < 500 || bytes.byteLength > 2_000_000) throw new AgentError("PUBLIC_AGENT_AUDIO_INVALID", 400);
  const extension = input.mimeType.includes("mp4") ? "m4a" : input.mimeType.includes("mpeg") ? "mp3" : input.mimeType.includes("wav") ? "wav" : input.mimeType.includes("ogg") ? "ogg" : "webm";
  const form = new FormData();
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("language", "pt");
  form.append("prompt", "Atendimento imobiliário da Évora Urbanismo e do Solaris Residencial, em português do Brasil.");
  form.append("file", new Blob([bytes], { type: input.mimeType }), `audio.${extension}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${input.runtime.apiKey}` },
      body: form,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as JsonObject | null;
    const transcript = payload && text(payload.text);
    if (!response.ok || !transcript) throw new AgentError("PUBLIC_AGENT_TRANSCRIPTION_FAILED", 503);
    return transcript.slice(0, 1200);
  } finally {
    clearTimeout(timer);
  }
}

async function runtime(admin: ReturnType<typeof createClient>, organizationId: string): Promise<Runtime> {
  const result = await admin.rpc("get_crm_ai_runtime_credentials", { p_organization_id: organizationId });
  if (result.error) throw new AgentError("PUBLIC_AGENT_RUNTIME_LOOKUP_FAILED", 503);
  const parsed = parseRuntime(result.data);
  if (!parsed) throw new AgentError("PUBLIC_AGENT_RUNTIME_DISABLED", 503);
  return parsed;
}

async function handleMessage(input: {
  admin: ReturnType<typeof createClient>;
  slug: string;
  tokenHash: string;
  fingerprintHash: string;
  userMessage: string;
}) {
  const context = await rpc(input.admin, "get_public_agent_v3_context", {
    p_slug: input.slug,
    p_session_token_hash: input.tokenHash,
    p_fingerprint_hash: input.fingerprintHash,
  }) as JsonObject;
  const enterprise = await rpc(input.admin, "get_public_agent_enterprise_context", { p_slug: input.slug }) as JsonObject;
  const profile = safeProfile(context.profile);
  const initialFilters = filtersFromProfile(profile, input.userMessage);
  let commercialData = await commercial(input.admin, input.slug, initialFilters);
  const resourcesMeta = await rpc(input.admin, "list_public_agent_shared_resources", { p_slug: input.slug, p_limit: 10 });
  const resources = Array.isArray(resourcesMeta) ? resourcesMeta : [];
  const aiRuntime = await runtime(input.admin, String(context.organizationId || ""));

  let generated: GeneratedReply;
  let degraded = false;
  try {
    generated = await generateSupervisedReply({
      runtime: aiRuntime,
      context,
      enterprise,
      commercial: commercialData,
      resources,
      userMessage: input.userMessage,
      filters: initialFilters,
      vectorStoreId: text(context.vectorStoreId),
    });
  } catch (error) {
    degraded = true;
    console.error("enterprise-vitoria-agent model degraded", {
      code: error instanceof AgentError ? error.code : "PUBLIC_AGENT_MODEL_FAILED",
    });
    generated = fallbackReply(context, input.userMessage);
  }

  const cards: ResponseCard[] = [];
  const selected = generated.selectedUnitCode;
  const filters = safeFilters(generated.filters, initialFilters);
  if (selected) filters.unit_code = selected;
  commercialData = await commercial(input.admin, input.slug, filters);

  if (generated.action === "show_enterprise") {
    generated.reply = enterpriseReply(enterprise);
    cards.push({
      type: "enterprise",
      title: "Évora Urbanismo e empreendimentos",
      items: Array.isArray(enterprise.projects) ? enterprise.projects : [],
    });
  } else if (generated.action === "show_inventory") {
    generated.reply = inventoryReply(commercialData, selected);
    cards.push({ type: "inventory", title: "Disponibilidade consultada agora", data: commercialData });
  } else if (generated.action === "show_policy") {
    generated.reply = policyReply(commercialData);
    cards.push({ type: "policy", title: "Condições comerciais vigentes", data: commercialData });
  } else if (generated.action === "show_resources") {
    const signed = await sharedResources(input.admin, input.slug);
    generated.reply = resourcesReply(signed);
    cards.push({ type: "resources", title: "Materiais autorizados pela Évora", items: signed });
  } else if (generated.action === "hold_status") {
    const status = await holdStatus(input.admin, input.slug, input.tokenHash, input.fingerprintHash);
    generated.reply = holdStatusReply(status);
    cards.push({ type: "hold", title: "Situação do bloqueio", data: status });
  } else if (generated.action === "generate_home_simulation") {
    const simulation = safeSimulation(generated.simulation);
    if (!simulation.explicit_confirmation) {
      generated.reply = "Posso criar um estudo visual conceitual da casa. Antes de gerar, confirme que deseja a imagem e, se possível, diga o estilo, número de pavimentos, dormitórios e se gostaria de piscina.";
      generated.quickReplies = ["Sim, gerar a simulação", "Quero ajustar as preferências"];
    } else {
      const result = await generateSimulation({
        admin: input.admin,
        runtime: aiRuntime,
        slug: input.slug,
        tokenHash: input.tokenHash,
        fingerprintHash: input.fingerprintHash,
        simulation,
        selectedUnit: findUnit(commercialData, selected),
        profile: generated.profile,
        enterprise,
      });
      generated.reply = result.reply;
      cards.push(result.card);
    }
  }

  const contactResult = await rpc(input.admin, "update_public_agent_contact_capture_v3", {
    p_slug: input.slug,
    p_session_token_hash: input.tokenHash,
    p_fingerprint_hash: input.fingerprintHash,
    p_patch: generated.contactPatch,
    p_service_consent: generated.serviceConsent,
    p_marketing_consent: generated.marketingConsent,
    p_consent_copy_version: "immersive-v1-2026-08-15",
  }) as JsonObject;

  const contact = object(contactResult.contactCapture) ? contactResult.contactCapture : {};
  const isConsented = contactResult.serviceConsented === true;
  let lead: JsonObject | null = null;
  const complete = contactComplete(contact);

  if (!complete && generated.requestContact) {
    const missing: string[] = [];
    if (!text(contact.name)) missing.push("seu nome");
    if (!normalizeBrazilianPhone(contact.phone)) missing.push("um telefone com DDD");
    if (missing.length) {
      generated.reply = `${generated.reply}${generated.reply.endsWith("?") ? "" : ""} Para continuar, informe ${missing.join(" e ")} diretamente nesta conversa.`;
      generated.stage = "contact";
    }
  } else if (complete && !isConsented && generated.requestContact) {
    generated.reply = `${generated.reply} Você autoriza a Évora Urbanismo a usar esses dados exclusivamente para continuar este atendimento comercial?`;
    generated.quickReplies = ["Sim, autorizo", "Não autorizo"];
    generated.stage = "contact";
  }

  await rpc(input.admin, "append_public_agent_turn", {
    p_slug: input.slug,
    p_session_token_hash: input.tokenHash,
    p_fingerprint_hash: input.fingerprintHash,
    p_user_message: input.userMessage,
    p_assistant_message: generated.reply,
    p_stage: generated.stage,
    p_profile: generated.profile,
    p_metadata: {
      agent_response_id: generated.agentResponseId,
      supervisor_response_id: generated.supervisorResponseId,
      supervisor_decision: generated.supervisorDecision,
      action: generated.action,
      selected_unit_code: selected,
      file_search_used: generated.fileSearchUsed,
      facts_used: generated.factsUsed,
      risk_flags: generated.riskFlags,
      card_types: cards.map((card) => card.type),
      degraded,
    },
  });

  const converted = context.converted === true;
  if (!converted && complete && isConsented) {
    const convertedRaw = await rpc(input.admin, "convert_public_agent_lead", {
      p_slug: input.slug,
      p_session_token_hash: input.tokenHash,
      p_fingerprint_hash: input.fingerprintHash,
      p_name: complete.name,
      p_phone_e164: complete.phone,
      p_email: complete.email,
      p_city: complete.city,
      p_marketing_consent: contactResult.marketingConsented === true,
      p_profile: { ...generated.profile, preferred_city: complete.city || generated.profile.preferred_city },
    });
    lead = object(convertedRaw) ? convertedRaw : {};
    const protocol = text(lead.protocol);
    if (protocol) cards.push({ type: "lead", title: "Atendimento registrado", protocol });
  }

  if (generated.action === "request_hold" && selected) {
    const latestContact = complete || contactComplete(contact);
    if (latestContact && isConsented) {
      const hold = await rpc(input.admin, "request_public_agent_unit_hold", {
        p_slug: input.slug,
        p_session_token_hash: input.tokenHash,
        p_fingerprint_hash: input.fingerprintHash,
        p_unit_code: selected,
        p_customer_name: latestContact.name,
      });
      const holdData = object(hold) ? hold : {};
      cards.push({ type: "hold", title: "Solicitação de bloqueio", data: holdData });
      generated.reply = `Solicitei o bloqueio temporário do lote ${selected}. Ele fica sujeito à aprovação administrativa da Évora; o protocolo e a situação aparecem abaixo.`;
    } else {
      generated.reply = `Posso solicitar o bloqueio temporário do lote ${selected}. Para isso, preciso do seu nome, telefone com DDD e autorização para continuar este atendimento.`;
      generated.stage = "contact";
      generated.requestContact = true;
    }
  }

  return {
    reply: generated.reply,
    stage: generated.stage,
    profile: generated.profile,
    contactCapture: contact,
    contactConsented: isConsented,
    requestContact: generated.requestContact,
    handoffRequested: generated.handoffRequested,
    quickReplies: generated.quickReplies,
    action: generated.action,
    selectedUnitCode: selected,
    cards,
    lead,
    converted: converted || Boolean(lead),
    degraded,
  };
}

Deno.serve(async (request) => {
  try {
    if (request.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    const length = Number(request.headers.get("content-length") || "0");
    if (Number.isFinite(length) && length > MAX_BYTES) return json({ ok: false, error: "PAYLOAD_TOO_LARGE" }, 413);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceRole) return json({ ok: false, error: "SERVICE_CONFIG_MISSING" }, 503);

    const token = bearer(request);
    if (!token) return json({ ok: false, error: "PUBLIC_AGENT_AUTH_REQUIRED" }, 401);
    const admin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const verification = await admin.rpc("verify_public_agent_edge_bearer", {
      p_candidate: token,
      p_request_url: requestUrl(request),
    });
    if (verification.error || verification.data !== true) {
      return json({ ok: false, error: "PUBLIC_AGENT_AUTH_REQUIRED" }, 401);
    }

    const body = await request.json().catch(() => null);
    if (!object(body)) throw new AgentError("PUBLIC_AGENT_INPUT_INVALID", 400);
    const action = String(body.action || "");
    const slug = safeSlug(body.slug);

    if (action === "experience") {
      const data = await rpc(admin, "get_public_agent_experience", { p_slug: slug });
      return json({ ok: true, data });
    }

    const tokenHash = safeHash(body.tokenHash);
    const fingerprintHash = safeHash(body.fingerprintHash);

    if (action === "session") {
      const data = await rpc(admin, "open_public_agent_session", {
        p_slug: slug,
        p_session_token_hash: tokenHash,
        p_fingerprint_hash: fingerprintHash,
        p_utm: safeObject(body.attribution, 16_384),
        p_landing_page: text(body.landingPage)?.slice(0, 1000) || null,
        p_referrer: text(body.referrer)?.slice(0, 1000) || null,
        p_user_agent: text(body.userAgent)?.slice(0, 1000) || null,
      });
      return json({ ok: true, data });
    }

    if (action === "message") {
      const data = await handleMessage({
        admin,
        slug,
        tokenHash,
        fingerprintHash,
        userMessage: safeMessage(body.message),
      });
      return json({ ok: true, data });
    }

    if (action === "transcribe") {
      const context = await rpc(admin, "get_public_agent_v3_context", {
        p_slug: slug,
        p_session_token_hash: tokenHash,
        p_fingerprint_hash: fingerprintHash,
      }) as JsonObject;
      const aiRuntime = await runtime(admin, String(context.organizationId || ""));
      const transcript = await transcribe({
        admin,
        runtime: aiRuntime,
        slug,
        tokenHash,
        fingerprintHash,
        audioBase64: String(body.audioBase64 || ""),
        mimeType: String(body.mimeType || "").split(";")[0].toLowerCase(),
      });
      return json({ ok: true, data: { transcript } });
    }

    if (action === "lead") {
      if (body.serviceContactConsent !== true) throw new AgentError("PUBLIC_AGENT_CONSENT_REQUIRED", 400);
      const name = text(body.name);
      const phone = normalizeBrazilianPhone(body.phone);
      if (!name || !phone) throw new AgentError("PUBLIC_AGENT_INPUT_INVALID", 400);
      const data = await rpc(admin, "convert_public_agent_lead", {
        p_slug: slug,
        p_session_token_hash: tokenHash,
        p_fingerprint_hash: fingerprintHash,
        p_name: name.slice(0, 180),
        p_phone_e164: phone,
        p_email: text(body.email)?.toLowerCase().slice(0, 320) || null,
        p_city: text(body.city)?.slice(0, 180) || null,
        p_marketing_consent: body.marketingConsent === true,
        p_profile: safeProfile(body.profile),
      });
      return json({ ok: true, data });
    }

    throw new AgentError("PUBLIC_AGENT_ACTION_INVALID", 400);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    const status = error instanceof AgentError ? error.status : timedOut ? 504 : 503;
    const code = error instanceof AgentError
      ? error.code
      : timedOut
        ? "PUBLIC_AGENT_TIMEOUT"
        : "PUBLIC_AGENT_EDGE_UNAVAILABLE";
    if (!(error instanceof AgentError)) {
      console.error("enterprise-vitoria-agent", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return json({ ok: false, error: code }, status);
  }
});
