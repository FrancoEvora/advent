import { NextRequest, NextResponse } from "next/server";

import {
  convertPublicAgentLead,
  enforcePublicAgentOrigin,
  publicAgentCookieName,
  publicAgentFingerprint,
  PublicAgentServerError,
  sanitizeProfile,
} from "@/lib/public-agent/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function POST(request: NextRequest) {
  try {
    enforcePublicAgentOrigin(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new PublicAgentServerError("PUBLIC_AGENT_JSON_REQUIRED", 415);
    }

    const body = await request.json().catch(() => null);
    if (!object(body) || typeof body.slug !== "string") {
      throw new PublicAgentServerError("PUBLIC_AGENT_INPUT_INVALID", 400);
    }
    if (typeof body.website === "string" && body.website.trim().length > 0) {
      throw new PublicAgentServerError("PUBLIC_AGENT_BOT_REJECTED", 400);
    }
    if (typeof body.name !== "string" || body.name.trim().length < 2) {
      throw new PublicAgentServerError("PUBLIC_AGENT_NAME_INVALID", 400);
    }
    if (typeof body.phone !== "string" || body.phone.trim().length < 10) {
      throw new PublicAgentServerError("PUBLIC_AGENT_PHONE_INVALID", 400);
    }
    if (body.marketingConsent !== true) {
      throw new PublicAgentServerError("PUBLIC_AGENT_CONSENT_REQUIRED", 400);
    }

    const token = request.cookies.get(publicAgentCookieName(body.slug))?.value;
    if (!token) {
      throw new PublicAgentServerError("PUBLIC_AGENT_SESSION_NOT_FOUND", 401);
    }

    const result = await convertPublicAgentLead({
      slug: body.slug,
      token,
      fingerprint: publicAgentFingerprint(request),
      name: body.name,
      phone: body.phone,
      email: typeof body.email === "string" ? body.email : null,
      city: typeof body.city === "string" ? body.city : null,
      marketingConsent: true,
      profile: sanitizeProfile(body.profile),
    });

    return NextResponse.json({ ok: true, ...result }, { headers: HEADERS });
  } catch (error) {
    const status = error instanceof PublicAgentServerError ? error.status : 503;
    const code = error instanceof PublicAgentServerError
      ? error.code
      : "PUBLIC_AGENT_LEAD_UNAVAILABLE";
    if (!(error instanceof PublicAgentServerError)) {
      console.error("Public agent lead conversion failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return NextResponse.json({ ok: false, error: code }, { status, headers: HEADERS });
  }
}
