import type { AgentAction, ContactPatch, Filters, JsonObject, Profile, Reasoning, Runtime, SimulationSpec, Stage } from "./types.ts";

export class AgentError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 503) {
    super(code);
    this.name = "AgentError";
    this.code = code;
    this.status = status;
  }
}

export const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export function safeSlug(value: unknown): string {
  const slug = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
    throw new AgentError("PUBLIC_AGENT_SLUG_INVALID", 400);
  }
  return slug;
}

export function safeHash(value: unknown): string {
  const hash = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new AgentError("PUBLIC_AGENT_SESSION_INVALID", 400);
  }
  return hash;
}

export function safeMessage(value: unknown): string {
  const message = String(value || "").trim();
  if (message.length < 1 || message.length > 1200) {
    throw new AgentError("PUBLIC_AGENT_MESSAGE_INVALID", 400);
  }
  return message;
}

export function safeObject(value: unknown, maximumBytes = 32_768): JsonObject {
  if (!object(value)) return {};
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumBytes) return {};
  return value;
}

export function numeric(value: unknown, maximum = 1_000_000_000): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) return null;
  return Math.round(value * 100) / 100;
}

export function safeStage(value: unknown): Stage {
  const stage = String(value || "discovery") as Stage;
  return ["welcome", "discovery", "qualification", "contact", "handoff", "completed"].includes(stage)
    ? stage
    : "discovery";
}

export function safeAction(value: unknown): AgentAction {
  const action = String(value || "none") as AgentAction;
  return [
    "none",
    "show_enterprise",
    "show_inventory",
    "show_policy",
    "show_resources",
    "request_hold",
    "hold_status",
    "generate_home_simulation",
  ].includes(action)
    ? action
    : "none";
}

export function safeUnitCode(value: unknown): string | null {
  const code = String(value || "").trim().toUpperCase();
  return /^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$/.test(code) ? code : null;
}

export function safeProfile(value: unknown): Profile {
  if (!object(value)) return {};
  const profile: Profile = {};
  if (["morar", "investir", "conhecer", "unknown"].includes(String(value.intent))) {
    profile.intent = value.intent as Profile["intent"];
  }
  if (["ate_3_meses", "3_a_6_meses", "6_a_12_meses", "mais_de_12_meses", "unknown"].includes(String(value.purchase_horizon))) {
    profile.purchase_horizon = value.purchase_horizon as Profile["purchase_horizon"];
  }
  for (const key of ["budget_min", "budget_max", "preferred_area_min", "preferred_area_max", "payment_capacity"] as const) {
    const raw = value[key];
    if (raw === null) profile[key] = null;
    else {
      const parsed = numeric(raw, key.startsWith("preferred_area") ? 100_000 : 1_000_000_000);
      if (parsed !== null) profile[key] = parsed;
    }
  }
  for (const key of ["financing_interest", "visit_interest"] as const) {
    const raw = value[key];
    if (raw === null || typeof raw === "boolean") profile[key] = raw;
  }
  if (typeof value.preferred_city === "string") {
    profile.preferred_city = value.preferred_city.trim().slice(0, 180) || null;
  }
  profile.selected_unit_code = safeUnitCode(value.selected_unit_code);
  if (typeof value.lead_score === "number" && Number.isFinite(value.lead_score)) {
    profile.lead_score = Math.max(0, Math.min(100, Math.round(value.lead_score)));
  }
  if (typeof value.summary === "string") profile.summary = value.summary.trim().slice(0, 700);
  return profile;
}

