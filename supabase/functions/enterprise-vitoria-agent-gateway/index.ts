import { createClient as createSupabaseClient } from "npm:@supabase/supabase-js@2";

type JsonObject = Record<string, unknown>;
type GatewayDatabase = {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Record<string, {
      Args: Record<string, unknown>;
      Returns: unknown;
    }>;
  };
};

function createClient(
  supabaseUrl: string,
  supabaseKey: string,
  options?: Parameters<typeof createSupabaseClient<GatewayDatabase>>[2],
) {
  return createSupabaseClient<GatewayDatabase>(supabaseUrl, supabaseKey, options);
}
type AdminClient = ReturnType<typeof createClient>;

const MAX_BYTES = 3_500_000;
const TIMEOUT_MS = 125_000;
const CONSENT_COPY_VERSION = "vitoria-enterprise-v4-2026-08-16";
const CLIENT_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNIT_CODE = /^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$/;
const HEADERS = {
  "cache-control": "no-store",
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
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalized(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function upstreamUrl() {
  const raw = Deno.env.get("SUPABASE_URL") || "";
  const base = new URL(raw);
  if (base.protocol !== "https:") throw new GatewayError("VITORIA_GATEWAY_CONFIG_INVALID");
  return new URL("/functions/v1/enterprise-vitoria-agent", base);
}

async function internalBearer(admin: AdminClient) {
  const result = await admin.rpc("get_public_agent_internal_bearer");
  if (
    result.error
    || typeof result.data !== "string"
    || result.data.length < 32
    || result.data.length > 512
    || /\s/.test(result.data)
  ) {
    throw new GatewayError("VITORIA_INTERNAL_BEARER_UNAVAILABLE");
  }
  return result.data;
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
    console.error("bia-gateway-rpc", { name, code: result.error.code });
    throw new GatewayError("VITORIA_GATEWAY_RPC_FAILED", 503);
  }
  return result.data;
}

function safeUnit(value: unknown): string | null {
  const unit = text(value)?.toUpperCase() || "";
  return UNIT_CODE.test(unit) ? unit : null;
}

function unitFromMessage(message: string) {
  return safeUnit(message.match(/\b[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+\b/i)?.[0]);
}

function isGreeting(message: string) {
  const value = normalized(message).replace(/[!?.]+$/g, "").trim();
  return /^(oi|ola|bom dia|boa tarde|boa noite|oi bia|ola bia|bom dia bia|boa tarde bia|boa noite bia|tudo bem|oi tudo bem)$/.test(value);
}

function greetingReply(message: string) {
  const value = normalized(message);
  if (value.includes("bom dia")) return "Bom dia! 😊 Estou por aqui. Como posso te ajudar com o Solaris hoje?";
  if (value.includes("boa tarde")) return "Boa tarde! 😊 Estou por aqui. Como posso te ajudar com o Solaris hoje?";
  if (value.includes("boa noite")) return "Boa noite! 😊 Estou por aqui. Como posso te ajudar com o Solaris?";
  return "Oi! 😊 Tudo bem? Me conta como posso te ajudar com o Solaris.";
}

function wantsInventory(message: string) {
  const value = normalized(message);
  return /\b(ver|mostrar|mostre|quero ver|conhecer)\b.{0,30}\b(lotes?|terrenos?)\b.{0,20}\b(disponiveis?|disponibilidade)\b/.test(value)
    || /^(ver lotes|ver lotes disponiveis|lotes disponiveis|mostrar lotes)$/.test(value);
}

function wantsVisit(message: string) {
  const value = normalized(message);
  return /\b(agendar|marcar|combinar|organizar)\b.{0,30}\b(visita|visitar)\b/.test(value)
    || /\b(quero|gostaria|pretendo)\b.{0,24}\b(visitar|uma visita)\b/.test(value)
    || /^(agendar uma visita|agendar visita)$/.test(value);
}

function cancelsVisit(message: string) {
  return /\b(cancelar|cancela|desisti|desistir|nao quero|deixa pra la|deixa para la)\b/.test(normalized(message));
}

function serviceConsentYes(message: string) {
  return /\b(autorizo|pode me contatar|pode entrar em contato|pode falar comigo|sim pode|sim, pode)\b/.test(normalized(message));
}

function serviceConsentNo(message: string) {
  return /\b(nao autorizo|nao pode|sem contato|nao quero contato)\b/.test(normalized(message));
}

function normalizePhone(value: string): string | null {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("55") && digits.length >= 12) digits = digits.slice(2);
  if (!/^\d{10,11}$/.test(digits)) return null;
  return `+55${digits}`;
}

function phoneFromMessage(message: string) {
  const match = message.match(/(?:\+?55[\s.-]*)?(?:\(?\d{2}\)?[\s.-]*)?(?:9[\s.-]*)?\d{4}[\s.-]*-?[\s.-]*\d{4}/);
  return match ? normalizePhone(match[0]) : null;
}

function plainName(message: string) {
  const clean = message.trim().replace(/[.,;:!?]+$/g, "");
  const words = clean.split(/\s+/);
  if (words.length < 1 || words.length > 6) return null;
  if (/\b(quero|pode|posso|sim|nao|amanha|hoje|visita|lote|telefone|contato|autorizo)\b/.test(normalized(clean))) return null;
  return words.every((word) => /^[\p{L}][\p{L}'’.-]*$/u.test(word)) ? clean.slice(0, 180) : null;
}

function contactOf(context: JsonObject) {
  const contact = object(context.contactCapture) ? context.contactCapture : {};
  return {
    name: text(contact.name),
    phone: normalizePhone(String(contact.phone || "")),
    email: text(contact.email),
    city: text(contact.city),
  };
}

function selectedUnit(context: JsonObject) {
  const visit = object(context.visitState) ? context.visitState : {};
  const profile = object(context.profile) ? context.profile : {};
  const hold = object(context.holdStatus) ? context.holdStatus : {};
  const holdUnit = object(hold.unit) ? hold.unit : {};
  return safeUnit(visit.unitCode)
    || safeUnit(holdUnit.unitCode ?? holdUnit.unit_code)
    || safeUnit(profile.selected_unit_code)
    || null;
}

function responseBase(context: JsonObject, reply: string, options: JsonObject = {}) {
  return {
    status: "completed",
    reply,
    stage: text(options.stage) || text(context.stage) || "discovery",
    profile: object(context.profile) ? context.profile : {},
    contactCapture: object(context.contactCapture) ? context.contactCapture : {},
    serviceConsented: context.serviceConsented === true,
    marketingConsented: context.marketingConsented === true,
    requestContact: options.requestContact === true,
    handoffRequested: false,
    quickReplies: Array.isArray(options.quickReplies) ? options.quickReplies : [],
    action: text(options.action) || "none",
    selectedUnitCode: safeUnit(options.selectedUnitCode) || selectedUnit(context),
    commercial: object(options.commercial) ? options.commercial : null,
    simulation: null,
    attachments: [],
    holdStatus: object(context.holdStatus) ? context.holdStatus : null,
    converted: context.converted === true,
    leadProtocol: text(context.leadProtocol),
    degraded: false,
  };
}

async function gatewayContext(admin: AdminClient, body: JsonObject) {
  const value = await rpc(admin, "get_public_agent_gateway_context_v1", {
    p_slug: body.slug,
    p_session_token_hash: body.tokenHash,
    p_fingerprint_hash: body.fingerprintHash,
  });
  if (!object(value)) throw new GatewayError("VITORIA_GATEWAY_CONTEXT_INVALID");
  return value;
}

async function commitTurn(
  admin: AdminClient,
  body: JsonObject,
  response: JsonObject,
  options: {
    visitState?: JsonObject | null;
    contactPatch?: JsonObject;
    serviceConsent?: boolean | null;
  } = {},
) {
  const value = await rpc(admin, "commit_public_agent_gateway_turn_v1", {
    p_slug: body.slug,
    p_session_token_hash: body.tokenHash,
    p_fingerprint_hash: body.fingerprintHash,
    p_client_request_id: body.clientMessageId,
    p_user_message: body.message,
    p_response: response,
    p_visit_state: options.visitState ?? null,
    p_contact_patch: options.contactPatch || {},
    p_service_consent: options.serviceConsent ?? null,
    p_marketing_consent: null,
    p_consent_copy_version: options.serviceConsent === true ? CONSENT_COPY_VERSION : null,
  });
  if (!object(value)) throw new GatewayError("VITORIA_GATEWAY_TURN_INVALID");
  return value;
}

async function convertLead(admin: AdminClient, body: JsonObject, context: JsonObject) {
  if (context.converted === true) return context;
  const contact = contactOf(context);
  if (!contact.name || !contact.phone || context.serviceConsented !== true) {
    throw new GatewayError("PUBLIC_AGENT_VISIT_CONTACT_REQUIRED", 409);
  }
  await rpc(admin, "convert_public_agent_lead", {
    p_slug: body.slug,
    p_session_token_hash: body.tokenHash,
    p_fingerprint_hash: body.fingerprintHash,
    p_name: contact.name,
    p_phone_e164: contact.phone,
    p_email: contact.email,
    p_city: contact.city,
    p_marketing_consent: context.marketingConsented === true,
    p_profile: object(context.profile) ? context.profile : {},
  });
  return await gatewayContext(admin, body);
}

function compactCommercial(value: unknown) {
  if (!object(value)) return null;
  const units = Array.isArray(value.units) ? value.units.slice(0, 3).filter(object).map((unit) => ({
    unitCode: safeUnit(unit.unitCode ?? unit.unit_code) || "",
    blockCode: text(unit.blockCode ?? unit.block_code),
    lotNumber: text(unit.lotNumber ?? unit.lot_number),
    area: typeof unit.area === "number" ? unit.area : null,
    frontage: typeof unit.frontage === "number" ? unit.frontage : null,
    depth: typeof unit.depth === "number" ? unit.depth : null,
    corner: unit.corner === true,
    topography: text(unit.topography),
    orientation: text(unit.orientation),
    listPrice: typeof (unit.listPrice ?? unit.list_price) === "number" ? Number(unit.listPrice ?? unit.list_price) : null,
    pricePerSqm: typeof (unit.pricePerSqm ?? unit.price_per_sqm) === "number" ? Number(unit.pricePerSqm ?? unit.price_per_sqm) : null,
    updatedAt: text(unit.updatedAt ?? unit.updated_at),
  })).filter((unit) => unit.unitCode) : [];
  const summary = object(value.summary) ? value.summary : {};
  const policy = object(value.policy) ? value.policy : {};
  const project = object(value.project) ? value.project : {};
  return {
    realTime: value.realTime === true,
    asOf: text(value.asOf),
    project: { name: text(project.name), slug: text(project.slug) },
    summary: {
      availableCount: typeof summary.availableCount === "number" ? summary.availableCount : null,
      minimumArea: typeof summary.minimumArea === "number" ? summary.minimumArea : null,
      maximumArea: typeof summary.maximumArea === "number" ? summary.maximumArea : null,
      minimumPrice: typeof summary.minimumPrice === "number" ? summary.minimumPrice : null,
      maximumPrice: typeof summary.maximumPrice === "number" ? summary.maximumPrice : null,
    },
    policy: {
      name: text(policy.name),
      description: text(policy.description),
      minimumDownPaymentPct: typeof policy.minimumDownPaymentPct === "number" ? policy.minimumDownPaymentPct : null,
      maximumInstallments: typeof policy.maximumInstallments === "number" ? policy.maximumInstallments : null,
      monthlyInterestRate: typeof policy.monthlyInterestRate === "number" ? policy.monthlyInterestRate : null,
      indexer: text(policy.indexer),
      reservationValidityHours: typeof policy.reservationValidityHours === "number" ? policy.reservationValidityHours : null,
    },
    units,
  };
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };
function saoPauloParts(date = new Date()): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

function pad(value: number) { return String(value).padStart(2, "0"); }
function localDateString(year: number, month: number, day: number) { return `${year}-${pad(month)}-${pad(day)}`; }
function dateAtNoon(year: number, month: number, day: number) { return new Date(Date.UTC(year, month - 1, day, 15, 0, 0)); }
function addDaysLocal(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const target = dateAtNoon(year, month, day);
  target.setUTCDate(target.getUTCDate() + days);
  return localDateString(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate());
}

function nextWeekdayLocal(base: string, weekday: number) {
  const [year, month, day] = base.split("-").map(Number);
  const target = dateAtNoon(year, month, day);
  const current = target.getUTCDay();
  let delta = (weekday - current + 7) % 7;
  if (delta === 0) delta = 7;
  target.setUTCDate(target.getUTCDate() + delta);
  return localDateString(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate());
}

function parseVisitMoment(message: string, storedDate: string | null) {
  const value = normalized(message);
  const now = saoPauloParts();
  const today = localDateString(now.year, now.month, now.day);
  let localDate: string | null = null;

  const explicit = value.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (explicit) {
    const day = Number(explicit[1]);
    const month = Number(explicit[2]);
    let year = explicit[3] ? Number(explicit[3]) : now.year;
    if (year < 100) year += 2000;
    const test = dateAtNoon(year, month, day);
    if (test.getUTCFullYear() === year && test.getUTCMonth() + 1 === month && test.getUTCDate() === day) {
      localDate = localDateString(year, month, day);
    }
  } else if (/\bdepois de amanha\b/.test(value)) {
    localDate = addDaysLocal(today, 2);
  } else if (/\bamanha\b/.test(value)) {
    localDate = addDaysLocal(today, 1);
  } else if (/\bhoje\b/.test(value)) {
    localDate = today;
  } else {
    const weekdays: Array<[RegExp, number]> = [
      [/\bdomingo\b/, 0], [/\bsegunda(?:-feira)?\b/, 1], [/\bterca(?:-feira)?\b/, 2],
      [/\bquarta(?:-feira)?\b/, 3], [/\bquinta(?:-feira)?\b/, 4], [/\bsexta(?:-feira)?\b/, 5], [/\bsabado\b/, 6],
    ];
    const match = weekdays.find(([pattern]) => pattern.test(value));
    if (match) localDate = nextWeekdayLocal(today, match[1]);
  }

  let hour: number | null = null;
  let minute = 0;
  const withPrefix = value.match(/\b(?:as|pelas?)\s+(\d{1,2})(?::(\d{2}))?\b/);
  const withH = value.match(/\b(\d{1,2})h(?:(\d{2}))?\b/);
  const withColon = value.match(/\b(\d{1,2}):(\d{2})\b/);
  const time = withPrefix || withH || withColon;
  if (time) {
    hour = Number(time[1]);
    minute = Number(time[2] || 0);
    if (hour > 23 || minute > 59) { hour = null; minute = 0; }
  }

  if (!localDate && storedDate) localDate = storedDate;
  if (!localDate) return { localDate: null, scheduledAt: null, hasDate: false, hasTime: hour !== null };
  if (hour === null) return { localDate, scheduledAt: null, hasDate: true, hasTime: false };

  const scheduledAt = `${localDate}T${pad(hour)}:${pad(minute)}:00-03:00`;
  const instant = new Date(scheduledAt);
  if (Number.isNaN(instant.getTime()) || instant.getTime() < Date.now() + 10 * 60 * 1000) {
    return { localDate, scheduledAt: null, hasDate: true, hasTime: true, invalidPast: true };
  }
  return { localDate, scheduledAt, hasDate: true, hasTime: true };
}

function visitQuickReplies() {
  return ["Amanhã às 10h", "Amanhã às 14h", "Sábado às 9h"];
}

function formatVisitTime(value: string) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function handleDeterministicMessage(admin: AdminClient, body: JsonObject): Promise<JsonObject | null> {
  if (body.action !== "message") return null;
  const message = text(body.message);
  const clientMessageId = text(body.clientMessageId);
  const slug = text(body.slug);
  const tokenHash = text(body.tokenHash);
  const fingerprintHash = text(body.fingerprintHash);
  if (!message || !clientMessageId || !CLIENT_REQUEST_ID.test(clientMessageId) || !slug || !tokenHash || !fingerprintHash) return null;

  let context = await gatewayContext(admin, body);
  const visitState = object(context.visitState) ? context.visitState : null;

  if (visitState) {
    const phase = text(visitState.phase);
    const unit = safeUnit(visitState.unitCode) || selectedUnit(context);
    if (cancelsVisit(message)) {
      const response = responseBase(context, "Tudo bem. Não vou marcar a visita agora. Quando quiser, retomamos daqui.", {
        stage: context.converted === true ? "qualification" : "discovery",
        selectedUnitCode: unit,
        quickReplies: unit ? [`Calcular pagamento do ${unit}`, `Ver fotos e materiais do ${unit}`, "Agendar uma visita"] : ["Ver lotes disponíveis"],
      });
      return await commitTurn(admin, body, response, { visitState: { clear: true } });
    }

    const currentContact = contactOf(context);
    if (phase === "name") {
      const name = plainName(message);
      if (!name) {
        const response = responseBase(context, "Só preciso do seu nome para organizar a visita. Como você se chama?", { stage: "contact", requestContact: true, selectedUnitCode: unit });
        return await commitTurn(admin, body, response);
      }
      const nextPhase = currentContact.phone ? (context.serviceConsented === true ? "when" : "consent") : "phone";
      const reply = nextPhase === "phone"
        ? `Prazer, ${name.split(/\s+/)[0]}. Qual é o melhor telefone com DDD?`
        : nextPhase === "consent"
        ? "Perfeito. Você autoriza a Évora a usar esse contato para organizar esta visita?"
        : "Perfeito. Qual dia e horário ficam melhores para a visita?";
      const response = responseBase(context, reply, {
        stage: nextPhase === "when" ? "qualification" : "contact",
        requestContact: nextPhase !== "when",
        selectedUnitCode: unit,
        quickReplies: nextPhase === "consent" ? ["Autorizo o contato da Évora"] : nextPhase === "when" ? visitQuickReplies() : [],
      });
      return await commitTurn(admin, body, response, { contactPatch: { name }, visitState: { phase: nextPhase, unitCode: unit } });
    }

    if (phase === "phone") {
      const phone = phoneFromMessage(message);
      if (!phone) {
        const response = responseBase(context, "Não consegui identificar o número. Pode enviar novamente com DDD? Por exemplo: (34) 99999-9999.", { stage: "contact", requestContact: true, selectedUnitCode: unit });
        return await commitTurn(admin, body, response);
      }
      const nextPhase = context.serviceConsented === true ? "when" : "consent";
      const response = responseBase(context,
        nextPhase === "consent"
          ? "Ótimo. Você autoriza a Évora a usar esse contato para organizar esta visita?"
          : "Perfeito. Qual dia e horário ficam melhores para a visita?",
        {
          stage: nextPhase === "when" ? "qualification" : "contact",
          requestContact: nextPhase !== "when",
          selectedUnitCode: unit,
          quickReplies: nextPhase === "consent" ? ["Autorizo o contato da Évora"] : visitQuickReplies(),
        },
      );
      return await commitTurn(admin, body, response, { contactPatch: { phone }, visitState: { phase: nextPhase, unitCode: unit } });
    }

    if (phase === "consent") {
      if (serviceConsentNo(message)) {
        const response = responseBase(context, "Tudo bem. Sem essa autorização eu não vou registrar a visita, mas continuo te ajudando por aqui normalmente.", {
          stage: "discovery",
          selectedUnitCode: unit,
          quickReplies: ["Ver lotes disponíveis", "Conhecer as condições"],
        });
        return await commitTurn(admin, body, response, { serviceConsent: false, visitState: { clear: true } });
      }
      if (!serviceConsentYes(message)) {
        const response = responseBase(context, "Para eu registrar a visita na agenda da Évora, preciso da sua autorização para usar o contato apenas neste atendimento. Você autoriza?", {
          stage: "contact",
          requestContact: true,
          selectedUnitCode: unit,
          quickReplies: ["Autorizo o contato da Évora"],
        });
        return await commitTurn(admin, body, response);
      }
      await rpc(admin, "update_public_agent_contact_capture_v3", {
        p_slug: body.slug,
        p_session_token_hash: body.tokenHash,
        p_fingerprint_hash: body.fingerprintHash,
        p_patch: {},
        p_service_consent: true,
        p_marketing_consent: null,
        p_consent_copy_version: CONSENT_COPY_VERSION,
      });
      context = await gatewayContext(admin, body);
      context = await convertLead(admin, body, context);
      const response = responseBase(context, "Perfeito. Agora me diga o dia e o horário que ficam melhores para a visita.", {
        stage: "qualification",
        selectedUnitCode: unit,
        quickReplies: visitQuickReplies(),
      });
      return await commitTurn(admin, body, response, { visitState: { phase: "when", unitCode: unit } });
    }

    if (phase === "when" || phase === "time") {
      if (context.converted !== true) context = await convertLead(admin, body, context);
      const storedDate = text(visitState.localDate);
      const parsed = parseVisitMoment(message, storedDate);
      if (parsed.invalidPast) {
        const response = responseBase(context, "Esse horário já passou ou ficou muito próximo. Me diga outro horário, por favor.", {
          stage: "qualification", selectedUnitCode: unit, quickReplies: visitQuickReplies(),
        });
        return await commitTurn(admin, body, response);
      }
      if (parsed.hasDate && !parsed.hasTime && parsed.localDate) {
        const [year, month, day] = parsed.localDate.split("-").map(Number);
        const label = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(dateAtNoon(year, month, day));
        const response = responseBase(context, `Certo, ${label}. Qual horário fica melhor para você?`, {
          stage: "qualification", selectedUnitCode: unit, quickReplies: ["9h", "10h", "14h", "16h"],
        });
        return await commitTurn(admin, body, response, { visitState: { phase: "time", unitCode: unit, localDate: parsed.localDate } });
      }
      if (!parsed.scheduledAt) {
        const response = responseBase(context, "Claro. Me diga o dia e o horário da visita — por exemplo, “amanhã às 10h” ou “sábado às 9h”.", {
          stage: "qualification", selectedUnitCode: unit, quickReplies: visitQuickReplies(),
        });
        return await commitTurn(admin, body, response);
      }

      const scheduled = await rpc(admin, "schedule_public_agent_visit_v1", {
        p_slug: body.slug,
        p_session_token_hash: body.tokenHash,
        p_fingerprint_hash: body.fingerprintHash,
        p_client_action_id: body.clientMessageId,
        p_scheduled_at: parsed.scheduledAt,
        p_unit_code: unit,
      });
      if (!object(scheduled) || !text(scheduled.scheduledAt)) throw new GatewayError("PUBLIC_AGENT_VISIT_SCHEDULE_FAILED");
      const scheduledAt = String(scheduled.scheduledAt);
      const reply = unit
        ? `Pronto. Agendei sua visita ao ${unit} para ${formatVisitTime(scheduledAt)}. A visita já ficou registrada na agenda da Évora.`
        : `Pronto. Agendei sua visita para ${formatVisitTime(scheduledAt)}. A visita já ficou registrada na agenda da Évora.`;
      const response = responseBase(context, reply, {
        stage: "qualification",
        selectedUnitCode: unit,
        quickReplies: unit ? [`Ver fotos e materiais do ${unit}`, `Calcular pagamento do ${unit}`] : ["Ver lotes disponíveis"],
      });
      return await commitTurn(admin, body, response, { visitState: { clear: true } });
    }
  }

  if (wantsVisit(message)) {
    const unit = unitFromMessage(message) || selectedUnit(context);
    const contact = contactOf(context);
    let phase: "name" | "phone" | "consent" | "when";
    let reply: string;
    let quickReplies: string[] = [];

    if (!contact.name) {
      phase = "name";
      reply = unit ? `Claro. Eu organizo a visita ao ${unit} por aqui. Como você se chama?` : "Claro. Eu organizo a visita por aqui. Como você se chama?";
    } else if (!contact.phone) {
      phase = "phone";
      reply = `Perfeito, ${contact.name.split(/\s+/)[0]}. Qual é o melhor telefone com DDD?`;
    } else if (context.serviceConsented !== true) {
      phase = "consent";
      reply = "Perfeito. Você autoriza a Évora a usar esse contato para organizar esta visita?";
      quickReplies = ["Autorizo o contato da Évora"];
    } else {
      context = await convertLead(admin, body, context);
      phase = "when";
      reply = unit
        ? `Claro. Vamos marcar a visita ao ${unit}. Qual dia e horário ficam melhores para você?`
        : "Claro. Qual dia e horário ficam melhores para a visita?";
      quickReplies = visitQuickReplies();
    }

    const response = responseBase(context, reply, {
      stage: phase === "when" ? "qualification" : "contact",
      requestContact: phase !== "when",
      selectedUnitCode: unit,
      quickReplies,
      action: "request_visit",
    });
    return await commitTurn(admin, body, response, { visitState: { phase, unitCode: unit } });
  }

  if (isGreeting(message)) {
    const response = responseBase(context, greetingReply(message), {
      stage: context.converted === true ? "qualification" : "discovery",
      quickReplies: ["Ver lotes disponíveis", "Conhecer as condições", "Conhecer o Solaris"],
    });
    return await commitTurn(admin, body, response);
  }

  if (wantsInventory(message)) {
    const commercialRaw = await rpc(admin, "get_public_agent_commercial_context", {
      p_slug: body.slug,
      p_filters: { limit: 3 },
    });
    const commercial = compactCommercial(commercialRaw);
    const count = commercial && object(commercial.summary) && typeof commercial.summary.availableCount === "number"
      ? commercial.summary.availableCount
      : null;
    const response = responseBase(context,
      count
        ? `Claro. Hoje tenho ${count} lotes disponíveis no estoque. Separei algumas opções para você começar a comparar.`
        : "Claro. Separei as opções disponíveis agora para você comparar.",
      {
        stage: "discovery",
        action: "show_inventory",
        commercial: commercial || {},
        quickReplies: ["Comparar por metragem", "Conhecer as condições", "Agendar uma visita"],
      },
    );
    return await commitTurn(admin, body, response);
  }

  return null;
}

async function proxyUpstream(admin: AdminClient, bytes: Uint8Array) {
  const token = await internalBearer(admin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(upstreamUrl(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: new TextDecoder().decode(bytes),
      signal: controller.signal,
    });
    const responseBody = await upstream.arrayBuffer();
    const headers = new Headers(HEADERS);
    headers.set("content-type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
    return new Response(responseBody, { status: upstream.status, headers });
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (request: Request) => {
  try {
    if (request.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ ok: false, error: "JSON_REQUIRED" }, 415);
    if (!ingressAuthorized(request)) return json({ ok: false, error: "VITORIA_GATEWAY_AUTH_REQUIRED" }, 401);
    const declared = request.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) return json({ ok: false, error: "PAYLOAD_TOO_LARGE" }, 413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) return json({ ok: false, error: bytes.byteLength ? "PAYLOAD_TOO_LARGE" : "JSON_REQUIRED" }, bytes.byteLength ? 413 : 415);

    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return json({ ok: false, error: "INVALID_JSON" }, 400); }
    if (!object(parsed)) return json({ ok: false, error: "INVALID_REQUEST" }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceRole) throw new GatewayError("VITORIA_GATEWAY_CONFIG_MISSING");
    const admin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    const deterministic = await handleDeterministicMessage(admin, parsed);
    if (deterministic) return json({ ok: true, data: deterministic });

    return await proxyUpstream(admin, bytes);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    const code = timedOut
      ? "VITORIA_GATEWAY_TIMEOUT"
      : error instanceof GatewayError ? error.code : "VITORIA_GATEWAY_UNAVAILABLE";
    const status = timedOut ? 504 : error instanceof GatewayError ? error.status : 503;
    console.error("enterprise-vitoria-agent-gateway", {
      code,
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return json({ ok: false, error: code }, status);
  }
});
