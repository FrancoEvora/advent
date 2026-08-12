import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { MetaLeadNotification } from "./webhook-core";
import { getSupabaseIntegrationConfig } from "./server-config";

type JsonObject = Record<string, unknown>;

// Contrato Postgres concentrado: nenhuma rota conhece nomes de argumentos RPC.
const META_INGRESS_RPC = {
  enqueue: {
    name: "enqueue_meta_lead_delivery",
    rawBodySha256: "p_raw_body_sha256",
    rawBody: "p_raw_body",
    requestHeaders: "p_request_headers",
    signatureVerified: "p_signature_verified",
    events: "p_events",
    correlationId: "p_correlation_id",
    receivedAt: "p_received_at",
  },
  claim: {
    name: "claim_meta_lead_events",
    workerId: "p_worker_id",
    limit: "p_limit",
    leaseSeconds: "p_lease_seconds",
  },
  ingest: {
    name: "ingest_meta_lead",
    eventId: "p_event_id",
    lockToken: "p_lock_token",
    lead: "p_lead",
  },
  fail: {
    name: "fail_meta_lead_event",
    eventId: "p_event_id",
    lockToken: "p_lock_token",
    errorCode: "p_error_code",
    errorMessage: "p_error_message",
    retryable: "p_retryable",
  },
} as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const META_ID_PATTERN = /^\d{1,64}$/;
const MAX_EVENT_PAYLOAD_BYTES = 32 * 1024;

export type MetaEnqueueInput = {
  notifications: MetaLeadNotification[];
  rawBodySha256: string;
  rawBody: JsonObject;
  correlationId: string;
  receivedAt: string;
  requestHeaders: {
    "content-type": string | null;
    "user-agent": string | null;
    "x-hub-signature-256": string;
  };
};

export type EnqueuedMetaLeadDelivery = {
  deliveryId: string;
  totalEvents: number;
  insertedEvents: number;
  duplicateEvents: number;
  mappedEvents: number;
  unmappedEvents: number;
};

export type ClaimedMetaLeadEvent = {
  id: string;
  lockToken: string;
  organizationId: string;
  metaLeadId: string;
  pageId: string;
  formId: string | null;
  eventOccurredAt: string;
  defaultCountryCallingCode: string | null;
  eventPayload: JsonObject;
  correlationId: string | null;
  attempts: number;
};

export class MetaInboxGatewayError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(operation: string, databaseCode?: string, retryable = true) {
    super(`A fila de integração falhou em ${operation}.`);
    this.name = "MetaInboxGatewayError";
    this.code = databaseCode
      ? `META_INBOX_${operation.toUpperCase()}_${databaseCode}`
      : `META_INBOX_${operation.toUpperCase()}_FAILED`;
    this.retryable = retryable;
  }
}

let integrationClient: SupabaseClient | null = null;

function database(): SupabaseClient {
  if (integrationClient) return integrationClient;
  const config = getSupabaseIntegrationConfig();
  integrationClient = createClient(config.url, config.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      headers: { "X-Client-Info": "evora-meta-leads/1.0" },
    },
  });
  return integrationClient;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function databaseCode(error: unknown): string | undefined {
  if (!isObject(error) || typeof error.code !== "string") return undefined;
  return error.code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined;
}

function metaId(value: unknown): string | null {
  const normalized =
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  return META_ID_PATTERN.test(normalized) ? normalized : null;
}

function safeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function parseClaimedEvent(value: unknown): ClaimedMetaLeadEvent | null {
  if (!isObject(value)) return null;
  const id = typeof value.event_id === "string" ? value.event_id : "";
  const lockToken = typeof value.lock_token === "string" ? value.lock_token : "";
  const organizationId = typeof value.organization_id === "string" ? value.organization_id : "";
  const metaLeadId = metaId(value.meta_lead_id);
  const pageId = metaId(value.page_id);
  const formId = metaId(value.form_id);
  const eventOccurredAt = safeTimestamp(value.event_occurred_at);
  const defaultCountryCallingCode =
    value.default_country_calling_code === null ||
    value.default_country_calling_code === undefined
      ? null
      : typeof value.default_country_calling_code === "string" &&
          /^[1-9]\d{0,2}$/.test(value.default_country_calling_code)
        ? value.default_country_calling_code
        : undefined;
  const eventPayload = isObject(value.event_payload) ? value.event_payload : null;
  if (
    !UUID_PATTERN.test(id) ||
    !UUID_PATTERN.test(lockToken) ||
    !UUID_PATTERN.test(organizationId) ||
    !metaLeadId ||
    !pageId ||
    !eventOccurredAt ||
    defaultCountryCallingCode === undefined ||
    !eventPayload
  ) {
    return null;
  }
  const rawAttempts = value.attempt_count ?? 0;
  const attempts = Number.isSafeInteger(rawAttempts) ? Number(rawAttempts) : 0;
  return {
    id,
    lockToken,
    organizationId,
    metaLeadId,
    pageId,
    formId,
    eventOccurredAt,
    defaultCountryCallingCode,
    eventPayload,
    correlationId:
      typeof value.correlation_id === "string" ? value.correlation_id : null,
    attempts,
  };
}

function eventPayload(notification: MetaLeadNotification): JsonObject {
  const value = {
    field: "leadgen",
    value: {
      leadgen_id: notification.leadgenId,
      page_id: notification.pageId,
      form_id: notification.formId,
      ad_id: notification.adId,
      created_time: notification.createdTime,
    },
    entry_index: notification.entryIndex,
    change_index: notification.changeIndex,
    ad_id: notification.adId,
    created_time: notification.createdTime,
  };
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
    throw new MetaInboxGatewayError("event_payload_too_large", undefined, false);
  }
  return value;
}

