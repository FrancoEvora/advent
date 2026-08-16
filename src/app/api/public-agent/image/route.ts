import { NextRequest, NextResponse } from "next/server";

import {
  enforcePublicAgentOrigin,
  generatePublicAgentHouseImage,
  publicAgentCookieName,
  publicAgentFingerprint,
  PublicAgentServerError,
  sanitizeProfile,
} from "@/lib/public-agent/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 150;

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
    if (!object(body) || typeof body.slug !== "string" || typeof body.brief !== "string") {
      throw new PublicAgentServerError("PUBLIC_AGENT_IMAGE_BRIEF_INVALID", 400);
    }
    const token = request.cookies.get(publicAgentCookieName(body.slug))?.value;
    if (!token) throw new PublicAgentServerError("PUBLIC_AGENT_SESSION_NOT_FOUND", 401);
    const result = await generatePublicAgentHouseImage({
      slug: body.slug,
      token,
      fingerprint: publicAgentFingerprint(request),
      brief: body.brief,
      profile: sanitizeProfile(body.profile),
    });
    return NextResponse.json({ ok: true, ...result }, { headers: HEADERS });
  } catch (error) {
    const status = error instanceof PublicAgentServerError ? error.status : 503;
    const code = error instanceof PublicAgentServerError ? error.code : "PUBLIC_AGENT_IMAGE_UNAVAILABLE";
    if (!(error instanceof PublicAgentServerError)) {
      console.error("Public agent image failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
    }
    return NextResponse.json({ ok: false, error: code }, { status, headers: HEADERS });
  }
}
