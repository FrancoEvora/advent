"use client";
import { useRef, useState } from "react";
import AudioIcon from "./AudioIcon";
import styles from "./audio-recorder.module.css";
export const audioTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
export default function AudioPlayer({ src, duration = 0, onError }: { src: string; duration?: number; onError?: () => void }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false), [position, setPosition] = useState(0), [length, setLength] = useState(duration), [error, setError] = useState("");
  async function toggle() { const audio = ref.current; if (!audio) return; if (!audio.paused) audio.pause(); else { try { await audio.play(); setError(""); } catch { setError("Toque para ouvir novamente."); } } }
  return <div className={styles.player}>
    <audio ref={ref} src={src} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={() => setPosition(ref.current?.currentTime || 0)} onLoadedMetadata={() => { const d = ref.current?.duration; if (d && Number.isFinite(d)) setLength(d); }} onError={() => { setError("Não foi possível reproduzir este áudio."); onError?.(); }} />
    <button type="button" className={styles.plain} onClick={() => void toggle()} aria-label={playing ? "Pausar áudio" : "Ouvir áudio"}><AudioIcon name={playing ? "pause" : "play"} /></button>
    <div className={styles.track}><input aria-label="Posição do áudio" type="range" min={0} max={length || 1} step={0.1} value={Math.min(position, length || 1)} disabled={!length} onChange={e => { if (ref.current) { ref.current.currentTime = Number(e.target.value); setPosition(Number(e.target.value)); } }} /><span>{error || audioTime(playing || position ? position : length)}</span></div>
  </div>;
}
