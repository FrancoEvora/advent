import { createHmac } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";

import { parseMetaCredentialBearer } from "@/lib/integrations/meta/credential-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_API_VERSION = "v25.0";
const META_ID = /^\d{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const API_VERSION = /^v\d{1,3}\.\d{1,2}$/i;
const HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

type Obj = Record<string, unknown>;
type Discovery = {
  identity: { id: string; name: string };
  permissions: Array<{ permission: string; status: string }>;
  ad_accounts: Obj[];
  pages: Obj[];
  phones: Obj[];
  businesses: Obj[];
  warnings: string[];
};

type AuthContext = {
  user: SupabaseClient;
  service: SupabaseClient;
  organizationId: string;
};

class ApiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown, max = 8192) {
  if (typeof value !== "string") return "";
  const next = value.trim();
  return next.length <= max ? next : "";
}

function normalizeApiVersion(value: unknown) {
  const raw = cleanString(value, 16) || DEFAULT_API_VERSION;
  const next = raw.toLowerCase().startsWith("v") ? raw : `v${raw}`;
  return API_VERSION.test(next) ? next.toLowerCase() : DEFAULT_API_VERSION;
}

function metaId(value: unknown) {
  const raw = cleanString(value, 80).replace(/^act_/i, "");
  return META_ID.test(raw) ? raw : "";
}

function digits(value: unknown) {
  return cleanString(value, 64).replace(/\D/g, "");
}

function publicConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key) throw new ApiError("Supabase público indisponível.", 503);
  return { url, key };
}

function serviceConfig() {
  const url = process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new ApiError("Supabase de integração indisponível.", 503);
  return { url, key };
}

function enforceSameOrigin(request: NextRequest) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new ApiError("Requisição entre origens recusada.", 403);
  }
}

async function authContext(request: NextRequest, organizationId: string): Promise<AuthContext> {
  if (!UUID.test(organizationId)) throw new ApiError("Organização inválida.", 400);
  const bearer = parseMetaCredentialBearer(request.headers.get("authorization"));
  if (!bearer) throw new ApiError("Sessão necessária.", 401);
  const pub = publicConfig();
  const user = createClient(pub.url, pub.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const session = await user.auth.getUser(bearer);
  if (session.error || !session.data.user) throw new ApiError("Sessão expirada.", 401);
  const permission = await user.rpc("has_app_permission", {
    p_organization_id: organizationId,
    p_permission_key: "crm.integrations.manage",
  });
  if (permission.error || permission.data !== true) {
    throw new ApiError("Seu perfil não pode configurar integrações comerciais.", 403);
  }
  const svc = serviceConfig();
  const service = createClient(svc.url, svc.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return { user, service, organizationId };
}

async function body(request: NextRequest): Promise<Obj> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new ApiError("Envie os dados em JSON.", 415);
  }
  const value = await request.json() as unknown;
  if (!isObj(value)) throw new ApiError("Dados inválidos.", 400);
  return value;
}

function proof(token: string, appSecret: string) {
  return appSecret ? createHmac("sha256", appSecret).update(token).digest("hex") : "";
}

async function graphGet(
  apiVersion: string,
  token: string,
  appSecret: string,
  pathOrUrl: string,
  params: Record<string, string | number> = {},
) {
  let url: URL;
  if (/^https:\/\//i.test(pathOrUrl)) {
    url = new URL(pathOrUrl);
    if (url.hostname !== "graph.facebook.com") throw new ApiError("Resposta de paginação Meta inválida.", 502);
  } else {
    url = new URL(`https://graph.facebook.com/${apiVersion}/${pathOrUrl.replace(/^\//, "")}`);
  }
  url.searchParams.delete("access_token");
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const appSecretProof = proof(token, appSecret);
  if (appSecretProof) url.searchParams.set("appsecret_proof", appSecretProof);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new ApiError("Não foi possível alcançar a Meta Graph API.", 503);
  }
  const payload = await response.json().catch(() => null) as unknown;
  const error = isObj(payload) && isObj(payload.error) ? payload.error : null;
  if (!response.ok || error) {
    const message = error && typeof error.message === "string" ? error.message : `Meta Graph HTTP ${response.status}`;
    const code = error && typeof error.code === "number" ? ` · código ${error.code}` : "";
    const subcode = error && typeof error.error_subcode === "number" ? ` · subcódigo ${error.error_subcode}` : "";
    throw new ApiError(`${message}${code}${subcode}`, response.status >= 400 && response.status < 500 ? 400 : 502);
  }
  if (!isObj(payload)) throw new ApiError("Resposta inválida da Meta Graph API.", 502);
  return payload;
}