export async function enqueueMetaLeadDelivery(
  input: MetaEnqueueInput,
): Promise<EnqueuedMetaLeadDelivery> {
  if (input.notifications.length === 0 || input.notifications.length > 1_000) {
    throw new MetaInboxGatewayError("invalid_event_batch", undefined, false);
  }
  const events = input.notifications.map((notification) => ({
    event_key: notification.eventKey,
    meta_lead_id: notification.leadgenId,
    page_id: notification.pageId,
    form_id: notification.formId,
    event_occurred_at:
      notification.createdTime === null
        ? input.receivedAt
        : new Date(notification.createdTime * 1_000).toISOString(),
    event_payload: eventPayload(notification),
  }));
  const { data, error } = await database().rpc(META_INGRESS_RPC.enqueue.name, {
    [META_INGRESS_RPC.enqueue.rawBodySha256]: input.rawBodySha256,
    [META_INGRESS_RPC.enqueue.rawBody]: input.rawBody,
    [META_INGRESS_RPC.enqueue.requestHeaders]: input.requestHeaders,
    [META_INGRESS_RPC.enqueue.signatureVerified]: true,
    [META_INGRESS_RPC.enqueue.events]: events,
    [META_INGRESS_RPC.enqueue.correlationId]: input.correlationId,
    [META_INGRESS_RPC.enqueue.receivedAt]: input.receivedAt,
  });
  if (error) {
    throw new MetaInboxGatewayError("enqueue", databaseCode(error));
  }
  const result = Array.isArray(data) ? data[0] : data;
  if (
    !isObject(result) ||
    typeof result.delivery_id !== "string" ||
    typeof result.total_events !== "number" ||
    typeof result.inserted_events !== "number" ||
    typeof result.duplicate_events !== "number" ||
    typeof result.mapped_events !== "number" ||
    typeof result.unmapped_events !== "number"
  ) {
    throw new MetaInboxGatewayError("enqueue_contract", undefined, false);
  }
  return {
    deliveryId: result.delivery_id,
    totalEvents: result.total_events,
    insertedEvents: result.inserted_events,
    duplicateEvents: result.duplicate_events,
    mappedEvents: result.mapped_events,
    unmappedEvents: result.unmapped_events,
  };
}

export async function claimMetaLeadEvents(
  workerId: string,
  limit: number,
  leaseSeconds: number,
): Promise<ClaimedMetaLeadEvent[]> {
  const { data, error } = await database().rpc(META_INGRESS_RPC.claim.name, {
    [META_INGRESS_RPC.claim.workerId]: workerId,
    [META_INGRESS_RPC.claim.limit]: limit,
    [META_INGRESS_RPC.claim.leaseSeconds]: leaseSeconds,
  });
  if (error) {
    throw new MetaInboxGatewayError("claim", databaseCode(error));
  }
  const candidates = Array.isArray(data)
    ? data
    : isObject(data) && Array.isArray(data.events)
      ? data.events
      : [];
  const events = candidates.map(parseClaimedEvent).filter((item) => item !== null);
  if (events.length !== candidates.length) {
    throw new MetaInboxGatewayError("claim_contract", undefined, false);
  }
  return events;
}

export async function ingestMetaLeadEvent(
  event: ClaimedMetaLeadEvent,
  lead: JsonObject,
): Promise<void> {
  const { error } = await database().rpc(META_INGRESS_RPC.ingest.name, {
    [META_INGRESS_RPC.ingest.eventId]: event.id,
    [META_INGRESS_RPC.ingest.lockToken]: event.lockToken,
    [META_INGRESS_RPC.ingest.lead]: lead,
  });
  if (error) {
    throw new MetaInboxGatewayError("ingest", databaseCode(error));
  }
}

export async function failMetaLeadEvent(input: {
  event: ClaimedMetaLeadEvent;
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
}): Promise<void> {
  const { error } = await database().rpc(META_INGRESS_RPC.fail.name, {
    [META_INGRESS_RPC.fail.eventId]: input.event.id,
    [META_INGRESS_RPC.fail.lockToken]: input.event.lockToken,
    [META_INGRESS_RPC.fail.errorCode]: input.errorCode.slice(0, 128),
    [META_INGRESS_RPC.fail.errorMessage]: input.errorMessage.slice(0, 512),
    [META_INGRESS_RPC.fail.retryable]: input.retryable,
  });
  if (error) {
    throw new MetaInboxGatewayError("fail", databaseCode(error));
  }
}

export function notificationFromClaim(
  event: ClaimedMetaLeadEvent,
): MetaLeadNotification {
  const value = isObject(event.eventPayload.value) ? event.eventPayload.value : {};
  return {
    eventKey: `meta:leadgen:${event.metaLeadId}`,
    leadgenId: event.metaLeadId,
    pageId: event.pageId,
    formId: event.formId,
    adId: metaId(event.eventPayload.ad_id),
    createdTime:
      typeof event.eventPayload.created_time === "number" &&
      Number.isSafeInteger(event.eventPayload.created_time)
        ? event.eventPayload.created_time
        : Math.floor(Date.parse(event.eventOccurredAt) / 1_000),
    entryIndex: Number(event.eventPayload.entry_index) || 0,
    changeIndex: Number(event.eventPayload.change_index) || 0,
    value,
  };
}
