import { NextRequest, NextResponse } from "next/server";

import {
  enforcePublicAgentOrigin,
  publicAgentCookieName,
  publicAgentFingerprint,
  PublicAgentServerError,
  transcribePublicAgentAudio,
} from "@/lib/public-agent/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

const MAX_AUDIO_BYTES = 2_100_000;
const MAX_MULTIPART_BYTES = 3_000_000;
const CLIENT_MESSAGE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
]);
const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

export async function POST(request: NextRequest) {
  try {
    enforcePublicAgentOrigin(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
      throw new PublicAgentServerError("PUBLIC_AGENT_MULTIPART_REQUIRED", 415);
    }

    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTIPART_BYTES) {
      throw new PublicAgentServerError("PUBLIC_AGENT_AUDIO_TOO_LARGE", 413);
    }

    const form = await request.formData().catch(() => null);
    const audio = form?.get("audio");
    const slug = String(form?.get("slug") || "").trim();
    const clientMessageId = String(form?.get("clientMessageId") || "").trim();
    const durationSeconds = Number(form?.get("durationSeconds"));
    if (
      !(audio instanceof File)
      || !audio.size
      || audio.size > MAX_AUDIO_BYTES
      || !slug
      || !CLIENT_MESSAGE_ID.test(clientMessageId)
      || !Number.isFinite(durationSeconds)
      || durationSeconds <= 0
      || durationSeconds > 90
    ) {
      throw new PublicAgentServerError("PUBLIC_AGENT_AUDIO_INVALID", 400);
    }

    const mimeType = audio.type.toLowerCase().split(";")[0];
    if (!AUDIO_TYPES.has(mimeType)) {
      throw new PublicAgentServerError("PUBLIC_AGENT_AUDIO_TYPE_INVALID", 415);
    }

    const token = request.cookies.get(publicAgentCookieName(slug))?.value;
    if (!token) {
      throw new PublicAgentServerError("PUBLIC_AGENT_SESSION_NOT_FOUND", 401);
    }

    const bytes = new Uint8Array(await audio.arrayBuffer());
    const result = await transcribePublicAgentAudio({
      slug,
      token,
      fingerprint: publicAgentFingerprint(request),
      clientMessageId,
      mimeType,
      durationSeconds,
      bytes,
    });

    return NextResponse.json(
      { ok: true, ...result },
      { status: result.status === "processing" ? 202 : 200, headers: HEADERS },
    );
  } catch (error) {
    const status = error instanceof PublicAgentServerError ? error.status : 503;
    const code = error instanceof PublicAgentServerError
      ? error.code
      : "PUBLIC_AGENT_TRANSCRIPTION_UNAVAILABLE";
    if (!(error instanceof PublicAgentServerError)) {
      console.error("Public agent transcription failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return NextResponse.json({ ok: false, error: code }, { status, headers: HEADERS });
  }
}