async function graphAll(
  apiVersion: string,
  token: string,
  appSecret: string,
  path: string,
  params: Record<string, string | number>,
  maxPages: number,
) {
  const rows: Obj[] = [];
  let next: string | null = path;
  let first = true;
  for (let page = 0; next && page < maxPages; page += 1) {
    const payload = await graphGet(apiVersion, token, appSecret, next, first ? params : {});
    first = false;
    if (!Array.isArray(payload.data)) throw new ApiError("A Meta retornou uma lista inválida.", 502);
    payload.data.forEach((item) => { if (isObj(item)) rows.push(item); });
    const paging = isObj(payload.paging) ? payload.paging : null;
    next = paging && typeof paging.next === "string" ? paging.next : null;
  }
  return rows;
}

function accountKey(row: Obj) {
  return metaId(row.account_id) || metaId(row.id);
}

async function discover(apiVersion: string, token: string, appSecret: string): Promise<Discovery> {
  const me = await graphGet(apiVersion, token, appSecret, "me", { fields: "id,name" });
  const result: Discovery = {
    identity: { id: metaId(me.id), name: cleanString(me.name, 256) },
    permissions: [],
    ad_accounts: [],
    pages: [],
    phones: [],
    businesses: [],
    warnings: [],
  };
  try {
    const rows = await graphAll(apiVersion, token, appSecret, "me/permissions", { limit: 200 }, 5);
    result.permissions = rows.map((row) => ({
      permission: cleanString(row.permission, 128),
      status: cleanString(row.status, 64),
    })).filter((row) => row.permission);
  } catch (error) {
    result.warnings.push(`Permissões: ${error instanceof Error ? error.message : "indisponíveis"}`);
  }

  const accounts = new Map<string, Obj>();
  const pages = new Map<string, Obj>();
  const phones = new Map<string, Obj>();
  const addAccounts = (rows: Obj[]) => rows.forEach((row) => {
    const key = accountKey(row);
    if (key) accounts.set(key, { ...row, account_id: key });
  });
  const addPages = (rows: Obj[]) => rows.forEach((row) => {
    const key = metaId(row.id);
    if (!key) return;
    const old = pages.get(key);
    if (!old || (!isObj(old.instagram_business_account) && isObj(row.instagram_business_account))) pages.set(key, row);
  });

  try {
    addAccounts(await graphAll(apiVersion, token, appSecret, "me/adaccounts", {
      fields: "id,account_id,name,account_status,currency,timezone_name",
      limit: 200,
    }, 10));
  } catch (error) {
    result.warnings.push(`Contas de anúncio: ${error instanceof Error ? error.message : "indisponíveis"}`);
  }
  try {
    addPages(await graphAll(apiVersion, token, appSecret, "me/accounts", {
      fields: "id,name,instagram_business_account",
      limit: 200,
    }, 10));
  } catch (error) {
    result.warnings.push(`Páginas: ${error instanceof Error ? error.message : "indisponíveis"}`);
  }

  let businesses: Obj[] = [];
  try {
    businesses = await graphAll(apiVersion, token, appSecret, "me/businesses", { fields: "id,name", limit: 200 }, 10);
    result.businesses = businesses;
  } catch (error) {
    result.warnings.push(`Portfólios empresariais: ${error instanceof Error ? error.message : "indisponíveis"}`);
  }

  for (const business of businesses) {
    const businessId = metaId(business.id);
    if (!businessId) continue;
    for (const edge of ["owned_ad_accounts", "client_ad_accounts"]) {
      try {
        addAccounts(await graphAll(apiVersion, token, appSecret, `${businessId}/${edge}`, {
          fields: "id,account_id,name,account_status,currency,timezone_name",
          limit: 200,
        }, 10));
      } catch { /* opcional, como no Campaign Control local */ }
    }
    for (const edge of ["owned_pages", "client_pages"]) {
      try {
        addPages(await graphAll(apiVersion, token, appSecret, `${businessId}/${edge}`, {
          fields: "id,name,instagram_business_account",
          limit: 200,
        }, 10));
      } catch { /* opcional */ }
    }
    try {
      const wabas = await graphAll(apiVersion, token, appSecret, `${businessId}/owned_whatsapp_business_accounts`, {
        fields: "id,name",
        limit: 100,
      }, 5);
      for (const waba of wabas) {
        const wabaId = metaId(waba.id);
        if (!wabaId) continue;
        try {
          const rows = await graphAll(apiVersion, token, appSecret, `${wabaId}/phone_numbers`, {
            fields: "id,display_phone_number,verified_name,quality_rating",
            limit: 100,
          }, 5);
          rows.forEach((row) => {
            const phoneId = metaId(row.id);
            if (phoneId) phones.set(phoneId, { ...row, waba_id: wabaId, business_id: businessId });
          });
        } catch { /* WhatsApp é opcional na descoberta */ }
      }
    } catch { /* business_management/WhatsApp pode não estar disponível */ }
  }

  result.ad_accounts = [...accounts.values()].sort((a, b) => cleanString(a.name).localeCompare(cleanString(b.name), "pt-BR"));
  result.pages = [...pages.values()].sort((a, b) => cleanString(a.name).localeCompare(cleanString(b.name), "pt-BR"));
  result.phones = [...phones.values()].sort((a, b) => cleanString(a.display_phone_number).localeCompare(cleanString(b.display_phone_number), "pt-BR"));
  result.businesses.sort((a, b) => cleanString(a.name).localeCompare(cleanString(b.name), "pt-BR"));
  return result;
}

