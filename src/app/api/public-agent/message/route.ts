import { NextRequest, NextResponse } from "next/server";

import { generatePublicAgentReply, PublicAgentModelError } from "@/lib/public-agent/openai";
import {
  appendPublicAgentTurn,
  enforcePublicAgentOrigin,
  getPublicAgentContext,
  publicAgentCookieName,
  publicAgentFingerprint,
  PublicAgentServerError,
} from "@/lib/public-agent/server";
import type { PublicAgentReply } from "@/lib/public-agent/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fallbackReply(): PublicAgentReply {
  return {
    reply: "Estou com uma instabilidade momentânea, mas não quero interromper seu atendimento. Posso registrar seu contato para um especialista da Évora continuar com você?",
    stage: "handoff",
    profile: {},
    requestContact: true,
    handoffRequested: true,
    quickReplies: ["Quero falar com um especialista"],
    factsUsed: [],
    riskFlags: ["model_unavailable"],
    agentResponseId: null,
    supervisorResponseId: null,
    supervisorDecision: "block",
  };
}

export async function POST(request: NextRequest) {
  let context: Awaited<ReturnType<typeof getPublicAgentContext>> | null = null;
  try {
    enforcePublicAgentOrigin(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new PublicAgentServerError("PUBLIC_AGENT_JSON_REQUIRED", 415);
    }
    const body = await request.json().catch(() => null);
    if (!object(body) || typeof body.slug !== "string" || typeof body.message !== "string") {
      throw new PublicAgentServerError("PUBLIC_AGENT_INPUT_INVALID", 400);
    }
    const message = body.message.trim();
    if (message.length < 1 || message.length > 800) {
      throw new PublicAgentServerError("PUBLIC_AGENT_MESSAGE_INVALID", 400);
    }
    const token = request.cookies.get(publicAgentCookieName(body.slug))?.value;
    if (!token) throw new PublicAgentServerError("PUBLIC_AGENT_SESSION_NOT_FOUND", 401);
    const fingerprint = publicAgentFingerprint(request);
    context = await getPublicAgentContext({ slug: body.slug, token, fingerprint });

    let reply: PublicAgentReply;
    let degraded = false;
    try {
      reply = await generatePublicAgentReply(context, message);
    } catch (error) {
      if (!(error instanceof PublicAgentModelError)) throw error;
      degraded = true;
      reply = { ...fallbackReply(), profile: context.profile || {} };
      console.error("Public agent model degraded", { code: error.code, retryable: error.retryable });
    }

    const persisted = await appendPublicAgentTurn({
      slug: body.slug,
      token,
      fingerprint,
      userMessage: message,
      assistantMessage: reply.reply,
      stage: reply.stage,
      profile: reply.profile,
      metadata: {
        agent_response_id: reply.agentResponseId,
        supervisor_response_id: reply.supervisorResponseId,
        supervisor_decision: reply.supervisorDecision,
        facts_used: reply.factsUsed,
        risk_flags: reply.riskFlags,
        degraded,
      },
    });

    return NextResponse.json(
      {
        ok: true,
        reply: reply.reply,
        stage: persisted.stage,
        profile: persisted.profile,
        requestContact: reply.requestContact,
        handoffRequested: reply.handoffRequested,
        quickReplies: reply.quickReplies,
        converted: persisted.converted,
        degraded,
      },
      { headers: HEADERS },
    );
  } catch (error) {
    const status = error instanceof PublicAgentServerError ? error.status : 503;
    const code = error instanceof PublicAgentServerError
      ? error.code
      : "PUBLIC_AGENT_MESSAGE_UNAVAILABLE";
    if (!(error instanceof PublicAgentServerError)) {
      console.error("Public agent message failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        hasContext: Boolean(context),
      });
    }
    return NextResponse.json({ ok: false, error: code }, { status, headers: HEADERS });
  }
}
