"use client";
import { useEffect, useState } from "react";
import AudioRecorder from "../../components/arisa/AudioRecorder";
export default function Fixture() {
  const [active, setActive] = useState(false), [sent, setSent] = useState(0), [fail, setFail] = useState(false), [ready, setReady] = useState(false);
  useEffect(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async () => { const audio = new AudioContext(); const oscillator = audio.createOscillator(); const dest = audio.createMediaStreamDestination(); oscillator.frequency.value = 440; oscillator.connect(dest); oscillator.start(); const track = dest.stream.getAudioTracks()[0]; const stop = track.stop.bind(track); track.stop = () => { stop(); oscillator.stop(); void audio.close(); }; return dest.stream; };
    setReady(true); return () => { navigator.mediaDevices.getUserMedia = original; };
  }, []);
  return <div style={{ padding: 24 }}><h1>Teste isolado do gravador</h1><p>Áudio sintético; nenhum dado enviado ao servidor.</p><label><input type="checkbox" checked={fail} onChange={e => setFail(e.target.checked)} /> Simular falha</label><p role="status">{active ? "Gravação aberta" : "Pronto"} · Envios: {sent}</p><div className="public-agent-page bia-whatsapp arisa-chat" style={{ position: "relative", width: 390, height: 600, maxWidth: "100%", background: "#f6f8f2", display: "flex", flexDirection: "column" }}><header className="public-agent-chat-head"><strong>Arisa</strong></header><div style={{ flex: 1, padding: 16 }}>Teste de gravação</div><form className="public-agent-composer arisa-composer" style={{ position: "relative" }} onSubmit={e => e.preventDefault()}>{!active && <><button type="button" aria-label="Anexar">+</button><textarea placeholder="Mensagem" /></>}<AudioRecorder disabled={!ready} onStart={() => {}} onActive={setActive} onSend={async file => { if (!file.size) throw Error("Áudio vazio"); if (fail) throw Error("Falha simulada de conexão."); setSent(n => n + 1); }} /></form></div></div>;
}
