"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { client, type Message } from "./chat-client";
import { browserVoiceAudio, initialVoiceState, VoiceQueue, type VoiceState } from "./voice-queue";
import { SPEECH_VERSION } from "../../../supabase/functions/_shared/arisa-speech-text";

export function useArisaVoice(organizationId: string, messages: Message[]) {
  const [state, setState] = useState<VoiceState>(initialVoiceState);
  const queue = useRef<VoiceQueue<AudioBuffer> | null>(null);
  const armed = useRef<string | null>(null);
  const intent = useRef(0);
  const [fullText, setFullText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const current = new VoiceQueue(browserVoiceAudio(), async (messageId, partIndex, signal) => {
      const { data, error } = await client().functions.invoke("arisa-speech", { body: { organizationId, messageId, partIndex, version: SPEECH_VERSION }, signal });
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (error) {
        const response = "context" in error && error.context instanceof Response ? error.context : null;
        const detail = response ? await response.json().catch(() => null) : null;
        throw new Error(typeof detail?.message === "string" ? detail.message : "Não foi possível gerar a voz. A resposta escrita está preservada.");
      }
      if (!(data instanceof Blob) || data.size < 32 || data.size > 3000000) throw new Error("O áudio retornado não está disponível. Tente ouvir novamente.");
      return data.arrayBuffer();
    }, next => { if (live) setState(next); });
    queue.current = current;
    const background = () => { if (document.hidden) { intent.current++; armed.current = null; void current.pause(); } };
    document.addEventListener("visibilitychange", background);
    const leaving = () => { intent.current++; armed.current = null; current.stop(); };
    window.addEventListener("pagehide", leaving);
    return () => { live = false; intent.current++; armed.current = null; current.destroy(); queue.current = null; document.removeEventListener("visibilitychange", background); window.removeEventListener("pagehide", leaving); };
  }, [organizationId]);
  const stop = useCallback(() => { intent.current++; armed.current = null; queue.current?.stop(); }, []);
  const toggle = useCallback(() => {
    const current = queue.current; if (!current) return;
    if (current.state.enabled) { intent.current++; armed.current = null; current.stop(true); }
    else void current.enable();
  }, []);
  const prepare = useCallback(() => { intent.current++; armed.current = null; const current = queue.current; if (!current) return; current.stop(); if (current.state.enabled) void current.enable(); }, []);
  const arm = useCallback((messageId: string) => { if (queue.current?.state.enabled) armed.current = messageId; }, []);
  const read = useCallback((message: Message) => {
    if (message.role !== "assistant" || message.status !== "completed") return;
    const current = queue.current; if (!current) return;
    const request = ++intent.current; armed.current = null; current.stop(); setFullText(message.id);
    // Start unlock synchronously in the click event; only synthesis waits for networking.
    void current.enable().then(() => { if (request === intent.current && current.state.enabled && queue.current === current && !document.hidden) void current.read(message.id, message.content); });
  }, []);
  useEffect(() => {
    const current = queue.current, parent = armed.current;
    if (!current?.state.enabled || !parent || document.hidden) return;
    const reply = messages.find(message => message.parent_id === parent && message.role === "assistant" && message.status === "completed" && message.content.trim());
    if (!reply) return;
    armed.current = null;
    void current.read(reply.id, reply.content);
  }, [messages]);
  const pause = useCallback(() => { void queue.current?.pause(); }, []);
  const resume = useCallback(() => { void queue.current?.resume(); }, []);
  const reveal = useCallback((id: string) => setFullText(id), []);
  return { state, toggle, prepare, arm, stop, read, pause, resume, fullText, reveal };
}
export type ArisaVoice = ReturnType<typeof useArisaVoice>;
