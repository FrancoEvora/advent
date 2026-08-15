import { NextRequest, NextResponse } from "next/server";

import {
  enforcePublicAgentOrigin,
  hashPublicAgentValue,
  publicAgentCookieName,
  publicAgentFingerprint,
  PublicAgentServerError,
} from "@/lib/public-agent/server";
import { publicAgentV2Transcribe, PublicAgentV2Error } from "@/lib/public-agent/v2-edge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};
const MAX_BASE64_CHARS = 8_500_000;

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);

export async function POST(request: NextRequest) {
  try {
    enforcePublicAgentOrigin(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new PublicAgentServerError("PUBLIC_AGENT_JSON_REQUIRED", 415);
    }
    const body = await request.json().catch(() => null);
    if (!object(body) || typeof body.slug !== "string" || typeof body.audioBase64 !== "string") {
      throw new PublicAgentServerError("PUBLIC_AGENT_AUDIO_INVALID", 400);
    }
    if (body.audioBase64.length < 40 || body.audioBase64.length > MAX_BASE64_CHARS) {
      throw new PublicAgentServerError("PUBLIC_AGENT_AUDIO_INVALID", 400);
    }
    const token = request.cookies.get(publicAgentCookieName(body.slug))?.value;
    if (!token) throw new PublicAgentServerError("PUBLIC_AGENT_SESSION_NOT_FOUND", 401);
    const result = await publicAgentV2Transcribe({
      slug: body.slug,
      tokenHash: hashPublicAgentValue(token),
      fingerprintHash: publicAgentFingerprint(request),
      audioBase64: body.audioBase64,
      mimeType: typeof body.mimeType === "string" ? body.mimeType.slice(0, 80) : "audio/webm",
    });
    return NextResponse.json({ ok: true, ...result }, { headers: HEADERS });
  } catch (error) {
    const status = error instanceof PublicAgentServerError || error instanceof PublicAgentV2Error ? error.status : 503;
    const code = error instanceof PublicAgentServerError || error instanceof PublicAgentV2Error ? error.code : "PUBLIC_AGENT_AUDIO_UNAVAILABLE";
    return NextResponse.json({ ok: false, error: code }, { status, headers: HEADERS });
  }
}