export function safeContactPatch(value: unknown): ContactPatch {
  if (!object(value)) return {};
  const patch: ContactPatch = {};
  if (typeof value.name === "string") patch.name = value.name.trim().slice(0, 180) || null;
  if (typeof value.phone === "string") patch.phone = value.phone.trim().slice(0, 40) || null;
  if (typeof value.email === "string") patch.email = value.email.trim().toLowerCase().slice(0, 320) || null;
  if (typeof value.city === "string") patch.city = value.city.trim().slice(0, 180) || null;
  if (["telefone", "whatsapp", "email"].includes(String(value.preferred_contact_method))) {
    patch.preferred_contact_method = value.preferred_contact_method as ContactPatch["preferred_contact_method"];
  }
  return patch;
}

export function safeSimulation(value: unknown): SimulationSpec {
  if (!object(value)) return {};
  const result: SimulationSpec = {};
  if (typeof value.style === "string") result.style = value.style.trim().slice(0, 100) || null;
  for (const key of ["floors", "bedrooms", "suites", "garage_spaces"] as const) {
    const raw = value[key];
    if (raw === null) result[key] = null;
    else if (typeof raw === "number" && Number.isFinite(raw)) result[key] = Math.max(0, Math.min(20, Math.round(raw)));
  }
  if (value.pool === null || typeof value.pool === "boolean") result.pool = value.pool as boolean | null;
  if (typeof value.notes === "string") result.notes = value.notes.trim().slice(0, 500) || null;
  result.explicit_confirmation = value.explicit_confirmation === true;
  return result;
}

export function safeFilters(value: unknown, fallback: Filters = {}): Filters {
  const input = object(value) ? value : {};
  return {
    area_min: input.area_min === null ? null : numeric(input.area_min, 100_000) ?? fallback.area_min ?? null,
    area_max: input.area_max === null ? null : numeric(input.area_max, 100_000) ?? fallback.area_max ?? null,
    budget_max: input.budget_max === null ? null : numeric(input.budget_max) ?? fallback.budget_max ?? null,
    unit_code: safeUnitCode(input.unit_code) ?? fallback.unit_code ?? null,
    limit:
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(24, Math.round(input.limit)))
        : Math.max(1, Math.min(24, fallback.limit || 8)),
  };
}

export function filtersFromProfile(profile: Profile, message?: string): Filters {
  const exact = safeUnitCode(message?.match(/\b[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+\b/i)?.[0]);
  return {
    area_min: profile.preferred_area_min ?? null,
    area_max: profile.preferred_area_max ?? null,
    budget_max: profile.budget_max ?? null,
    unit_code: exact ?? profile.selected_unit_code ?? null,
    limit: 8,
  };
}

export function dbFilters(filters: Filters): JsonObject {
  return {
    areaMin: filters.area_min ?? null,
    areaMax: filters.area_max ?? null,
    budgetMax: filters.budget_max ?? null,
    unitCode: filters.unit_code ?? null,
    limit: filters.limit || 8,
  };
}

export function cleanStringArray(value: unknown, limit: number, maximumLength = 220): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, maximumLength))
        .filter(Boolean),
    ),
  ].slice(0, limit);
}

export function computeLeadScore(profile: Profile): number {
  let score = 5;
  if (profile.intent && profile.intent !== "unknown") score += 15;
  if (profile.budget_max) score += 20;
  if (profile.preferred_area_min) score += 10;
  if (profile.purchase_horizon === "ate_3_meses") score += 25;
  else if (profile.purchase_horizon === "3_a_6_meses") score += 20;
  else if (profile.purchase_horizon === "6_a_12_meses") score += 10;
  if (profile.preferred_city) score += 5;
  if (profile.financing_interest !== null && profile.financing_interest !== undefined) score += 5;
  if (profile.visit_interest) score += 20;
  return Math.max(0, Math.min(100, score));
}

export function mergedProfile(current: unknown, proposed: unknown, selectedUnitCode?: string | null): Profile {
  const next = { ...safeProfile(current), ...safeProfile(proposed) };
  if (selectedUnitCode) next.selected_unit_code = selectedUnitCode;
  next.lead_score = computeLeadScore(next);
  return next;
}

