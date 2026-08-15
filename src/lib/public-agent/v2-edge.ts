import type { PublicAgentProfile, PublicAgentStage } from "./types";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "https://qsdffayasuzsmngteika.supabase.co";
const PUBLIC_EDGE_URL = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/enterprise-public-agent-v2`;

type EdgeOk<T> = { ok: true } & T;
type EdgeFail = { ok: false; error?: string };

export class PublicAgentV2Error extends Error {
  status: number;
  code: string;
  constructor(code: string, status = 503) {
    super(code);
    this.name = "PublicAgentV2Error";
    this.code = code;
    this.status = status;
  }
}

async function edge<T>(body: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(PUBLIC_EDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as EdgeOk<T> | EdgeFail | null;
    if (!payload || !response.ok || payload.ok !== true) {
      const code = payload && payload.ok === false && typeof payload.error === "string"
        ? payload.error
        : `PUBLIC_AGENT_V2_HTTP_${response.status}`;
      const status = response.status === 429 ? 429 : response.status >= 400 && response.status < 500 ? response.status : 503;
      throw new PublicAgentV2Error(code, status);
    }
    const { ok: _ok, ...data } = payload;
    void _ok;
    return data as T;
  } catch (error) {
    if (error instanceof PublicAgentV2Error) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new PublicAgentV2Error("PUBLIC_AGENT_V2_TIMEOUT", 504);
    throw new PublicAgentV2Error("PUBLIC_AGENT_V2_NETWORK_FAILURE", 503);
  } finally {
    clearTimeout(timer);
  }
}

export function publicAgentV2Message(input: {
  slug: string;
  tokenHash: string;
  fingerprintHash: string;
  message: string;
}) {
  return edge<{
    reply: string;
    stage: PublicAgentStage;
    profile: PublicAgentProfile;
    requestContact: boolean;
    quickReplies: string[];
    converted: boolean;
    protocol?: string | null;
  }>({ action: "message", ...input });
}

export function publicAgentV2Transcribe(input: {
  slug: string;
  tokenHash: string;
  fingerprintHash: string;
  audioBase64: string;
  mimeType: string;
}) {
  return edge<{ text: string }>({ action: "transcribe", ...input }, 70_000);
}
