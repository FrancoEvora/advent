import { NextRequest, NextResponse } from "next/server";

import {
  enforceVitoriaOrigin,
  newVitoriaToken,
  openVitoriaSession,
  sanitizeVitoriaAttribution,
  vitoriaCookieName,
  vitoriaFingerprint,
  VitoriaServerError,
} from "@/lib/vitoria-v2/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

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
    if (!object(body) || typeof body.slug !== "string") {
      throw new VitoriaServerError("VITORIA_INPUT_INVALID", 400);
    }

    const cookieName = vitoriaCookieName(body.slug);
    const existing = request.cookies.get(cookieName)?.value || "";
    const token = /^[A-Za-z0-9_-]{40,100}$/.test(existing) ? existing : newVitoriaToken();
    const session = await openVitoriaSession({
      slug: body.slug,
      token,
      fingerprint: vitoriaFingerprint(request),
      attribution: sanitizeVitoriaAttribution(body.attribution),
      landingPage: typeof body.landingPage === "string" ? body.landingPage : null,
      referrer: typeof body.referrer === "string" ? body.referrer : request.headers.get("referer"),
      userAgent: request.headers.get("user-agent"),
    });

    const response = NextResponse.json({ ok: true, ...session }, { headers: HEADERS });
    response.cookies.set(cookieName, token, {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 14,
    });
    return response;
  } catch (error) {
    const status = error instanceof VitoriaServerError ? error.status : 503;
    const code = error instanceof VitoriaServerError ? error.code : "VITORIA_SESSION_UNAVAILABLE";
    if (!(error instanceof VitoriaServerError)) {
      console.error("Vitoria immersive session failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return NextResponse.json({ ok: false, error: code }, { status, headers: HEADERS });
  }
}
