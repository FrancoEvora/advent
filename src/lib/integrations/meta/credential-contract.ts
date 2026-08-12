export type MetaCredentialState = {
  configured: boolean;
  version: number | null;
  configuredAt: string | null;
  updatedAt: string | null;
};

export type MetaPageCredentialStatus = {
  pageId: string;
  registeredAt: string | null;
  updatedAt: string | null;
  routeCount: number;
  activeRouteCount: number;
  accessToken: MetaCredentialState;
};

export type MetaCredentialStatus = {
  organizationId: string;
  appSecret: MetaCredentialState;
  verifyToken: MetaCredentialState;
  pages: MetaPageCredentialStatus[];
  ready: {
    webhookVerification: boolean;
    signatureValidation: boolean;
    graphPages: number;
  };
};

type JsonObject = Record<string, unknown>;

const META_ID_PATTERN = /^\d{1,64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseMetaCredentialBearer(value: string | null): string | null {
  const match = /^Bearer ([^\s]{20,4096})$/i.exec(value || "");
  return match ? match[1] : null;
}

export function resolveConditionalWebhookSecrets(
  pageIds: string[],
  readAppSecret: () => string,
  readVerifyToken: () => string,
): { appSecret: string | null; verifyToken: string | null } {
  return pageIds.length
    ? { appSecret: readAppSecret(), verifyToken: null }
    : { appSecret: null, verifyToken: readVerifyToken() };
}

function objectValue(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function timestampValue(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function nonNegativeInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function credentialState(value: unknown): MetaCredentialState {
  const source = objectValue(value);
  return {
    configured: source.configured === true,
    version: source.configured === true ? nonNegativeInteger(source.version) || null : null,
    configuredAt: timestampValue(source.configured_at),
    updatedAt: timestampValue(source.updated_at),
  };
}

export function parseMetaCredentialStatus(value: unknown): MetaCredentialStatus {
  const source = objectValue(value);
  const organizationId = typeof source.organization_id === "string" && UUID_PATTERN.test(source.organization_id)
    ? source.organization_id
    : "";
  if (!organizationId) throw new Error("META_CREDENTIAL_STATUS_INVALID");

  const pages = Array.isArray(source.pages)
    ? source.pages.flatMap((value): MetaPageCredentialStatus[] => {
        const page = objectValue(value);
        const pageId = typeof page.page_id === "string" && META_ID_PATTERN.test(page.page_id)
          ? page.page_id
          : "";
        if (!pageId) return [];
        return [{
          pageId,
          registeredAt: timestampValue(page.registered_at),
          updatedAt: timestampValue(page.updated_at),
          routeCount: nonNegativeInteger(page.route_count),
          activeRouteCount: nonNegativeInteger(page.active_route_count),
          accessToken: credentialState(page.access_token),
        }];
      })
    : [];
  const ready = objectValue(source.ready);
  return {
    organizationId,
    appSecret: credentialState(source.app_secret),
    verifyToken: credentialState(source.verify_token),
    pages,
    ready: {
      webhookVerification: ready.webhook_verification === true,
      signatureValidation: ready.signature_validation === true,
      graphPages: nonNegativeInteger(ready.graph_pages),
    },
  };
}
