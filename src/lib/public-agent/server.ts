import { createHmac, randomBytes } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

import { getSupabaseIntegrationConfig } from "@/lib/integrations/meta/server-config";
import type {
  PublicAgentContextPayload,
  PublicAgentExperience,
  PublicAgentProfile,
  PublicAgentSessionPayload,
  PublicAgentStage,
} from "./types";

type JsonObject = Record<string, unknown>;

let serviceClient: SupabaseClient | null = null;

export class PublicAgentServerError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 503) {
    super(code);
    this.name = "PublicAgentServerError";
    this.code = code;
    this.status = status;
  }
}

function database(): SupabaseClient {
  if (serviceClient) return serviceClient;
  const config = getSupabaseIntegrationConfig();
  serviceClient = createClient(config.url, config.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { headers: { "X-Client-Info": "evora-public-agent/1.0" } },
  });
  return serviceClient;
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
    throw new PublicAgentServerError("PUBLIC_AGENT_SLUG_INVALID", 400);
  }
  return slug;
}

function databaseError(error: unknown): PublicAgentServerError {
  const raw = object(error) && typeof error.message === "string" ? error.message : "";
  const message = raw.toUpperCase();
  if (message.includes("EXPERIENCE_NOT_FOUND")) {
    return new PublicAgentServerError("PUBLIC_AGENT_NOT_FOUND", 404);
  }
  if (message.includes("SESSION_NOT_FOUND")) {
    return new PublicAgentServerError("PUBLIC_AGENT_SESSION_NOT_FOUND", 401);
  }
  if (message.includes("RATE_LIMIT")) {
    return new PublicAgentServerError("PUBLIC_AGENT_RATE_LIMIT", 429);
  }
  if (message.includes("SESSION_INACTIVE")) {
    return new PublicAgentServerError("PUBLIC_AGENT_SESSION_INACTIVE", 409);
  }
  if (message.includes("INPUT_INVALID") || message.includes("EMAIL_INVALID")) {
    return new PublicAgentServerError("PUBLIC_AGENT_INPUT_INVALID", 400);
  }
  return new PublicAgentServerError("PUBLIC_AGENT_DATABASE_UNAVAILABLE", 503);
}

async function rpc<T>(name: string, params: JsonObject): Promise<T> {
  const { data, error } = await database().rpc(name, params);
  if (error) throw databaseError(error);
  return data as T;
}

function hashingKey(): string {
  return getSupabaseIntegrationConfig().serviceRoleKey;
}

export function hashPublicAgentValue(value: string): string {
  return createHmac("sha256", hashingKey()).update(value, "utf8").digest("hex");
}

export function newPublicAgentToken(): string {
  return randomBytes(32).toString("base64url");
}

export function publicAgentCookieName(slug: string): string {
  return `evora_agent_${safeSlug(slug).replace(/-/g, "_")}`;
}

export function publicAgentFingerprint(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
  const userAgent = request.headers.get("user-agent")?.slice(0, 500) || "unknown";
  const language = request.headers.get("accept-language")?.slice(0, 120) || "unknown";
  return hashPublicAgentValue(`${ip}\n${userAgent}\n${language}`);
}

export function enforcePublicAgentOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  try {
    const parsed = new URL(origin);
    if (parsed.host !== request.nextUrl.host || parsed.protocol !== request.nextUrl.protocol) {
      throw new Error("origin mismatch");
    }
  } catch {
    throw new PublicAgentServerError("PUBLIC_AGENT_ORIGIN_REJECTED", 403);
  }
}

export function sanitizeAttribution(value: unknown): JsonObject {
  if (!object(value)) return {};
  const allowed = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "fbclid",
    "campaign_id",
    "adset_id",
    "ad_id",
    "ad_name",
    "creative_id",
    "placement",
    "publisher_platform",
  ];
  const sanitized: JsonObject = {};
  for (const key of allowed) {
    const raw = value[key];
    if (typeof raw !== "string") continue;
    const clean = raw.trim().slice(0, 500);
    if (clean) sanitized[key] = clean;
  }
  return sanitized;
}

export function normalizeBrazilianPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  const national = digits.startsWith("55") ? digits.slice(2) : digits;
  if (!/^\d{10,11}$/.test(national)) {
    throw new PublicAgentServerError("PUBLIC_AGENT_PHONE_INVALID", 400);
  }
  return `+55${national}`;
}

export function sanitizeEmail(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase() || "";
  if (!email) return null;
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new PublicAgentServerError("PUBLIC_AGENT_EMAIL_INVALID", 400);
  }
  return email;
}

