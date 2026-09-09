import { NextRequest, NextResponse } from "next/server";

import {
  enforcePublicAgentOrigin,
  newPublicAgentToken,
  navigateBiaConversation,
  openPublicAgentSession,
  publicAgentCookieName,
  publicAgentDeviceCookieName,
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
const PUBLIC_CONVERSATION_MAX_AGE = 60 * 60 * 24 * 14;

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
    const slug = body.slug;
    const operation = body.operation ?? "resume";
    if (!["resume", "new", "select", "older"].includes(String(operation))
      || operation === "select" && (typeof body.conversationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.conversationId))
      || operation === "older" && (typeof body.beforeId !== "string" || !/^[1-9][0-9]{0,18}$/.test(body.beforeId))) {
      throw new PublicAgentServerError("PUBLIC_AGENT_INPUT_INVALID", 400);
    }

    const cookieName = publicAgentCookieName(slug);
    const existing = request.cookies.get(cookieName)?.value || "";
    const existingDevice = request.cookies.get(publicAgentDeviceCookieName())?.value || "";
    const deviceToken = /^[A-Za-z0-9_-]{40,100}$/.test(existingDevice)
      ? existingDevice
      : newPublicAgentToken();
    let token = /^[A-Za-z0-9_-]{40,100}$/.test(existing)
      ? existing
      : newPublicAgentToken();
    const sessionInput = () => ({
      slug,
      token,
      fingerprint: publicAgentFingerprint(request, deviceToken),
      attribution: sanitizeAttribution(body.attribution),
      landingPage: typeof body.landingPage === "string" ? body.landingPage : request.nextUrl.origin,
      referrer: typeof body.referrer === "string" ? body.referrer : request.headers.get("referer"),
      userAgent: request.headers.get("user-agent"),
    });
    let payload: Awaited<ReturnType<typeof openPublicAgentSession>>;
    if (operation !== "resume") {
      if (!/^[A-Za-z0-9_-]{40,100}$/.test(existing) || !/^[A-Za-z0-9_-]{40,100}$/.test(existingDevice)) {
        throw new PublicAgentServerError("PUBLIC_AGENT_SESSION_NOT_FOUND", 401);
      }
      const nextToken = operation === "older" ? undefined : newPublicAgentToken();
      payload = await navigateBiaConversation({ slug, token: existing,
        fingerprint: publicAgentFingerprint(request, existingDevice), newToken: nextToken,
        conversationId: operation === "select" ? String(body.conversationId) : null,
        beforeId: operation === "older" ? String(body.beforeId) : undefined });
      if (nextToken) token = nextToken;
    } else try {
      payload = await openPublicAgentSession(sessionInput());
    } catch (error) {
      const canRotate = error instanceof PublicAgentServerError
        && (
          ["PUBLIC_AGENT_SESSION_INACTIVE", "PUBLIC_AGENT_SESSION_NOT_FOUND"].includes(error.code)
          || error.code === "PUBLIC_AGENT_NOT_FOUND"
          || error.status === 404
        );
      if (!canRotate) throw error;
      token = newPublicAgentToken();
      payload = await openPublicAgentSession(sessionInput());
    }

    const response = NextResponse.json({ ok: true, ...payload }, { headers: HEADERS });
    if (operation !== "older") response.cookies.set(cookieName, token, {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: PUBLIC_CONVERSATION_MAX_AGE,
    });
    response.cookies.set(publicAgentDeviceCookieName(), deviceToken, {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: PUBLIC_CONVERSATION_MAX_AGE,
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
