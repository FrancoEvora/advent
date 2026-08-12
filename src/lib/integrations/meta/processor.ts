import { randomUUID } from "node:crypto";

import { fetchMetaLeadBundle, MetaGraphRequestError } from "./graph-api";
import {
  buildMetaIngestPayload,
  MetaLeadNormalizationError,
} from "./lead-normalization";
import { MetaIntegrationConfigError, getMetaProcessorConfig } from "./server-config";
import {
  claimMetaLeadEvents,
  failMetaLeadEvent,
  ingestMetaLeadEvent,
  MetaInboxGatewayError,
  notificationFromClaim,
  type ClaimedMetaLeadEvent,
} from "./supabase-gateway";

export type MetaProcessingResult = {
  claimed: number;
  processed: number;
  failed: number;
  retryable: number;
};

type SafeFailure = {
  code: string;
  message: string;
  retryable: boolean;
};

function safeFailure(error: unknown): SafeFailure {
  if (error instanceof MetaGraphRequestError) {
    return {
      code: error.code,
      message: "A consulta do lead à Graph API não foi concluída.",
      retryable: error.retryable,
    };
  }
  if (error instanceof MetaLeadNormalizationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof MetaInboxGatewayError) {
    return {
      code: error.code,
      message: "O processamento transacional do lead não foi concluído.",
      retryable: error.retryable,
    };
  }
  if (error instanceof MetaIntegrationConfigError) {
    return {
      code: error.code,
      message: "A configuração server-side da integração está incompleta.",
      retryable: true,
    };
  }
  return {
    code: "META_LEAD_UNEXPECTED_FAILURE",
    message: "O processamento do lead encontrou uma falha não classificada.",
    retryable: true,
  };
}

async function processClaimedEvent(
  event: ClaimedMetaLeadEvent,
  normalization: {
    defaultCountryCode: string;
    marketingConsentCheckboxKeys: string[];
  },
): Promise<"processed" | "failed" | "retryable"> {
  try {
    const notification = notificationFromClaim(event);
    const bundle = await fetchMetaLeadBundle(notification, event.organizationId);
    const ingestPayload = buildMetaIngestPayload(
      bundle,
      event.defaultCountryCallingCode || normalization.defaultCountryCode,
      normalization.marketingConsentCheckboxKeys,
    );
    await ingestMetaLeadEvent(event, ingestPayload);
    return "processed";
  } catch (error) {
    const failure = safeFailure(error);
    await failMetaLeadEvent({
      event,
      errorCode: failure.code,
      errorMessage: failure.message,
      retryable: failure.retryable,
    });
    return failure.retryable ? "retryable" : "failed";
  }
}

export async function processMetaLeadQueue(options?: {
  limit?: number;
}): Promise<MetaProcessingResult> {
  const config = getMetaProcessorConfig();
  const limit = Math.max(1, Math.min(options?.limit ?? config.batchSize, 25));
  const workerId = `evora-meta-${randomUUID()}`;
  const events = await claimMetaLeadEvents(workerId, limit, config.leaseSeconds);
  if (events.length === 0) {
    return { claimed: 0, processed: 0, failed: 0, retryable: 0 };
  }

  let cursor = 0;
  const outcomes: Array<"processed" | "failed" | "retryable"> = [];
  const worker = async () => {
    while (cursor < events.length) {
      const event = events[cursor];
      cursor += 1;
      outcomes.push(await processClaimedEvent(event, config));
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(config.concurrency, events.length) },
      () => worker(),
    ),
  );

  return {
    claimed: events.length,
    processed: outcomes.filter((value) => value === "processed").length,
    failed: outcomes.filter((value) => value === "failed").length,
    retryable: outcomes.filter((value) => value === "retryable").length,
  };
}
