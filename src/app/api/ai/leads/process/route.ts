import { randomUUID, timingSafeEqual } from "node:crypto";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  CrmAiConfigError,
  getCrmAiWorkerToken,
  isCrmAiShadowEnabled,
} from "@/lib/ai/config";
import { processCrmAiShadowQueue } from "@/lib/ai/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function requestedLimit(request: NextRequest): number | undefined {
  const raw = request.nextUrl.searchParams.get("limit");
  if (!raw) return undefined;
  if (!/^\d{1,2}$/.test(raw)) return Number.NaN;
  const value = Number(raw);
  return value >= 1 && value <= 25 ? value : Number.NaN;
}

function bearerToken(request: NextRequest): string | null {
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  return match?.[1] || null;
}

function secureEqual(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function isAuthorized(request: NextRequest): boolean {
  const candidate = bearerToken(request);
  if (!candidate) return false;
  return secureEqual(candidate, getCrmAiWorkerToken());
}

export async function POST(request: NextRequest) {
  const correlationId = randomUUID();
  try {
    if (!isAuthorized(request)) {
      return NextResponse.json(
        { ok: false, error: "PROCESS_AUTHORIZATION_REQUIRED", correlationId },
        { status: 401, headers: RESPONSE_HEADERS },
      );
    }
    if (!isCrmAiShadowEnabled()) {
      return NextResponse.json(
        { ok: false, error: "CRM_AI_SHADOW_DISABLED", correlationId },
        { status: 409, headers: RESPONSE_HEADERS },
      );
    }

    const limit = requestedLimit(request);
    if (Number.isNaN(limit)) {
      return NextResponse.json(
        { ok: false, error: "INVALID_PROCESS_LIMIT", correlationId },
        { status: 400, headers: RESPONSE_HEADERS },
      );
    }

    const result = await processCrmAiShadowQueue({ limit });
    return NextResponse.json(
      { ok: true, ...result, correlationId },
      { status: 200, headers: RESPONSE_HEADERS },
    );
  } catch (error) {
    const code =
      error instanceof CrmAiConfigError
        ? error.code
        : "CRM_AI_PROCESSOR_UNAVAILABLE";
    console.error("CRM AI shadow worker unavailable", {
      correlationId,
      errorCode: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message.slice(0, 160) : "unknown",
    });
    return NextResponse.json(
      { ok: false, error: code, correlationId },
      { status: 503, headers: RESPONSE_HEADERS },
    );
  }
}
