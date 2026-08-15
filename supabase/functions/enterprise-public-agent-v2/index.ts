import { createClient } from "npm:@supabase/supabase-js@2";

type Obj = Record<string, unknown>;
type Stage = "welcome" | "discovery" | "qualification" | "contact" | "handoff" | "completed";
type Profile = Record<string, unknown>;

type Context = {
  organizationId: string;
  projectId?: string | null;
  stage?: Stage;
  profile?: Profile;
  contactCapture?: Obj;
  contactConsented?: boolean;
  converted?: boolean;
  vectorStoreId?: string | null;
  knowledge?: Obj;
  experience?: Obj;
  messages?: Array<Obj>;
};

type Runtime = {
  apiKey: string;
  model: string;
  supervisorModel: string;
  agentReasoning: string;
  supervisorReasoning: string;
};

type OpenAiResponse = {
  id?: string;
  output?: Array<Obj>;
  error?: Obj;
};

const MAX_AUDIO_BYTES = 6 * 1024 * 1024;
const MAX_MESSAGE = 800;
const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

const PROFILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: { type: "string", enum: ["morar", "investir", "conhecer", "unknown"] },
    budget_min: { type: ["number", "null"] },
    budget_max: { type: ["number", "null"] },
    preferred_area_min: { type: ["number", "null"] },
    preferred_area_max: { type: ["number", "null"] },
    purchase_horizon: { type: "string", enum: ["ate_3_meses", "3_a_6_meses", "6_a_12_meses", "mais_de_12_meses", "unknown"] },
    preferred_city: { type: ["string", "null"] },
    financing_interest: { type: ["boolean", "null"] },
    payment_capacity: { type: ["number", "null"] },
    visit_interest: { type: ["boolean", "null"] },
    lead_score: { type: "integer", minimum: 0, maximum: 100 },
    summary: { type: "string", maxLength: 900 },
  },
  required: ["intent","budget_min","budget_max","preferred_area_min","preferred_area_max","purchase_horizon","preferred_city","financing_interest","payment_capacity","visit_interest","lead_score","summary"],
};

const AGENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reply: { type: "string", maxLength: 1000 },
    stage: { type: "string", enum: ["welcome","discovery","qualification","contact","handoff","completed"] },
    profile: PROFILE_SCHEMA,
    request_contact: { type: "boolean" },
    quick_replies: { type: "array", maxItems: 4, items: { type: "string", maxLength: 80 } },
  },
  required: ["reply","stage","profile","request_contact","quick_replies"],
};

const SUPERVISOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["approve","revise","block"] },
    final_reply: { type: "string", maxLength: 1000 },
    stage: { type: "string", enum: ["welcome","discovery","qualification","contact","handoff","completed"] },
    request_contact: { type: "boolean" },
    quick_replies: { type: "array", maxItems: 4, items: { type: "string", maxLength: 80 } },
    issues: { type: "array", maxItems: 8, items: { type: "string", maxLength: 160 } },
  },
  required: ["decision","final_reply","stage","request_contact","quick_replies","issues"],
};

class AppError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

const isObj = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

function safeHash(value: unknown) {
  const hash = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new AppError("PUBLIC_AGENT_SESSION_INVALID", 400);
  return hash;
}
function safeSlug(value: unknown) {
  const slug = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) throw new AppError("PUBLIC_AGENT_SLUG_INVALID", 400);
  return slug;
}
function safeMessage(value: unknown) {
  const text = String(value || "").trim();
  if (text.length < 1 || text.length > MAX_MESSAGE) throw new AppError("PUBLIC_AGENT_MESSAGE_INVALID", 400);
  return text;
}
function safeStage(value: unknown): Stage {
  const stage = String(value || "discovery") as Stage;
  return ["welcome","discovery","qualification","contact","handoff","completed"].includes(stage) ? stage : "discovery";
}
function cleanReplies(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0,80)).filter(Boolean))].slice(0,4);
}

