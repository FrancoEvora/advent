"use client";

import type { CSSProperties, KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  PublicAgentAttachment,
  PublicAgentContactCapture,
  PublicAgentExperience,
  PublicAgentMessage,
  PublicAgentMessagePayload,
  PublicAgentProfile,
  PublicAgentSessionPayload,
  PublicAgentStage,
} from "@/lib/public-agent/types";
import { VitoriaAvatar, type VitoriaAvatarState } from "./VitoriaAvatar";
import styles from "./VitoriaImmersiveExperience.module.css";

type Props = { slug: string; experience: PublicAgentExperience };
type UiMessage = {
  id: string;
  direction: "user" | "assistant";
  content: string;
  attachments: PublicAgentAttachment[];
};
type SessionResponse = { ok: boolean; error?: string } & Partial<PublicAgentSessionPayload>;
type MessageResponse = { ok: boolean; error?: string } & Partial<PublicAgentMessagePayload>;
type TranscribeResponse = { ok: boolean; error?: string; text?: string };
type AnalyticsWindow = Window & {
  dataLayer?: Array<Record<string, unknown>>;
  fbq?: (...args: unknown[]) => void;
};

type MediaRecorderWithMime = MediaRecorder & { mimeType: string };

const ERROR_TEXT: Record<string, string> = {
  PUBLIC_AGENT_RATE_LIMIT: "Você enviou muitas mensagens em pouco tempo. Aguarde alguns instantes.",
  PUBLIC_AGENT_MEDIA_RATE_LIMIT: "O limite de mensagens de voz desta hora foi atingido. Continue por texto.",
  PUBLIC_AGENT_IMAGE_RATE_LIMIT: "O limite diário de simulações desta conversa foi atingido.",
  PUBLIC_AGENT_MEDIA_TOO_LARGE: "O áudio ficou longo demais. Grave uma mensagem de até 45 segundos.",
  PUBLIC_AGENT_SESSION_INACTIVE: "A conversa expirou. Atualize a página para iniciar uma nova sessão.",
  PUBLIC_AGENT_EDGE_TIMEOUT: "A consulta está levando mais tempo que o esperado. Tente novamente.",
};

const NAV_ACTIONS = [
  { label: "Empreendimentos", message: "Quero conhecer os empreendimentos da Évora Urbanismo." },
  { label: "Lotes disponíveis", message: "Mostre os lotes disponíveis no Solaris." },
  { label: "Simular uma casa", message: "Quero criar uma simulação conceitual de casa para o Solaris." },
  { label: "Documentos", message: "Quais documentos e materiais oficiais você pode me apresentar?" },
  { label: "Agendar visita", message: "Quero agendar uma visita ao Solaris." },
];

function analytics(event: string, slug: string, extra: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  const target = window as AnalyticsWindow;
  target.dataLayer?.push({ event, agent_experience: slug, ...extra });
  target.fbq?.("trackCustom", event, { agent_experience: slug, ...extra });
}

function attributionFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const keys = [
    "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid",
    "campaign_id", "adset_id", "ad_id", "ad_name", "creative_id", "placement", "publisher_platform",
  ];
  return Object.fromEntries(keys.map(key => [key, params.get(key)]).filter(([, value]) => Boolean(value)));
}

function initialGreeting(experience: PublicAgentExperience) {
  return experience.theme?.greeting || `Olá. Sou a ${experience.agentName}, agente digital da Évora Urbanismo. Posso apresentar nossos empreendimentos, consultar condições e lotes, mostrar documentos ou criar uma visão conceitual da sua futura casa. Como posso ajudar?`;
}

function storedMessages(messages: PublicAgentMessage[]): UiMessage[] {
  return messages
    .filter(message => message.direction === "user" || message.direction === "assistant")
    .map(message => ({
      id: String(message.id),
      direction: message.direction as "user" | "assistant",
      content: message.content,
      attachments: Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : [],
    }));
}

function formatPrice(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(numeric)
    : "Consulte";
}

