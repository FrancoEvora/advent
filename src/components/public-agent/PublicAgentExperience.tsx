"use client";

import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

import type {
  PublicAgentExperience,
  PublicAgentMessage,
  PublicAgentProfile,
  PublicAgentStage,
} from "@/lib/public-agent/types";

type Props = { slug: string; experience: PublicAgentExperience };
type SessionResponse = { ok: boolean; error?: string; stage?: PublicAgentStage; profile?: PublicAgentProfile; converted?: boolean; leadProtocol?: string | null; messages?: PublicAgentMessage[] };
type MessageResponse = { ok: boolean; error?: string; reply?: string; stage?: PublicAgentStage; profile?: PublicAgentProfile; requestContact?: boolean; quickReplies?: string[]; converted?: boolean; protocol?: string | null };
type AudioResponse = { ok: boolean; error?: string; text?: string };
type UiMessage = { id: string; direction: "user" | "assistant"; content: string };
type AnalyticsWindow = Window & { dataLayer?: Array<Record<string, unknown>>; fbq?: (...args: unknown[]) => void };

const ERROR_TEXT: Record<string, string> = {
  PUBLIC_AGENT_RATE_LIMIT: "Você enviou muitas mensagens em pouco tempo. Aguarde alguns minutos e tente novamente.",
  PUBLIC_AGENT_SESSION_INACTIVE: "Esta conversa expirou. Atualize a página para iniciar um novo atendimento.",
  PUBLIC_AGENT_MESSAGE_INVALID: "Revise a mensagem e tente novamente.",
  PUBLIC_AGENT_AUDIO_INVALID: "Não consegui processar este áudio. Grave novamente, por favor.",
  AUDIO_TRANSCRIPTION_FAILED: "Não consegui entender o áudio. Tente novamente ou escreva a mensagem.",
};

function analytics(event: string, slug: string, extra: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  const target = window as AnalyticsWindow;
  target.dataLayer?.push({ event, agent_experience: slug, ...extra });
  target.fbq?.("trackCustom", event, { agent_experience: slug, ...extra });
}

function initialGreeting(agentName: string) {
  return `Olá, sou a ${agentName}, especialista virtual da Évora Urbanismo. Posso te ajudar com a Évora, o Solaris, o Parque das Árvores e nossos empreendimentos. Você está pensando em morar, investir ou quer conhecer melhor algum projeto?`;
}

function attributionFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const keys = ["utm_source","utm_medium","utm_campaign","utm_content","utm_term","fbclid","campaign_id","adset_id","ad_id","ad_name","creative_id","placement","publisher_platform"];
  return Object.fromEntries(keys.map((key) => [key, params.get(key)]).filter(([, value]) => Boolean(value)));
}

function mapStoredMessages(messages: PublicAgentMessage[]): UiMessage[] {
  return messages.filter((message) => message.direction === "user" || message.direction === "assistant").map((message) => ({ id: String(message.id), direction: message.direction as "user" | "assistant", content: message.content }));
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "pt-BR";
  utterance.rate = 1;
  utterance.pitch = 1.02;
  const voices = window.speechSynthesis.getVoices();
  const ptVoice = voices.find((voice) => voice.lang.toLowerCase().startsWith("pt-br")) || voices.find((voice) => voice.lang.toLowerCase().startsWith("pt"));
  if (ptVoice) utterance.voice = ptVoice;
  window.speechSynthesis.speak(utterance);
}

