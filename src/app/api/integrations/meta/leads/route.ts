import { after, type NextRequest, NextResponse } from "next/server";

import { processMetaLeadQueue } from "@/lib/integrations/meta/processor";
import { getMetaWebhookCredentialCandidates } from "@/lib/integrations/meta/server-config";
import {
  enqueueMetaLeadDelivery,
  MetaInboxGatewayError,
} from "@/lib/integrations/meta/supabase-gateway";
import {
  correlationIdOrNew,
  extractMetaPageIdsForSignature,
  META_WEBHOOK_MAX_BYTES,
  MetaWebhookInputError,
  parseMetaVerificationRequest,
  parseMetaWebhookPayload,
  sha256Hex,
  verifyMetaWebhookCandidateCoverage,
} from "@/lib/integrations/meta/webhook-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function jsonError(code: string, status: number, correlationId?: string) {
  return NextResponse.json(
    {
      received: false,
      error: code,
      ...(correlationId ? { correlationId } : {}),
    },
    { status, headers: NO_STORE_HEADERS },
  );
}

async function readBodyWithinLimit(request: NextRequest): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    if (!/^\d+$/.test(contentLength)) {
      throw new MetaWebhookInputError(
        "INVALID_CONTENT_LENGTH",
        "O tamanho do evento Meta é inválido.",
      );
    }
    if (Number(contentLength) > META_WEBHOOK_MAX_BYTES) {
      throw new MetaWebhookInputError(
        "META_PAYLOAD_TOO_LARGE",
        "O evento Meta excede o limite permitido.",
        413,
      );
    }
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > META_WEBHOOK_MAX_BYTES) {
      await reader.cancel();
      throw new MetaWebhookInputError(
        "META_PAYLOAD_TOO_LARGE",
        "O evento Meta excede o limite permitido.",
        413,
      );
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function safeLogCode(error: unknown): string {
  if (
    error instanceof MetaWebhookInputError ||
    error instanceof MetaInboxGatewayError
  ) {
    return error.code;
  }
  return error instanceof Error ? error.name : "UnknownError";
}

export async function GET(request: NextRequest) {
  try {
    const { candidates } = await getMetaWebhookCredentialCandidates();
    for (const candidate of candidates) {
      if (!candidate.verifyToken) continue;
      try {
        const challenge = parseMetaVerificationRequest(
          request.nextUrl.searchParams,
          candidate.verifyToken,
        );
        return new NextResponse(challenge, {
          status: 200,
          headers: {
            ...NO_STORE_HEADERS,
            "Content-Type": "text/plain; charset=utf-8",
          },
        });
      } catch (error) {
        if (error instanceof MetaWebhookInputError && error.code === "INVALID_META_CHALLENGE") {
          throw error;
        }
      }
    }
    throw new MetaWebhookInputError(
      "META_VERIFICATION_DENIED",
      "A verificação do webhook Meta foi recusada.",
      403,
    );
  } catch (error) {
    if (error instanceof MetaWebhookInputError) {
      return jsonError(error.code, error.status);
    }
    console.error("Meta webhook verification unavailable", {
      errorCode: safeLogCode(error),
    });
    return jsonError("META_INTEGRATION_UNAVAILABLE", 503);
  }
}

export async function POST(request: NextRequest) {
  const correlationId = correlationIdOrNew(
    request.headers.get("x-correlation-id"),
  );
  try {
    const contentType = request.headers.get("content-type");
    if (!contentType?.toLowerCase().startsWith("application/json")) {
      return jsonError("UNSUPPORTED_CONTENT_TYPE", 415, correlationId);
    }

    const rawBody = await readBodyWithinLimit(request);
    const signature = request.headers.get("x-hub-signature-256");
    const pageIds = extractMetaPageIdsForSignature(rawBody);
    if (pageIds.length === 0) {
      return jsonError("INVALID_META_SIGNATURE", 401, correlationId);
    }
    const credentials = await getMetaWebhookCredentialCandidates(pageIds);
    const signatureCandidates = credentials.candidates.flatMap((item) =>
      item.appSecret ? [{ pageIds: item.pageIds, appSecret: item.appSecret }] : []);
    const signatureIsValid = credentials.unresolvedPageIds.length === 0 &&
      verifyMetaWebhookCandidateCoverage(
        rawBody,
        signature,
        pageIds,
        signatureCandidates,
      );
    if (!signatureIsValid) {
      return jsonError("INVALID_META_SIGNATURE", 401, correlationId);
    }

    const parsed = parseMetaWebhookPayload(rawBody);
    const extractedPages = new Set(pageIds);
    if (parsed.notifications.some((notification) => !extractedPages.has(notification.pageId))) {
      return jsonError("INVALID_META_SIGNATURE_SCOPE", 401, correlationId);
    }
    if (parsed.notifications.length === 0) {
      return NextResponse.json(
        { received: true, ignored: true, correlationId },
        { status: 200, headers: NO_STORE_HEADERS },
      );
    }

    const receivedAt = new Date().toISOString();
    const delivery = await enqueueMetaLeadDelivery({
      notifications: parsed.notifications,
      rawBodySha256: sha256Hex(rawBody),
      rawBody: parsed.payload,
      correlationId,
      receivedAt,
      requestHeaders: {
        "content-type": contentType.slice(0, 256),
        "user-agent": request.headers.get("user-agent")?.slice(0, 512) || null,
        "x-hub-signature-256": signature || "",
      },
    });

    if (delivery.mappedEvents > 0) {
      after(async () => {
        try {
          await processMetaLeadQueue();
        } catch (error) {
          console.error("Meta lead best-effort processing deferred", {
            correlationId,
            errorCode: safeLogCode(error),
          });
        }
      });
    }

    return NextResponse.json(
      {
        received: true,
        events: delivery.totalEvents,
        queued: delivery.insertedEvents,
        duplicates: delivery.duplicateEvents,
        unmapped: delivery.unmappedEvents,
        correlationId,
      },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (error instanceof MetaWebhookInputError) {
      return jsonError(error.code, error.status, correlationId);
    }
    if (error instanceof MetaInboxGatewayError && !error.retryable) {
      const status = error.code.includes("TOO_LARGE") ? 413 : 422;
      return jsonError(error.code, status, correlationId);
    }
    console.error("Meta webhook enqueue unavailable", {
      correlationId,
      errorCode: safeLogCode(error),
    });
    return jsonError("META_INGRESS_UNAVAILABLE", 503, correlationId);
  }
}