function normalizePhone(text: string) {
  const candidates = text.match(/(?:\+?55[\s().-]*)?(?:\(?\d{2}\)?[\s.-]*)?(?:9?\d{4})[\s.-]*\d{4}/g) || [];
  for (const raw of candidates) {
    let digits = raw.replace(/\D/g, "");
    if (digits.startsWith("55") && digits.length >= 12) digits = digits.slice(2);
    if (/^\d{10,11}$/.test(digits)) return `+55${digits}`;
  }
  return null;
}
function extractEmail(text: string) {
  return text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0]?.toLowerCase() || null;
}
function extractName(text: string, previousAssistant: string) {
  const explicit = text.match(/(?:meu nome (?:é|e)|sou o|sou a|me chamo)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' -]{1,80})/i)?.[1]?.trim();
  if (explicit) return explicit.replace(/[,.!?].*$/, "").trim().slice(0,80);
  if (/\b(nome|como (?:você|voce) se chama)\b/i.test(previousAssistant)) {
    const stripped = text.replace(/\b(?:oi|olá|ola|sou|me chamo|meu nome é|meu nome e)\b/gi, " ").replace(/[^A-Za-zÀ-ÿ' -]/g, " ").replace(/\s+/g, " ").trim();
    if (stripped.length >= 2 && stripped.length <= 80) return stripped;
  }
  return null;
}
function isContactIntent(text: string) {
  return /\b(falar com (?:algu[eé]m|uma pessoa|corretor|especialista)|entr(?:e|ar) em contato|me lig(?:a|ue)|quero contato|quero uma visita|agendar visita|especialista)\b/i.test(text);
}
function isConsent(text: string) {
  return /^(?:sim[,! ]*)?(?:eu )?autorizo\b|^pode registrar\b|^sim,? pode\b/i.test(text.trim());
}
function isRefusal(text: string) {
  return /^(?:não|nao|agora não|agora nao|prefiro não|prefiro nao)\b/i.test(text.trim());
}
function redactPii(text: string) {
  const phone = normalizePhone(text);
  const email = extractEmail(text);
  let safe = text;
  if (phone) safe = safe.replace(/(?:\+?55[\s().-]*)?(?:\(?\d{2}\)?[\s.-]*)?(?:9?\d{4})[\s.-]*\d{4}/g, "[TELEFONE INFORMADO]");
  if (email) safe = safe.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL INFORMADO]");
  return safe;
}

function outputText(payload: OpenAiResponse) {
  for (const item of payload.output || []) {
    if (!isObj(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isObj(part) && part.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  throw new AppError("OPENAI_EMPTY_OUTPUT", 503);
}

async function modelJson(apiKey: string, model: string, reasoning: string, schemaName: string, schema: Obj, system: string, user: string, vectorStoreId?: string | null) {
  const tools = vectorStoreId && /^vs_[A-Za-z0-9_-]{6,}$/.test(vectorStoreId)
    ? [{ type: "file_search", vector_store_ids: [vectorStoreId], max_num_results: 8 }]
    : [];
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      reasoning: { effort: reasoning === "max" ? "high" : reasoning },
      input: [{ role: "system", content: system }, { role: "user", content: user }],
      tools,
      include: tools.length ? ["file_search_call.results"] : undefined,
      text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
      max_output_tokens: 1400,
      store: false,
    }),
  });
  const payload = await response.json().catch(() => null) as OpenAiResponse | null;
  if (!response.ok || !payload) {
    console.error("public-agent-v2 openai", { status: response.status, model });
    throw new AppError("OPENAI_UNAVAILABLE", response.status === 429 ? 429 : 503);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(outputText(payload)); } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("OPENAI_INVALID_JSON", 503);
  }
  if (!isObj(parsed)) throw new AppError("OPENAI_INVALID_SCHEMA", 503);
  return { id: payload.id || null, value: parsed };
}

async function getRuntime(admin: ReturnType<typeof createClient>, organizationId: string): Promise<Runtime> {
  const result = await admin.rpc("get_crm_ai_runtime_credentials", { p_organization_id: organizationId });
  if (result.error || !isObj(result.data)) throw new AppError("AI_RUNTIME_UNAVAILABLE", 503);
  const apiKey = typeof result.data.api_key === "string" ? result.data.api_key : "";
  if (apiKey.length < 32) throw new AppError("AI_RUNTIME_DISABLED", 503);
  return {
    apiKey,
    model: typeof result.data.agent_model === "string" ? result.data.agent_model : "gpt-5.6-sol",
    supervisorModel: typeof result.data.supervisor_model === "string" ? result.data.supervisor_model : "gpt-5.6-sol",
    agentReasoning: typeof result.data.agent_reasoning === "string" ? result.data.agent_reasoning : "medium",
    supervisorReasoning: typeof result.data.supervisor_reasoning === "string" ? result.data.supervisor_reasoning : "high",
  };
}

async function rpc(admin: ReturnType<typeof createClient>, name: string, args: Obj) {
  const result = await admin.rpc(name, args);
  if (result.error) {
    const msg = String(result.error.message || "").toUpperCase();
    if (msg.includes("RATE_LIMIT")) throw new AppError("PUBLIC_AGENT_RATE_LIMIT", 429);
    if (msg.includes("NOT_FOUND")) throw new AppError("PUBLIC_AGENT_SESSION_NOT_FOUND", 401);
    if (msg.includes("INACTIVE")) throw new AppError("PUBLIC_AGENT_SESSION_INACTIVE", 409);
    throw new AppError("PUBLIC_AGENT_DATABASE_UNAVAILABLE", 503);
  }
  return result.data;
}

