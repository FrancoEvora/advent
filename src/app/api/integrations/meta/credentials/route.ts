import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";

import {
  parseMetaCredentialBearer,
  parseMetaCredentialStatus,
} from "@/lib/integrations/meta/credential-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_REQUEST_BYTES = 20 * 1024;
const META_ID_PATTERN = /^\d{1,64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESPONSE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

type JsonObject = Record<string, unknown>;

class CredentialApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    code: string,
    status: number,
  ) {
    super(code);
    this.name = "CredentialApiError";
    this.code = code;
    this.status = status;
  }
}

function publicSupabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key) throw new CredentialApiError("SERVICE_UNAVAILABLE", 503);
  return { url, key };
}

function bearerToken(request: NextRequest): string {
  const token = parseMetaCredentialBearer(request.headers.get("authorization"));
  if (!token) throw new CredentialApiError("SESSION_REQUIRED", 401);
  return token;
}

async function authenticatedDatabase(request: NextRequest): Promise<SupabaseClient> {
  const token = bearerToken(request);
  const { url, key } = publicSupabaseConfig();
  const client = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new CredentialApiError("SESSION_EXPIRED", 401);
  return client;
}

function organizationId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new CredentialApiError("INVALID_ORGANIZATION", 400);
  }
  return value;
}

function pageId(value: unknown): string {
  if (typeof value !== "string" || !META_ID_PATTERN.test(value)) {
    throw new CredentialApiError("INVALID_META_PAGE", 400);
  }
  return value;
}

function optionalSecret(
  source: JsonObject,
  key: string,
  minimumLength: number,
  maximumLength: number,
): string | null {
  const value = source[key];
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /\s/.test(value)
  ) {
    throw new CredentialApiError("INVALID_CREDENTIAL_VALUE", 400);
  }
  return value;
}

async function jsonBody(request: NextRequest): Promise<JsonObject> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new CredentialApiError("UNSUPPORTED_CONTENT_TYPE", 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_REQUEST_BYTES)) {
    throw new CredentialApiError("REQUEST_TOO_LARGE", 413);
  }
  if (!request.body) throw new CredentialApiError("INVALID_REQUEST", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new CredentialApiError("REQUEST_TOO_LARGE", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new CredentialApiError("INVALID_REQUEST", 400);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CredentialApiError("INVALID_REQUEST", 400);
  }
  return parsed as JsonObject;
}

function enforceSameOriginBrowserRequest(request: NextRequest) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new CredentialApiError("CROSS_SITE_REQUEST_REJECTED", 403);
  }
}

function errorCode(error: unknown): string {
  if (error instanceof CredentialApiError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code)
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 32);
    if (code) return code;
  }
  return error instanceof Error ? error.name : "UnknownError";
}

function responseError(error: unknown, supportReference: string) {
  if (error instanceof CredentialApiError) {
    return NextResponse.json(
      { ok: false, error: error.code },
      { status: error.status, headers: RESPONSE_HEADERS },
    );
  }
  console.error("Meta credential operation failed", {
    supportReference,
    errorCode: errorCode(error),
  });
  const databaseCode = errorCode(error);
  const status = databaseCode === "42501"
    ? 403
    : ["PGRST202", "42883"].includes(databaseCode)
      ? 503
      : ["23505", "23514", "P0001", "22023"].includes(databaseCode)
        ? 409
        : 503;
  const publicCode = status === 403
    ? "META_CREDENTIAL_PERMISSION_DENIED"
    : status === 409
      ? "META_CREDENTIAL_CHANGE_REJECTED"
      : "META_CREDENTIAL_SERVICE_UNAVAILABLE";
  return NextResponse.json(
    {
      ok: false,
      error: publicCode,
      supportReference,
    },
    { status, headers: RESPONSE_HEADERS },
  );
}

async function statusResponse(data: unknown) {
  return NextResponse.json(
    { ok: true, status: parseMetaCredentialStatus(data) },
    { status: 200, headers: RESPONSE_HEADERS },
  );
}

export async function GET(request: NextRequest) {
  const supportReference = `META-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  try {
    const orgId = organizationId(request.nextUrl.searchParams.get("organizationId"));
    const client = await authenticatedDatabase(request);
    const { data, error } = await client.rpc("get_meta_lead_credential_status", {
      p_organization_id: orgId,
    });
    if (error) throw error;
    return statusResponse(data);
  } catch (error) {
    return responseError(error, supportReference);
  }
}

export async function PUT(request: NextRequest) {
  const supportReference = `META-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  try {
    enforceSameOriginBrowserRequest(request);
    const body = await jsonBody(request);
    const orgId = organizationId(body.organizationId);
    const metaPageId = pageId(body.pageId);
    const appSecret = optionalSecret(body, "appSecret", 24, 512);
    const verifyToken = optionalSecret(body, "verifyToken", 24, 512);
    const accessToken = optionalSecret(body, "accessToken", 32, 8_192);
    const client = await authenticatedDatabase(request);
    const { data, error } = await client.rpc("configure_meta_lead_credentials", {
      p_organization_id: orgId,
      p_page_id: metaPageId,
      p_app_secret: appSecret,
      p_verify_token: verifyToken,
      p_access_token: accessToken,
    });
    if (error) throw error;
    return statusResponse(data);
  } catch (error) {
    return responseError(error, supportReference);
  }
}

export async function DELETE(request: NextRequest) {
  const supportReference = `META-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  try {
    enforceSameOriginBrowserRequest(request);
    const body = await jsonBody(request);
    const orgId = organizationId(body.organizationId);
    const credential = body.credential;
    if (!new Set(["app_secret", "verify_token", "access_token", "page_registration"]).has(String(credential))) {
      throw new CredentialApiError("INVALID_CREDENTIAL_TYPE", 400);
    }
    const metaPageId = credential === "access_token" || credential === "page_registration"
      ? pageId(body.pageId)
      : null;
    const client = await authenticatedDatabase(request);
    const { data, error } = await client.rpc("revoke_meta_lead_credential", {
      p_organization_id: orgId,
      p_credential: credential,
      p_page_id: metaPageId,
    });
    if (error) throw error;
    return statusResponse(data);
  } catch (error) {
    return responseError(error, supportReference);
  }
}
