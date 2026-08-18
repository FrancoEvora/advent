import { NextRequest, NextResponse } from "next/server";

import {
  enforcePublicAgentOrigin,
  publicAgentCookieName,
  publicAgentFingerprint,
  PublicAgentServerError,
  respondPublicAgentMessage,
} from "@/lib/public-agent/server";
import type {
  PublicAgentAttachment,
  PublicAgentCommercialContext,
  PublicAgentSimulation,
  PublicAgentTurnResponse,
} from "@/lib/public-agent/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

type JsonObject = Record<string, unknown>;
const CLIENT_MESSAGE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const decimal = new Intl.NumberFormat("pt-BR", {
  maximumFractionDigits: 2,
});

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pct(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.abs(value) <= 1 ? value * 100 : value;
  return `${decimal.format(normalized)}%`;
}

function commercialPrelude(
  simulation?: PublicAgentSimulation | null,
  commercial?: PublicAgentCommercialContext | null,
) {
  if (!simulation && !commercial?.policy) return null;
  const policy = commercial?.policy;
  const lines: string[] = ["Condições comerciais:"];

  if (simulation) {
    const entry = pct(simulation.downPaymentPct);
    if (entry) {
      lines.push(
        simulation.downPaymentInstallments > 1
          ? `• Entrada: ${entry} em ${simulation.downPaymentInstallments}x de ${currency.format(simulation.downPaymentInstallmentAmount)}`
          : `• Entrada: ${entry} (${currency.format(simulation.downPayment)})`,
      );
    }
    if (simulation.scenarios.length) {
      lines.push(
        `• Parcelas: ${simulation.scenarios
          .map((scenario) => `${scenario.months}x de ${currency.format(scenario.monthlyPayment)}`)
          .join(" · ")}`,
      );
    }
    const interest = pct(simulation.monthlyInterestRate);
    if (interest) lines.push(`• Juros: ${interest} ao mês`);
    if (simulation.indexer) lines.push(`• Correção: ${simulation.indexer}`);
    if (simulation.balloonCount > 0) {
      lines.push(
        `• Balões: ${simulation.balloonCount} de ${currency.format(simulation.balloonAmount)} a cada ${simulation.balloonFrequencyMonths} meses`,
      );
    }
  } else if (policy) {
    const entry = pct(policy.minimumDownPaymentPct);
    if (entry) lines.push(`• Entrada mínima: ${entry}`);
    if (typeof policy.maximumInstallments === "number") {
      lines.push(`• Parcelamento: até ${policy.maximumInstallments} meses`);
    }
    const interest = pct(policy.monthlyInterestRate);
    if (interest) lines.push(`• Juros: ${interest} ao mês`);
    if (policy.indexer) lines.push(`• Correção: ${policy.indexer}`);
  }

  return lines.length > 1 ? lines.join("\n") : null;
}

function dedupeAttachments(
  attachments: PublicAgentAttachment[] | undefined,
  simulation?: PublicAgentSimulation | null,
) {
  if (!attachments?.length) return attachments;
  const seen = new Set<string>();
  let simulationDocumentKept = false;

  return attachments.filter((attachment) => {
    const title = attachment.title?.normalize("NFC").trim().toLowerCase() || "";
    const isSimulationDocument = attachment.type === "document" && /simula[cç][aã]o/iu.test(title);
    if (simulation && isSimulationDocument) {
      if (simulationDocumentKept) return false;
      simulationDocumentKept = true;
    }

    const key = [
      attachment.type,
      attachment.id || "",
      attachment.url || "",
      title,
      attachment.mimeType || "",
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizePresentation(result: PublicAgentTurnResponse): PublicAgentTurnResponse {
  if (result.status !== "completed") return result;
  const prelude = commercialPrelude(result.simulation, result.commercial);
  const reply = result.reply || "";
  return {
    ...result,
    reply: prelude && !reply.includes("Condições comerciais:")
      ? `${prelude}\n\n${reply}`.trim()
      : reply,
    attachments: dedupeAttachments(result.attachments, result.simulation),
  };
}

export async function POST(request: NextRequest) {
  try {
    enforcePublicAgentOrigin(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new PublicAgentServerError("PUBLIC_AGENT_JSON_REQUIRED", 415);
    }

    const body = await request.json().catch(() => null);
    if (
      !object(body)
      || typeof body.slug !== "string"
      || typeof body.message !== "string"
      || typeof body.clientMessageId !== "string"
      || !CLIENT_MESSAGE_ID.test(body.clientMessageId)
      || (
        body.source === "audio"
        && (
          typeof body.transcriptionRequestId !== "string"
          || !CLIENT_MESSAGE_ID.test(body.transcriptionRequestId)
        )
      )
    ) {
      throw new PublicAgentServerError("PUBLIC_AGENT_INPUT_INVALID", 400);
    }
    const message = body.message.trim();
    if (message.length < 1 || message.length > 800) {
      throw new PublicAgentServerError("PUBLIC_AGENT_MESSAGE_INVALID", 400);
    }

    const token = request.cookies.get(publicAgentCookieName(body.slug))?.value;
    if (!token) {
      throw new PublicAgentServerError("PUBLIC_AGENT_SESSION_NOT_FOUND", 401);
    }

    const result = normalizePresentation(await respondPublicAgentMessage({
      slug: body.slug,
      token,
      fingerprint: publicAgentFingerprint(request),
      message,
      clientMessageId: body.clientMessageId,
      source: body.source === "audio" ? "audio" : "text",
      transcriptionRequestId: body.source === "audio"
        ? String(body.transcriptionRequestId)
        : null,
    }));

    return NextResponse.json(
      { ok: true, ...result },
      { status: result.status === "processing" ? 202 : 200, headers: HEADERS },
    );
  } catch (error) {
    const status = error instanceof PublicAgentServerError ? error.status : 503;
    const code = error instanceof PublicAgentServerError
      ? error.code
      : "PUBLIC_AGENT_MESSAGE_UNAVAILABLE";
    if (!(error instanceof PublicAgentServerError)) {
      console.error("Public agent message failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return NextResponse.json({ ok: false, error: code }, { status, headers: HEADERS });
  }
}
