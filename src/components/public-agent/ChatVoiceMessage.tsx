"use client";

import { useEffect, useRef, useState } from "react";

const durationText = (v: number) => {
  const seconds = Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export function ChatVoicePlayer({ src, duration = 0, label = "Reproduzir mensagem de voz" }: { src: string; duration?: number; label?: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [total, setTotal] = useState(duration);
  const [failed, setFailed] = useState(false);
  useEffect(() => () => { audioRef.current?.pause(); }, []);
  const maximum = total > 0 && Number.isFinite(total) ? total : Math.max(duration, 1);
  async function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) { audio.pause(); return; }
    setFailed(false);
    try { await audio.play(); } catch { setPlaying(false); setFailed(true); }
  }
  return <div className="bia-voice-player">
    <audio ref={audioRef} src={src} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setPosition(0); }} onTimeUpdate={() => setPosition(audioRef.current?.currentTime || 0)} onLoadedMetadata={() => { const value = audioRef.current?.duration; if (value && Number.isFinite(value)) setTotal(value); }} onError={() => { setPlaying(false); setFailed(true); }} />
    <button type="button" className="bia-voice-play" onClick={() => void toggle()} aria-label={playing ? "Pausar mensagem de voz" : label}>
      <svg viewBox="0 0 24 24" aria-hidden="true">{playing ? <path d="M6 4h4v16H6zm8 0h4v16h-4z" /> : <path d="m7 3 15 9-15 9z" />}</svg>
    </button>
    <div className="bia-voice-track"><input type="range" aria-label="Posição da mensagem de voz" min="0" max={maximum} step="0.1" value={Math.min(position, maximum)} onChange={event => { const value = Number(event.target.value); const audio = audioRef.current; if (!audio) return; try { audio.currentTime = value; setPosition(value); } catch { /* The stream may not have seekable ranges yet. */ } }} /><span>{durationText(playing || position > 0 ? position : maximum)}</span></div>
    <svg className="bia-voice-mic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a4 4 0 0 0 4-4V5a4 4 0 0 0-8 0v6a4 4 0 0 0 4 4Zm-7-4a7 7 0 0 0 14 0M12 18v4m-4 0h8" /></svg>
    {failed && <p role="status" className="bia-voice-error">Não foi possível reproduzir. A transcrição, quando disponível, pode ser lida abaixo.</p>}
  </div>;
}

type VoiceMessage = {
  id: string;
  audioUrl?: string;
  audioDuration?: number;
  audioState?: "transcribing" | "ready" | "failed";
  transcript?: string;
};
export function AudioMessageView({ message, disabled, onRetry }: { message: VoiceMessage; disabled: boolean; onRetry: (id: string) => void }) {
  return <section className="public-agent-audio-bubble bia-voice-message" aria-label="Mensagem de voz">
    {message.audioUrl && <ChatVoicePlayer src={message.audioUrl} duration={message.audioDuration} />}
    {message.audioState === "transcribing" && <small className="bia-voice-state" role="status">Transcrevendo seu áudio…</small>}
    {message.transcript && <details className="bia-voice-transcript"><summary>Ver transcrição</summary><p>{message.transcript}</p></details>}
    {message.audioState === "failed" && <button className="bia-voice-retry" type="button" onClick={() => onRetry(message.id)} disabled={disabled}>Tentar transcrever novamente</button>}
  </section>;
}

export function ChatPrivacyNote() {
  return <details className="bia-chat-privacy"><summary>Atendimento com IA · Privacidade</summary><div>
    <p>Bia é a especialista digital da Futura Casa, parceira da Évora Urbanismo. As conversas e os dados enviados ficam registrados para atendimento, segurança e histórico comercial. Preços e disponibilidade são consultados no ERP da Évora.</p>
    <a href="mailto:relacionamento@evoraurbanismo.com.br?subject=Privacidade%20-%20Atendimento%20Bia%20Futura%20Casa">Falar sobre privacidade</a>
  </div></details>;
}
