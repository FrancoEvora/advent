import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { processMetaLeadQueue } from "@/lib/integrations/meta/processor";
import { pullMetaLeadRoutes } from "@/lib/integrations/meta/pull-sync";
import { getMetaWorkerConfig } from "@/lib/integrations/meta/server-config";
import {
  authorizeBearer,
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

function matchesConfiguredWorkerEndpoint(request: NextRequest, workerUrl: string): boolean {
  const expected = new URL(workerUrl);
  return request.nextUrl.origin === expected.origin &&
    request.nextUrl.pathname === expected.pathname;
}

async function processRequest(request: NextRequest) {
  const correlationId = correlationIdOrNew(
    request.headers.get("x-correlation-id"),
  );
  try {
    if (!isStructurallyValidWorkerAuthorization(request.headers.get("authorization"))) {
      return NextResponse.json(
        { ok: false, error: "PROCESS_AUTHORIZATION_REQUIRED" },
        { status: 401, headers: RESPONSE_HEADERS },
      );
    }
    const worker = await getMetaWorkerConfig();
    if (
      !matchesConfiguredWorkerEndpoint(request, worker.workerUrl) ||
      !authorizeBearer(
        request.headers.get("authorization"),
        worker.workerSecret,
      )
    ) {
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

    // Quando não há App Secret, o Enterprise mantém o mesmo modelo de
    // autenticação do Campaign Control e lê novos leads pela Graph API.
    // Se houver webhook, a fila continua idempotente e elimina duplicidades.
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
