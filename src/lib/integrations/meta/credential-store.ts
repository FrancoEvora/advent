import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type JsonObject = Record<string, unknown>;

const META_ID_PATTERN = /^\d{1,64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class MetaCredentialStoreError extends Error {
  readonly kind: "rpc_missing" | "unavailable" | "invalid_contract";
  readonly databaseCode?: string;

  constructor(
    kind: "rpc_missing" | "unavailable" | "invalid_contract",
    databaseCode?: string,
  ) {
    super(`META_CREDENTIAL_STORE_${kind.toUpperCase()}`);
    this.name = "MetaCredentialStoreError";
    this.kind = kind;
    this.databaseCode = databaseCode;
  }
}

export type MetaWebhookRuntimeCredential = {
  organizationId: string;
  pageIds: string[];
  appSecret: string | null;
  verifyToken: string | null;
};

export type MetaWebhookRuntimeCredentials = {
  candidates: MetaWebhookRuntimeCredential[];
  unresolvedPageIds: string[];
};

export type MetaGraphRuntimeCredential = {
  organizationId: string;
  pageId: string;
  appSecret: string | null;
  accessToken: string;
};

export type MetaWorkerRuntimeCredential = {
  workerUrl: string;
  workerSecret: string;
};

let serviceClient: SupabaseClient | null = null;

function database(): SupabaseClient {
  if (serviceClient) return serviceClient;
  const url = process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key || key.length < 32) {
    throw new MetaCredentialStoreError("unavailable");
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) {
      throw new Error("invalid protocol");
    }
    serviceClient = createClient(parsed.origin, key, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
      global: { headers: { "X-Client-Info": "evora-meta-credential-runtime/1.0" } },
    });
    return serviceClient;
  } catch (error) {
    if (error instanceof MetaCredentialStoreError) throw error;
    throw new MetaCredentialStoreError("unavailable");
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function databaseError(error: unknown): MetaCredentialStoreError {
  const rawCode = isObject(error) && typeof error.code === "string" ? error.code : "";
  const code = rawCode.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined;
  return new MetaCredentialStoreError(
    rawCode === "PGRST202" || rawCode === "42883" ? "rpc_missing" : "unavailable",
    code,
  );
}

function secret(value: unknown, minimumLength: number, maximumLength: number): string | null {
  return typeof value === "string" &&
    value.length >= minimumLength &&
    value.length <= maximumLength &&
    value.trim() === value &&
    !/\s/.test(value)
    ? value
    : null;
}

function metaId(value: unknown): string | null {
  return typeof value === "string" && META_ID_PATTERN.test(value) ? value : null;
}

export async function fetchMetaWebhookRuntimeCredentials(
  pageIds?: string[],
): Promise<MetaWebhookRuntimeCredentials> {
  const { data, error } = await database().rpc("get_meta_webhook_runtime_credentials", {
    p_page_ids: pageIds?.length ? pageIds : null,
  });
  if (error) throw databaseError(error);
  return parseMetaWebhookRuntimeCredentialResult(data, pageIds);
}

export function parseMetaWebhookRuntimeCredentialResult(
  data: unknown,
  pageIds?: string[],
): MetaWebhookRuntimeCredentials {
  if (!isObject(data) || !Array.isArray(data.candidates) || !Array.isArray(data.unresolved_page_ids)) {
    throw new MetaCredentialStoreError("invalid_contract");
  }
  const requestedPageIds = pageIds?.length ? new Set(pageIds) : null;
  const candidates = data.candidates.map((value): MetaWebhookRuntimeCredential => {
    if (!isObject(value)) throw new MetaCredentialStoreError("invalid_contract");
    const organizationId = typeof value.organization_id === "string" && UUID_PATTERN.test(value.organization_id)
      ? value.organization_id
      : null;
    const candidatePageIds = Array.isArray(value.page_ids)
      ? value.page_ids.map(metaId).filter((item): item is string => item !== null)
      : [];
    const appSecret = value.app_secret === null || value.app_secret === undefined
      ? null
      : secret(value.app_secret, 24, 512);
    const verifyToken = value.verify_token === null || value.verify_token === undefined
      ? null
      : secret(value.verify_token, 24, 512);
    if (
      !organizationId ||
      (pageIds?.length ? (!appSecret || verifyToken !== null) : (!verifyToken || appSecret !== null)) ||
      (value.app_secret !== null && value.app_secret !== undefined && !appSecret) ||
      (value.verify_token !== null && value.verify_token !== undefined && !verifyToken) ||
      candidatePageIds.length === 0 ||
      candidatePageIds.length !== (value.page_ids as unknown[])?.length ||
      (requestedPageIds && candidatePageIds.some((pageId) => !requestedPageIds.has(pageId)))
    ) {
      throw new MetaCredentialStoreError("invalid_contract");
    }
    return { organizationId, pageIds: candidatePageIds, appSecret, verifyToken };
  });
  const unresolvedPageIds = data.unresolved_page_ids
    .map(metaId)
    .filter((item): item is string => item !== null);
  if (unresolvedPageIds.length !== data.unresolved_page_ids.length) {
    throw new MetaCredentialStoreError("invalid_contract");
  }
  if (requestedPageIds && unresolvedPageIds.some((pageId) => !requestedPageIds.has(pageId))) {
    throw new MetaCredentialStoreError("invalid_contract");
  }
  return { candidates, unresolvedPageIds };
}

export async function fetchMetaGraphRuntimeCredential(
  organizationId: string,
  pageId: string,
): Promise<MetaGraphRuntimeCredential> {
  // O Graph runtime do Enterprise usa a mesma credencial de Página do Campaign Control.
  // O App Secret permanece opcional, exatamente como no conector local.
  const { data, error } = await database().rpc("get_campaign_control_meta_runtime_credentials", {
    p_organization_id: organizationId,
    p_page_id: pageId,
  });
  if (error) throw databaseError(error);
  if (!isObject(data)) throw new MetaCredentialStoreError("invalid_contract");
  const returnedOrganizationId = typeof data.organization_id === "string" && UUID_PATTERN.test(data.organization_id)
    ? data.organization_id
    : null;
  const returnedPageId = metaId(data.page_id);
  const appSecret = data.app_secret === null || data.app_secret === undefined
    ? null
    : secret(data.app_secret, 24, 512);
  const accessToken = secret(data.access_token, 32, 8_192);
  if (
    returnedOrganizationId !== organizationId ||
    returnedPageId !== pageId ||
    (data.app_secret !== null && data.app_secret !== undefined && !appSecret) ||
    !accessToken
  ) {
    throw new MetaCredentialStoreError("invalid_contract");
  }
  return {
    organizationId: returnedOrganizationId,
    pageId: returnedPageId,
    appSecret,
    accessToken,
  };
}

export async function fetchMetaWorkerRuntimeCredential(): Promise<MetaWorkerRuntimeCredential> {
  const { data, error } = await database().rpc("get_meta_worker_runtime_credentials", {});
  if (error) throw databaseError(error);
  return parseMetaWorkerRuntimeCredential(data);
}

export function parseMetaWorkerRuntimeCredential(data: unknown): MetaWorkerRuntimeCredential {
  if (!isObject(data)) throw new MetaCredentialStoreError("invalid_contract");
  const workerUrl = typeof data.worker_url === "string" && data.worker_url.length <= 2_048
    ? data.worker_url
    : null;
  const workerSecret = secret(data.worker_secret, 32, 512);
  if (!workerUrl || !workerSecret) throw new MetaCredentialStoreError("invalid_contract");
  try {
    const parsed = new URL(workerUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      parsed.search ||
      parsed.pathname !== "/api/integrations/meta/leads/process"
    ) {
      throw new Error("invalid worker URL");
    }
    return { workerUrl: parsed.toString(), workerSecret };
  } catch {
    throw new MetaCredentialStoreError("invalid_contract");
  }
}