async function persistTurn(admin: ReturnType<typeof createClient>, slug: string, tokenHash: string, fingerprintHash: string, userMessage: string, assistantMessage: string, stage: Stage, profile: Profile, metadata: Obj = {}) {
  return rpc(admin, "append_public_agent_turn", {
    p_slug: slug,
    p_session_token_hash: tokenHash,
    p_fingerprint_hash: fingerprintHash,
    p_user_message: userMessage,
    p_assistant_message: assistantMessage,
    p_stage: stage,
    p_profile: profile,
    p_metadata: metadata,
  });
}

async function updateContact(admin: ReturnType<typeof createClient>, slug: string, tokenHash: string, fingerprintHash: string, patch: Obj, consent: boolean | null = null) {
  return rpc(admin, "update_public_agent_contact_capture", {
    p_slug: slug,
    p_session_token_hash: tokenHash,
    p_fingerprint_hash: fingerprintHash,
    p_patch: patch,
    p_consent: consent,
  }) as Obj;
}

async function contactFlow(admin: ReturnType<typeof createClient>, context: Context, slug: string, tokenHash: string, fingerprintHash: string, message: string) {
  const messages = Array.isArray(context.messages) ? context.messages : [];
  const previousAssistant = [...messages].reverse().find((item) => item.direction === "assistant")?.content;
  const capture = isObj(context.contactCapture) ? { ...context.contactCapture } : {};
  let collecting = capture.collecting === true || isContactIntent(message) || context.stage === "contact" || context.stage === "handoff";
  const phone = normalizePhone(message);
  const email = extractEmail(message);
  const name = extractName(message, typeof previousAssistant === "string" ? previousAssistant : "");
  if (phone) capture.phone = phone;
  if (email) capture.email = email;
  if (name) capture.name = name;
  if (collecting) capture.collecting = true;

  if (!collecting) return null;

  if (isRefusal(message) && !context.contactConsented) {
    capture.collecting = false;
    const reply = "Sem problema. Podemos continuar por aqui sem registrar seu contato. O que você gostaria de saber sobre a Évora ou o Solaris?";
    await updateContact(admin, slug, tokenHash, fingerprintHash, capture, false);
    await persistTurn(admin, slug, tokenHash, fingerprintHash, message, reply, "discovery", context.profile || {}, { contact_flow: true });
    return { reply, stage: "discovery" as Stage, profile: context.profile || {}, requestContact: false, quickReplies: ["Quero conhecer o Solaris", "Quero investir"], converted: false };
  }

  if (!capture.name) {
    const reply = "Claro. Eu mesma registro tudo aqui na conversa para você não precisar preencher formulário. Qual é o seu nome?";
    await updateContact(admin, slug, tokenHash, fingerprintHash, capture);
    await persistTurn(admin, slug, tokenHash, fingerprintHash, message, reply, "contact", context.profile || {}, { contact_flow: true, requested: "name" });
    return { reply, stage: "contact" as Stage, profile: context.profile || {}, requestContact: true, quickReplies: [], converted: false };
  }

  if (!capture.phone) {
    const firstName = String(capture.name).split(/\s+/)[0];
    const reply = `Prazer, ${firstName}. Qual telefone com DDD a equipe da Évora pode usar para continuar este atendimento?`;
    await updateContact(admin, slug, tokenHash, fingerprintHash, capture);
    await persistTurn(admin, slug, tokenHash, fingerprintHash, message, reply, "contact", context.profile || {}, { contact_flow: true, requested: "phone" });
    return { reply, stage: "contact" as Stage, profile: context.profile || {}, requestContact: true, quickReplies: [], converted: false };
  }

  if (!context.contactConsented && !isConsent(message)) {
    const reply = `Perfeito, ${String(capture.name).split(/\s+/)[0]}. Posso registrar estes dados no Enterprise e autorizar a Évora Urbanismo a entrar em contato com você sobre este atendimento?`;
    await updateContact(admin, slug, tokenHash, fingerprintHash, capture);
    await persistTurn(admin, slug, tokenHash, fingerprintHash, message, reply, "contact", context.profile || {}, { contact_flow: true, requested: "consent" });
    return { reply, stage: "contact" as Stage, profile: context.profile || {}, requestContact: true, quickReplies: ["Sim, autorizo", "Agora não"], converted: false };
  }

  const consented = context.contactConsented || isConsent(message);
  if (consented) {
    await updateContact(admin, slug, tokenHash, fingerprintHash, capture, true);
    const lead = await rpc(admin, "convert_public_agent_lead", {
      p_slug: slug,
      p_session_token_hash: tokenHash,
      p_fingerprint_hash: fingerprintHash,
      p_name: String(capture.name).slice(0,180),
      p_phone_e164: String(capture.phone),
      p_email: typeof capture.email === "string" ? capture.email : null,
      p_city: typeof capture.city === "string" ? capture.city : null,
      p_marketing_consent: true,
      p_profile: context.profile || {},
    }) as Obj;
    const protocol = typeof lead.protocol === "string" ? lead.protocol : null;
    const reply = `Pronto, ${String(capture.name).split(/\s+/)[0]}. Seu atendimento foi registrado${protocol ? ` com o protocolo ${protocol}` : ""}. Um especialista da Évora receberá o contexto desta conversa para continuar com você.`;
    await persistTurn(admin, slug, tokenHash, fingerprintHash, message, reply, "completed", context.profile || {}, { contact_flow: true, converted: true, protocol });
    return { reply, stage: "completed" as Stage, profile: context.profile || {}, requestContact: false, quickReplies: [], converted: true, protocol };
  }
  return null;
}