async function savedMarketing(service: SupabaseClient, organizationId: string) {
  const result = await service.rpc("cc_meta_marketing_token_get", { p_organization_id: organizationId });
  if (result.error) throw result.error;
  return isObj(result.data) ? result.data : null;
}

async function savedConnections(service: SupabaseClient, organizationId: string) {
  const result = await service.rpc("cc_meta_connections_list", { p_organization_id: organizationId });
  if (result.error) throw result.error;
  return Array.isArray(result.data) ? result.data.filter(isObj) : [];
}

async function resolveMarketingToken(service: SupabaseClient, organizationId: string, supplied: unknown) {
  const direct = cleanString(supplied, 8192);
  if (direct) return direct;
  const saved = await savedMarketing(service, organizationId);
  const token = saved ? cleanString(saved.access_token, 8192) : "";
  if (!token) throw new ApiError("Informe o token de acesso da Meta.", 400);
  return token;
}

async function derivePageAccessToken(apiVersion: string, marketingToken: string, appSecret: string, pageId: string) {
  let accountsError: unknown = null;
  try {
    const rows = await graphAll(apiVersion, marketingToken, appSecret, "me/accounts", {
      fields: "id,name,access_token,tasks",
      limit: 200,
    }, 10);
    for (const row of rows) {
      if (metaId(row.id) !== pageId) continue;
      const token = cleanString(row.access_token, 8192);
      if (token) return token;
    }
  } catch (error) {
    accountsError = error;
  }
  try {
    const page = await graphGet(apiVersion, marketingToken, appSecret, pageId, { fields: "id,name,access_token" });
    const token = cleanString(page.access_token, 8192);
    if (token) return token;
  } catch { /* mantém a mensagem direcionada abaixo */ }
  if (accountsError instanceof Error) {
    throw new ApiError(`Não foi possível obter o Page Access Token: ${accountsError.message}`, 400);
  }
  throw new ApiError(`A credencial administra anúncios, mas não devolveu um Page Access Token para a Página ${pageId}. Reconecte a Meta concedendo acesso à Página e aos leads.`, 400);
}

async function listLeadForms(apiVersion: string, pageToken: string, appSecret: string, pageId: string) {
  return graphAll(apiVersion, pageToken, appSecret, `${pageId}/leadgen_forms`, {
    fields: "id,name,status,locale",
    limit: 100,
  }, 20);
}

