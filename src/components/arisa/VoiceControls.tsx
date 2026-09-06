"use client";
import { useEffect, useState } from "react";
import { MessageText } from "./MessageText";
import type { Message } from "./chat-client";
import type { ArisaVoice } from "./use-arisa-voice";
import styles from "./voice.module.css";
export function VoiceToggle({ voice, disabled }: { voice: ArisaVoice; disabled?: boolean }) {
  return <button type="button" className={styles.toggle} onClick={voice.toggle} disabled={disabled} aria-pressed={voice.state.enabled} aria-label={voice.state.enabled ? "Desativar modo fala" : "Ativar modo fala"} title="Respostas por voz — voz gerada por IA"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" />{voice.state.enabled ? <><path d="M16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14" /></> : <path d="m17 9 5 6m0-6-5 6" />}</svg><span>Modo fala</span></button>;
}
export function VoiceBar({ voice }: { voice: ArisaVoice }) {
  const { state } = voice;
  if (!state.enabled && !state.error) return null;
  const active = !!state.messageId;
  return <section className={styles.bar} aria-label="Controles da voz da Arisa">
    <div><strong>{state.phase === "paused" ? "Fala pausada" : state.phase === "speaking" ? "Arisa está falando" : state.phase === "loading" ? "Preparando voz…" : "Modo fala ligado"}</strong><small>Voz gerada por IA · Português brasileiro{active && state.part > 0 ? ` · Trecho ${state.part} de ${state.total}` : ""}</small></div>
    {active && <div className={styles.actions}>{state.phase === "paused" ? <button type="button" onClick={voice.resume}>Continuar</button> : <button type="button" onClick={voice.pause}>Pausar</button>}<button type="button" onClick={voice.stop}>Parar</button></div>}
    {state.error && <p role="alert">{state.error}</p>}
  </section>;
}
export function VoiceMessage({ message, voice, disabled }: { message: Message; voice: ArisaVoice; disabled?: boolean }) {
  const [reduced, setReduced] = useState(true);
  useEffect(() => { const media = window.matchMedia("(prefers-reduced-motion: reduce)"); const sync = () => setReduced(media.matches); sync(); media.addEventListener("change", sync); return () => media.removeEventListener("change", sync); }, []);
  const { state } = voice;
  const active = state.messageId === message.id;
  // The original answer is already committed: reveal by spoken phrase, never by speculative tool output.
  const end = active && !reduced && voice.fullText !== message.id ? state.end : message.content.length;
  const partial = end < message.content.length;
  return <><div className={active ? styles.reading : undefined}>
    {partial ? <><div aria-hidden="true"><MessageText content={message.content.slice(0, end)} /><span className={styles.caret}>▍</span></div><span className={styles.srOnly}>{message.content}</span></> : <MessageText content={message.content} />}
  </div>{partial && <button className={styles.reveal} type="button" onClick={() => voice.reveal(message.id)}>Mostrar resposta completa</button>}
  {message.status === "completed" && message.content.trim() && <div className={styles.replay}><button type="button" disabled={disabled} onClick={() => active ? voice.stop() : voice.read(message)} aria-label={active ? "Parar leitura desta resposta" : "Ouvir esta resposta da Arisa"}>{active ? "■ Parar leitura" : "▷ Ouvir resposta"}</button><small>Somente leitura · Não repete ações</small></div>}</>;
}
