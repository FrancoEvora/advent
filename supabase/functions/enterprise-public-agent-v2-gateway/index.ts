import { createClient } from "npm:@supabase/supabase-js@2";

const PROJECT_PUBLISHABLE_KEY = "sb_publishable_nMCXNDXMvU0EbMSSmnEfQg_0uE_lVOW";
const MAX_BYTES = 15 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 130_000;
const ALLOWED_ACTIONS = new Set([
  "experience",
  "session",
  "message",
  "lead",
  "transcribe",
  "speech",
  "house_simulation",
]);

const RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...RESPONSE_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

function bearer(request: Request): string {
  return /^Bearer\s+([^\s]{20,512})$/i.exec(request.headers.get("authorization") || "")?.[1] || "";
}

function upstreamUrl(): URL {
  const raw = Deno.env.get("SUPABASE_URL") || "";
  const base = new URL(raw);
  if (base.protocol !== "https:") throw new Error("invalid supabase url");
  return new URL("/functions/v1/enterprise-public-agent-v2", base);
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
    throw new Error("internal bearer unavailable");
  }
  return result.data;
}

Deno.serve(async (request) => {
  try {
    if (request.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return json({ ok: false, error: "JSON_REQUIRED" }, 415);
    }
    const supplied = bearer(request) || request.headers.get("apikey") || "";
    if (supplied !== PROJECT_PUBLISHABLE_KEY) {
      return json({ ok: false, error: "VITORIA_GATEWAY_AUTH_REQUIRED" }, 401);
    }

    const declared = request.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
      return json({ ok: false, error: "PAYLOAD_TOO_LARGE" }, 413);
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) {
      return json({ ok: false, error: bytes.byteLength ? "PAYLOAD_TOO_LARGE" : "JSON_REQUIRED" }, bytes.byteLength ? 413 : 415);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return json({ ok: false, error: "INVALID_JSON" }, 400);
    }
    if (!object(parsed) || typeof parsed.action !== "string" || !ALLOWED_ACTIONS.has(parsed.action)) {
      return json({ ok: false, error: "VITORIA_ACTION_INVALID" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceRole) return json({ ok: false, error: "VITORIA_GATEWAY_CONFIG_MISSING" }, 503);
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
        body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        signal: controller.signal,
      });
      const body = await upstream.arrayBuffer();
      return new Response(body, {
        status: upstream.status,
        headers: {
          ...RESPONSE_HEADERS,
          "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
        },
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const timeout = error instanceof Error && error.name === "AbortError";
    console.error("enterprise-public-agent-v2-gateway", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return json({ ok: false, error: timeout ? "VITORIA_GATEWAY_TIMEOUT" : "VITORIA_GATEWAY_UNAVAILABLE" }, timeout ? 504 : 503);
  }
});
