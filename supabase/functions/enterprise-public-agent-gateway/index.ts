import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@6";

const TEAM_SLUG = "franco-3095s-projects";
const PROJECT_NAME = "advent";
const PROJECT_ID = "prj_nwbanG1FjXypYgaLVnFdJu1noHsv";
const OWNER_ID = "team_MqRTvNvoaArIVzGLcNA6OU4v";
const ISSUER = `https://oidc.vercel.com/${TEAM_SLUG}`;
const AUDIENCE = `https://vercel.com/${TEAM_SLUG}`;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks`));
const MAX_BYTES = 96 * 1024;
const UPSTREAM_TIMEOUT_MS = 70_000;
const RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

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

function bearer(request: Request): string {
  const match = /^Bearer\s+([^\s]{100,8192})$/i.exec(
    request.headers.get("authorization") || "",
  );
  return match?.[1] || "";
}

function expectedSubjects(): Set<string> {
  return new Set([
    `owner:${TEAM_SLUG}:project:${PROJECT_NAME}:environment:production`,
    `owner:${TEAM_SLUG}:project:${PROJECT_NAME}:environment:preview`,
  ]);
}

async function verifyVercelIdentity(token: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ISSUER,
      audience: AUDIENCE,
      clockTolerance: 10,
      maxTokenAge: "10m",
    });

    if (typeof payload.sub !== "string" || !expectedSubjects().has(payload.sub)) {
      return false;
    }

    const claims = payload as Obj;
    if (
      typeof claims.project_id === "string" &&
      claims.project_id !== PROJECT_ID
    ) {
      return false;
    }
    if (typeof claims.owner_id === "string" && claims.owner_id !== OWNER_ID) {
      return false;
    }
    if (
      typeof claims.environment === "string" &&
      !["production", "preview"].includes(claims.environment)
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function upstreamUrl(): URL {
  const raw = Deno.env.get("SUPABASE_URL") || "";
  const base = new URL(raw);
  if (base.protocol !== "https:") {
    throw new GatewayError("PUBLIC_AGENT_GATEWAY_CONFIG_INVALID");
  }
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
    if (request.method !== "POST") {
      return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    }
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    ) {
      return json({ ok: false, error: "JSON_REQUIRED" }, 415);
    }

    const declared = request.headers.get("content-length");
    if (
      declared &&
      (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)
    ) {
      return json({ ok: false, error: "PAYLOAD_TOO_LARGE" }, 413);
    }

    const token = bearer(request);
    if (!token || !(await verifyVercelIdentity(token))) {
      return json({ ok: false, error: "PUBLIC_AGENT_AUTH_REQUIRED" }, 401);
    }

    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength === 0 || body.byteLength > MAX_BYTES) {
      return json(
        { ok: false, error: body.byteLength ? "PAYLOAD_TOO_LARGE" : "JSON_REQUIRED" },
        body.byteLength ? 413 : 415,
      );
    }
    try {
      const parsed = JSON.parse(new TextDecoder().decode(body));
      if (!object(parsed)) {
        return json({ ok: false, error: "INVALID_REQUEST" }, 400);
      }
    } catch {
      return json({ ok: false, error: "INVALID_JSON" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceRole) {
      throw new GatewayError("PUBLIC_AGENT_GATEWAY_CONFIG_MISSING");
    }

    const admin = createClient(supabaseUrl, serviceRole, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
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
        body: body.buffer.slice(
          body.byteOffset,
          body.byteOffset + body.byteLength,
        ),
        signal: controller.signal,
      });
      const upstreamBody = await upstream.arrayBuffer();
      const headers = new Headers(RESPONSE_HEADERS);
      headers.set(
        "content-type",
        upstream.headers.get("content-type") ||
          "application/json; charset=utf-8",
      );
      return new Response(upstreamBody, {
        status: upstream.status,
        headers,
      });
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
