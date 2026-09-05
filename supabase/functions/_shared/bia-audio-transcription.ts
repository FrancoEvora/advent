type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
export type AudioDiagnostic = {
  model: string; status: number; code: string; type: string | null; requestId: string | null;
};
export type AudioTranscription = { ok: true; text: string } | { ok: false; code: string };

export async function transcribeBiaAudio(input: {
  apiKey: string;
  model?: string;
  mime: string;
  bytes: Uint8Array;
  timeoutMs: number;
  diagnose: (value: AudioDiagnostic) => Promise<void>;
}): Promise<AudioTranscription> {
  const model = input.model?.trim() || "gpt-4o-mini-transcribe";
  const extension = input.mime.includes("mp4") ? "m4a" : input.mime.includes("mpeg") ? "mp3" : input.mime.includes("wav") ? "wav" : "webm";
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(input.bytes)], { type: input.mime }), `mensagem.${extension}`);
  form.append("model", model);
  form.append("language", "pt");
  form.append("response_format", "json");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${input.apiKey}` }, body: form, signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    const transcript = object(payload) ? text(payload.text) : "";
    if (!response.ok || !transcript) {
      const error = object(payload) && object(payload.error) ? payload.error : {};
      const providerCode = (text(error.code) || `HTTP_${response.status}`).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
      await input.diagnose({ model, status: response.status, code: providerCode, type: text(error.type) || null, requestId: response.headers.get("x-request-id") }).catch(() => undefined);
      const permission = response.status === 401 || response.status === 403 || response.status === 404 || /model_not_found|permission|access_denied/.test(providerCode);
      const quota = response.status === 429 && /quota|credit|billing|balance/.test(providerCode);
      return { ok: false, code: permission ? "PUBLIC_AGENT_AUDIO_MODEL_UNAVAILABLE" : quota ? "PUBLIC_AGENT_AUDIO_PROVIDER_QUOTA" : response.status === 429 ? "PUBLIC_AGENT_AUDIO_PROVIDER_BUSY" : "PUBLIC_AGENT_TRANSCRIPTION_FAILED" };
    }
    if (transcript.length > 800) return { ok: false, code: "PUBLIC_AGENT_AUDIO_TRANSCRIPT_TOO_LONG" };
    return { ok: true, text: transcript };
  } catch (error) {
    return { ok: false, code: error instanceof Error && error.name === "AbortError" ? "PUBLIC_AGENT_TRANSCRIPTION_TIMEOUT" : "PUBLIC_AGENT_TRANSCRIPTION_UNAVAILABLE" };
  } finally { clearTimeout(timer); }
}
