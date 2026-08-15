import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BYTES = 1024 * 1024;
const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function edgeEndpoint(request: NextRequest) {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!raw) throw new Error("SUPABASE_URL_UNAVAILABLE");
  const base = new URL(raw);
  if (base.protocol !== "https:") throw new Error("SUPABASE_URL_INVALID");
  const target = new URL("/functions/v1/enterprise-whatsapp-webhook", base);
  request.nextUrl.searchParams.forEach((value, key) => target.searchParams.append(key, value));
  return target;
}

async function readBody(request: NextRequest) {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
    throw new Error("PAYLOAD_TOO_LARGE");
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_BYTES) throw new Error("PAYLOAD_TOO_LARGE");
  return body;
}

function requestBody(body?: Uint8Array): ArrayBuffer | undefined {
  if (!body?.byteLength) return undefined;
  return body.buffer.slice(
    body.byteOffset,
    body.byteOffset + body.byteLength,
  ) as ArrayBuffer;
}

async function proxy(request: NextRequest, body?: Uint8Array) {
  const target = edgeEndpoint(request);
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  const signature = request.headers.get("x-hub-signature-256");
  if (contentType) headers.set("content-type", contentType);
  if (signature) headers.set("x-hub-signature-256", signature);

  const response = await fetch(target, {
    method: request.method,
    headers,
    body: requestBody(body),
    cache: "no-store",
    redirect: "manual",
  });
  const responseBody = await response.arrayBuffer();
  const responseHeaders = new Headers(RESPONSE_HEADERS);
  const upstreamType = response.headers.get("content-type");
  if (upstreamType) responseHeaders.set("content-type", upstreamType);
  return new NextResponse(responseBody, {
    status: response.status,
    headers: responseHeaders,
  });
}

export async function GET(request: NextRequest) {
  try {
    return await proxy(request);
  } catch (error) {
    console.error("WhatsApp webhook verification proxy failed", {
      errorCode: error instanceof Error ? error.message.slice(0, 80) : "UnknownError",
    });
    return new NextResponse("Unavailable", { status: 503, headers: RESPONSE_HEADERS });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await readBody(request);
    return await proxy(request, body);
  } catch (error) {
    const code = error instanceof Error ? error.message : "WHATSAPP_WEBHOOK_PROXY_FAILED";
    const status = code === "PAYLOAD_TOO_LARGE" ? 413 : 503;
    console.error("WhatsApp webhook delivery proxy failed", {
      errorCode: code.slice(0, 80),
    });
    return NextResponse.json(
      { ok: false, error: status === 413 ? code : "WHATSAPP_WEBHOOK_UNAVAILABLE" },
      { status, headers: RESPONSE_HEADERS },
    );
  }
}
