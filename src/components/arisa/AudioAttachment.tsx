"use client";
import AudioIcon from "./AudioIcon";
import AudioPlayer from "./AudioPlayer";
import styles from "./audio-recorder.module.css";
import { useState } from "react";
import { client, errorText, type ChatFile } from "./chat-client";
export default function AudioAttachment({ file }: { file: ChatFile }) {
  const [url, setUrl] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function load() {
    setBusy(true); setError("");
    try { const result = await client().storage.from("arisa-chat").createSignedUrl(file.storage_path, 3600); if (result.error || !result.data?.signedUrl) throw result.error || new Error("Áudio indisponível."); setUrl(result.data.signedUrl); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <div className={styles.attachment}>{url ? <AudioPlayer key={url} src={url} onError={() => { setUrl(""); setError("Toque para carregar novamente."); }} /> : <button type="button" className={styles.load} disabled={busy} onClick={() => void load()}><AudioIcon name="play" />{busy ? "Carregando áudio…" : "Mensagem de voz"}</button>}{error && <small role="alert">{error}</small>}</div>;
}
