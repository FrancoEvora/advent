import { NextRequest, NextResponse } from "next/server";

import {
  enforceVitoriaOrigin,
  transcribeVitoriaAudio,
  vitoriaCookieName,
  vitoriaFingerprint,
  VitoriaServerError,
} from "@/lib/vitoria-v2/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export async function POST(request: NextRequest) {
  try {
    enforceVitoriaOrigin(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new VitoriaServerError("VITORIA_JSON_REQUIRED", 415);
    }
    const body = await request.json().catch(() => null);
    if (
      !object(body) ||
      typeof body.slug !== "string" ||
      typeof body.audioBase64 !== "string" ||
      typeof body.mimeType !== "string"
    ) {
      throw new VitoriaServerError("VITORIA_AUDIO_INVALID", 400);
    }
    const token = request.cookies.get(vitoriaCookieName(body.slug))?.value;
    if (!token) throw new VitoriaServerError("VITORIA_SESSION_NOT_FOUND", 401);

    const result = await transcribeVitoriaAudio({
      slug: body.slug,
      token,
      fingerprint: vitoriaFingerprint(request),
      audioBase64: body.audioBase64,
      mimeType: body.mimeType,
    });
    return NextResponse.json({ ok: true, ...result }, { headers: HEADERS });
  } catch (error) {
    const status = error instanceof VitoriaServerError ? error.status : 503;
    const code = error instanceof VitoriaServerError ? error.code : "VITORIA_TRANSCRIPTION_UNAVAILABLE";
    return NextResponse.json({ ok: false, error: code }, { status, headers: HEADERS });
  }
}
