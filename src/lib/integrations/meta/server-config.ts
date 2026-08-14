import {
  fetchMetaGraphRuntimeCredential,
  fetchMetaWorkerRuntimeCredential,
  fetchMetaWebhookRuntimeCredentials,
  MetaCredentialStoreError,
  type MetaWebhookRuntimeCredential,
} from "./credential-store";
import { resolveConditionalWebhookSecrets } from "./credential-contract";

export class MetaIntegrationConfigError extends Error {
  readonly code = "META_INTEGRATION_NOT_CONFIGURED";

  constructor(variableName: string) {
    super(`A variável de servidor ${variableName} não foi configurada corretamente.`);
    this.name = "MetaIntegrationConfigError";
  }
}

function requiredSecret(name: string, minimumLength = 16, maximumLength = 8_192): string {
  const value = process.env[name]?.trim();
  if (!value || value.length < minimumLength || value.length > maximumLength || /\s/.test(value)) {
    throw new MetaIntegrationConfigError(name);
  }
  return value;
}

function positiveInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new MetaIntegrationConfigError(name);
  }
  return value;
}

function supabaseUrl(): string {
  const raw =
    process.env.SUPABASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!raw) throw new MetaIntegrationConfigError("SUPABASE_URL");
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))
    ) {
      throw new Error("invalid protocol");
    }
    return parsed.origin;
  } catch {
    throw new MetaIntegrationConfigError("SUPABASE_URL");
  }
}

function allowEnvironmentCredentialFallback(): boolean {
  return process.env.META_CREDENTIALS_ENV_FALLBACK?.trim().toLowerCase() === "true";
}

function canUseEnvironmentCredentialFallback(error: unknown): boolean {
  return allowEnvironmentCredentialFallback() &&
    error instanceof MetaCredentialStoreError &&
    error.kind === "rpc_missing";
}

export function buildEnvironmentWebhookCredential(
  pageIds: string[],
): MetaWebhookRuntimeCredential {
  return {
    organizationId: "environment-bootstrap",
    pageIds,
    ...resolveConditionalWebhookSecrets(
      pageIds,
      () => requiredSecret("META_APP_SECRET", 24, 512),
      () => requiredSecret("META_WEBHOOK_VERIFY_TOKEN", 24, 512),
    ),
  };
}

export async function getMetaWebhookCredentialCandidates(
  pageIds: string[] = [],
) {
  try {
    return await fetchMetaWebhookRuntimeCredentials(pageIds);
  } catch (error) {
    if (canUseEnvironmentCredentialFallback(error)) {
      return {
        candidates: [buildEnvironmentWebhookCredential(pageIds)],
        unresolvedPageIds: [],
      };
    }
    throw new MetaIntegrationConfigError("META_CREDENTIAL_VAULT");
  }
}

function pageAccessToken(pageId: string): string {
  const rawMap = process.env.META_PAGE_ACCESS_TOKENS_JSON?.trim();
  if (rawMap) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMap) as unknown;
    } catch {
      throw new MetaIntegrationConfigError("META_PAGE_ACCESS_TOKENS_JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new MetaIntegrationConfigError("META_PAGE_ACCESS_TOKENS_JSON");
    }
    const token = (parsed as Record<string, unknown>)[pageId];
    if (
      typeof token === "string" &&
      token.length >= 32 &&
      token.length <= 8_192 &&
      token.trim() === token &&
      !/\s/.test(token)
    ) {
      return token;
    }
  }
  return requiredSecret("META_LEADS_ACCESS_TOKEN", 32, 8_192);
}

export async function getMetaGraphConfig(organizationId: string, pageId: string) {
  const apiVersion = process.env.META_GRAPH_API_VERSION?.trim() || "v26.0";
  if (!apiVersion || !/^v\d{1,3}\.\d{1,2}$/.test(apiVersion)) {
    throw new MetaIntegrationConfigError("META_GRAPH_API_VERSION");
  }
  let credentials: { appSecret: string | null; accessToken: string };
  try {
    const stored = await fetchMetaGraphRuntimeCredential(organizationId, pageId);
    credentials = {
      appSecret: stored.appSecret,
      accessToken: stored.accessToken,
    };
  } catch (error) {
    if (!canUseEnvironmentCredentialFallback(error)) {
      throw new MetaIntegrationConfigError("META_CREDENTIAL_VAULT");
    }
    credentials = {
      appSecret: requiredSecret("META_APP_SECRET", 24, 512),
      accessToken: pageAccessToken(pageId),
    };
  }
  return {
    apiVersion,
    ...credentials,
    requestTimeoutMs: positiveInteger(
      "META_GRAPH_TIMEOUT_MS",
      12_000,
      1_000,
      30_000,
    ),
  };
}

export function getMetaProcessorConfig() {
  const defaultCountryCode =
    process.env.META_DEFAULT_COUNTRY_CODE?.trim() || "55";
  if (!/^[1-9]\d{0,2}$/.test(defaultCountryCode)) {
    throw new MetaIntegrationConfigError("META_DEFAULT_COUNTRY_CODE");
  }
  const marketingConsentCheckboxKeys = (
    process.env.META_MARKETING_CONSENT_CHECKBOX_KEYS || ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    marketingConsentCheckboxKeys.length > 20 ||
    marketingConsentCheckboxKeys.some((value) => value.length > 128) ||
    marketingConsentCheckboxKeys.join(",").length > 180
  ) {
    throw new MetaIntegrationConfigError("META_MARKETING_CONSENT_CHECKBOX_KEYS");
  }
  return {
    batchSize: positiveInteger("META_LEADS_BATCH_SIZE", 10, 1, 25),
    leaseSeconds: positiveInteger("META_LEADS_LEASE_SECONDS", 120, 30, 600),
    concurrency: positiveInteger("META_LEADS_CONCURRENCY", 3, 1, 5),
    defaultCountryCode,
    marketingConsentCheckboxKeys,
  };
}

export async function getMetaWorkerConfig() {
  try {
    return await fetchMetaWorkerRuntimeCredential();
  } catch {
    throw new MetaIntegrationConfigError("META_WORKER_VAULT");
  }
}

export function getSupabaseIntegrationConfig() {
  const secretKey =
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!secretKey || secretKey.length < 32) {
    throw new MetaIntegrationConfigError("SUPABASE_SECRET_KEY");
  }
  return {
    url: supabaseUrl(),
    serviceRoleKey: secretKey,
  };
}