export function parseRuntime(value: unknown): Runtime | null {
  if (!object(value) || value.enabled !== true) return null;
  const apiKey = text(value.api_key);
  const agentModel = text(value.agent_model);
  const supervisorModel = text(value.supervisor_model);
  const agentReasoning = text(value.agent_reasoning) as Reasoning | null;
  const supervisorReasoning = text(value.supervisor_reasoning) as Reasoning | null;
  const model = /^[A-Za-z0-9._:-]{2,120}$/;
  const efforts = new Set<Reasoning>(["none", "low", "medium", "high", "xhigh", "max"]);
  if (
    !apiKey ||
    apiKey.length < 32 ||
    /\s/.test(apiKey) ||
    !agentModel ||
    !model.test(agentModel) ||
    !supervisorModel ||
    !model.test(supervisorModel) ||
    !agentReasoning ||
    !efforts.has(agentReasoning) ||
    !supervisorReasoning ||
    !efforts.has(supervisorReasoning)
  ) {
    return null;
  }
  return { apiKey, agentModel, agentReasoning, supervisorModel, supervisorReasoning };
}

export function explicitServiceConsent(previousAssistant: string, message: string): boolean | null {
  const previous = previousAssistant.toLocaleLowerCase("pt-BR");
  const current = message.toLocaleLowerCase("pt-BR").trim();
  const wasAsked = /autoriza|autorização|usar (esses|seus) dados|continuar (o|este) atendimento/.test(previous);
  if (!wasAsked) return null;
  if (/^(sim|sim,|autorizo|pode|pode sim|concordo|aceito|confirmo|claro|ok\b)/.test(current)) return true;
  if (/^(não|nao|não autorizo|nao autorizo|não aceito|nao aceito)/.test(current)) return false;
  return null;
}

export function explicitMarketingConsent(message: string): boolean | null {
  const current = message.toLocaleLowerCase("pt-BR");
  if (/autorizo.*(novidade|oferta|marketing)|aceito receber.*(novidade|oferta)|pode me enviar.*(novidade|oferta)/.test(current)) return true;
  if (/não quero.*(novidade|oferta)|não autorizo.*marketing|nao autorizo.*marketing/.test(current)) return false;
  return null;
}

export function localSafetyIssues(message: string, action: AgentAction): string[] {
  const issues: string[] = [];
  if (message.length < 2 || message.length > 1000) issues.push("message_length");
  if ((message.match(/\?/g) || []).length > 2) issues.push("too_many_questions");
  if (/https?:\/\//i.test(message)) issues.push("external_link");
  if (/\b(CPF|RG|comprovante de renda|foto do documento|senha|cartão)\b/i.test(message)) issues.push("sensitive_data_request");
  if (/\b(garantid[oa]|rentabilidade certa|valorização garantida|lucro garantido)\b/i.test(message)) issues.push("guarantee_claim");
  if (action === "none" && (/R\$\s*\d/i.test(message) || /\b\d+[,.]?\d*\s*%/i.test(message))) {
    issues.push("commercial_number_outside_realtime_context");
  }
  return issues;
}

export function normalizeBrazilianPhone(value: unknown): string | null {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("55")) digits = digits.slice(2);
  return /^\d{10,11}$/.test(digits) ? `+55${digits}` : null;
}

export function contactComplete(value: unknown): { name: string; phone: string; email: string | null; city: string | null } | null {
  if (!object(value)) return null;
  const name = text(value.name)?.slice(0, 180) || null;
  const phone = normalizeBrazilianPhone(value.phone);
  const email = text(value.email)?.toLowerCase().slice(0, 320) || null;
  const city = text(value.city)?.slice(0, 180) || null;
  if (!name || name.length < 2 || !phone) return null;
  return { name, phone, email, city };
}

export function brl(value: unknown): string {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(amount)
    : "valor não informado";
}

export function ptNumber(value: unknown, digits = 2): string {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(amount)
    : "—";
}
