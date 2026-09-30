import { createHash, randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseIntegrationConfig } from "@/lib/integrations/meta/server-config";

export const MCP_ORIGIN = "https://enterprise.terraragroup.com.br";
export const MCP_RESOURCE = `${MCP_ORIGIN}/mcp`;
export const MCP_ISSUER = MCP_ORIGIN;
export const MCP_SCOPE = "solaris:read";
export const CHATGPT_CLIENT_ID = "https://chatgpt.com/oauth/client.json";
export const CHATGPT_REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";
export const EVORA_ORGANIZATION_ID = "041758e2-bc13-4614-8f06-a92fde19c9f8";
export const SOLARIS_PROJECT_ID = "85799c1b-e14a-5120-bf3d-976928d5dec3";

const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SAFE_TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const SAFE_STATE = /^[A-Za-z0-9._~+/=-]{8,1024}$/;

type JsonObject = Record<string, unknown>;

export type AuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  resource: string;
  scope: string;
};

export type McpIdentity = {
  userId: string;
  organizationId: string;
  projectIds: string[];
  scopes: string[];
  clientId: string;
};

export class McpOAuthError extends Error {
  readonly status: number;
  readonly oauthCode: string;

  constructor(status: number, oauthCode: string, message: string) {
    super(message);
    this.name = "McpOAuthError";
    this.status = status;
    this.oauthCode = oauthCode;
  }
}

let serviceClient: SupabaseClient | null = null;
let userClient: SupabaseClient | null = null;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function database(): SupabaseClient {
  if (serviceClient) return serviceClient;
  const config = getSupabaseIntegrationConfig();
  serviceClient = createClient(config.url, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { headers: { "X-Client-Info": "evora-mcp-oauth/1.0" } },
  });
  return serviceClient;
}

