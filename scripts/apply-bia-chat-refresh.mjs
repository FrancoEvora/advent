import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

const file='src/components/public-agent/PublicAgentExperience.tsx';
let source=fs.readFileSync(file,'utf8');
if(source.includes('className="public-agent-page bia-whatsapp"')){
 console.log('Chat refresh already applied.');
 process.exit(0);
}
const blob=createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
assert.equal(blob,'3fb2db51769ba86a152ea70125542860c8abf6a3','Upstream changed; inspect before applying.');
function swap(from,to){assert.equal(source.split(from).length,2,`Expected one match: ${from.slice(0,90)}`);source=source.replace(from,to);}
swap('import Image from "next/image";','import Image from "next/image";\nimport { CommercialUnitsView } from "./ChatLotOptions";\nimport { AudioMessageView, ChatVoicePlayer, ChatPrivacyNote } from "./ChatVoiceMessage";');
swap('  PublicAgentCommercialUnit,\n','');
const oldStart=source.indexOf('function AudioMessageView('),oldEnd=source.indexOf('function SimulationView(');
assert.ok(oldStart>0&&oldEnd>oldStart);source=source.slice(0,oldStart)+source.slice(oldEnd);
swap('className="public-agent-page"','className="public-agent-page bia-whatsapp"');
swap('<span>{PUBLIC_AGENT_BRAND_LINE}</span>','<span title={PUBLIC_AGENT_BRAND_LINE}>{sending ? "digitando…" : audioBusy ? "Transcrevendo áudio…" : "Especialista da Futura Casa"}</span>\n              <small>Parceira da Évora Urbanismo</small>');
swap('aria-busy={initializing || sending || audioBusy}>','aria-busy={initializing || sending || audioBusy} data-identified={converted}>');
swap('            {converted && <em className="public-agent-captured">Atendimento registrado</em>}\n','');
swap('{message.commercial && (','{message.commercial && !message.simulation && (');
swap('onSimulate={(unit) => void sendMessage(`Simular condições do lote ${unit.unitCode}`)}','onSimulate={(unit) => void sendMessage(`Simule a menor parcela do lote ${unit.unitCode}, mantendo a entrada e os balões que já definimos. Se não definimos, use a entrada mínima da política e nenhum balão. Explique as premissas.`)}');
swap('{quickReplies.map((reply) => (','{quickReplies.slice(0, 3).map((reply) => (');
swap('placeholder={initializing ? "Iniciando atendimento..." : converted ? "Continue a conversa, se precisar" : "Mensagem"}','placeholder={initializing ? "Iniciando atendimento…" : "Mensagem"}');
swap('disabled={initializing || audioBusy}','disabled={initializing || audioBusy || microphonePending}');
swap('disabled={initializing || sending || audioBusy}\n                aria-label={input.trim()', 'disabled={initializing || sending || audioBusy || microphonePending}\n                aria-label={microphonePending ? "Aguardando permissão do microfone" : input.trim()');
swap('<audio aria-label="Ouvir mensagem de voz antes de enviar" controls preload="metadata" src={audioDraft.url} />','<ChatVoicePlayer key={audioDraft.url} src={audioDraft.url} duration={audioDraft.duration} label="Ouvir mensagem de voz antes de enviar" />');
const disclosure=source.match(/          <p className="public-agent-disclosure">[\s\S]*?<\/p>/g);assert.equal(disclosure?.length,1);source=source.replace(disclosure[0],'          <ChatPrivacyNote />');
swap('  const [isRecording, setIsRecording] = useState(false);','  const [isRecording, setIsRecording] = useState(false);\n  const [microphonePending, setMicrophonePending] = useState(false);');
swap('  const mediaRecorderRef = useRef<MediaRecorder | null>(null);','  const mediaRecorderRef = useRef<MediaRecorder | null>(null);\n  const recordingStartingRef = useRef(false);\n  const sendInFlightRef = useRef(false);\n  const audioInFlightRef = useRef(false);\n  const pinnedToBottomRef = useRef(true);');
swap('      if (!messagesPane) return;','      if (!messagesPane || !pinnedToBottomRef.current) return;');
swap('<div ref={messagesRef} className="public-agent-messages"','<div ref={messagesRef} onScroll={(event) => { const pane = event.currentTarget; pinnedToBottomRef.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 100; }} className="public-agent-messages"');
swap('      || sending\n      || initializing','      || sending\n      || sendInFlightRef.current\n      || recordingStartingRef.current\n      || initializing');
swap('    const clientMessageId = options.clientMessageId || crypto.randomUUID();','    sendInFlightRef.current = true;\n    pinnedToBottomRef.current = true;\n    const clientMessageId = options.clientMessageId || crypto.randomUUID();');
swap('      setSending(false);\n      window.setTimeout(() => inputRef.current?.focus(), 100);','      sendInFlightRef.current = false;\n      if (mountedRef.current) setSending(false);\n      if (options.source !== "audio" && navigator.maxTouchPoints === 0) window.setTimeout(() => inputRef.current?.focus(), 100);');
swap('    if (!audio || audioBusy || sending || initializing) return;','    if (!audio || audioBusy || audioInFlightRef.current || sending || initializing) return;\n    audioInFlightRef.current = true;');
swap('      if (mountedRef.current) setAudioBusy(false);','      audioInFlightRef.current = false;\n      if (mountedRef.current) setAudioBusy(false);');
swap('      const transcript = payload.text?.trim().slice(0, 800) || "";','      const transcript = payload.text?.trim() || "";\n      if (transcript.length > 800) throw new Error("PUBLIC_AGENT_AUDIO_TRANSCRIPT_TOO_LONG");');
swap('  PUBLIC_AGENT_AUDIO_INVALID:','  PUBLIC_AGENT_AUDIO_TRANSCRIPT_TOO_LONG: "O áudio tem mais texto do que cabe em uma mensagem. Grave em partes mais curtas para não perder informações.",\n  PUBLIC_AGENT_AUDIO_INVALID:');
swap('PUBLIC_AGENT_CONSENT_REQUIRED: "Confirme a autorização de contato para continuar."','PUBLIC_AGENT_CONSENT_REQUIRED: "Para organizar esse atendimento, informe seu nome e WhatsApp."');
const start=source.indexOf('  async function startRecording() {'),end=source.indexOf('  function deleteAudioDraft()',start);assert.ok(start>0&&end>start);
const replacement=`  async function startRecording() {
    if (initializing || sending || audioBusy || audioDraft || isRecording || recordingStartingRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setPageError("A gravação não está disponível neste navegador. Você pode escrever sua mensagem.");
      return;
    }
    recordingStartingRef.current = true;
    setMicrophonePending(true);
    setPageError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (!mountedRef.current) { stream.getTracks().forEach(track => track.stop()); return; }
      mediaStreamRef.current = stream;
      const supportedMime = AUDIO_MIME_CANDIDATES.find(mime => MediaRecorder.isTypeSupported(mime));
      let recorder: MediaRecorder;
      try { recorder = new MediaRecorder(stream, supportedMime ? { mimeType: supportedMime, audioBitsPerSecond: 64_000 } : { audioBitsPerSecond: 64_000 }); }
      catch { recorder = new MediaRecorder(stream); }
      const allowed = ["audio/webm", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav"];
      if (recorder.mimeType && !allowed.includes(baseAudioMimeType(recorder.mimeType))) throw new Error("PUBLIC_AGENT_AUDIO_TYPE_INVALID");
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      keepRecordingRef.current = true;
      recorder.ondataavailable = event => { if (event.data.size) audioChunksRef.current.push(event.data); };
      recorder.onerror = () => {
        keepRecordingRef.current = false;
        clearRecordingTimer();
        if (recorder.state !== "inactive") recorder.stop();
        stream.getTracks().forEach(track => track.stop());
        if (mountedRef.current) { setIsRecording(false); setPageError("A gravação foi interrompida. Grave novamente ou escreva sua mensagem."); }
      };
      recorder.onstop = () => {
        clearRecordingTimer();
        stream.getTracks().forEach(track => track.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        if (!mountedRef.current) return;
        setIsRecording(false);
        setRecordingSeconds(0);
        if (!keepRecordingRef.current) { audioChunksRef.current = []; return; }
        const duration = Math.max(1, Math.min(MAX_RECORDING_SECONDS, Math.round((nowMs() - recordingStartedAtRef.current) / 1_000)));
        const actualMime = recorder.mimeType || audioChunksRef.current.find(chunk => chunk.type)?.type || "";
        const mimeType = baseAudioMimeType(actualMime);
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        audioChunksRef.current = [];
        if (!actualMime || !allowed.includes(mimeType)) { setPageError(ERROR_TEXT.PUBLIC_AGENT_AUDIO_TYPE_INVALID); return; }
        if (!blob.size) { setPageError(ERROR_TEXT.PUBLIC_AGENT_AUDIO_INVALID); return; }
        if (blob.size > MAX_AUDIO_BYTES) { setPageError(ERROR_TEXT.PUBLIC_AGENT_AUDIO_TOO_LARGE); return; }
        const url = URL.createObjectURL(blob);
        objectUrlsRef.current.add(url);
        setAudioDraft({ messageId: crypto.randomUUID(), transcriptionRequestId: crypto.randomUUID(), blob, url, duration, mimeType, filename: audioFilename(mimeType) });
      };
      stream.getAudioTracks().forEach(track => track.addEventListener("ended", () => { if (recorder.state === "recording") recorder.stop(); }, { once: true }));
      recordingStartedAtRef.current = nowMs();
      recorder.start(250);
      setRecordingSeconds(0);
      setIsRecording(true);
      analytics("AgentVoiceRecordingStarted", slug);
      recordingIntervalRef.current = window.setInterval(() => {
        const elapsed = Math.floor((nowMs() - recordingStartedAtRef.current) / 1_000);
        setRecordingSeconds(Math.min(elapsed, MAX_RECORDING_SECONDS));
        if (elapsed >= MAX_RECORDING_SECONDS) stopRecording(true);
      }, 250);
    } catch (error) {
      clearRecordingTimer();
      mediaStreamRef.current?.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
      mediaRecorderRef.current = null;
      if (mountedRef.current) {
        setIsRecording(false);
        const denied = error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name);
        setPageError(denied ? "Para enviar áudio, permita o microfone nas configurações do navegador." : ERROR_TEXT[error instanceof Error ? error.message : ""] || "Não consegui acessar o microfone. Você pode escrever sua mensagem.");
      }
    } finally {
      recordingStartingRef.current = false;
      if (mountedRef.current) setMicrophonePending(false);
    }
  }

`;
source=source.slice(0,start)+replacement+source.slice(end);
swap('  function clearRecordingTimer() {',`  useEffect(() => {
    const interrupt = () => {
      const recorder = mediaRecorderRef.current;
      if (document.hidden && recorder?.state === "recording") recorder.stop();
    };
    document.addEventListener("visibilitychange", interrupt);
    return () => document.removeEventListener("visibilitychange", interrupt);
  }, []);

  function clearRecordingTimer() {`);
fs.writeFileSync(file,source);
const layout='src/app/layout.tsx';let css=fs.readFileSync(layout,'utf8');
assert.equal(css.split('import "./styles/v6-26-crm-broker-bia.css";').length,2);
css=css.replace('import "./styles/v6-26-crm-broker-bia.css";','import "./styles/v6-26-crm-broker-bia.css";\nimport "./styles/v6-27-bia-whatsapp.css";');fs.writeFileSync(layout,css);
console.log('Applied scoped chat and audio-capture changes.');
