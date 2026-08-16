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

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

export async function POST(request: NextRequest) {
  try {
    enforcePublicAgentOrigin(request);
    const form = await request.formData();
    const slug = form.get("slug");
    const audio = form.get("audio");
    if (typeof slug !== "string" || !(audio instanceof File)) {
      throw new PublicAgentServerError("PUBLIC_AGENT_AUDIO_INVALID", 400);
    }
    if (audio.size < 200 || audio.size > 2_100_000) {
      throw new PublicAgentServerError("PUBLIC_AGENT_MEDIA_TOO_LARGE", 413);
    }
    const token = request.cookies.get(publicAgentCookieName(slug))?.value;
    if (!token) throw new PublicAgentServerError("PUBLIC_AGENT_SESSION_NOT_FOUND", 401);

    const result = await transcribePublicAgentAudio({
      slug,
      token,
      fingerprint: publicAgentFingerprint(request),
      mimeType: audio.type || "audio/webm",
      audio: await audio.arrayBuffer(),
    });
    return NextResponse.json({ ok: true, ...result }, { headers: HEADERS });
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
