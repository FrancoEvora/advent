import { createClient } from "npm:@supabase/supabase-js@2";

const PUBLIC_KEY = "sb_publishable_nMCXNDXMvU0EbMSSmnEfQg_0uE_lVOW";
const MAX_BYTES = 96 * 1024;
const UPSTREAM_TIMEOUT_MS = 75_000;
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "apikey, content-type, x-client-info",
  "access-control-max-age": "86400",
  "vary": "Origin",
};
const RESPONSE_HEADERS = {
  ...CORS_HEADERS,
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const ALLOWED_ACTIONS = new Set([
  "experience",
  "session",
  "message",
  "inventory",
  "lead",
  "hold",
  "hold_status",
]);

type Obj = Record<string, unknown>;

class GatewayError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 503) {
    super(code);
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...RESPONSE_HEADERS,
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function object(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validPublicKey(request: Request): boolean {
  const candidate = request.headers.get("apikey")?.trim() || "";
  return candidate.length === PUBLIC_KEY.length && candidate === PUBLIC_KEY;
}

function upstreamUrl(): URL {
  const raw = Deno.env.get("SUPABASE_URL") || "";
  const base = new URL(raw);
  if (base.protocol !== "https:") throw new GatewayError("PUBLIC_AGENT_GATEWAY_CONFIG_INVALID");
  return new URL("/functions/v1/enterprise-public-agent", base);
}

async function internalBearer(admin: ReturnType<typeof createClient>) {
  const result = await admin.rpc("get_public_agent_internal_bearer");
  if (
    result.error ||
    typeof result.data !== "string" ||
    result.data.length < 32 ||
    result.data.length > 512 ||
    /\s/.test(result.data)
  ) {
    throw new GatewayError("PUBLIC_AGENT_INTERNAL_BEARER_UNAVAILABLE");
  }
  return result.data;
}

Deno.serve(async (request) => {
  try {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: RESPONSE_HEADERS });
    if (request.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    if (!validPublicKey(request)) return json({ ok: false, error: "PUBLIC_AGENT_AUTH_REQUIRED" }, 401);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return json({ ok: false, error: "JSON_REQUIRED" }, 415);
    }

    const declared = request.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
      return json({ ok: false, error: "PAYLOAD_TOO_LARGE" }, 413);
    }

    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength === 0 || body.byteLength > MAX_BYTES) {
      return json(
        { ok: false, error: body.byteLength ? "PAYLOAD_TOO_LARGE" : "JSON_REQUIRED" },
        body.byteLength ? 413 : 415,
      );
    }

    let parsed: Obj;
    try {
      const candidate = JSON.parse(new TextDecoder().decode(body));
      if (!object(candidate)) return json({ ok: false, error: "INVALID_REQUEST" }, 400);
      parsed = candidate;
    } catch {
      return json({ ok: false, error: "INVALID_JSON" }, 400);
    }

    const action = typeof parsed.action === "string" ? parsed.action : "";
    if (!ALLOWED_ACTIONS.has(action)) return json({ ok: false, error: "PUBLIC_AGENT_ACTION_INVALID" }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceRole) throw new GatewayError("PUBLIC_AGENT_GATEWAY_CONFIG_MISSING");

    const admin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const internalToken = await internalBearer(admin);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const upstream = await fetch(upstreamUrl(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${internalToken}`,
          "Content-Type": "application/json",
        },
        body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        signal: controller.signal,
      });
      const upstreamBody = await upstream.arrayBuffer();
      const headers = new Headers(RESPONSE_HEADERS);
      headers.set("content-type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
      return new Response(upstreamBody, { status: upstream.status, headers });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    const status = error instanceof GatewayError ? error.status : 503;
    const code = timedOut
      ? "PUBLIC_AGENT_GATEWAY_TIMEOUT"
      : error instanceof GatewayError
        ? error.code
        : "PUBLIC_AGENT_GATEWAY_UNAVAILABLE";
    console.error("enterprise-public-agent-gateway", {
      errorCode: code,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return json({ ok: false, error: code }, timedOut ? 504 : status);
  }
});
