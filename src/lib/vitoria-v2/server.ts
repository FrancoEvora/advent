import { createHash, randomBytes } from "node:crypto";

import type { NextRequest } from "next/server";

import type {
  VitoriaExperience,
  VitoriaProfile,
  VitoriaReply,
  VitoriaSession,
} from "./types";

type JsonObject = Record<string, unknown>;
type GatewayEnvelope<T> = { ok: true; data: T } | { ok: false; error?: string };

const DEFAULT_SUPABASE_URL = "https://qsdffayasuzsmngteika.supabase.co";
const DEFAULT_PUBLISHABLE_KEY = "sb_publishable_nMCXNDXMvU0EbMSSmnEfQg_0uE_lVOW";

export class VitoriaServerError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 503) {
    super(code);
    this.name = "VitoriaServerError";
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
    throw new VitoriaServerError("VITORIA_SLUG_INVALID", 400);
  }
  return slug;
}

function supabaseUrl(): URL {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || DEFAULT_SUPABASE_URL;
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    throw new VitoriaServerError("VITORIA_GATEWAY_NOT_CONFIGURED", 503);
  }
  if (base.protocol !== "https:") {
    throw new VitoriaServerError("VITORIA_GATEWAY_NOT_CONFIGURED", 503);
  }
  return base;
}

function publishableKey(): string {
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() || DEFAULT_PUBLISHABLE_KEY;
  if (key.length < 20 || /\s/.test(key)) {
    throw new VitoriaServerError("VITORIA_GATEWAY_NOT_CONFIGURED", 503);
  }
  return key;
}

function gatewayUrl(): URL {
  return new URL("/functions/v1/enterprise-public-agent-v2-gateway", supabaseUrl());
}

function translateGatewayError(code: string, status: number): VitoriaServerError {
  if (status === 404 || code.includes("NOT_FOUND")) {
    return new VitoriaServerError("VITORIA_NOT_FOUND", 404);
  }
  if (status === 429 || code.includes("RATE_LIMIT")) {
    return new VitoriaServerError("VITORIA_RATE_LIMIT", 429);
  }
  if (status === 409 || code.includes("INACTIVE")) {
    return new VitoriaServerError("VITORIA_SESSION_INACTIVE", 409);
  }
  if (status === 400 || code.includes("INVALID") || code.includes("CONSENT")) {
    return new VitoriaServerError(code || "VITORIA_INPUT_INVALID", 400);
  }
  return new VitoriaServerError(code || "VITORIA_GATEWAY_UNAVAILABLE", 503);
}

async function gatewayRequest<T>(
  action: string,
  payload: JsonObject,
  timeoutMs = 45_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const key = publishableKey();
    const response = await fetch(gatewayUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
        "Content-Type": "application/json",
        "X-Client-Info": "evora-vitoria-immersive/2.0",
      },
      body: JSON.stringify({ action, ...payload }),
      cache: "no-store",
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as GatewayEnvelope<T> | null;
    if (!body || !response.ok || body.ok !== true) {
      const code = body && body.ok === false && typeof body.error === "string"
        ? body.error
        : `VITORIA_GATEWAY_HTTP_${response.status}`;
      throw translateGatewayError(code, response.status);
    }
    return body.data;
  } catch (error) {
    if (error instanceof VitoriaServerError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new VitoriaServerError("VITORIA_GATEWAY_TIMEOUT", 504);
    }
    throw new VitoriaServerError("VITORIA_GATEWAY_NETWORK_FAILURE", 503);
  } finally {
    clearTimeout(timer);
  }
}

export function hashVitoriaValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function newVitoriaToken(): string {
  return randomBytes(32).toString("base64url");
}

export function vitoriaCookieName(slug: string): string {
  return `evora_vitoria_${safeSlug(slug).replace(/-/g, "_")}`;
}

export function vitoriaFingerprint(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
  const userAgent = request.headers.get("user-agent")?.slice(0, 500) || "unknown";
  const language = request.headers.get("accept-language")?.slice(0, 120) || "unknown";
  return hashVitoriaValue(`${ip}\n${userAgent}\n${language}`);
}

export function enforceVitoriaOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  try {
    const parsed = new URL(origin);
    if (parsed.host !== request.nextUrl.host || parsed.protocol !== request.nextUrl.protocol) {
      throw new Error("origin mismatch");
    }
  } catch {
    throw new VitoriaServerError("VITORIA_ORIGIN_REJECTED", 403);
  }
}

export function sanitizeVitoriaAttribution(value: unknown): JsonObject {
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

export async function getVitoriaExperience(slug: string): Promise<VitoriaExperience> {
  return gatewayRequest<VitoriaExperience>("experience", { slug: safeSlug(slug) });
}

export async function openVitoriaSession(input: {
  slug: string;
  token: string;
  fingerprint: string;
  attribution: JsonObject;
  landingPage: string | null;
  referrer: string | null;
  userAgent: string | null;
}): Promise<VitoriaSession> {
  return gatewayRequest<VitoriaSession>("session", {
    slug: safeSlug(input.slug),
    tokenHash: hashVitoriaValue(input.token),
    fingerprintHash: input.fingerprint,
    attribution: input.attribution,
    landingPage: input.landingPage?.slice(0, 1000) || null,
    referrer: input.referrer?.slice(0, 1000) || null,
    userAgent: input.userAgent?.slice(0, 1000) || null,
  });
}

export async function sendVitoriaMessage(input: {
  slug: string;
  token: string;
  fingerprint: string;
  message: string;
}): Promise<VitoriaReply> {
  const message = input.message.trim();
  if (!message || message.length > 1200) {
    throw new VitoriaServerError("VITORIA_MESSAGE_INVALID", 400);
  }
  return gatewayRequest<VitoriaReply>("message", {
    slug: safeSlug(input.slug),
    tokenHash: hashVitoriaValue(input.token),
    fingerprintHash: input.fingerprint,
    message,
  }, 90_000);
}

export async function transcribeVitoriaAudio(input: {
  slug: string;
  token: string;
  fingerprint: string;
  audioBase64: string;
  mimeType: string;
}): Promise<{ text: string }> {
  if (input.audioBase64.length > 14_000_000) {
    throw new VitoriaServerError("VITORIA_AUDIO_TOO_LARGE", 413);
  }
  return gatewayRequest("transcribe", {
    slug: safeSlug(input.slug),
    tokenHash: hashVitoriaValue(input.token),
    fingerprintHash: input.fingerprint,
    audioBase64: input.audioBase64,
    mimeType: input.mimeType.slice(0, 100),
  }, 90_000);
}

export async function synthesizeVitoriaSpeech(input: {
  slug: string;
  token: string;
  fingerprint: string;
  text: string;
}): Promise<{ audioBase64: string; mimeType: string }> {
  const text = input.text.trim().slice(0, 1800);
  if (!text) throw new VitoriaServerError("VITORIA_SPEECH_TEXT_INVALID", 400);
  return gatewayRequest("speech", {
    slug: safeSlug(input.slug),
    tokenHash: hashVitoriaValue(input.token),
    fingerprintHash: input.fingerprint,
    text,
  }, 90_000);
}

export async function requestVitoriaHouseSimulation(input: {
  slug: string;
  token: string;
  fingerprint: string;
  instructions: string;
  profile: VitoriaProfile;
}): Promise<VitoriaReply> {
  return gatewayRequest("house_simulation", {
    slug: safeSlug(input.slug),
    tokenHash: hashVitoriaValue(input.token),
    fingerprintHash: input.fingerprint,
    instructions: input.instructions.trim().slice(0, 1500),
    profile: input.profile,
  }, 120_000);
}