function localGuard(text: string) {
  return /\b(valorização garantida|rentabilidade garantida|retorno garantido)\b/i.test(text) || /https?:\/\//i.test(text);
}

async function generateSpecialistReply(admin: ReturnType<typeof createClient>, context: Context, message: string) {
  const runtime = await getRuntime(admin, context.organizationId);
  const approved = isObj(context.knowledge) && Array.isArray(context.knowledge.approvedFacts) ? context.knowledge.approvedFacts : [];
  const guardrails = isObj(context.knowledge) && Array.isArray(context.knowledge.guardrails) ? context.knowledge.guardrails : [];
  const transcript = (context.messages || []).slice(-18).map((item) => ({
    role: item.direction === "user" ? "visitante" : "vitoria",
    content: typeof item.content === "string" ? redactPii(item.content).slice(0,1200) : "",
  }));
  const modelContext = JSON.stringify({ approvedFacts: approved, guardrails, profile: context.profile || {}, transcript });
  const safeUserMessage = redactPii(message);
  const system = [
    "Você é Vitória, a especialista virtual institucional e comercial da Évora Urbanismo.",
    "Sua primeira identidade é ser uma super especialista em Évora Urbanismo: empresa, empreendimentos, diferenciais, localização, conceito, infraestrutura, estágio, serviços e experiência do cliente.",
    "Quando houver uma base de conhecimento corporativa disponível, use file_search ativamente antes de responder perguntas factuais sobre Évora ou seus empreendimentos.",
    "As fontes cadastradas pela equipe da Évora são a referência primária. Os approvedFacts são a referência secundária.",
    "Nunca invente informação ausente. Se a base não responder com segurança, diga que vai confirmar com a equipe ou ofereça um especialista humano.",
    "Não prometa valorização, rentabilidade, disponibilidade, preço ou condição comercial não comprovada na base atual.",
    "Responda como uma consultora elegante, segura, calorosa e muito bem informada — sem jargão de chatbot.",
    "Faça uma pergunta por vez, salvo quando duas perguntas curtas forem indispensáveis.",
    "Não solicite CPF, RG, documentos, renda detalhada ou dados sensíveis.",
    "Telefone e e-mail são tratados pelo sistema fora do modelo; marcadores de PII significam apenas que o visitante informou o dado.",
  ].join("\n");
  const agent = await modelJson(runtime.apiKey, runtime.model, runtime.agentReasoning, "vitoria_specialist_reply", AGENT_SCHEMA, system, `CONTEXTO:\n${modelContext}\n\nMENSAGEM:\n${safeUserMessage}`, context.vectorStoreId);
  const draft = agent.value;
  const supervisor = await modelJson(runtime.apiKey, runtime.supervisorModel, runtime.supervisorReasoning, "vitoria_specialist_supervisor", SUPERVISOR_SCHEMA, [
    "Você é o Supervisor de Excelência da Vitória, especialista virtual da Évora Urbanismo.",
    "Valide fatos contra a base corporativa com file_search quando necessário.",
    "Bloqueie invenções, promessas, exageros, preços/condições não sustentados e qualquer pedido desnecessário de dado pessoal.",
    "Preserve uma voz humana, elegante e consultiva.",
  ].join("\n"), `CONTEXTO:\n${modelContext}\n\nMENSAGEM DO VISITANTE:\n${safeUserMessage}\n\nRASCUNHO:\n${JSON.stringify(draft)}`, context.vectorStoreId);
  let reply = typeof supervisor.value.final_reply === "string" ? supervisor.value.final_reply.trim() : "";
  const decision = String(supervisor.value.decision || "block");
  if (!reply || decision === "block" || localGuard(reply)) {
    reply = "Quero te responder com precisão. Essa informação precisa ser confirmada na base da Évora; se preferir, posso registrar seu contato para um especialista continuar com você.";
  }
  const profile = isObj(draft.profile) ? draft.profile : (context.profile || {});
  return {
    reply,
    stage: safeStage(supervisor.value.stage || draft.stage),
    profile,
    requestContact: supervisor.value.request_contact === true || draft.request_contact === true,
    quickReplies: cleanReplies(supervisor.value.quick_replies).length ? cleanReplies(supervisor.value.quick_replies) : cleanReplies(draft.quick_replies),
    metadata: {
      specialist_v2: true,
      agent_response_id: agent.id,
      supervisor_response_id: supervisor.id,
      supervisor_decision: decision,
      vector_store_used: Boolean(context.vectorStoreId),
    },
  };
}

