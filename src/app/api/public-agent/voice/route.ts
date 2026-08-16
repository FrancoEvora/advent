import { NextRequest, NextResponse } from "next/server";

import {
  enforcePublicAgentOrigin,
  publicAgentCookieName,
  publicAgentFingerprint,
  PublicAgentServerError,
  synthesizePublicAgentSpeech,
  transcribePublicAgentAudio,
} from "@/lib/public-agent/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
    if (!object(body) || typeof body.slug !== "string" || typeof body.action !== "string") {
      throw new PublicAgentServerError("PUBLIC_AGENT_INPUT_INVALID", 400);
    }
    const token = request.cookies.get(publicAgentCookieName(body.slug))?.value;
    if (!token) throw new PublicAgentServerError("PUBLIC_AGENT_SESSION_NOT_FOUND", 401);
    const fingerprint = publicAgentFingerprint(request);

    if (body.action === "transcribe") {
      if (typeof body.audioBase64 !== "string" || typeof body.mimeType !== "string") {
        throw new PublicAgentServerError("PUBLIC_AGENT_AUDIO_INVALID", 400);
      }
      const result = await transcribePublicAgentAudio({
        slug: body.slug,
        token,
        fingerprint,
        audioBase64: body.audioBase64,
        mimeType: body.mimeType,
      });
      return NextResponse.json({ ok: true, ...result }, { headers: HEADERS });
    }

    if (body.action === "speech") {
      if (typeof body.text !== "string") {
        throw new PublicAgentServerError("PUBLIC_AGENT_SPEECH_INVALID", 400);
      }
      const result = await synthesizePublicAgentSpeech({
        slug: body.slug,
        token,
        fingerprint,
        text: body.text,
      });
      return NextResponse.json({ ok: true, ...result }, { headers: HEADERS });
    }

    throw new PublicAgentServerError("PUBLIC_AGENT_ACTION_INVALID", 400);
  } catch (error) {
    const status = error instanceof PublicAgentServerError ? error.status : 503;
    const code = error instanceof PublicAgentServerError
      ? error.code
      : "PUBLIC_AGENT_VOICE_UNAVAILABLE";
    if (!(error instanceof PublicAgentServerError)) {
      console.error("Public agent voice failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return NextResponse.json({ ok: false, error: code }, { status, headers: HEADERS });
  }
}
