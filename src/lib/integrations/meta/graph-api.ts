import { createHmac } from "node:crypto";

import type { MetaLeadNotification } from "./webhook-core";
import { getMetaGraphConfig } from "./server-config";
import {
  assertMatchingMetaIdentifier,
  isMetaAuthOrPermissionError,
  MetaGraphRequestError,
} from "./graph-error";

export { MetaGraphRequestError } from "./graph-error";

type JsonObject = Record<string, unknown>;
type MetaGraphConfig = Awaited<ReturnType<typeof getMetaGraphConfig>>;

const META_ID_PATTERN = /^\d{1,64}$/;
const MAX_GRAPH_RESPONSE_BYTES = 1024 * 1024;
const RETRYABLE_META_CODES = new Set([1, 2, 4, 17, 32, 341, 613, 80004]);

export type MetaLeadBundle = {
  provider: "meta";
  channel: "meta_lead_ads";
  fetched_at: string;
  lead: JsonObject;
  attribution: {
    provider_account_id: string | null;
    campaign_id: string | null;
    campaign_name: string | null;
    adset_id: string | null;
    adset_name: string | null;
    ad_id: string | null;
    ad_name: string | null;
    creative_id: string | null;
    creative_name: string | null;
    form_id: string | null;
    form_name: string | null;
    page_id: string;
    page_name: string | null;
    publisher_platform: string | null;
    placement: string | null;
    attribution_incomplete: boolean;
    enrichment_warnings: string[];
  };
  graph: {
    ad: JsonObject | null;
    form: JsonObject | null;
  };
  webhook: {
    event_key: string;
    leadgen_id: string;
    page_id: string;
    form_id: string | null;
    ad_id: string | null;
    created_time: number | null;
  };
};

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, maximumLength = 512): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximumLength ? normalized : null;
}

function idValue(value: unknown): string | null {
  const normalized =
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  return META_ID_PATTERN.test(normalized) ? normalized : null;
}

function requireMetaId(value: string): string {
  if (!META_ID_PATTERN.test(value)) {
    throw new MetaGraphRequestError("INVALID_META_ID", 400, false);
  }
  return value;
}

function graphErrorCode(payload: unknown, status: number): {
  code: string;
  retryable: boolean;
  metaCode: number | null;
} {
  const error = isObject(payload) && isObject(payload.error) ? payload.error : null;
  const metaCode = error && typeof error.code === "number" ? error.code : null;
  const subcode = error && typeof error.error_subcode === "number" ? error.error_subcode : null;
  const isTransient = error?.is_transient === true;
  return {
    code: `META_GRAPH_${metaCode ?? status}${subcode ? `_${subcode}` : ""}`,
    retryable:
      isTransient ||
      status === 408 ||
      status === 429 ||
      status >= 500 ||
      (metaCode !== null && RETRYABLE_META_CODES.has(metaCode)),
    metaCode,
  };
}

async function readGraphJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_GRAPH_RESPONSE_BYTES) {
    throw new MetaGraphRequestError("META_GRAPH_RESPONSE_TOO_LARGE", 502, true);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_GRAPH_RESPONSE_BYTES) {
    throw new MetaGraphRequestError("META_GRAPH_RESPONSE_TOO_LARGE", 502, true);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MetaGraphRequestError("META_GRAPH_INVALID_JSON", 502, true);
  }
}

async function fetchGraphObject(
  objectId: string,
  fields: readonly string[],
  config: MetaGraphConfig,
): Promise<JsonObject> {
  const url = new URL(
    `https://graph.facebook.com/${config.apiVersion}/${requireMetaId(objectId)}`,
  );
  url.searchParams.set("fields", fields.join(","));
  // Igual ao Évora Campaign Control: appsecret_proof só é enviado quando
  // há App Secret configurado. Page Access Token continua funcional sem ele.
  if (config.appSecret) {
    const appSecretProof = createHmac("sha256", config.appSecret)
      .update(config.accessToken)
      .digest("hex");
    url.searchParams.set("appsecret_proof", appSecretProof);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.accessToken}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    const code = error instanceof Error && error.name === "TimeoutError"
      ? "META_GRAPH_TIMEOUT"
      : "META_GRAPH_NETWORK_ERROR";
    throw new MetaGraphRequestError(code, 503, true);
  }

  const payload = await readGraphJson(response);
  if (!response.ok || (isObject(payload) && isObject(payload.error))) {
    const failure = graphErrorCode(payload, response.status);
    throw new MetaGraphRequestError(
      failure.code,
      response.status,
      failure.retryable,
      failure.metaCode,
    );
  }
  if (!isObject(payload)) {
    throw new MetaGraphRequestError("META_GRAPH_INVALID_OBJECT", 502, true);
  }
  return payload;
}

function normalizeFieldData(value: unknown): Array<{ name: string; values: string[] }> {
  if (!Array.isArray(value) || value.length > 100) {
    throw new MetaGraphRequestError("META_LEAD_FIELD_DATA_INVALID", 502, false);
  }
  return value.map((candidate) => {
    if (!isObject(candidate)) {
      throw new MetaGraphRequestError("META_LEAD_FIELD_DATA_INVALID", 502, false);
    }
    const name = stringValue(candidate.name, 128);
    if (!name || !Array.isArray(candidate.values) || candidate.values.length > 20) {
      throw new MetaGraphRequestError("META_LEAD_FIELD_DATA_INVALID", 502, false);
    }
    const values = candidate.values.map((item) => {
      if (typeof item !== "string" || item.length > 4_096) {
        throw new MetaGraphRequestError("META_LEAD_FIELD_DATA_INVALID", 502, false);
      }
      return item;
    });
    return { name, values };
  });
}

