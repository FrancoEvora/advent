import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { parseMetaCredentialBearer } from "@/lib/integrations/meta/credential-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY_BYTES = 11 * 1024 * 1024;
const HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

class ProxyError extends Error {
  status: number;
  code: string;
  constructor(code: string, status = 503) {
    super(code);
    this.name = "ProxyError";
    this.status = status;
    this.code = code;
  }
}

function publicConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) throw new ProxyError("SUPABASE_PUBLIC_UNAVAILABLE", 503);
  return { url: new URL(url), key };
}

function enforceSameOrigin(request: NextRequest) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new ProxyError("CROSS_ORIGIN_REJECTED", 403);
  }
}

function bearer(request: NextRequest) {
  const token = parseMetaCredentialBearer(request.headers.get("authorization"));
  if (!token) throw new ProxyError("SESSION_REQUIRED", 401);
  return `Bearer ${token}`;
}

function contentLength(request: NextRequest) {
  const raw = request.headers.get("content-length");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function proxy(request: NextRequest) {
  enforceSameOrigin(request);
  const authorization = bearer(request);
  const config = publicConfig();
  const endpoint = new URL(
    "/functions/v1/enterprise-bia-knowledge-admin",
    config.url,
  );

  if (request.method === "GET") {
    const organizationId = request.nextUrl.searchParams.get("organizationId");
    if (organizationId) endpoint.searchParams.set("organizationId", organizationId);
  }

  const declaredLength = contentLength(request);
  if (declaredLength !== null && declaredLength > MAX_BODY_BYTES) {
    throw new ProxyError("KNOWLEDGE_FILE_TOO_LARGE", 413);
  }

  const requestContentType = request.headers.get("content-type");
  const body = request.method === "GET" ? undefined : await request.arrayBuffer();
  if (body && body.byteLength > MAX_BODY_BYTES) {
    throw new ProxyError("KNOWLEDGE_FILE_TOO_LARGE", 413);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 58_000);
  try {
    const response = await fetch(endpoint, {
      method: request.method,
      headers: {
        Authorization: authorization,
        apikey: config.key,
        ...(requestContentType ? { "Content-Type": requestContentType } : {}),
        "X-Client-Info": "evora-gestao-bia-knowledge-proxy/1.1",
      },
      body,
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = await response.text();
    return new NextResponse(payload || JSON.stringify({ ok: response.ok }), {
      status: response.status,
      headers: {
        ...HEADERS,
        "Content-Type":
          response.headers.get("content-type") ||
          "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProxyError("AI_KNOWLEDGE_TIMEOUT", 504);
    }
    throw new ProxyError("AI_KNOWLEDGE_EDGE_UNAVAILABLE", 503);
  } finally {
    clearTimeout(timeout);
  }
}

function errorResponse(error: unknown) {
  const known = error instanceof ProxyError ? error : null;
  return NextResponse.json(
    { ok: false, error: known?.code || "AI_KNOWLEDGE_UNAVAILABLE" },
    { status: known?.status || 503, headers: HEADERS },
  );
}

export async function GET(request: NextRequest) {
  try {
    return await proxy(request);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("multipart/form-data")
    ) {
      throw new ProxyError("MULTIPART_REQUIRED", 415);
    }
    return await proxy(request);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    ) {
      throw new ProxyError("JSON_REQUIRED", 415);
    }
    return await proxy(request);
  } catch (error) {
    return errorResponse(error);
  }
}