export function PublicAgentExperience({ slug, experience }: Props) {
  const theme = experience.theme || {};
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [profile, setProfile] = useState<PublicAgentProfile>({});
  const [stage, setStage] = useState<PublicAgentStage>("welcome");
  const [input, setInput] = useState("");
  const [quickReplies, setQuickReplies] = useState<string[]>(theme.quickReplies || []);
  const [initializing, setInitializing] = useState(true);
  const [sending, setSending] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [converted, setConverted] = useState(false);
  const [protocol, setProtocol] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceReplies, setVoiceReplies] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const startedRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const visibleMessages = useMemo(() => messages.length ? messages : [{ id: "welcome", direction: "assistant" as const, content: initialGreeting(experience.agentName) }], [messages, experience.agentName]);

  useEffect(() => {
    let active = true;
    async function start() {
      try {
        const response = await fetch("/api/public-agent/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, attribution: attributionFromLocation(), landingPage: window.location.href, referrer: document.referrer || null }) });
        const payload = (await response.json()) as SessionResponse;
        if (!response.ok || !payload.ok) throw new Error(payload.error || "PUBLIC_AGENT_SESSION_UNAVAILABLE");
        if (!active) return;
        setMessages(mapStoredMessages(payload.messages || []));
        setStage(payload.stage || "welcome");
        setProfile(payload.profile || {});
        setConverted(Boolean(payload.converted));
        setProtocol(payload.leadProtocol || null);
        if (payload.converted) setQuickReplies([]);
        if (!startedRef.current) { startedRef.current = true; analytics("AgentStarted", slug, { resumed: Boolean(payload.messages?.length) }); }
      } catch (error) {
        if (active) setPageError(ERROR_TEXT[error instanceof Error ? error.message : ""] || "Não foi possível iniciar o atendimento agora. Tente atualizar a página.");
      } finally { if (active) setInitializing(false); }
    }
    void start();
    return () => {
      active = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, [slug]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [messages, sending, transcribing]);

  async function sendMessage(value: string) {
    const message = value.trim();
    if (!message || sending || initializing || transcribing) return;
    setInput(""); setPageError(null); setQuickReplies([]);
    setMessages((current) => [...current, { id: `user-${Date.now()}`, direction: "user", content: message }]);
    setSending(true); analytics("AgentMessageSent", slug, { stage });
    try {
      const response = await fetch("/api/public-agent/message", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, message }) });
      const payload = (await response.json()) as MessageResponse;
      if (!response.ok || !payload.ok || !payload.reply) throw new Error(payload.error || "PUBLIC_AGENT_MESSAGE_UNAVAILABLE");
      setMessages((current) => [...current, { id: `assistant-${Date.now()}`, direction: "assistant", content: payload.reply || "" }]);
      setStage(payload.stage || "discovery"); setProfile(payload.profile || {}); setQuickReplies(payload.quickReplies || []); setConverted(Boolean(payload.converted));
      if (payload.protocol) setProtocol(payload.protocol);
      if (voiceReplies) speak(payload.reply);
      analytics("AgentReplyReceived", slug, { stage: payload.stage, contact_requested: Boolean(payload.requestContact), converted: Boolean(payload.converted) });
      if (payload.converted) analytics("QualifiedLead", slug, { protocol: payload.protocol || null });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setMessages((current) => [...current, { id: `assistant-error-${Date.now()}`, direction: "assistant", content: ERROR_TEXT[code] || "Tive uma instabilidade neste momento. Podemos continuar em instantes ou você pode pedir atendimento humano por aqui." }]);
    } finally { setSending(false); window.setTimeout(() => inputRef.current?.focus(), 100); }
  }

  async function startRecording() {
    if (recording) { recorderRef.current?.stop(); return; }
    setPageError(null);
    if (!("MediaRecorder" in window) || !navigator.mediaDevices?.getUserMedia) { setPageError("Este navegador não oferece gravação de voz. Você pode continuar digitando normalmente."); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream; chunksRef.current = [];
      const preferred = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType: preferred });
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = async () => {
        setRecording(false); stream.getTracks().forEach((track) => track.stop()); streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (blob.size < 32) return;
        setTranscribing(true);
        try {
          const audioBase64 = await blobToDataUrl(blob);
          const response = await fetch("/api/public-agent/audio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, audioBase64, mimeType: blob.type }) });
          const payload = (await response.json()) as AudioResponse;
          if (!response.ok || !payload.ok || !payload.text) throw new Error(payload.error || "AUDIO_TRANSCRIPTION_FAILED");
          setVoiceReplies(true); analytics("AgentVoiceMessage", slug, { bytes: blob.size });
          setTranscribing(false);
          await sendMessage(payload.text);
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          setPageError(ERROR_TEXT[code] || "Não consegui processar o áudio. Tente novamente ou escreva sua mensagem.");
          setTranscribing(false);
        }
      };
      recorder.start(); setRecording(true); analytics("AgentVoiceStarted", slug);
      window.setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 60_000);
    } catch { setPageError("Para conversar por voz, permita o acesso ao microfone no navegador."); }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(input); } }

  const style = { "--pa-accent": theme.accent || "#2f6d4f", "--pa-accent-strong": theme.accentStrong || "#1f4f3a", "--pa-navy": theme.navy || "#173f59", "--pa-background": theme.background || "#f4f1e8" } as React.CSSProperties;

  return <main className="public-agent-page" style={style}>
    <div className="public-agent-ambient public-agent-ambient-one" /><div className="public-agent-ambient public-agent-ambient-two" />
    <header className="public-agent-header"><a className="public-agent-brand" href="/solaris/atendimento" aria-label="Évora Urbanismo"><img src="/evora-brand.svg" alt="Évora Urbanismo" /></a><div className="public-agent-header-project"><span>{experience.name}</span><b>Atendimento inteligente</b></div></header>
    <section className="public-agent-shell">
      <aside className="public-agent-story" aria-label="Apresentação do Solaris">
        <span className="public-agent-eyebrow">{experience.eyebrow}</span><h1>{experience.title}</h1><p>{experience.subtitle}</p>
        <div className="public-agent-specialist-card"><img src="/vitoria-avatar.svg" alt="Ilustração da Vitória, assistente virtual da Évora" /><div><strong>Vitória</strong><span>Especialista virtual em Évora Urbanismo e seus empreendimentos</span></div></div>
        <div className="public-agent-landscape" aria-hidden="true"><span className="public-agent-sun" /><span className="public-agent-hill public-agent-hill-back" /><span className="public-agent-hill public-agent-hill-front" /><span className="public-agent-water" /></div>
        <div className="public-agent-trust-grid">{(theme.trustItems || []).map((item) => <div key={item} className="public-agent-trust-item"><span>✓</span><p>{item}</p></div>)}</div>
        <button className="public-agent-human-link" type="button" onClick={() => void sendMessage("Quero falar com um especialista da Évora.")}>Prefere falar com uma pessoa? <strong>Solicitar especialista</strong></button>
      </aside>
      <section className="public-agent-chat-card" aria-label="Conversa com a Vitória">
        <div className="public-agent-chat-head"><div className="public-agent-avatar"><img src="/vitoria-avatar.svg" alt="" /></div><div><strong>{experience.agentName}</strong><span><i /> Especialista virtual da Évora</span></div><button className={`public-agent-voice-toggle ${voiceReplies ? "active" : ""}`} type="button" onClick={() => { const next=!voiceReplies; setVoiceReplies(next); if(!next && "speechSynthesis" in window) window.speechSynthesis.cancel(); }} aria-label={voiceReplies ? "Desativar respostas em voz" : "Ativar respostas em voz"} title={voiceReplies ? "Respostas em voz ativas" : "Ouvir respostas da Vitória"}>◖))</button>{converted && <em className="public-agent-captured">Atendimento registrado</em>}</div>
        <div className="public-agent-messages" aria-live="polite">{visibleMessages.map((message) => <div key={message.id} className={`public-agent-message ${message.direction}`}><p>{message.content}</p></div>)}{(sending || transcribing) && <div className="public-agent-message assistant public-agent-typing" aria-label={transcribing ? "Vitória está entendendo seu áudio" : "Vitória está digitando"}><span /><span /><span /></div>}<div ref={endRef} /></div>
        {!initializing && quickReplies.length > 0 && !converted && <div className="public-agent-quick-replies">{quickReplies.map((reply) => <button key={reply} type="button" onClick={() => void sendMessage(reply)} disabled={sending || transcribing}>{reply}</button>)}</div>}
        {pageError && <div className="public-agent-alert" role="alert">{pageError}</div>}
        <div className="public-agent-composer public-agent-composer-voice"><button className={`public-agent-mic ${recording ? "recording" : ""}`} type="button" onClick={() => void startRecording()} disabled={initializing || sending || transcribing} aria-label={recording ? "Parar gravação" : "Falar com a Vitória"} title={recording ? "Toque para enviar" : "Falar com a Vitória"}>{recording ? "■" : "●"}</button><input ref={inputRef} value={input} onChange={(event) => setInput(event.target.value.slice(0,800))} onKeyDown={handleKeyDown} placeholder={recording ? "Estou ouvindo... toque no botão para enviar" : transcribing ? "Entendendo seu áudio..." : initializing ? "Iniciando atendimento..." : "Escreva ou fale com a Vitória"} disabled={initializing || sending || transcribing || recording} aria-label="Mensagem para a Vitória" /><button className="public-agent-send" type="button" onClick={() => void sendMessage(input)} disabled={initializing || sending || transcribing || recording || !input.trim()} aria-label="Enviar mensagem"><span>➜</span></button></div>
        <p className="public-agent-disclosure">A Vitória é uma assistente virtual da Évora. Você pode fornecer seus dados diretamente na conversa; informações comerciais finais são confirmadas quando necessário.</p>
      </section>
    </section>
    <footer className="public-agent-footer"><span>Évora Urbanismo</span><p>{theme.privacyNotice || "Seus dados são usados somente para este atendimento e para o contato solicitado."}</p></footer>
    {converted && protocol && <div className="public-agent-protocol" title="Protocolo do atendimento">Protocolo <strong>{protocol}</strong></div>}
  </main>;
}
