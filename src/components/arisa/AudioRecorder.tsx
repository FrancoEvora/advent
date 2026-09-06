"use client";
import { useEffect, useRef, useState } from "react";
import { errorText } from "./chat-client";
import styles from "./audio-recorder.module.css";

type Props = { disabled: boolean; onStart: () => void; onActive: (active: boolean) => void; onSend: (file: File) => Promise<void> };
export default function AudioRecorder({ disabled, onStart, onActive, onSend }: Props) {
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "paused" | "preview" | "sending">("idle");
  const [seconds, setSeconds] = useState(0), [locked, setLocked] = useState(false), [url, setUrl] = useState(""), [error, setError] = useState("");
  const recorder = useRef<MediaRecorder | null>(null), file = useRef<File | null>(null), mounted = useRef(true), cancelled = useRef(false), active = useRef(false);
  const gesture = useRef<{ x: number; y: number; at: number; released: boolean; locked: boolean } | null>(null);
  const callbacks = useRef({ onStart, onActive, onSend }); useEffect(() => { callbacks.current = { onStart, onActive, onSend }; }, [onStart, onActive, onSend]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelled.current = true; const r = recorder.current; if (r) { r.onstop = null; if (r.state !== "inactive") r.stop(); r.stream.getTracks().forEach(t => t.stop()); } }; }, []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => { if (phase !== "recording") return; const timer = setInterval(() => setSeconds(s => s + 1), 1000); return () => clearInterval(timer); }, [phase]);
  useEffect(() => { if (seconds >= 90 && recorder.current?.state !== "inactive") recorder.current?.stop(); }, [seconds]);
  function reset() { file.current = null; setUrl(""); setSeconds(0); setLocked(false); setPhase("idle"); active.current = false; callbacks.current.onActive(false); }
  function stop(discard = false) { cancelled.current = discard; const r = recorder.current; if (r && r.state !== "inactive") r.stop(); else if (discard && phase !== "starting") reset(); }
  async function start() {
    if (disabled || active.current) return;
    active.current = true; cancelled.current = false; setError(""); setPhase("starting"); callbacks.current.onStart(); callbacks.current.onActive(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("Este navegador não permite gravação de áudio.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current || cancelled.current) { stream.getTracks().forEach(t => t.stop()); if (mounted.current) reset(); return; }
      const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find(t => MediaRecorder.isTypeSupported(t));
      let r: MediaRecorder;
      try { r = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined); } catch (e) { stream.getTracks().forEach(t => t.stop()); throw e; }
      recorder.current = r; const chunks: Blob[] = [];
      r.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      r.onerror = () => { cancelled.current = true; stream.getTracks().forEach(t => t.stop()); if (mounted.current) { reset(); setError("A gravação foi interrompida. Tente novamente."); } };
      r.onstop = () => {
        stream.getTracks().forEach(t => t.stop()); recorder.current = null;
        if (!mounted.current) return;
        if (cancelled.current) { reset(); return; }
        const type = r.mimeType.split(";")[0] || "audio/webm";
        const audio = new File(chunks, `audio-${Date.now()}.${type === "audio/mp4" ? "m4a" : "webm"}`, { type });
        if (!audio.size) { reset(); setError("Nenhum áudio foi captado. Grave novamente."); return; }
        file.current = audio; setUrl(URL.createObjectURL(audio)); setPhase("preview");
      };
      r.start(250); setSeconds(0); setPhase("recording");
      if (gesture.current?.released) { setLocked(true); gesture.current.locked = true; }
    } catch (e) { if (mounted.current) { reset(); setError(errorText(e)); } }
  }
  async function send() {
    if (!file.current || phase === "sending") return;
    setPhase("sending"); setError("");
    try { await callbacks.current.onSend(file.current); if (mounted.current) reset(); }
    catch (e) { if (mounted.current) { setPhase("preview"); setError(errorText(e)); } }
  }
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return <div className={styles.wrapper}>
    {<button tabIndex={phase === "idle" ? 0 : -1} aria-hidden={phase !== "idle"} style={phase === "idle" ? undefined : { position: "absolute", opacity: 0, pointerEvents: "none", width: 0, padding: 0 }} type="button" disabled={disabled} aria-label="Gravar mensagem de voz" className={styles.mic}
      onPointerDown={e => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); gesture.current = { x: e.clientX, y: e.clientY, at: Date.now(), released: false, locked: false }; void start(); }}
      onPointerMove={e => { const g = gesture.current; if (!g || g.released || g.locked) return; if (e.clientX - g.x < -80) { g.released = true; stop(true); } else if (e.clientY - g.y < -70) { g.locked = true; setLocked(true); } }}
      onPointerUp={() => { const g = gesture.current; if (!g || g.released) return; g.released = true; if (g.locked || Date.now() - g.at < 350) { g.locked = true; setLocked(true); } else stop(); }}
      onPointerCancel={() => { if (!gesture.current?.locked) stop(true); }}
      onClick={e => { if (e.detail === 0) { gesture.current = null; setLocked(true); void start(); } }}
    >🎙</button>} {phase !== "idle" && <div className={styles.controls}>
      <button type="button" disabled={phase === "sending"} onClick={() => stop(true)} aria-label="Excluir gravação">✕</button>
      {url ? <audio controls src={url} preload="metadata" aria-label="Ouvir áudio antes de enviar" /> : <span role="status">{phase === "starting" ? "Abrindo microfone…" : `● ${time} ${locked ? "· Gravação travada" : "· Deslize para cancelar"}`}</span>}
      {(phase === "recording" || phase === "paused") && <><button type="button" onClick={() => { const r = recorder.current; if (r?.state === "recording") { r.pause(); setPhase("paused"); } else if (r?.state === "paused") { r.resume(); setPhase("recording"); } }} aria-label={phase === "paused" ? "Continuar gravação" : "Pausar gravação"}>{phase === "paused" ? "▶" : "Ⅱ"}</button><button type="button" onClick={() => stop()} aria-label="Concluir e ouvir gravação">■</button></>}
      {url && <button type="button" disabled={phase === "sending"} onClick={() => void send()} aria-label="Enviar áudio">{phase === "sending" ? "Enviando…" : "➤"}</button>}
    </div>}
    {error && <p className={styles.error} role="alert">{error} {url ? "O áudio permanece aqui para tentar novamente." : ""}</p>}
  </div>;
}