async function activateEligibleRoutes(service: SupabaseClient, organizationId: string, pageId: string, forms: Obj[]) {
  const formIds = forms.map((form) => metaId(form.id)).filter(Boolean);
  if (!formIds.length) return 0;
  const routes = await service.from("crm_meta_lead_routes")
    .select("id,form_id,project_id,product_id,lead_source_id,pipeline_id,initial_stage_id,team_id,fallback_owner_user_id,assignment_strategy,active")
    .eq("organization_id", organizationId)
    .eq("page_id", pageId)
    .in("form_id", formIds);
  if (routes.error) return 0;
  const eligible = (routes.data || []).filter((route) =>
    route.form_id && route.project_id && route.product_id && route.lead_source_id && route.pipeline_id && route.initial_stage_id &&
    route.fallback_owner_user_id && (route.assignment_strategy === "fallback_only" || route.team_id),
  );
  const inactive = eligible.filter((route) => !route.active).map((route) => route.id);
  if (!inactive.length) return 0;
  const update = await service.from("crm_meta_lead_routes").update({ active: true, updated_at: new Date().toISOString() }).in("id", inactive);
  return update.error ? 0 : inactive.length;
}

function safeConnection(connection: Obj | null) {
  if (!connection) return null;
  return {
    id: cleanString(connection.id, 64),
    status: cleanString(connection.status, 64),
    app_id: cleanString(connection.app_id, 128),
    ad_account_id: metaId(connection.ad_account_id),
    page_id: metaId(connection.page_id),
    page_name: cleanString(connection.page_name, 256),
    business_id: metaId(connection.business_id),
    token_subject_id: cleanString(connection.token_subject_id, 128),
    permissions: Array.isArray(connection.permissions) ? connection.permissions : [],
    capabilities: isObj(connection.capabilities) ? connection.capabilities : {},
    metadata: isObj(connection.metadata) ? connection.metadata : {},
    last_verified_at: cleanString(connection.last_verified_at, 64),
    updated_at: cleanString(connection.updated_at, 64),
  };
}

export async function GET(request: NextRequest) {
  try {
    const organizationId = request.nextUrl.searchParams.get("organizationId") || "";
    const { user, service } = await authContext(request, organizationId);
    const [tokenStatus, connections, credentialStatus, routes] = await Promise.all([
      savedMarketing(service, organizationId),
      savedConnections(service, organizationId),
      user.rpc("get_meta_lead_credential_status", { p_organization_id: organizationId }),
      service.from("crm_meta_lead_routes").select("id,name,page_id,form_id,provider_account_id,project_id,product_id,team_id,fallback_owner_user_id,assignment_strategy,active").eq("organization_id", organizationId),
    ]);
    if (credentialStatus.error) throw credentialStatus.error;
    const current = connections.length ? connections[0] : null;
    return NextResponse.json({
      ok: true,
      marketing_token_configured: Boolean(tokenStatus && cleanString(tokenStatus.access_token)),
      token_subject_id: tokenStatus ? cleanString(tokenStatus.token_subject_id, 128) : "",
      token_subject_name: tokenStatus ? cleanString(tokenStatus.token_subject_name, 256) : "",
      connection: safeConnection(current),
      credential_status: credentialStatus.data,
      routes: routes.data || [],
    }, { headers: HEADERS });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 503;
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Falha ao carregar a conexão Meta." }, { status, headers: HEADERS });
  }
}

export async function POST(request: NextRequest) {
  try {
    enforceSameOrigin(request);
    const input = await body(request);
    const organizationId = cleanString(input.organizationId, 64);
    const { service } = await authContext(request, organizationId);
    const apiVersion = normalizeApiVersion(input.api_version);
    const accessToken = await resolveMarketingToken(service, organizationId, input.access_token);
    const appSecret = cleanString(input.app_secret, 512);
    const data = await discover(apiVersion, accessToken, appSecret);
    return NextResponse.json({ ok: true, api_version: apiVersion, discovery: data }, { headers: HEADERS });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 503;
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Falha na conexão com a Meta." }, { status, headers: HEADERS });
  }
}

