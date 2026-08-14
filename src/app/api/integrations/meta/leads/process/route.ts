import { createClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { processMetaLeadQueue } from "@/lib/integrations/meta/processor";
import { pullMetaLeadRoutes } from "@/lib/integrations/meta/pull-sync";
import {
  correlationIdOrNew,
  isStructurallyValidWorkerAuthorization,
} from "@/lib/integrations/meta/webhook-core";

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

function workerToken(request: NextRequest): string | null {
  const authorization = request.headers.get("authorization");
  if (!isStructurallyValidWorkerAuthorization(authorization)) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization || "");
  return match?.[1] || null;
}

async function verifyConfiguredWorker(request: NextRequest): Promise<boolean> {
  const candidate = workerToken(request);
  if (!candidate) return false;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key) return false;
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const requestUrl = `${request.nextUrl.origin}${request.nextUrl.pathname}`;
  const result = await client.rpc("verify_meta_worker_bearer", {
    p_candidate: candidate,
    p_request_url: requestUrl,
  });
  return !result.error && result.data === true;
}

async function processRequest(request: NextRequest) {
  const correlationId = correlationIdOrNew(
    request.headers.get("x-correlation-id"),
  );
  try {
    if (!(await verifyConfiguredWorker(request))) {
      return NextResponse.json(
        { ok: false, error: "PROCESS_AUTHORIZATION_REQUIRED" },
        { status: 401, headers: RESPONSE_HEADERS },
      );
    }
    const limit = requestedLimit(request);
    if (Number.isNaN(limit)) {
      return NextResponse.json(
        { ok: false, error: "INVALID_PROCESS_LIMIT", correlationId },
        { status: 400, headers: RESPONSE_HEADERS },
      );
    }

    const polling = await pullMetaLeadRoutes();
    const result = await processMetaLeadQueue({ limit });
    return NextResponse.json(
      { ok: true, polling, ...result, correlationId },
      { status: 200, headers: RESPONSE_HEADERS },
    );
  } catch (error) {
    console.error("Meta lead worker unavailable", {
      correlationId,
      errorCode: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message.slice(0, 160) : "unknown",
    });
    return NextResponse.json(
      {
        ok: false,
        error: "META_PROCESSOR_UNAVAILABLE",
        correlationId,
      },
      { status: 503, headers: RESPONSE_HEADERS },
    );
  }
}

export async function POST(request: NextRequest) {
  return processRequest(request);
}