export function sanitizeProfile(value: unknown): PublicAgentProfile {
  if (!object(value)) return {};
  const profile: PublicAgentProfile = {};
  const intent = value.intent;
  if (["morar", "investir", "conhecer", "unknown"].includes(String(intent))) {
    profile.intent = intent as PublicAgentProfile["intent"];
  }
  const horizon = value.purchase_horizon;
  if (
    [
      "ate_3_meses",
      "3_a_6_meses",
      "6_a_12_meses",
      "mais_de_12_meses",
      "unknown",
    ].includes(String(horizon))
  ) {
    profile.purchase_horizon = horizon as PublicAgentProfile["purchase_horizon"];
  }
  for (const key of [
    "budget_min",
    "budget_max",
    "preferred_area_min",
    "preferred_area_max",
    "payment_capacity",
  ] as const) {
    const raw = value[key];
    if (raw === null) profile[key] = null;
    else if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1_000_000_000) {
      profile[key] = Math.round(raw * 100) / 100;
    }
  }
  for (const key of ["financing_interest", "visit_interest"] as const) {
    const raw = value[key];
    if (raw === null || typeof raw === "boolean") profile[key] = raw;
  }
  if (typeof value.preferred_city === "string") {
    profile.preferred_city = value.preferred_city.trim().slice(0, 180) || null;
  }
  if (typeof value.lead_score === "number" && Number.isFinite(value.lead_score)) {
    profile.lead_score = Math.max(0, Math.min(100, Math.round(value.lead_score)));
  }
  if (typeof value.summary === "string") {
    profile.summary = value.summary.trim().slice(0, 1000);
  }
  return profile;
}

export function sanitizeStage(value: unknown): PublicAgentStage {
  const stage = String(value || "discovery") as PublicAgentStage;
  if (["welcome", "discovery", "qualification", "contact", "handoff", "completed"].includes(stage)) {
    return stage;
  }
  return "discovery";
}

export async function getPublicAgentExperience(slug: string): Promise<PublicAgentExperience> {
  return rpc<PublicAgentExperience>("get_public_agent_experience", {
    p_slug: safeSlug(slug),
  });
}

export async function openPublicAgentSession(input: {
  slug: string;
  token: string;
  fingerprint: string;
  attribution: JsonObject;
  landingPage: string | null;
  referrer: string | null;
  userAgent: string | null;
}): Promise<PublicAgentSessionPayload> {
  return rpc<PublicAgentSessionPayload>("open_public_agent_session", {
    p_slug: safeSlug(input.slug),
    p_session_token_hash: hashPublicAgentValue(input.token),
    p_fingerprint_hash: input.fingerprint,
    p_utm: input.attribution,
    p_landing_page: input.landingPage?.slice(0, 1000) || null,
    p_referrer: input.referrer?.slice(0, 1000) || null,
    p_user_agent: input.userAgent?.slice(0, 1000) || null,
  });
}

export async function getPublicAgentContext(input: {
  slug: string;
  token: string;
  fingerprint: string;
}): Promise<PublicAgentContextPayload> {
  return rpc<PublicAgentContextPayload>("get_public_agent_context", {
    p_slug: safeSlug(input.slug),
    p_session_token_hash: hashPublicAgentValue(input.token),
    p_fingerprint_hash: input.fingerprint,
  });
}

export async function appendPublicAgentTurn(input: {
  slug: string;
  token: string;
  fingerprint: string;
  userMessage: string;
  assistantMessage: string;
  stage: PublicAgentStage;
  profile: PublicAgentProfile;
  metadata: JsonObject;
}): Promise<{ stage: PublicAgentStage; profile: PublicAgentProfile; converted: boolean }> {
  return rpc("append_public_agent_turn", {
    p_slug: safeSlug(input.slug),
    p_session_token_hash: hashPublicAgentValue(input.token),
    p_fingerprint_hash: input.fingerprint,
    p_user_message: input.userMessage.trim(),
    p_assistant_message: input.assistantMessage.trim(),
    p_stage: input.stage,
    p_profile: input.profile,
    p_metadata: input.metadata,
  });
}

export async function convertPublicAgentLead(input: {
  slug: string;
  token: string;
  fingerprint: string;
  name: string;
  phone: string;
  email: string | null;
  city: string | null;
  marketingConsent: boolean;
  profile: PublicAgentProfile;
}): Promise<{
  ok: boolean;
  idempotent: boolean;
  contactId: string;
  crmRecordId: string;
  conversationId?: string;
  assignmentId?: string;
  protocol: string;
}> {
  return rpc("convert_public_agent_lead", {
    p_slug: safeSlug(input.slug),
    p_session_token_hash: hashPublicAgentValue(input.token),
    p_fingerprint_hash: input.fingerprint,
    p_name: input.name.trim().slice(0, 180),
    p_phone_e164: normalizeBrazilianPhone(input.phone),
    p_email: sanitizeEmail(input.email),
    p_city: input.city?.trim().slice(0, 180) || null,
    p_marketing_consent: input.marketingConsent,
    p_profile: sanitizeProfile(input.profile),
  });
}