export async function PUT(request: NextRequest) {
  try {
    enforceSameOrigin(request);
    const input = await body(request);
    const organizationId = cleanString(input.organizationId, 64);
    const { user, service } = await authContext(request, organizationId);
    const apiVersion = normalizeApiVersion(input.api_version);
    const accessToken = await resolveMarketingToken(service, organizationId, input.access_token);
    const appSecret = cleanString(input.app_secret, 512);
    const adAccountId = metaId(input.ad_account_id);
    const pageId = metaId(input.page_id);
    const whatsappNumber = digits(input.whatsapp_number);
    const whatsappPhoneId = metaId(input.whatsapp_phone_number_id);
    if (!adAccountId || !pageId || whatsappNumber.length < 10 || whatsappNumber.length > 15) {
      throw new ApiError("Preencha conta de anúncios, Página e WhatsApp com DDI e DDD, como no Campaign Control.", 400);
    }

    const discovery = await discover(apiVersion, accessToken, appSecret);
    const account = await graphGet(apiVersion, accessToken, appSecret, `act_${adAccountId}`, {
      fields: "id,account_id,name,account_status,currency,timezone_name",
    });
    const page = await graphGet(apiVersion, accessToken, appSecret, pageId, {
      fields: "id,name,instagram_business_account",
    });
    let phone: Obj | null = null;
    if (whatsappPhoneId) {
      try {
        phone = await graphGet(apiVersion, accessToken, appSecret, whatsappPhoneId, {
          fields: "id,display_phone_number,verified_name,quality_rating",
        });
      } catch { phone = null; }
    }
    const pageAccessToken = await derivePageAccessToken(apiVersion, accessToken, appSecret, pageId);
    const forms = await listLeadForms(apiVersion, pageAccessToken, appSecret, pageId);

    const tokenSave = await service.rpc("cc_meta_marketing_token_save", {
      p_organization_id: organizationId,
      p_access_token: accessToken,
      p_token_subject_id: discovery.identity.id || null,
      p_token_subject_name: discovery.identity.name || null,
    });
    if (tokenSave.error) throw tokenSave.error;

    const credentials = await user.rpc("configure_meta_lead_credentials", {
      p_organization_id: organizationId,
      p_page_id: pageId,
      p_app_secret: appSecret || null,
      p_verify_token: null,
      p_access_token: pageAccessToken,
    });
    if (credentials.error) throw credentials.error;

    const instagram = isObj(page.instagram_business_account) ? metaId(page.instagram_business_account.id) : "";
    const selectedBusiness = discovery.businesses.find((business) => {
      const id = metaId(business.id);
      return discovery.phones.some((candidate) => metaId(candidate.id) === whatsappPhoneId && metaId(candidate.business_id) === id);
    });
    const connectionSave = await service.rpc("cc_meta_connection_upsert", {
      p_organization_id: organizationId,
      p_payload: {
        ad_account_id: adAccountId,
        page_id: pageId,
        page_name: cleanString(page.name, 256),
        business_id: selectedBusiness ? metaId(selectedBusiness.id) : null,
        status: "CONNECTED",
        credential_source: "SUPABASE_VAULT",
        last_verified_at: new Date().toISOString(),
        last_error: null,
        token_subject_id: discovery.identity.id || null,
        permissions: discovery.permissions,
        capabilities: {
          ad_account_access: true,
          page_access: true,
          page_access_token: true,
          lead_forms: forms.length,
          whatsapp_verified: Boolean(phone || whatsappPhoneId),
        },
        metadata: {
          api_version: apiVersion,
          identity: discovery.identity,
          ad_account: account,
          page,
          instagram_actor_id: instagram,
          whatsapp: {
            number: whatsappNumber,
            phone_number_id: whatsappPhoneId || null,
            display_name: phone ? `${cleanString(phone.verified_name, 256)} ${cleanString(phone.display_phone_number, 64)}`.trim() : cleanString(input.whatsapp_display_name, 256),
          },
          businesses: discovery.businesses,
          forms,
        },
      },
    });
    if (connectionSave.error) throw connectionSave.error;

    const routesActivated = await activateEligibleRoutes(service, organizationId, pageId, forms);
    return NextResponse.json({
      ok: true,
      connection: safeConnection(isObj(connectionSave.data) ? connectionSave.data : null),
      discovery,
      forms,
      credential_status: credentials.data,
      routes_activated: routesActivated,
    }, { headers: HEADERS });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 503;
    console.error("Enterprise Campaign Control Meta setup failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Não foi possível validar e salvar a conexão Meta." }, { status, headers: HEADERS });
  }
}
