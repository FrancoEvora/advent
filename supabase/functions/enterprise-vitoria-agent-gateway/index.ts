import { createClient as createSupabaseClient } from "npm:@supabase/supabase-js@2";

type GatewayDatabase = {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Record<string, {
      Args: Record<string, unknown>;
      Returns: unknown;
    }>;
  };
};

function createClient(
  supabaseUrl: string,
  supabaseKey: string,
  options?: Parameters<typeof createSupabaseClient<GatewayDatabase>>[2],
) {
  return createSupabaseClient<GatewayDatabase>(supabaseUrl, supabaseKey, options);
}
type AdminClient = ReturnType<typeof createClient>;

const MAX_BYTES = 3_500_000;
const TIMEOUT_MS = 125_000;
const HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

class GatewayError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 503) { super(code); this.name = "GatewayError"; this.code = code; this.status = status; }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, "content-type": "application/json; charset=utf-8" } });
}
function upstreamUrl() {
  const raw = Deno.env.get("SUPABASE_URL") || "";
  const base = new URL(raw);
  if (base.protocol !== "https:") throw new GatewayError("VITORIA_GATEWAY_CONFIG_INVALID");
  return new URL("/functions/v1/enterprise-vitoria-agent", base);
}
async function internalBearer(admin: AdminClient) {
  const result = await admin.rpc("get_public_agent_internal_bearer");
  if (result.error || typeof result.data !== "string" || result.data.length < 32 || result.data.length > 512 || /\s/.test(result.data)) {
    throw new GatewayError("VITORIA_INTERNAL_BEARER_UNAVAILABLE");
  }
  return result.data;
}

function constantTimeEqual(left: string, right: string) {
  let difference = left.length ^ right.length;
  for (let index = 0; index < 512; index += 1) {
    const leftCode = index < left.length ? left.charCodeAt(index) : 0;
    const rightCode = index < right.length ? right.charCodeAt(index) : 0;
    difference |= leftCode ^ rightCode;
  }
  return difference === 0;
}

function configuredPublishableKeys() {
  const raw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "";
  if (!raw || raw.length > 65_536) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.values(parsed).filter((value): value is string => (
      typeof value === "string"
      && value.length >= 32
      && value.length <= 512
      && !/\s/.test(value)
    )).slice(0, 64);
  } catch {
    return [];
  }
}

function ingressAuthorized(request: Request) {
  const candidate = request.headers.get("apikey") || "";
  if (
    candidate.length < 32
    || candidate.length > 512
    || /\s/.test(candidate)
  ) return false;
  let authorized = 0;
  for (const configured of configuredPublishableKeys()) {
    authorized |= Number(constantTimeEqual(configured, candidate));
  }
  return authorized === 1;
}

Deno.serve(async (request: Request) => {
  try {
    if (request.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ ok: false, error: "JSON_REQUIRED" }, 415);
    if (!ingressAuthorized(request)) return json({ ok: false, error: "VITORIA_GATEWAY_AUTH_REQUIRED" }, 401);
    const declared = request.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) return json({ ok: false, error: "PAYLOAD_TOO_LARGE" }, 413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) return json({ ok: false, error: bytes.byteLength ? "PAYLOAD_TOO_LARGE" : "JSON_REQUIRED" }, bytes.byteLength ? 413 : 415);
    try { const parsed = JSON.parse(new TextDecoder().decode(bytes)); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({ ok: false, error: "INVALID_REQUEST" }, 400); }
    catch { return json({ ok: false, error: "INVALID_JSON" }, 400); }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceRole) throw new GatewayError("VITORIA_GATEWAY_CONFIG_MISSING");
    const admin = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const token = await internalBearer(admin);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const upstream = await fetch(upstreamUrl(), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        signal: controller.signal,
      });
      const responseBody = await upstream.arrayBuffer();
      const headers = new Headers(HEADERS);
      headers.set("content-type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
      return new Response(responseBody, { status: upstream.status, headers });
    } finally { clearTimeout(timer); }
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    const code = timedOut ? "VITORIA_GATEWAY_TIMEOUT" : error instanceof GatewayError ? error.code : "VITORIA_GATEWAY_UNAVAILABLE";
    const status = timedOut ? 504 : error instanceof GatewayError ? error.status : 503;
    console.error("enterprise-vitoria-agent-gateway", { code, name: error instanceof Error ? error.name : "UnknownError" });
    return json({ ok: false, error: code }, status);
  }
});
