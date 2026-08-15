import { NextRequest, NextResponse } from "next/server";

import {
  enforcePublicAgentOrigin,
  newPublicAgentToken,
  openPublicAgentSession,
  publicAgentCookieName,
  publicAgentFingerprint,
  PublicAgentServerError,
  sanitizeAttribution,
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

    const cookieName = publicAgentCookieName(body.slug);
    const existing = request.cookies.get(cookieName)?.value || "";
    const token = /^[A-Za-z0-9_-]{40,100}$/.test(existing)
      ? existing
      : newPublicAgentToken();
    const payload = await openPublicAgentSession({
      slug: body.slug,
      token,
      fingerprint: publicAgentFingerprint(request),
      attribution: sanitizeAttribution(body.attribution),
      landingPage: typeof body.landingPage === "string" ? body.landingPage : request.nextUrl.origin,
      referrer: typeof body.referrer === "string" ? body.referrer : request.headers.get("referer"),
      userAgent: request.headers.get("user-agent"),
    });

    const response = NextResponse.json({ ok: true, ...payload }, { headers: HEADERS });
    response.cookies.set(cookieName, token, {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 14,
    });
    return response;
  } catch (error) {
    const status = error instanceof PublicAgentServerError ? error.status : 503;
    const code = error instanceof PublicAgentServerError
      ? error.code
      : "PUBLIC_AGENT_SESSION_UNAVAILABLE";
    if (!(error instanceof PublicAgentServerError)) {
      console.error("Public agent session failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return NextResponse.json({ ok: false, error: code }, { status, headers: HEADERS });
  }
}