function authDatabase(): SupabaseClient {
  if (userClient) return userClient;
  const config = getSupabaseIntegrationConfig();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!key || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
    throw new McpOAuthError(503, "server_error", "A autenticação do Enterprise não está configurada.");
  }
  userClient = createClient(config.url, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { headers: { "X-Client-Info": "evora-mcp-user-auth/1.0" } },
  });
  return userClient;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function opaqueToken(prefix: "code" | "at" | "rt"): string {
  return `evmcp_${prefix}_${randomBytes(32).toString("base64url")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function expiresIso(ttlMs: number) {
  return new Date(Date.now() + ttlMs).toISOString();
}

function parseScope(value: string | null): string {
  const scope = (value || MCP_SCOPE).trim();
  const parts = scope.split(/\s+/).filter(Boolean);
  if (parts.length !== 1 || parts[0] !== MCP_SCOPE) {
    throw new McpOAuthError(400, "invalid_scope", "O escopo solicitado não é permitido.");
  }
  return MCP_SCOPE;
}

export function parseAuthorizationRequest(url: URL): AuthorizationRequest {
  const p = url.searchParams;
  const responseType = p.get("response_type");
  const clientId = p.get("client_id") || "";
  const redirectUri = p.get("redirect_uri") || "";
  const codeChallenge = p.get("code_challenge") || "";
  const codeChallengeMethod = p.get("code_challenge_method");
  const state = p.get("state") || "";
  const resource = p.get("resource") || "";
  if (
    responseType !== "code" ||
    clientId !== CHATGPT_CLIENT_ID ||
    redirectUri !== CHATGPT_REDIRECT_URI ||
    codeChallengeMethod !== "S256" ||
    !PKCE_CHALLENGE.test(codeChallenge) ||
    !SAFE_STATE.test(state) ||
    resource !== MCP_RESOURCE
  ) {
    throw new McpOAuthError(400, "invalid_request", "A solicitação OAuth não é válida.");
  }
  return {
    clientId,
    redirectUri,
    codeChallenge,
    state,
    resource,
    scope: parseScope(p.get("scope")),
  };
}

export function authorizationRedirect(
  request: AuthorizationRequest,
  result: { code?: string; error?: string; errorDescription?: string },
): string {
  const url = new URL(request.redirectUri);
  if (result.code) url.searchParams.set("code", result.code);
  if (result.error) url.searchParams.set("error", result.error);
  if (result.errorDescription) url.searchParams.set("error_description", result.errorDescription);
  url.searchParams.set("state", request.state);
  url.searchParams.set("iss", MCP_ISSUER);
  return url.toString();
}

export async function validateChatGptClient(fetcher: typeof fetch = fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(CHATGPT_CLIENT_ID, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new McpOAuthError(503, "temporarily_unavailable", "Não foi possível validar o cliente ChatGPT.");
  }
  if (!response.ok || Number(response.headers.get("content-length")) > 64 * 1024) {
    throw new McpOAuthError(503, "temporarily_unavailable", "Não foi possível validar o cliente ChatGPT.");
  }
  let metadata: unknown;
  try {
    metadata = await response.json();
  } catch {
    throw new McpOAuthError(503, "temporarily_unavailable", "Metadados do cliente ChatGPT inválidos.");
  }
  if (
    !isObject(metadata) ||
    metadata.client_id !== CHATGPT_CLIENT_ID ||
    !Array.isArray(metadata.redirect_uris) ||
    !metadata.redirect_uris.includes(CHATGPT_REDIRECT_URI) ||
    !Array.isArray(metadata.token_endpoint_auth_methods_supported) ||
    !metadata.token_endpoint_auth_methods_supported.includes("none")
  ) {
    throw new McpOAuthError(503, "temporarily_unavailable", "O cliente ChatGPT não corresponde à configuração autorizada.");
  }
}

async function requireEnterpriseAdmin(accessToken: string): Promise<{ userId: string; email?: string }> {
  if (!accessToken || accessToken.length > 8192) {
    throw new McpOAuthError(401, "access_denied", "Sessão administrativa necessária.");
  }
  const { data, error } = await authDatabase().auth.getUser(accessToken);
  const user = data.user;
  if (error || !user?.id || user.is_anonymous) {
    throw new McpOAuthError(401, "access_denied", "Sessão administrativa inválida ou expirada.");
  }
  const { data: member, error: memberError } = await database()
    .from("organization_members")
    .select("user_id,organization_id,role,active")
    .eq("user_id", user.id)
    .eq("organization_id", EVORA_ORGANIZATION_ID)
    .eq("active", true)
    .maybeSingle();
  if (
    memberError ||
    !member ||
    member.user_id !== user.id ||
    member.organization_id !== EVORA_ORGANIZATION_ID ||
    member.role !== "admin"
  ) {
    throw new McpOAuthError(403, "access_denied", "A conexão do Dot está restrita a administradores autorizados.");
  }
  return { userId: user.id, ...(user.email ? { email: user.email } : {}) };
}

export async function approveAuthorization(input: {
  request: AuthorizationRequest;
  enterpriseAccessToken: string;
}): Promise<string> {
  await validateChatGptClient();
  const principal = await requireEnterpriseAdmin(input.enterpriseAccessToken);
  const code = opaqueToken("code");
  const { error } = await database().from("mcp_oauth_authorization_codes").insert({
    code_hash: sha256(code),
    user_id: principal.userId,
    organization_id: EVORA_ORGANIZATION_ID,
    project_ids: [SOLARIS_PROJECT_ID],
    client_id: input.request.clientId,
    redirect_uri: input.request.redirectUri,
    code_challenge: input.request.codeChallenge,
    resource: input.request.resource,
    scope: input.request.scope,
    expires_at: expiresIso(CODE_TTL_MS),
  });
  if (error) {
    throw new McpOAuthError(503, "server_error", "Não foi possível criar a autorização do Dot.");
  }
  return authorizationRedirect(input.request, { code });
}

function invalidGrant(): never {
  throw new McpOAuthError(400, "invalid_grant", "Código ou token de atualização inválido.");
}

export async function exchangeAuthorizationCode(form: URLSearchParams) {
  const code = form.get("code") || "";
  const clientId = form.get("client_id") || "";
  const redirectUri = form.get("redirect_uri") || "";
  const verifier = form.get("code_verifier") || "";
  const resource = form.get("resource") || "";
  if (
    !SAFE_TOKEN.test(code.replace(/^evmcp_code_/, "")) ||
    clientId !== CHATGPT_CLIENT_ID ||
    redirectUri !== CHATGPT_REDIRECT_URI ||
    resource !== MCP_RESOURCE ||
    !PKCE_VERIFIER.test(verifier)
  ) invalidGrant();

  const { data: row, error } = await database()
    .from("mcp_oauth_authorization_codes")
    .select("code_hash,user_id,organization_id,project_ids,client_id,redirect_uri,code_challenge,resource,scope,expires_at,used_at")
    .eq("code_hash", sha256(code))
    .maybeSingle();
  if (
    error || !row || row.used_at ||
    new Date(String(row.expires_at)).getTime() <= Date.now() ||
    row.client_id !== clientId ||
    row.redirect_uri !== redirectUri ||
    row.resource !== resource ||
    row.scope !== MCP_SCOPE ||
    pkceS256(verifier) !== row.code_challenge
  ) invalidGrant();

  const { data: consumed, error: consumeError } = await database()
    .from("mcp_oauth_authorization_codes")
    .update({ used_at: nowIso() })
    .eq("code_hash", sha256(code))
    .is("used_at", null)
    .select("code_hash");
  if (consumeError || !Array.isArray(consumed) || consumed.length !== 1) invalidGrant();

  const accessToken = opaqueToken("at");
  const refreshToken = opaqueToken("rt");
  const expiresAt = expiresIso(ACCESS_TTL_MS);
  const refreshExpiresAt = expiresIso(REFRESH_TTL_MS);
  const { error: tokenError } = await database().from("mcp_oauth_tokens").insert({
    access_token_hash: sha256(accessToken),
    refresh_token_hash: sha256(refreshToken),
    user_id: row.user_id,
    organization_id: row.organization_id,
    project_ids: row.project_ids,
    client_id: row.client_id,
    resource: row.resource,
    scopes: [MCP_SCOPE],
    expires_at: expiresAt,
    refresh_expires_at: refreshExpiresAt,
  });
  if (tokenError) {
    throw new McpOAuthError(503, "server_error", "Não foi possível emitir o token do Dot.");
  }
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: MCP_SCOPE,
  };
}

export async function exchangeRefreshToken(form: URLSearchParams) {
  const refreshToken = form.get("refresh_token") || "";
  const clientId = form.get("client_id") || "";
  const resource = form.get("resource") || "";
  if (
    !SAFE_TOKEN.test(refreshToken.replace(/^evmcp_rt_/, "")) ||
    clientId !== CHATGPT_CLIENT_ID ||
    resource !== MCP_RESOURCE
  ) invalidGrant();

  const refreshHash = sha256(refreshToken);
  const { data: row, error } = await database()
    .from("mcp_oauth_tokens")
    .select("id,user_id,organization_id,project_ids,client_id,resource,scopes,refresh_expires_at,revoked_at")
    .eq("refresh_token_hash", refreshHash)
    .maybeSingle();
  if (
    error || !row || row.revoked_at ||
    row.client_id !== clientId ||
    row.resource !== resource ||
    !Array.isArray(row.scopes) ||
    !row.scopes.includes(MCP_SCOPE) ||
    new Date(String(row.refresh_expires_at)).getTime() <= Date.now()
  ) invalidGrant();

  const accessToken = opaqueToken("at");
  const nextRefreshToken = opaqueToken("rt");
  const { data: updated, error: updateError } = await database()
    .from("mcp_oauth_tokens")
    .update({
      access_token_hash: sha256(accessToken),
      refresh_token_hash: sha256(nextRefreshToken),
      expires_at: expiresIso(ACCESS_TTL_MS),
      refresh_expires_at: expiresIso(REFRESH_TTL_MS),
      updated_at: nowIso(),
    })
    .eq("id", row.id)
    .eq("refresh_token_hash", refreshHash)
    .is("revoked_at", null)
    .select("id");
  if (updateError || !Array.isArray(updated) || updated.length !== 1) invalidGrant();

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: nextRefreshToken,
    scope: MCP_SCOPE,
  };
}

export async function resolveMcpIdentity(request: Request): Promise<McpIdentity | null> {
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(evmcp_at_[A-Za-z0-9_-]{32,256})$/i.exec(authorization);
  if (!match) return null;
  const { data: row, error } = await database()
    .from("mcp_oauth_tokens")
    .select("user_id,organization_id,project_ids,client_id,resource,scopes,expires_at,revoked_at")
    .eq("access_token_hash", sha256(match[1]))
    .maybeSingle();
  if (
    error || !row || row.revoked_at ||
    row.resource !== MCP_RESOURCE ||
    row.client_id !== CHATGPT_CLIENT_ID ||
    row.organization_id !== EVORA_ORGANIZATION_ID ||
    !Array.isArray(row.project_ids) ||
    !row.project_ids.includes(SOLARIS_PROJECT_ID) ||
    !Array.isArray(row.scopes) ||
    !row.scopes.includes(MCP_SCOPE) ||
    new Date(String(row.expires_at)).getTime() <= Date.now()
  ) return null;

  const { data: member, error: memberError } = await database()
    .from("organization_members")
    .select("role,active")
    .eq("organization_id", EVORA_ORGANIZATION_ID)
    .eq("user_id", row.user_id)
    .eq("active", true)
    .maybeSingle();
  if (memberError || !member || member.role !== "admin" || member.active !== true) return null;

  return {
    userId: String(row.user_id),
    organizationId: EVORA_ORGANIZATION_ID,
    projectIds: [SOLARIS_PROJECT_ID],
    scopes: [MCP_SCOPE],
    clientId: CHATGPT_CLIENT_ID,
  };
}

export function protectedResourceMetadata() {
  return {
    resource: MCP_RESOURCE,
    authorization_servers: [MCP_ISSUER],
    scopes_supported: [MCP_SCOPE],
    resource_documentation: `${MCP_ORIGIN}/docs/evora-agent-api`,
  };
}

export function authorizationServerMetadata() {
  return {
    issuer: MCP_ISSUER,
    authorization_response_iss_parameter_supported: true,
    authorization_endpoint: `${MCP_ORIGIN}/oauth/authorize`,
    token_endpoint: `${MCP_ORIGIN}/api/oauth/token`,
    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: ["none"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [MCP_SCOPE],
  };
}

export function oauthErrorResponse(error: unknown): Response {
  const safe = error instanceof McpOAuthError
    ? error
    : new McpOAuthError(500, "server_error", "Não foi possível concluir a autenticação.");
  return Response.json(
    { error: safe.oauthCode, error_description: safe.message },
    { status: safe.status, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
}

export function mcpWwwAuthenticate(error = "invalid_token", description = "Conecte sua conta Évora para continuar.") {
  return `Bearer resource_metadata="${MCP_ORIGIN}/.well-known/oauth-protected-resource", scope="${MCP_SCOPE}", error="${error}", error_description="${description}"`;
}

export async function loadProfile(identity: McpIdentity) {
  const { data } = await database()
    .from("profiles")
    .select("full_name,email")
    .eq("id", identity.userId)
    .maybeSingle();
  return {
    id: `prf_${sha256(`${identity.organizationId}:${identity.userId}`).slice(0, 24)}`,
    ...(typeof data?.full_name === "string" && data.full_name ? { name: data.full_name } : {}),
    ...(typeof data?.email === "string" && data.email ? { email: data.email } : {}),
    nickname: "Évora Urbanismo — Solaris",
  };
}

export function mcpDatabase(): SupabaseClient {
  return database();
}
