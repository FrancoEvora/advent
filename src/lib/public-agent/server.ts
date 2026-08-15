import { createHash, randomBytes } from "node:crypto";

import type { NextRequest } from "next/server";

import { CrmAiConfigError, getCrmAiWorkerToken } from "@/lib/ai/config";
import type {
  PublicAgentExperience,
  PublicAgentProfile,
  PublicAgentSessionPayload,
  PublicAgentStage,
} from "./types";

type JsonObject = Record<string, unknown>;
type EdgeEnvelope<T> = { ok: true; data: T } | { ok: false; error?: string };

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

function edgeEndpoint(): URL {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!raw) throw new PublicAgentServerError("PUBLIC_AGENT_EDGE_NOT_CONFIGURED", 503);
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    throw new PublicAgentServerError("PUBLIC_AGENT_EDGE_NOT_CONFIGURED", 503);
  }
  if (base.protocol !== "https:") {
    throw new PublicAgentServerError("PUBLIC_AGENT_EDGE_NOT_CONFIGURED", 503);
  }
  return new URL("/functions/v1/enterprise-public-agent-gateway", base);
}

function edgeBearer(): string {
  const oidc = process.env.VERCEL_OIDC_TOKEN?.trim();
  if (oidc && oidc.length >= 100 && oidc.split(".").length === 3 && !/\s/.test(oidc)) {
    return oidc;
  }
  try {
    return getCrmAiWorkerToken();
  } catch (error) {
    if (error instanceof CrmAiConfigError) {
      throw new PublicAgentServerError("PUBLIC_AGENT_EDGE_NOT_CONFIGURED", 503);
    }
    throw error;
  }
}

function edgeError(code: string, status: number): PublicAgentServerError {
  if (status === 401 || code === "PUBLIC_AGENT_AUTH_REQUIRED") {
    return new PublicAgentServerError("PUBLIC_AGENT_EDGE_AUTH_FAILED", 503);
  }
  if (status === 404 || code === "PUBLIC_AGENT_NOT_FOUND") {
    return new PublicAgentServerError("PUBLIC_AGENT_NOT_FOUND", 404);
  }
  if (status === 429 || code.includes("RATE_LIMIT")) {
    return new PublicAgentServerError("PUBLIC_AGENT_RATE_LIMIT", 429);
  }
  if (status === 409 || code.includes("INACTIVE")) {
    return new PublicAgentServerError("PUBLIC_AGENT_SESSION_INACTIVE", 409);
  }
  if (status === 400 || code.includes("INVALID") || code.includes("CONSENT")) {
    return new PublicAgentServerError(code || "PUBLIC_AGENT_INPUT_INVALID", 400);
  }
  return new PublicAgentServerError(code || "PUBLIC_AGENT_EDGE_UNAVAILABLE", 503);
}

async function edgeRequest<T>(action: string, payload: JsonObject, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(edgeEndpoint(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${edgeBearer()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action, ...payload }),
      cache: "no-store",
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as EdgeEnvelope<T> | null;
    if (!body || !response.ok || body.ok !== true) {
      const code = body && body.ok === false && typeof body.error === "string"
        ? body.error
        : `PUBLIC_AGENT_EDGE_HTTP_${response.status}`;
      throw edgeError(code, response.status);
    }
    return body.data;
  } catch (error) {
    if (error instanceof PublicAgentServerError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new PublicAgentServerError("PUBLIC_AGENT_EDGE_TIMEOUT", 503);
    }
    throw new PublicAgentServerError("PUBLIC_AGENT_EDGE_NETWORK_FAILURE", 503);
  } finally {
    clearTimeout(timer);
  }
}

export function hashPublicAgentValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
  if (["morar", "investir", "conhecer", "unknown"].includes(String(value.intent))) {
    profile.intent = value.intent as PublicAgentProfile["intent"];
  }
  if (["ate_3_meses", "3_a_6_meses", "6_a_12_meses", "mais_de_12_meses", "unknown"].includes(String(value.purchase_horizon))) {
    profile.purchase_horizon = value.purchase_horizon as PublicAgentProfile["purchase_horizon"];
  }
  for (const key of ["budget_min", "budget_max", "preferred_area_min", "preferred_area_max", "payment_capacity"] as const) {
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
  return ["welcome", "discovery", "qualification", "contact", "handoff", "completed"].includes(stage)
    ? stage
    : "discovery";
}

export async function getPublicAgentExperience(slug: string): Promise<PublicAgentExperience> {
  return edgeRequest<PublicAgentExperience>("experience", { slug: safeSlug(slug) });
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
  return edgeRequest<PublicAgentSessionPayload>("session", {
    slug: safeSlug(input.slug),
    tokenHash: hashPublicAgentValue(input.token),
    fingerprintHash: input.fingerprint,
    attribution: input.attribution,
    landingPage: input.landingPage?.slice(0, 1000) || null,
    referrer: input.referrer?.slice(0, 1000) || null,
    userAgent: input.userAgent?.slice(0, 1000) || null,
  });
}

export async function respondPublicAgentMessage(input: {
  slug: string;
  token: string;
  fingerprint: string;
  message: string;
}): Promise<{
  reply: string;
  stage: PublicAgentStage;
  profile: PublicAgentProfile;
  requestContact: boolean;
  handoffRequested: boolean;
  quickReplies: string[];
  converted: boolean;
  degraded: boolean;
}> {
  return edgeRequest("message", {
    slug: safeSlug(input.slug),
    tokenHash: hashPublicAgentValue(input.token),
    fingerprintHash: input.fingerprint,
    message: input.message.trim(),
  }, 60_000);
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
  return edgeRequest("lead", {
    slug: safeSlug(input.slug),
    tokenHash: hashPublicAgentValue(input.token),
    fingerprintHash: input.fingerprint,
    name: input.name.trim().slice(0, 180),
    phone: normalizeBrazilianPhone(input.phone),
    email: sanitizeEmail(input.email),
    city: input.city?.trim().slice(0, 180) || null,
    marketingConsent: input.marketingConsent,
    profile: sanitizeProfile(input.profile),
  });
}