async function transcribe(runtime: Runtime, audioBase64: string, mimeType: string) {
  const raw = audioBase64.includes(",") ? audioBase64.split(",").pop() || "" : audioBase64;
  if (!/^[A-Za-z0-9+/=]+$/.test(raw) || raw.length > Math.ceil(MAX_AUDIO_BYTES * 4 / 3) + 16) throw new AppError("INVALID_AUDIO", 400);
  const bytes = Uint8Array.from(atob(raw), (char) => char.charCodeAt(0));
  if (bytes.byteLength < 32 || bytes.byteLength > MAX_AUDIO_BYTES) throw new AppError("INVALID_AUDIO", 400);
  const extension = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "m4a" : "webm";
  const file = new File([bytes], `vitoria-voz.${extension}`, { type: mimeType || "audio/webm" });
  const form = new FormData();
  form.set("model", "gpt-4o-mini-transcribe");
  form.set("file", file, file.name);
  form.set("language", "pt");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${runtime.apiKey}` }, body: form });
  const payload = await response.json().catch(() => null) as Obj | null;
  const text = payload && typeof payload.text === "string" ? payload.text.trim() : "";
  if (!response.ok || !text) throw new AppError("AUDIO_TRANSCRIPTION_FAILED", response.status === 429 ? 429 : 503);
  return text.slice(0, MAX_MESSAGE);
}

Deno.serve(async (request) => {
  try {
    if (request.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    const body = await request.json().catch(() => null) as Obj | null;
    if (!body || !isObj(body)) throw new AppError("INVALID_REQUEST", 400);
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceKey) throw new AppError("SERVICE_CONFIG_MISSING", 503);
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const slug = safeSlug(body.slug);
    const tokenHash = safeHash(body.tokenHash);
    const fingerprintHash = safeHash(body.fingerprintHash);
    const context = await rpc(admin, "get_public_agent_v2_context", { p_slug: slug, p_session_token_hash: tokenHash, p_fingerprint_hash: fingerprintHash }) as Context;
    const action = String(body.action || "message");

    if (action === "transcribe") {
      const runtime = await getRuntime(admin, context.organizationId);
      const audio = String(body.audioBase64 || "");
      const mime = String(body.mimeType || "audio/webm").slice(0,80);
      const text = await transcribe(runtime, audio, mime);
      return json({ ok: true, text });
    }

    const message = safeMessage(body.message);
    const contact = await contactFlow(admin, context, slug, tokenHash, fingerprintHash, message);
    if (contact) return json({ ok: true, ...contact });

    const generated = await generateSpecialistReply(admin, context, message);
    const persisted = await persistTurn(admin, slug, tokenHash, fingerprintHash, message, generated.reply, generated.stage, generated.profile, generated.metadata) as Obj;
    return json({
      ok: true,
      reply: generated.reply,
      stage: persisted.stage || generated.stage,
      profile: persisted.profile || generated.profile,
      requestContact: generated.requestContact,
      quickReplies: generated.quickReplies,
      converted: persisted.converted === true,
    });
  } catch (error) {
    const known = error instanceof AppError ? error : null;
    if (!known) console.error("enterprise-public-agent-v2", { errorName: error instanceof Error ? error.name : "UnknownError" });
    return json({ ok: false, error: known?.code || "PUBLIC_AGENT_V2_UNAVAILABLE" }, known?.status || 503);
  }
});
