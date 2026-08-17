import { NextRequest, NextResponse } from "next/server";

import {
  enforcePublicAgentOrigin,
  publicAgentCookieName,
  publicAgentFingerprint,
  PublicAgentServerError,
  respondPublicAgentMessage,
} from "@/lib/public-agent/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

type JsonObject = Record<string, unknown>;
const CLIENT_MESSAGE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    if (
      !object(body)
      || typeof body.slug !== "string"
      || typeof body.message !== "string"
      || typeof body.clientMessageId !== "string"
      || !CLIENT_MESSAGE_ID.test(body.clientMessageId)
      || (
        body.source === "audio"
        && (
          typeof body.transcriptionRequestId !== "string"
          || !CLIENT_MESSAGE_ID.test(body.transcriptionRequestId)
        )
      )
    ) {
      throw new PublicAgentServerError("PUBLIC_AGENT_INPUT_INVALID", 400);
    }
    const message = body.message.trim();
    if (message.length < 1 || message.length > 800) {
      throw new PublicAgentServerError("PUBLIC_AGENT_MESSAGE_INVALID", 400);
    }

    const token = request.cookies.get(publicAgentCookieName(body.slug))?.value;
    if (!token) {
      throw new PublicAgentServerError("PUBLIC_AGENT_SESSION_NOT_FOUND", 401);
    }

    const result = await respondPublicAgentMessage({
      slug: body.slug,
      token,
      fingerprint: publicAgentFingerprint(request),
      message,
      clientMessageId: body.clientMessageId,
      source: body.source === "audio" ? "audio" : "text",
      transcriptionRequestId: body.source === "audio"
        ? String(body.transcriptionRequestId)
        : null,
    });

    return NextResponse.json(
      { ok: true, ...result },
      { status: result.status === "processing" ? 202 : 200, headers: HEADERS },
    );
  } catch (error) {
    const status = error instanceof PublicAgentServerError ? error.status : 503;
    const code = error instanceof PublicAgentServerError
      ? error.code
      : "PUBLIC_AGENT_MESSAGE_UNAVAILABLE";
    if (!(error instanceof PublicAgentServerError)) {
      console.error("Public agent message failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return NextResponse.json({ ok: false, error: code }, { status, headers: HEADERS });
  }
}