function formatArea(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(numeric)} m²`
    : "Área sob consulta";
}

function attachmentIcon(attachment: PublicAgentAttachment) {
  if (attachment.type === "image") return "✦";
  if (attachment.type === "project") return "⌂";
  return "▤";
}

export function VitoriaImmersiveExperience({ slug, experience }: Props) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [profile, setProfile] = useState<PublicAgentProfile>({});
  const [contact, setContact] = useState<PublicAgentContactCapture>({});
  const [stage, setStage] = useState<PublicAgentStage>("welcome");
  const [input, setInput] = useState("");
  const [quickReplies, setQuickReplies] = useState<string[]>(experience.theme?.quickReplies || []);
  const [initializing, setInitializing] = useState(true);
  const [sending, setSending] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [converted, setConverted] = useState(false);
  const [protocol, setProtocol] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [commercial, setCommercial] = useState<Record<string, unknown> | null>(null);
  const [avatarState, setAvatarState] = useState<VitoriaAvatarState>("idle");
  const [conversationOpen, setConversationOpen] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const recorderRef = useRef<MediaRecorderWithMime | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stopTimerRef = useRef<number | null>(null);
  const startedRef = useRef(false);

  const visibleMessages = useMemo<UiMessage[]>(() => {
    if (messages.length) return messages;
    return [{ id: "welcome", direction: "assistant", content: initialGreeting(experience), attachments: [] }];
  }, [messages, experience]);

  const themeStyle = {
    "--vi-accent": experience.theme?.accent || "#64efd2",
    "--vi-gold": "#d7b46f",
  } as CSSProperties;

  const lastAssistantMessage = useMemo(
    () => [...visibleMessages].reverse().find(message => message.direction === "assistant"),
    [visibleMessages],
  );

  useEffect(() => {
    let active = true;
    async function start() {
      try {
        const response = await fetch("/api/public-agent/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug,
            attribution: attributionFromLocation(),
            landingPage: window.location.href,
            referrer: document.referrer || null,
          }),
        });
        const payload = (await response.json()) as SessionResponse;
        if (!response.ok || !payload.ok) throw new Error(payload.error || "PUBLIC_AGENT_SESSION_UNAVAILABLE");
        if (!active) return;
        setMessages(storedMessages(payload.messages || []));
        setStage(payload.stage || "welcome");
        setProfile(payload.profile || {});
        setContact(payload.contactCapture || {});
        setConverted(Boolean(payload.converted));
        setProtocol(payload.leadProtocol || null);
        if (payload.converted) setQuickReplies([]);
        if (!startedRef.current) {
          startedRef.current = true;
          analytics("AgentStarted", slug, { resumed: Boolean(payload.messages?.length), immersive: true });
        }
      } catch (error) {
        if (!active) return;
        const code = error instanceof Error ? error.message : "";
        setPageError(ERROR_TEXT[code] || "Não foi possível iniciar o atendimento agora. Atualize a página.");
      } finally {
        if (active) setInitializing(false);
      }
    }
    void start();
    return () => {
      active = false;
      window.speechSynthesis?.cancel();
      streamRef.current?.getTracks().forEach(track => track.stop());
      if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
    };
  }, [slug]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, sending, transcribing, conversationOpen]);

  const speak = useCallback((text: string) => {
    if (!soundEnabled || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.replace(/[*#]/g, ""));
    utterance.lang = "pt-BR";
    utterance.rate = .96;
    utterance.pitch = 1.03;
    const voices = window.speechSynthesis.getVoices();
    utterance.voice = voices.find(voice => voice.lang.toLowerCase().startsWith("pt-br") && /female|luciana|francisca|maria|brasil/i.test(voice.name))
      || voices.find(voice => voice.lang.toLowerCase().startsWith("pt-br"))
      || null;
    utterance.onstart = () => setAvatarState("speaking");
    utterance.onend = () => setAvatarState("idle");
    utterance.onerror = () => setAvatarState("idle");
    window.speechSynthesis.speak(utterance);
  }, [soundEnabled]);

  const sendMessage = useCallback(async (raw: string) => {
    const message = raw.trim();
    if (!message || sending || initializing || transcribing) return;
    setInput("");
    setPageError(null);
    setQuickReplies([]);
    setConversationOpen(true);
    setMessages(current => [...current, { id: `user-${Date.now()}`, direction: "user", content: message, attachments: [] }]);
    setSending(true);
    setAvatarState("thinking");
    analytics("AgentMessageSent", slug, { stage, voice: raw === input ? false : undefined });
    try {
      const response = await fetch("/api/public-agent/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, message }),
      });
      const payload = (await response.json()) as MessageResponse;
      if (!response.ok || !payload.ok || !payload.reply) throw new Error(payload.error || "PUBLIC_AGENT_MESSAGE_UNAVAILABLE");
      const attachments = payload.attachments || [];
      setMessages(current => [...current, {
        id: `assistant-${Date.now()}`,
        direction: "assistant",
        content: payload.reply || "",
        attachments,
      }]);
      setStage(payload.stage || "discovery");
      setProfile(payload.profile || {});
      setContact(payload.contactCapture || {});
      setQuickReplies(payload.quickReplies || []);
      setCommercial(payload.commercial || null);
      setConverted(Boolean(payload.converted));
      setProtocol(payload.leadProtocol || null);
      speak(payload.reply);
      if (!soundEnabled) setAvatarState("idle");
      analytics("AgentReplyReceived", slug, {
        stage: payload.stage,
        action: payload.action,
        attachment_count: attachments.length,
        converted: Boolean(payload.converted),
        degraded: Boolean(payload.degraded),
      });
      if (payload.converted) analytics("QualifiedLead", slug, { protocol: payload.leadProtocol || null });
      if (attachments.some(item => item.type === "image")) analytics("HomeSimulationGenerated", slug);
      if (attachments.some(item => item.type === "document")) analytics("DocumentsPresented", slug);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setMessages(current => [...current, {
        id: `assistant-error-${Date.now()}`,
        direction: "assistant",
        content: ERROR_TEXT[code] || "Tive uma instabilidade momentânea. Tente novamente ou peça um especialista.",
        attachments: [],
      }]);
      setAvatarState("idle");
    } finally {
      setSending(false);
      window.setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [sending, initializing, transcribing, slug, stage, speak, soundEnabled, input]);

  const submitAudio = useCallback(async (blob: Blob) => {
    setTranscribing(true);
    setAvatarState("thinking");
    try {
      const form = new FormData();
      form.append("slug", slug);
      form.append("audio", blob, `vitoria-${Date.now()}.webm`);
      const response = await fetch("/api/public-agent/transcribe", { method: "POST", body: form });
      const payload = (await response.json()) as TranscribeResponse;
      if (!response.ok || !payload.ok || !payload.text) throw new Error(payload.error || "PUBLIC_AGENT_TRANSCRIPTION_UNAVAILABLE");
      analytics("VoiceTranscribed", slug, { length: payload.text.length });
      setTranscribing(false);
      await sendMessage(payload.text);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setPageError(ERROR_TEXT[code] || "Não consegui compreender o áudio. Tente novamente ou escreva sua mensagem.");
      setTranscribing(false);
      setAvatarState("idle");
    }
  }, [slug, sendMessage]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
    stopTimerRef.current = null;
  }, []);

  const toggleRecording = useCallback(async () => {
    if (recording) {
      stopRecording();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !("MediaRecorder" in window)) {
      setPageError("Este navegador não oferece gravação de voz. Use o campo de texto.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      streamRef.current = stream;
      const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined) as MediaRecorderWithMime;
      chunksRef.current = [];
      recorder.ondataavailable = event => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        stream.getTracks().forEach(track => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setRecording(false);
        setAvatarState("idle");
        if (blob.size > 200) void submitAudio(blob);
      };
      recorderRef.current = recorder;
      recorder.start(250);
      setRecording(true);
      setAvatarState("listening");
      setPageError(null);
      analytics("VoiceRecordingStarted", slug);
      stopTimerRef.current = window.setTimeout(stopRecording, 45_000);
    } catch {
      setPageError("Não foi possível acessar o microfone. Verifique a permissão do navegador.");
      setRecording(false);
      setAvatarState("idle");
    }
  }, [recording, slug, stopRecording, submitAudio]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage(input);
    }
  }

  const units = useMemo(() => {
    if (!commercial || !Array.isArray(commercial.units)) return [];
    return commercial.units.filter((unit): unit is Record<string, unknown> => Boolean(unit) && typeof unit === "object").slice(0, 6);
  }, [commercial]);

  return (
    <main className={styles.page} style={themeStyle}>
      <div className={styles.noise} aria-hidden="true" />
      <div className={styles.topGlow} aria-hidden="true" />

      <header className={styles.header}>
        <a className={styles.brand} href="/solaris/atendimento" aria-label="Évora Urbanismo">
          <img src="/evora-brand.svg" alt="Évora Urbanismo" />
          <span>Inteligência comercial</span>
        </a>
        <div className={styles.headerActions}>
          <button type="button" className={soundEnabled ? styles.activeControl : styles.control} onClick={() => {
            setSoundEnabled(current => {
              if (current) window.speechSynthesis?.cancel();
              return !current;
            });
          }} aria-pressed={soundEnabled} title="Ativar ou silenciar voz">
            {soundEnabled ? "Som ativo" : "Som"}
          </button>
          <button type="button" className={styles.control} onClick={() => setConversationOpen(current => !current)}>
            {conversationOpen ? "Foco visual" : "Conversa"}
          </button>
          <div className={styles.online}><i /> Vitória online</div>
        </div>
      </header>

      <section className={styles.hero}>
        <div className={styles.contentColumn}>
          <span className={styles.eyebrow}>{experience.eyebrow}</span>
          <h1>
            <small>Olá.</small>
            Como posso <em>ajudar?</em>
          </h1>
          <p className={styles.intro}>{experience.subtitle}</p>

          <nav className={styles.actionNav} aria-label="Atalhos de atendimento">
            {NAV_ACTIONS.map(action => (
              <button key={action.label} type="button" onClick={() => void sendMessage(action.message)} disabled={sending || initializing}>
                <span>{action.label === "Simular uma casa" ? "✦" : action.label === "Documentos" ? "▤" : action.label === "Agendar visita" ? "⌖" : "○"}</span>
                {action.label}
              </button>
            ))}
          </nav>

          <div className={styles.voiceZone}>
            <div className={`${styles.voiceLine} ${recording ? styles.voiceLineActive : ""}`} aria-hidden="true">
              {Array.from({ length: 34 }, (_, index) => <i key={index} style={{ "--index": index } as CSSProperties} />)}
            </div>
            <button
              type="button"
              className={`${styles.voiceOrb} ${recording ? styles.voiceOrbRecording : ""} ${transcribing ? styles.voiceOrbThinking : ""}`}
              onClick={() => void toggleRecording()}
              disabled={initializing || sending || transcribing}
              aria-label={recording ? "Parar gravação" : "Falar com a Vitória"}
            >
              <span className={styles.voiceOrbCore}>{recording ? "■" : transcribing ? "…" : "⌁"}</span>
            </button>
            <div className={styles.voiceCaption}>
              <strong>{recording ? "Estou ouvindo" : transcribing ? "Compreendendo sua mensagem" : "Prefere falar?"}</strong>
              <span>{recording ? "Toque para enviar" : "Toque no microfone ou digite abaixo"}</span>
            </div>
          </div>

          {conversationOpen && (
            <section className={styles.conversation} aria-label="Conversa com a Vitória">
              <div className={styles.conversationHeader}>
                <div>
                  <strong>{experience.agentName}</strong>
                  <span>Especialista digital da Évora Urbanismo</span>
                </div>
                {converted && <b>Atendimento registrado {protocol ? `· ${protocol}` : ""}</b>}
              </div>
              <div className={styles.messageList} aria-live="polite">
                {visibleMessages.map(message => (
                  <article key={message.id} className={`${styles.message} ${message.direction === "user" ? styles.userMessage : styles.assistantMessage}`}>
                    <p>{message.content}</p>
                    {message.attachments.length > 0 && (
                      <div className={styles.attachments}>
                        {message.attachments.map((attachment, index) => (
                          <a
                            key={`${attachment.id || attachment.title}-${index}`}
                            className={`${styles.attachment} ${attachment.type === "image" ? styles.imageAttachment : ""}`}
                            href={attachment.url || undefined}
                            target={attachment.url ? "_blank" : undefined}
                            rel={attachment.url ? "noreferrer" : undefined}
                            onClick={event => { if (!attachment.url) event.preventDefault(); }}
                          >
                            {attachment.type === "image" && attachment.url ? (
                              <img src={attachment.url} alt={attachment.title} />
                            ) : (
                              <span className={styles.attachmentIcon}>{attachmentIcon(attachment)}</span>
                            )}
                            <div>
                              <small>{attachment.badge || (attachment.type === "document" ? "Documento" : "Évora Urbanismo")}</small>
                              <strong>{attachment.title}</strong>
                              {attachment.description && <p>{attachment.description}</p>}
                              {attachment.disclaimer && <em>{attachment.disclaimer}</em>}
                            </div>
                          </a>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
                {(sending || transcribing) && (
                  <div className={`${styles.message} ${styles.assistantMessage} ${styles.typing}`}>
                    <i /><i /><i />
                  </div>
                )}
                <div ref={endRef} />
              </div>

              {units.length > 0 && (
                <div className={styles.unitRail}>
                  {units.map(unit => {
                    const code = String(unit.unit_code || unit.unitCode || "Lote");
                    return (
                      <button key={code} type="button" onClick={() => void sendMessage(`Quero detalhes do lote ${code}.`)}>
                        <span>{code}</span>
                        <strong>{formatArea(unit.area)}</strong>
                        <em>{formatPrice(unit.list_price || unit.listPrice)}</em>
                      </button>
                    );
                  })}
                </div>
              )}

              {quickReplies.length > 0 && !sending && (
                <div className={styles.quickReplies}>
                  {quickReplies.map(reply => <button key={reply} type="button" onClick={() => void sendMessage(reply)}>{reply}</button>)}
                </div>
              )}

              {pageError && <div className={styles.alert} role="alert">{pageError}</div>}

              <div className={styles.composer}>
                <textarea
                  ref={inputRef}
                  rows={1}
                  value={input}
                  onChange={event => setInput(event.target.value.slice(0, 1200))}
                  onKeyDown={handleKeyDown}
                  placeholder={initializing ? "Conectando à base da Évora..." : "Pergunte sobre empreendimentos, lotes, documentos ou sua futura casa"}
                  disabled={initializing || sending || transcribing}
                  aria-label="Mensagem para a Vitória"
                />
                <button type="button" className={styles.miniMic} onClick={() => void toggleRecording()} disabled={initializing || sending || transcribing} aria-label="Enviar áudio">
                  {recording ? "■" : "⌁"}
                </button>
                <button type="button" className={styles.send} onClick={() => void sendMessage(input)} disabled={initializing || sending || transcribing || !input.trim()} aria-label="Enviar mensagem">➜</button>
              </div>

              {(contact.name || contact.phone) && !converted && (
                <div className={styles.contactProgress}>
                  <span>Dados na conversa</span>
                  <b>{contact.name || "Nome pendente"}</b>
                  <b>{contact.phone || "Telefone pendente"}</b>
                  <em>{contact.serviceConsent ? "Contato autorizado" : "Aguardando autorização explícita"}</em>
                </div>
              )}
            </section>
          )}
        </div>

        <aside className={styles.avatarColumn}>
          <VitoriaAvatar state={avatarState} heroImageUrl={experience.heroImageUrl} agentName={experience.agentName} />
          <div className={styles.avatarMeta}>
            <div><span>Agente</span><strong>{experience.agentName}</strong></div>
            <div><span>Base</span><strong>Enterprise + conhecimento Évora</strong></div>
            <div><span>Atendimento</span><strong>Texto, voz, documentos e imagens</strong></div>
          </div>
          {lastAssistantMessage && !conversationOpen && (
            <button className={styles.lastAnswer} type="button" onClick={() => setConversationOpen(true)}>
              <span>Última resposta</span>
              <p>{lastAssistantMessage.content}</p>
            </button>
          )}
        </aside>
      </section>

      <footer className={styles.footer}>
        <span>Évora Urbanismo · Atendimento inteligente</span>
        <p>A Vitória é uma agente digital. Estoque, valores, condições e documentos são consultados na base autorizada e sujeitos à confirmação comercial.</p>
      </footer>
    </main>
  );
}