async function optionalEnrichment(
  objectId: string | null,
  fields: readonly string[],
  config: MetaGraphConfig,
  warningCode: string,
): Promise<{ data: JsonObject | null; warning: string | null }> {
  if (!objectId) return { data: null, warning: null };
  try {
    return {
      data: await fetchGraphObject(objectId, fields, config),
      warning: null,
    };
  } catch (error) {
    if (
      error instanceof MetaGraphRequestError &&
      !error.retryable &&
      !isMetaAuthOrPermissionError(error)
    ) {
      return { data: null, warning: warningCode };
    }
    throw error;
  }
}

function nestedObject(source: JsonObject | null, key: string): JsonObject | null {
  if (!source || !isObject(source[key])) return null;
  return source[key];
}

async function fetchLeadObject(
  leadgenId: string,
  config: MetaGraphConfig,
): Promise<JsonObject> {
  try {
    return await fetchGraphObject(
      leadgenId,
      [
        "id",
        "created_time",
        "ad_id",
        "form_id",
        "field_data",
        "custom_disclaimer_responses",
        "campaign_id",
        "adset_id",
        "platform",
        "is_organic",
      ],
      config,
    );
  } catch (error) {
    if (
      !(error instanceof MetaGraphRequestError) ||
      error.retryable ||
      isMetaAuthOrPermissionError(error) ||
      ![400, 403].includes(error.status)
    ) {
      throw error;
    }
  }

  try {
    return await fetchGraphObject(
      leadgenId,
      [
        "id",
        "created_time",
        "ad_id",
        "form_id",
        "field_data",
        "custom_disclaimer_responses",
      ],
      config,
    );
  } catch (error) {
    if (
      !(error instanceof MetaGraphRequestError) ||
      error.retryable ||
      isMetaAuthOrPermissionError(error) ||
      ![400, 403].includes(error.status)
    ) {
      throw error;
    }
  }

  return fetchGraphObject(
    leadgenId,
    ["id", "created_time", "ad_id", "form_id", "field_data"],
    config,
  );
}

export async function fetchMetaLeadBundle(
  notification: MetaLeadNotification,
  organizationId: string,
): Promise<MetaLeadBundle> {
  const config = await getMetaGraphConfig(organizationId, notification.pageId);
  const lead = await fetchLeadObject(notification.leadgenId, config);
  const leadId = idValue(lead.id);
  if (leadId !== notification.leadgenId) {
    throw new MetaGraphRequestError("META_LEAD_ID_MISMATCH", 502, false);
  }
  const graphAdId = idValue(lead.ad_id);
  const graphFormId = idValue(lead.form_id);
  assertMatchingMetaIdentifier(
    notification.adId,
    graphAdId,
    "META_LEAD_AD_ID_MISMATCH",
  );
  assertMatchingMetaIdentifier(
    notification.formId,
    graphFormId,
    "META_LEAD_FORM_ID_MISMATCH",
  );
  const normalizedLead: JsonObject = {
    ...lead,
    id: leadId,
    field_data: normalizeFieldData(lead.field_data),
  };

  const adId = graphAdId || notification.adId;
  const formId = graphFormId || notification.formId;
  const [adEnrichment, formEnrichment] = await Promise.all([
    optionalEnrichment(
      adId,
      [
        "id",
        "name",
        "account_id",
        "adset{id,name,campaign{id,name}}",
        "creative{id,name}",
      ],
      config,
      "META_AD_ENRICHMENT_UNAVAILABLE",
    ),
    optionalEnrichment(
      formId,
      ["id", "name", "locale", "status", "page{id,name}"],
      config,
      "META_FORM_ENRICHMENT_UNAVAILABLE",
    ),
  ]);
  const ad = adEnrichment.data;
  const form = formEnrichment.data;
  const enrichmentWarnings = [adEnrichment.warning, formEnrichment.warning]
    .filter((value): value is string => value !== null);

  const adset = nestedObject(ad, "adset");
  const campaign = nestedObject(adset, "campaign");
  const creative = nestedObject(ad, "creative");
  const page = nestedObject(form, "page");
  assertMatchingMetaIdentifier(
    notification.pageId,
    idValue(page?.id),
    "META_FORM_PAGE_ID_MISMATCH",
  );

  return {
    provider: "meta",
    channel: "meta_lead_ads",
    fetched_at: new Date().toISOString(),
    lead: normalizedLead,
    attribution: {
      provider_account_id: idValue(ad?.account_id),
      campaign_id: idValue(lead.campaign_id) || idValue(campaign?.id),
      campaign_name: stringValue(campaign?.name),
      adset_id: idValue(lead.adset_id) || idValue(adset?.id),
      adset_name: stringValue(adset?.name),
      ad_id: adId,
      ad_name: stringValue(ad?.name),
      creative_id: idValue(creative?.id),
      creative_name: stringValue(creative?.name),
      form_id: formId,
      form_name: stringValue(form?.name),
      page_id: notification.pageId,
      page_name: stringValue(page?.name),
      publisher_platform: stringValue(lead.platform, 64),
      placement: null,
      attribution_incomplete: enrichmentWarnings.length > 0,
      enrichment_warnings: enrichmentWarnings,
    },
    graph: { ad, form },
    webhook: {
      event_key: notification.eventKey,
      leadgen_id: notification.leadgenId,
      page_id: notification.pageId,
      form_id: notification.formId,
      ad_id: notification.adId,
      created_time: notification.createdTime,
    },
  };
}
