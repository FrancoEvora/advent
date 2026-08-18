import { createHash, randomBytes } from "node:crypto";

import type { NextRequest } from "next/server";

import type {
  PublicAgentAction,
  PublicAgentExperience,
  PublicAgentSessionPayload,
  PublicAgentStage,
  PublicAgentTranscriptionResponse,
  PublicAgentTurnResponse,
} from "./types";

type JsonObject = Record<string, unknown>;
type EdgeEnvelope<T> = { ok: true; data: T } | { ok: false; error?: string };

const PUBLIC_AGENT_DEVICE_COOKIE = "evora_agent_device";
const EDGE_MAX_ATTEMPTS = 4;
const EDGE_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

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
  if (
    base.protocol !== "https:"
    || base.username
    || base.password
    || base.search
    || base.hash
    || (base.pathname !== "/" && base.pathname !== "")
  ) {
    throw new PublicAgentServerError("PUBLIC_AGENT_EDGE_NOT_CONFIGURED", 503);
  }
  return new URL("/functions/v1/enterprise-bia-agent-gateway", base);
}

function publishableKey(): string {
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() || "";
  if (key.length < 32 || key.length > 512 || /\s/.test(key)) {
    throw new PublicAgentServerError("PUBLIC_AGENT_EDGE_NOT_CONFIGURED", 503);
  }
  return key;
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
  if (status === 410 || code.includes("SESSION_INACTIVE")) {
    return new PublicAgentServerError("PUBLIC_AGENT_SESSION_INACTIVE", 410);
  }
  if (status === 409) return new PublicAgentServerError(code || "PUBLIC_AGENT_CONFLICT", 409);
  if (status === 400 || code.includes("INVALID") || code.includes("CONSENT")) {
    return new PublicAgentServerError(code || "PUBLIC_AGENT_INPUT_INVALID", 400);
  }
  return new PublicAgentServerError(code || "PUBLIC_AGENT_EDGE_UNAVAILABLE", 503);
}

function retryDelayMs(response: Response | null, attempt: number) {
  const retryAfter = response?.headers.get("retry-after")?.trim();
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return Math.min(2_500, Math.max(250, Number(retryAfter) * 1_000));
  }
  return Math.min(2_000, 300 * 2 ** Math.max(0, attempt - 1));
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function edgeRequest<T>(action: PublicAgentAction, payload: JsonObject, timeoutMs = 30_000): Promise<T> {
  const startedAt = Date.now();
  let lastError: PublicAgentServerError | null = null;

  for (let attempt = 1; attempt <= EDGE_MAX_ATTEMPTS; attempt += 1) {
    const elapsed = Date.now() - startedAt;
    const remaining = timeoutMs - elapsed;
    if (remaining <= 750) break;

    const controller = new AbortController();
    const attemptTimeout = Math.min(remaining, action === "message" ? 30_000 : 20_000);
    const timer = setTimeout(() => controller.abort(), attemptTimeout);
    let response: Response | null = null;

    try {
      response = await fetch(edgeEndpoint(), {
        method: "POST",
        headers: {
          apikey: publishableKey(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action, ...payload }),
        cache: "no-store",
        signal: controller.signal,
      });

      const body = (await response.json().catch(() => null)) as EdgeEnvelope<T> | null;
      if (body && response.ok && body.ok === true) return body.data;

      const code = body && body.ok === false && typeof body.error === "string"
        ? body.error
        : `PUBLIC_AGENT_EDGE_HTTP_${response.status}`;
      const mapped = edgeError(code, response.status);
      lastError = mapped;

      if (!EDGE_RETRYABLE_STATUS.has(response.status) || attempt >= EDGE_MAX_ATTEMPTS) {
        throw mapped;
      }

      console.warn("Public agent edge transient failure", {
        action,
        attempt,
        status: response.status,
        code: mapped.code,
      });
    } catch (error) {
      if (error instanceof PublicAgentServerError) {
        if (!EDGE_RETRYABLE_STATUS.has(error.status) || attempt >= EDGE_MAX_ATTEMPTS) throw error;
        lastError = error;
      } else if (error instanceof Error && error.name === "AbortError") {
        lastError = new PublicAgentServerError("PUBLIC_AGENT_EDGE_TIMEOUT", 503);
        if (attempt >= EDGE_MAX_ATTEMPTS) throw lastError;
        console.warn("Public agent edge transient failure", {
          action,
          attempt,
          status: 503,
          code: lastError.code,
        });
      } else {
        lastError = new PublicAgentServerError("PUBLIC_AGENT_EDGE_NETWORK_FAILURE", 503);
        if (attempt >= EDGE_MAX_ATTEMPTS) throw lastError;
        console.warn("Public agent edge transient failure", {
          action,
          attempt,
          status: 503,
          code: lastError.code,
        });
      }
    } finally {
      clearTimeout(timer);
    }

    const remainingAfterAttempt = timeoutMs - (Date.now() - startedAt);
    const delay = retryDelayMs(response, attempt);
    if (remainingAfterAttempt <= delay + 500) break;
    await wait(delay);
  }

  throw lastError || new PublicAgentServerError("PUBLIC_AGENT_EDGE_UNAVAILABLE", 503);
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

export function publicAgentDeviceCookieName(): string {
  return PUBLIC_AGENT_DEVICE_COOKIE;
}

export function publicAgentFingerprint(request: NextRequest, deviceToken?: string): string {
  const token = deviceToken || request.cookies.get(PUBLIC_AGENT_DEVICE_COOKIE)?.value || "";
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) {
    throw new PublicAgentServerError("PUBLIC_AGENT_DEVICE_NOT_FOUND", 401);
  }
  return hashPublicAgentValue(token);
}

export function enforcePublicAgentOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  try {
    const parsed = new URL(origin);
    if (parsed.host !== request.nextUrl.host || parsed.protocol !== request.nextUrl.protocol) throw new Error("origin mismatch");
  } catch {
    throw new PublicAgentServerError("PUBLIC_AGENT_ORIGIN_REJECTED", 403);
  }
}

export function sanitizeAttribution(value: unknown): JsonObject {
  if (!object(value)) return {};
  const allowed = [
    "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid",
    "campaign_id", "adset_id", "ad_id", "ad_name", "creative_id", "placement", "publisher_platform",
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
  clientMessageId: string;
  source: "text" | "audio";
  transcriptionRequestId?: string | null;
}): Promise<PublicAgentTurnResponse> {
  return edgeRequest<PublicAgentTurnResponse>("message", {
    slug: safeSlug(input.slug),
    tokenHash: hashPublicAgentValue(input.token),
    fingerprintHash: input.fingerprint,
    message: input.message.trim(),
    clientMessageId: input.clientMessageId,
    source: input.source,
    transcriptionRequestId: input.transcriptionRequestId || null,
  }, 90_000);
}

export async function transcribePublicAgentAudio(input: {
  slug: string;
  token: string;
  fingerprint: string;
  clientMessageId: string;
  mimeType: string;
  durationSeconds: number;
  bytes: Uint8Array;
}): Promise<PublicAgentTranscriptionResponse> {
  return edgeRequest<PublicAgentTranscriptionResponse>("transcribe", {
    slug: safeSlug(input.slug),
    tokenHash: hashPublicAgentValue(input.token),
    fingerprintHash: input.fingerprint,
    clientMessageId: input.clientMessageId,
    mimeType: input.mimeType,
    durationSeconds: input.durationSeconds,
    audioBase64: Buffer.from(input.bytes).toString("base64"),
  }, 65_000);
}
