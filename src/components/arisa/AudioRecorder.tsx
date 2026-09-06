"use client";
import { useEffect, useRef, useState } from "react";
import { errorText } from "./chat-client";
import AudioIcon from "./AudioIcon";
import AudioPlayer, { audioTime } from "./AudioPlayer";
import styles from "./audio-recorder.module.css";

type Phase = "idle" | "starting" | "recording" | "paused" | "preview" | "sending";
type Props = { disabled: boolean; onStart: () => void; onActive: (active: boolean) => void; onSend: (file: File) => Promise<void> };
export default function AudioRecorder({ disabled, onStart, onActive, onSend }: Props) {
  const [phase, setPhase] = useState<Phase>("idle"), [seconds, setSeconds] = useState(0), [locked, setLocked] = useState(false), [url, setUrl] = useState(""), [error, setError] = useState("");
  const [levels, setLevels] = useState<number[]>(Array(18).fill(3));
  const recorder = useRef<MediaRecorder | null>(null), file = useRef<File | null>(null), mounted = useRef(true), active = useRef(false), action = useRef<"review" | "send" | "cancel">("review");
  const meter = useRef<{ context: AudioContext; frame: number } | null>(null), elapsed = useRef(0), began = useRef(0), sending = useRef(false);
  const gesture = useRef<{ x: number; y: number; at: number; released: boolean; locked: boolean } | null>(null);
  const callbacks = useRef({ onStart, onActive, onSend });
  useEffect(() => { callbacks.current = { onStart, onActive, onSend }; }, [onStart, onActive, onSend]);
  function closeMeter() { const m = meter.current; if (m) { cancelAnimationFrame(m.frame); void m.context.close().catch(() => {}); meter.current = null; } }
  useEffect(() => {
    mounted.current = true;
    const background = () => { if (document.hidden && recorder.current?.state !== "inactive") { action.current = "review"; recorder.current?.stop(); } };
    document.addEventListener("visibilitychange", background);
    return () => { mounted.current = false; action.current = "cancel"; document.removeEventListener("visibilitychange", background); closeMeter(); const r = recorder.current; if (r) { r.onstop = null; if (r.state !== "inactive") r.stop(); r.stream.getTracks().forEach(t => t.stop()); } };
  }, []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => { const s = elapsed.current + (performance.now() - began.current) / 1000; setSeconds(s); if (s >= 90 && recorder.current?.state === "recording") { action.current = "review"; recorder.current.stop(); } }, 100);
    return () => clearInterval(timer);
  }, [phase]);
  function reset() { file.current = null; setUrl(""); setSeconds(0); setLocked(false); setPhase("idle"); active.current = false; sending.current = false; callbacks.current.onActive(false); }
  async function sendFile(audio: File) {
    if (sending.current) return;
    sending.current = true; setPhase("sending"); setError("");
    try { await callbacks.current.onSend(audio); if (mounted.current) reset(); }
    catch (e) { if (mounted.current) { setPhase("preview"); setError(errorText(e)); } }
    finally { sending.current = false; }
  }
  function finish(next: "review" | "send" | "cancel") {
    action.current = next;
    const r = recorder.current;
    if (r && r.state !== "inactive") { if (r.state === "recording") elapsed.current += (performance.now() - began.current) / 1000; r.stop(); }
    else if (file.current && next === "send") void sendFile(file.current);
    else if (next === "cancel" && phase !== "starting") reset();
  }
  function pause() {
    const r = recorder.current; if (!r) return;
    if (r.state === "recording") { elapsed.current += (performance.now() - began.current) / 1000; r.pause(); setPhase("paused"); }
    else if (r.state === "paused") { began.current = performance.now(); r.resume(); setPhase("recording"); }
  }
  function startMeter(stream: MediaStream) {
    try {
      const context = new AudioContext(); const analyser = context.createAnalyser(); analyser.fftSize = 512; context.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize); const m = { context, frame: 0 }; meter.current = m; let last = 0;
      const draw = (now: number) => { if (meter.current !== m || !mounted.current) return; if (now - last > 100) { last = now; analyser.getByteTimeDomainData(data); setLevels(Array.from({ length: 18 }, (_, i) => { const slice = data.slice(i * 28, (i + 1) * 28); const power = slice.reduce((sum, n) => sum + ((n - 128) / 128) ** 2, 0) / slice.length; return Math.max(3, Math.min(26, Math.sqrt(power) * 100)); })); } m.frame = requestAnimationFrame(draw); }; m.frame = requestAnimationFrame(draw);
    } catch { /* The recorder remains usable if audio visualisation is unavailable. */ }
  }
  async function start() {
    if (disabled || active.current) return;
    active.current = true; action.current = "review"; setError(""); setPhase("starting"); callbacks.current.onStart(); callbacks.current.onActive(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("Este navegador não permite gravar áudio. Abra a Arisa no Safari ou Chrome.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current || action.current === ("cancel" as string)) { stream.getTracks().forEach(t => t.stop()); if (mounted.current) reset(); return; }
      const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find(t => MediaRecorder.isTypeSupported(t));
      let r: MediaRecorder;
      try { r = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined); } catch (e) { stream.getTracks().forEach(t => t.stop()); throw e; }
      recorder.current = r; const chunks: Blob[] = [];
      r.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      r.onerror = () => { action.current = "cancel"; closeMeter(); stream.getTracks().forEach(t => t.stop()); if (mounted.current) { reset(); setError("A gravação foi interrompida. Tente novamente."); } };
      r.onstop = () => {
        closeMeter(); stream.getTracks().forEach(t => t.stop()); recorder.current = null;
        if (!mounted.current) return;
        if (action.current === "cancel") { reset(); return; }
        const type = r.mimeType.split(";")[0] || "audio/webm";
        const audio = new File(chunks, `audio-${Date.now()}.${type === "audio/mp4" ? "m4a" : "webm"}`, { type });
        if (!audio.size) { reset(); setError("Nenhum áudio foi captado. Grave novamente."); return; }
        file.current = audio; setUrl(URL.createObjectURL(audio)); setPhase("preview");
        if (action.current === "send") void sendFile(audio);
      };
      elapsed.current = 0; began.current = performance.now(); r.start(250); startMeter(stream); setSeconds(0); setPhase("recording");
      // First microphone permission can outlast the gesture. Keep that first recording hands-free.
      if (gesture.current?.released) { setLocked(true); gesture.current.locked = true; action.current = "review"; }
    } catch (e) { if (mounted.current) { reset(); setError(e instanceof DOMException && e.name === "NotAllowedError" ? "Permita o microfone nas configurações do navegador para gravar." : errorText(e)); } }
  }
  const isRecording = phase === "recording" || phase === "paused";
  return <div className={styles.wrapper}>
    <button tabIndex={phase === "idle" ? 0 : -1} aria-hidden={phase !== "idle"} type="button" disabled={disabled} aria-label="Gravar mensagem de voz" title="Segure para gravar ou toque para gravar sem segurar" className={`${styles.mic} ${phase !== "idle" ? styles.micActive : ""}`}
      onContextMenu={e => e.preventDefault()}
      onPointerDown={e => { if (e.button !== 0 || active.current) return; e.currentTarget.setPointerCapture(e.pointerId); gesture.current = { x: e.clientX, y: e.clientY, at: Date.now(), released: false, locked: false }; void start(); }}
      onPointerMove={e => { const g = gesture.current; if (!g || g.released || g.locked) return; if (e.clientX - g.x < -80) { g.released = true; finish("cancel"); } else if (e.clientY - g.y < -65) { g.locked = true; setLocked(true); } }}
      onPointerUp={() => { const g = gesture.current; if (!g || g.released) return; g.released = true; if (g.locked || Date.now() - g.at < 350) { g.locked = true; setLocked(true); } else finish("send"); }}
      onPointerCancel={() => { if (!gesture.current?.locked) finish("cancel"); }}
      onClick={e => { if (e.detail === 0) { gesture.current = null; setLocked(true); void start(); } }}><AudioIcon name="mic" /></button>
    {phase !== "idle" && <div className={styles.row}>
      {isRecording && !locked && <><span className={styles.hint}><AudioIcon name="chevron" /> Deslize para cancelar</span><span className={styles.lock}><AudioIcon name="chevron" style={{ transform: "rotate(90deg)" }} /><AudioIcon name="lock" /></span></>}
      <div className={styles.pill}>
        <button type="button" className={styles.plain} disabled={phase === "sending"} onClick={() => finish("cancel")} aria-label="Excluir gravação"><AudioIcon name="trash" /></button>
        {url ? <AudioPlayer key={url} src={url} duration={seconds} /> : phase === "starting" ? <span className={styles.status}>Abrindo microfone…</span> : <><i className={styles.dot} /><span className={styles.time}>{audioTime(seconds)}</span><div className={styles.waves} aria-hidden="true">{levels.map((level, i) => <i key={i} style={{ height: level }} />)}</div></>}
        {isRecording && <><button type="button" className={styles.plain} onClick={pause} aria-label={phase === "paused" ? "Continuar gravação" : "Pausar gravação"}><AudioIcon name={phase === "paused" ? "mic" : "pause"} /></button><button type="button" className={styles.plain} onClick={() => finish("review")} aria-label="Parar e ouvir gravação"><AudioIcon name="stop" /></button></>}
      </div>
      <button type="button" className={styles.send} disabled={phase === "starting" || phase === "sending"} onClick={() => finish("send")} aria-label={phase === "sending" ? "Enviando áudio" : "Enviar áudio"}>{phase === "sending" ? <span className={styles.spinner} /> : <AudioIcon name="send" />}</button>
    </div>}
    {error && <p className={styles.error} role="alert">{error} {url ? "Sua gravação está preservada." : ""}</p>}
  </div>;
}
