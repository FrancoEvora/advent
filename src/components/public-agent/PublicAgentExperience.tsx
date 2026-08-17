"use client";

import Image from "next/image";
import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

import type {
  PublicAgentAttachment,
  PublicAgentAudio,
  PublicAgentCommercialContext,
  PublicAgentCommercialUnit,
  PublicAgentExperience,
  PublicAgentMessage,
  PublicAgentProfile,
  PublicAgentSimulation,
  PublicAgentStage,
} from "@/lib/public-agent/types";

type Props = {
  slug: string;
  experience: PublicAgentExperience;
};

type SessionResponse = {
  ok: boolean;
  error?: string;
  stage?: PublicAgentStage;
  profile?: PublicAgentProfile;
  converted?: boolean;
  leadProtocol?: string | null;
  quickReplies?: string[];
  messages?: PublicAgentMessage[];
};

type MessageResponse = {
  ok: boolean;
  error?: string;
  reply?: string;
  stage?: PublicAgentStage;
  profile?: PublicAgentProfile;
  requestContact?: boolean;
  handoffRequested?: boolean;
  quickReplies?: string[];
  attachments?: PublicAgentAttachment[];
  simulation?: PublicAgentSimulation | null;
  commercial?: PublicAgentCommercialContext | null;
  converted?: boolean;
  degraded?: boolean;
};

type UiMessage = {
  id: string;
  direction: "user" | "assistant";
  content: string;
  createdAt?: string;
  deliveryState?: "sending" | "sent" | "failed";
  source?: "text" | "audio";
  transcriptionRequestId?: string;
  attachments?: PublicAgentAttachment[];
  simulation?: PublicAgentSimulation | null;
  commercial?: PublicAgentCommercialContext | null;
  kind?: "text" | "audio";
  audioUrl?: string;
  audioDuration?: number;
  audioState?: "transcribing" | "ready" | "failed";
  transcript?: string;
};

type AudioDraft = {
  messageId: string;
  transcriptionRequestId: string;
  blob: Blob;
  url: string;
  duration: number;
  mimeType: string;
  filename: string;
};

type AudioPayload = Omit<AudioDraft, "url"> & { url: string };

type SendMessageOptions = {
  clientMessageId?: string;
  source?: "text" | "audio";
  existingUserMessageId?: string;
  transcriptionRequestId?: string;
};

type TranscriptionResponse = {
  ok: boolean;
  error?: string;
  status?: "processing" | "completed";
  retryAfterMs?: number;
  text?: string;
  audio?: PublicAgentAudio;
};

type AnalyticsWindow = Window & {
  dataLayer?: Array<Record<string, unknown>>;
  fbq?: (...args: unknown[]) => void;
};

const ERROR_TEXT: Record<string, string> = {
  PUBLIC_AGENT_RATE_LIMIT: "Você enviou muitas mensagens em pouco tempo. Aguarde alguns minutos e tente novamente.",
  PUBLIC_AGENT_SESSION_INACTIVE: "Esta conversa expirou. Atualize a página para iniciar um novo atendimento.",
  PUBLIC_AGENT_CONSENT_REQUIRED: "Confirme a autorização de contato para continuar.",
  PUBLIC_AGENT_PHONE_INVALID: "Informe um telefone brasileiro válido com DDD.",
  PUBLIC_AGENT_EMAIL_INVALID: "Revise o e-mail informado.",
  PUBLIC_AGENT_AUDIO_INVALID: "Não consegui ler este áudio. Grave uma nova mensagem e tente novamente.",
  PUBLIC_AGENT_AUDIO_TYPE_INVALID: "Este formato de áudio não é compatível. Grave novamente pelo microfone da conversa.",
  PUBLIC_AGENT_AUDIO_TOO_LARGE: "O áudio ficou muito longo. Grave uma mensagem mais curta e tente novamente.",
  PUBLIC_AGENT_TRANSCRIPTION_TIMEOUT: "A transcrição demorou mais que o esperado. Você pode tentar novamente sem regravar.",
  PUBLIC_AGENT_TRANSCRIPTION_FAILED: "Não consegui transcrever este áudio agora. Você pode tentar novamente.",
  PUBLIC_AGENT_TRANSCRIPTION_UNAVAILABLE: "Não consegui transcrever este áudio agora. Você pode tentar novamente.",
  PUBLIC_AGENT_NETWORK_UNAVAILABLE: "A conexão oscilou antes de concluir o envio. Sua mensagem ficou disponível para tentar novamente.",
  PUBLIC_AGENT_RESPONSE_TIMEOUT: "A resposta demorou além do esperado. Pode tentar novamente; nada será duplicado.",
};
const CHAT_RECOVERY_WINDOW_MS = 245_000;
const CHAT_FETCH_TIMEOUT_MS = 85_000;
const TRANSCRIPTION_RECOVERY_WINDOW_MS = 170_000;
const TRANSCRIPTION_FETCH_TIMEOUT_MS = 70_000;
const MAX_AUDIO_BYTES = 2_100_000;
const MAX_RECORDING_SECONDS = 90;
const PUBLIC_AGENT_DISPLAY_NAME = "Bia";
const DEFAULT_VITORIA_AVATAR = "/vitoria/vitoria-avatar.webp";
const LEGACY_VITORIA_AVATAR = "/vitoria/vitoria-portrait.svg";
const AUDIO_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
];

function nowMs() {
  return Date.now();
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const clock = new Intl.DateTimeFormat("pt-BR", {
  hour: "2-digit",
  minute: "2-digit",
});

function storedRichPayload(message: PublicAgentMessage) {
  const metadata = object(message.metadata) ? message.metadata : {};
  const publicResponse = object(metadata.public_response) ? metadata.public_response : {};
  return {
    attachments: Array.isArray(publicResponse.attachments)
      ? publicResponse.attachments as PublicAgentAttachment[]
      : undefined,
    simulation: object(publicResponse.simulation)
      ? publicResponse.simulation as PublicAgentSimulation
      : null,
    commercial: object(publicResponse.commercial)
      ? publicResponse.commercial as PublicAgentCommercialContext
      : null,
  };
}

function analytics(event: string, slug: string, extra: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  const target = window as AnalyticsWindow;
  target.dataLayer?.push({ event, agent_experience: slug, ...extra });
  target.fbq?.("trackCustom", event, { agent_experience: slug, ...extra });
}

function safeSameOriginAsset(value: string | null | undefined) {
  const source = value?.trim();
  if (!source || !source.startsWith("/") || source.startsWith("//")) return null;
  return source === LEGACY_VITORIA_AVATAR ? DEFAULT_VITORIA_AVATAR : source;
}

function avatarSources(experience: PublicAgentExperience) {
  return Array.from(new Set([
    safeSameOriginAsset(experience.avatar?.imageUrl),
    safeSameOriginAsset(experience.heroImageUrl),
    DEFAULT_VITORIA_AVATAR,
  ].filter((source): source is string => Boolean(source))));
}

function publicAgentName(value: string | null | undefined) {
  const configured = value?.normalize("NFC").trim();
  return !configured || /^vit[oó]ria$/iu.test(configured)
    ? PUBLIC_AGENT_DISPLAY_NAME
    : configured;
}

function currentAgentCopy(value: string) {
  return value.replace(/Vit[oó]ria/giu, PUBLIC_AGENT_DISPLAY_NAME);
}

function initialGreeting(experience: PublicAgentExperience) {
  const configured = experience.greetingText?.normalize("NFC").trim();
  if (
    configured &&
    configured.length <= 600 &&
    !/assistente\s+virtual|chatbot/iu.test(configured)
  ) {
    return currentAgentCopy(configured);
  }
  const project = experience.name?.normalize("NFC").trim();
  const destination = project && project !== "Évora Urbanismo"
    ? ` ou ainda conhecendo o ${project}`
    : " ou ainda conhecendo as opções da Évora";
  return `Oi! Tudo bem? Sou a ${publicAgentName(experience.agentName)}, da Évora. Me conta: você está procurando um lote para morar, investir${destination}?`;
}

function attributionFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const keys = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "fbclid",
    "campaign_id",
    "adset_id",
    "ad_id",
    "ad_name",
    "creative_id",
    "placement",
    "publisher_platform",
  ];
  return Object.fromEntries(keys.map((key) => [key, params.get(key)]).filter(([, value]) => Boolean(value)));
}

function mapStoredMessages(messages: PublicAgentMessage[]): UiMessage[] {
  return messages
    .filter((message) => message.direction === "user" || message.direction === "assistant")
    .map((message) => {
      const metadata = object(message.metadata) ? message.metadata : {};
      const storedAudio = message.direction === "user" && object(metadata.public_audio)
        ? metadata.public_audio as PublicAgentAudio
        : null;
      const rich = message.direction === "assistant"
        ? storedRichPayload(message)
        : { attachments: undefined, simulation: null, commercial: null };
      return {
        id: String(message.id),
        direction: message.direction as "user" | "assistant",
        content: message.content,
        createdAt: message.created_at,
        deliveryState: message.direction === "user" ? "sent" as const : undefined,
        ...(storedAudio
          ? {
            kind: "audio" as const,
            audioUrl: storedAudio.url,
            audioDuration: storedAudio.durationSeconds,
            audioState: "ready" as const,
            transcript: message.content,
          }
          : {}),
        ...rich,
      };
  });
}

function formatDuration(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function formatClock(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return clock.format(date);
}

function baseAudioMimeType(value: string) {
  return value.toLowerCase().split(";")[0] || "audio/webm";
}

function audioFilename(mimeType: string) {
  if (mimeType.includes("mp4")) return "mensagem.m4a";
  if (mimeType.includes("mpeg")) return "mensagem.mp3";
  if (mimeType.includes("wav")) return "mensagem.wav";
  return "mensagem.webm";
}

function PublicAgentIcon({ name }: { name: "mic" | "send" | "stop" | "trash" }) {
  if (name === "mic") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M12 14.5a3.5 3.5 0 0 0 3.5-3.5V5a3.5 3.5 0 1 0-7 0v6a3.5 3.5 0 0 0 3.5 3.5Z" />
        <path d="M5.5 10.5v.5a6.5 6.5 0 0 0 13 0v-.5M12 17.5V21M8.5 21h7" />
      </svg>
    );
  }
  if (name === "send") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="m3.5 4 17 8-17 8 3.2-8-3.2-8Z" />
        <path d="M6.7 12h13.1" />
      </svg>
    );
  }
  if (name === "stop") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect x="7" y="7" width="10" height="10" rx="2" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4.5 7h15M9 7V4.5h6V7M7 7l.8 13h8.4L17 7M10 10.5v6M14 10.5v6" />
    </svg>
  );
}

function AudioMessageView({
  message,
  disabled,
  onRetry,
}: {
  message: UiMessage;
  disabled: boolean;
  onRetry: (messageId: string) => void;
}) {
  return (
    <section className="public-agent-audio-bubble" aria-label="Mensagem de voz">
      {message.audioUrl && (
        <audio
          aria-label="Reproduzir mensagem de voz"
          controls
          preload="metadata"
          src={message.audioUrl}
        />
      )}
      <div className="public-agent-audio-meta">
        <span>{formatDuration(message.audioDuration || 0)}</span>
        {message.audioState === "transcribing" && <span role="status">Transcrevendo…</span>}
        {message.audioState === "ready" && <span>Transcrito</span>}
        {message.audioState === "failed" && <span>Não transcrito</span>}
      </div>
      {message.transcript && (
        <div className="public-agent-audio-transcript">
          <span>Transcrição</span>
          {message.transcript}
        </div>
      )}
      {message.audioState === "failed" && (
        <button type="button" onClick={() => onRetry(message.id)} disabled={disabled}>
          Tentar transcrever novamente
        </button>
      )}
    </section>
  );
}

function CommercialUnitsView({
  commercial,
  disabled,
  onSimulate,
}: {
  commercial: PublicAgentCommercialContext;
  disabled: boolean;
  onSimulate: (unit: PublicAgentCommercialUnit) => void;
}) {
  const units = commercial.units || [];
  if (!units.length) return null;
  return (
    <section className="public-agent-units" aria-label="Lotes disponíveis">
      <div className="public-agent-units-head">
        <div>
          <span>{commercial.realTime ? "Disponibilidade em tempo real" : "Opções encontradas"}</span>
          <strong>Lotes disponíveis</strong>
        </div>
        {typeof commercial.summary?.availableCount === "number" && (
          <small>{commercial.summary.availableCount} no estoque</small>
        )}
      </div>
      <div className="public-agent-unit-list">
        {units.map((unit) => (
          <article className="public-agent-unit-card" key={unit.unitCode}>
            <span>Lote {unit.unitCode}</span>
            {typeof unit.area === "number" && <strong>{unit.area.toLocaleString("pt-BR")} m²</strong>}
            {typeof unit.listPrice === "number" && <b>{currency.format(unit.listPrice)}</b>}
            {typeof unit.pricePerSqm === "number" && <small>{currency.format(unit.pricePerSqm)}/m²</small>}
            <button
              type="button"
              onClick={() => onSimulate(unit)}
              disabled={disabled}
              aria-label={`Simular condições do lote ${unit.unitCode}`}
            >
              Simular condições
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function SimulationView({ simulation }: { simulation: PublicAgentSimulation }) {
  return (
    <section className="public-agent-simulation-card">
      <span>Simulação · {simulation.unitCode}</span>
      <strong>{currency.format(simulation.price)}</strong>
      <p>
        Entrada de {new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(simulation.downPaymentPct * 100)}%
        {simulation.downPaymentInstallments > 1
          ? ` em ${simulation.downPaymentInstallments}x de ${currency.format(simulation.downPaymentInstallmentAmount)}`
          : ` (${currency.format(simulation.downPayment)})`}
      </p>
      <div>
        {simulation.scenarios.map((scenario) => (
          <small key={scenario.months}>
            {scenario.months} meses <b>{currency.format(scenario.monthlyPayment)}/mês</b>
          </small>
        ))}
      </div>
      {simulation.balloonCount > 0 && (
        <em>
          {simulation.balloonCount} balões de {currency.format(simulation.balloonAmount)} a cada {simulation.balloonFrequencyMonths} meses
        </em>
      )}
    </section>
  );
}

function AttachmentView({ attachment }: { attachment: PublicAgentAttachment }) {
  if (attachment.type === "image" && attachment.url) {
    return (
      <figure className="public-agent-rich-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt={attachment.title} loading="lazy" src={attachment.url} />
        <figcaption><strong>{attachment.title}</strong><small>{attachment.disclaimer || attachment.description}</small></figcaption>
      </figure>
    );
  }
  if (attachment.url && attachment.mimeType?.startsWith("video/")) {
    return (
      <figure className="public-agent-rich-card">
        <video controls playsInline preload="metadata" src={attachment.url} />
        <figcaption><strong>{attachment.title}</strong><small>{attachment.description}</small></figcaption>
      </figure>
    );
  }
  if (attachment.type === "project") {
    return (
      <section className="public-agent-project-card">
        <span>{attachment.badge || "Évora Urbanismo"}</span>
        <strong>{attachment.title}</strong>
        {attachment.description && <small>{attachment.description}</small>}
      </section>
    );
  }
  if (!attachment.url) return null;
  return (
    <a className="public-agent-document-card" href={attachment.url} rel="noreferrer" target="_blank">
      <span>Documento</span>
      <strong>{attachment.title}</strong>
      <small>{attachment.badge || attachment.description || "Abrir arquivo"}</small>
    </a>
  );
}

export function PublicAgentExperience({ slug, experience }: Props) {
  const theme = experience.theme || {};
  const agentName = publicAgentName(experience.agentName);
  const availableAvatarSources = useMemo(() => avatarSources(experience), [experience]);
  const initialQuickRepliesRef = useRef(theme.quickReplies || []);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [stage, setStage] = useState<PublicAgentStage>("welcome");
  const [input, setInput] = useState("");
  const [quickReplies, setQuickReplies] = useState<string[]>(() => theme.quickReplies || []);
  const [initializing, setInitializing] = useState(true);
  const [sending, setSending] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [converted, setConverted] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioDraft, setAudioDraft] = useState<AudioDraft | null>(null);
  const [audioBusy, setAudioBusy] = useState(false);
  const [failedAvatarSources, setFailedAvatarSources] = useState<ReadonlySet<string>>(() => new Set());
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const startedRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingStartedAtRef = useRef(0);
  const recordingIntervalRef = useRef<number | null>(null);
  const keepRecordingRef = useRef(true);
  const objectUrlsRef = useRef<Set<string>>(new Set());
  const audioPayloadsRef = useRef<Map<string, AudioPayload>>(new Map());
  const mountedRef = useRef(true);

  const visibleMessages = useMemo(() => {
    if (messages.length) return messages;
    return [{ id: "welcome", direction: "assistant" as const, content: initialGreeting(experience) }];
  }, [messages, experience]);

  const activeAvatarSource = availableAvatarSources.find((source) => !failedAvatarSources.has(source));

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
        const restoredMessages = mapStoredMessages(payload.messages || []);
        setMessages(restoredMessages);
        setStage(payload.stage || "welcome");
        setConverted(Boolean(payload.converted));
        setQuickReplies(
          payload.quickReplies?.length
            ? payload.quickReplies
            : restoredMessages.length
            ? []
            : initialQuickRepliesRef.current,
        );
        if (!startedRef.current) {
          startedRef.current = true;
          analytics("AgentStarted", slug, { resumed: Boolean(payload.messages?.length) });
        }
      } catch (error) {
        if (!active) return;
        setPageError(ERROR_TEXT[error instanceof Error ? error.message : ""] || "Não foi possível iniciar o atendimento agora. Tente atualizar a página.");
      } finally {
        if (active) setInitializing(false);
      }
    }
    start();
    return () => {
      active = false;
    };
  }, [slug]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const syncHeight = () => {
      const height = Math.round(viewport?.height || window.innerHeight);
      document.documentElement.style.setProperty("--public-agent-viewport-height", `${height}px`);
    };
    syncHeight();
    viewport?.addEventListener("resize", syncHeight);
    viewport?.addEventListener("scroll", syncHeight, { passive: true });
    window.addEventListener("resize", syncHeight);
    return () => {
      viewport?.removeEventListener("resize", syncHeight);
      viewport?.removeEventListener("scroll", syncHeight);
      window.removeEventListener("resize", syncHeight);
      document.documentElement.style.removeProperty("--public-agent-viewport-height");
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, sending, audioBusy]);

  useEffect(() => {
    mountedRef.current = true;
    const urls = objectUrlsRef.current;
    return () => {
      mountedRef.current = false;
      keepRecordingRef.current = false;
      if (recordingIntervalRef.current !== null) {
        window.clearInterval(recordingIntervalRef.current);
      }
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

  async function sendMessage(value: string, options: SendMessageOptions = {}) {
    const message = value.trim();
    if (
      !message
      || sending
      || initializing
      || (audioBusy && !options.existingUserMessageId)
    ) return;
    const clientMessageId = options.clientMessageId || crypto.randomUUID();
    const userMessageId = options.existingUserMessageId || clientMessageId;
    const createdAt = new Date().toISOString();
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "47px";
    setPageError(null);
    setQuickReplies([]);
    if (options.existingUserMessageId) {
      setMessages((current) => current.map((item) => item.id === options.existingUserMessageId
        ? {
          ...item,
          content: message,
          transcript: message,
          audioState: item.kind === "audio" ? "ready" : item.audioState,
          deliveryState: "sending",
          source: options.source || item.source || "text",
          transcriptionRequestId: options.transcriptionRequestId || item.transcriptionRequestId,
        }
        : item));
    } else {
      setMessages((current) => [
        ...current,
        {
          id: clientMessageId,
          direction: "user",
          content: message,
          createdAt,
          deliveryState: "sending",
          source: options.source || "text",
          transcriptionRequestId: options.transcriptionRequestId,
        },
      ]);
    }
    setSending(true);
    analytics("AgentMessageSent", slug, { stage, source: options.source || "text" });
    try {
      let response: Response | null = null;
      let payload: MessageResponse & {
        status?: "processing" | "completed";
        retryAfterMs?: number;
        leadProtocol?: string | null;
      } = { ok: false };
      const deadline = nowMs() + CHAT_RECOVERY_WINDOW_MS;
      let networkAttempts = 0;
      let processingPolls = 0;
      while (nowMs() < deadline) {
        const controller = new AbortController();
        const remaining = Math.max(1_000, deadline - nowMs());
        const timer = window.setTimeout(
          () => controller.abort(),
          Math.min(CHAT_FETCH_TIMEOUT_MS, remaining),
        );
        try {
          response = await fetch("/api/public-agent/message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              slug,
              message,
              clientMessageId,
              source: options.source || "text",
              transcriptionRequestId: options.transcriptionRequestId || null,
            }),
            signal: controller.signal,
          });
          payload = (await response.json()) as typeof payload;
          networkAttempts = 0;
        } catch {
          networkAttempts += 1;
          if (networkAttempts >= 4 || nowMs() + 1_500 >= deadline) throw new Error("PUBLIC_AGENT_NETWORK_UNAVAILABLE");
          await new Promise((resolve) => window.setTimeout(resolve, 700 * networkAttempts));
          continue;
        } finally {
          window.clearTimeout(timer);
        }
        if (response.status === 202 || payload.status === "processing") {
          processingPolls += 1;
          await new Promise((resolve) => window.setTimeout(
            resolve,
            Math.max(1_200, Math.min(4_000, (payload.retryAfterMs || 1_200) + processingPolls * 200)),
          ));
          continue;
        }
        break;
      }
      if (!response || response.status === 202 || payload.status === "processing") {
        throw new Error("PUBLIC_AGENT_RESPONSE_TIMEOUT");
      }
      if (!response.ok || !payload.ok || !payload.reply) {
        throw new Error(payload.error || "PUBLIC_AGENT_MESSAGE_UNAVAILABLE");
      }
      setMessages((current) => [
        ...current.map((item) => item.id === userMessageId
          ? { ...item, deliveryState: "sent" as const }
          : item),
        {
          id: `assistant-${clientMessageId}`,
          direction: "assistant",
          content: payload.reply || "",
          createdAt: new Date().toISOString(),
          attachments: payload.attachments,
          simulation: payload.simulation,
          commercial: payload.commercial,
        },
      ]);
      if (options.source === "audio") audioPayloadsRef.current.delete(userMessageId);
      setStage(payload.stage || "discovery");
      setQuickReplies(payload.quickReplies || []);
      setConverted(Boolean(payload.converted));
      analytics("AgentReplyReceived", slug, {
        stage: payload.stage,
        contact_requested: Boolean(payload.requestContact),
        degraded: Boolean(payload.degraded),
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setMessages((current) => current.map((item) => item.id === userMessageId
        ? { ...item, deliveryState: "failed" }
        : item));
      setPageError(ERROR_TEXT[code] || "Não consegui concluir o envio agora. Sua mensagem pode ser tentada novamente sem duplicar o atendimento.");
    } finally {
      setSending(false);
      window.setTimeout(() => inputRef.current?.focus(), 100);
    }
  }

  function retryMessage(message: UiMessage) {
    void sendMessage(message.content, {
      clientMessageId: message.id,
      existingUserMessageId: message.id,
      source: message.source || "text",
      transcriptionRequestId: message.transcriptionRequestId,
    });
  }

  async function requestTranscription(audio: AudioPayload) {
    const deadline = nowMs() + TRANSCRIPTION_RECOVERY_WINDOW_MS;
    let networkAttempts = 0;
    let processingPolls = 0;
    while (nowMs() < deadline) {
      const form = new FormData();
      form.set("slug", slug);
      form.set("clientMessageId", audio.transcriptionRequestId);
      form.set("durationSeconds", String(audio.duration));
      form.set("audio", audio.blob, audio.filename);
      const controller = new AbortController();
      const remaining = Math.max(1_000, deadline - nowMs());
      const timer = window.setTimeout(
        () => controller.abort(),
        Math.min(TRANSCRIPTION_FETCH_TIMEOUT_MS, remaining),
      );
      let response: Response;
      let payload: TranscriptionResponse;
      try {
        response = await fetch("/api/public-agent/transcribe", {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
        payload = (await response.json()) as TranscriptionResponse;
      } catch {
        networkAttempts += 1;
        if (networkAttempts >= 4 || nowMs() + 1_500 >= deadline) {
          throw new Error("PUBLIC_AGENT_TRANSCRIPTION_UNAVAILABLE");
        }
        await new Promise((resolve) => window.setTimeout(resolve, 700 * networkAttempts));
        continue;
      } finally {
        window.clearTimeout(timer);
      }

      if (response.status >= 500) {
        networkAttempts += 1;
        if (networkAttempts >= 4 || nowMs() + 1_500 >= deadline) {
          throw new Error(payload.error || "PUBLIC_AGENT_TRANSCRIPTION_UNAVAILABLE");
        }
        await new Promise((resolve) => window.setTimeout(resolve, 700 * networkAttempts));
        continue;
      }
      networkAttempts = 0;
      if (response.status === 202 || payload.status === "processing") {
        processingPolls += 1;
        await new Promise((resolve) => window.setTimeout(
          resolve,
          Math.max(1_000, Math.min(3_000, (payload.retryAfterMs || 1_200) + processingPolls * 150)),
        ));
        continue;
      }
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "PUBLIC_AGENT_TRANSCRIPTION_UNAVAILABLE");
      }
      const transcript = payload.text?.trim().slice(0, 800) || "";
      if (!transcript) throw new Error("PUBLIC_AGENT_TRANSCRIPTION_FAILED");
      return { text: transcript, audio: payload.audio };
    }
    throw new Error("PUBLIC_AGENT_TRANSCRIPTION_TIMEOUT");
  }

  async function transcribeAndSend(messageId: string) {
    const audio = audioPayloadsRef.current.get(messageId);
    if (!audio || audioBusy || sending || initializing) return;
    setAudioBusy(true);
    setPageError(null);
    setMessages((current) => current.map((item) => item.id === messageId
      ? { ...item, audioState: "transcribing" }
      : item));
    try {
      const transcription = await requestTranscription(audio);
      const transcript = transcription.text;
      if (!mountedRef.current) return;
      setMessages((current) => current.map((item) => item.id === messageId
        ? {
          ...item,
          content: transcript,
          transcript,
          audioUrl: transcription.audio?.url || item.audioUrl,
          audioDuration: transcription.audio?.durationSeconds || item.audioDuration,
          audioState: "ready",
          source: "audio",
          transcriptionRequestId: audio.transcriptionRequestId,
        }
        : item));
      if (transcription.audio?.url && audio.url.startsWith("blob:")) {
        URL.revokeObjectURL(audio.url);
        objectUrlsRef.current.delete(audio.url);
      }
      analytics("AgentVoiceTranscribed", slug, { duration_seconds: audio.duration });
      await sendMessage(transcript, {
        clientMessageId: audio.messageId,
        source: "audio",
        existingUserMessageId: messageId,
        transcriptionRequestId: audio.transcriptionRequestId,
      });
    } catch (error) {
      if (!mountedRef.current) return;
      const code = error instanceof Error ? error.message : "";
      setMessages((current) => current.map((item) => item.id === messageId
        ? { ...item, audioState: "failed", deliveryState: undefined }
        : item));
      setPageError(ERROR_TEXT[code] || "Não consegui transcrever este áudio agora. Você pode tentar novamente sem regravar.");
    } finally {
      if (mountedRef.current) setAudioBusy(false);
    }
  }

  function clearRecordingTimer() {
    if (recordingIntervalRef.current !== null) {
      window.clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
  }

  function stopRecording(keepDraft = true) {
    keepRecordingRef.current = keepDraft;
    clearRecordingTimer();
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
  }

  async function startRecording() {
    if (initializing || sending || audioBusy || audioDraft || isRecording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setPageError("A gravação de áudio não está disponível neste navegador. Você pode escrever sua mensagem.");
      return;
    }
    setPageError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const supportedMime = AUDIO_MIME_CANDIDATES.find((mime) => MediaRecorder.isTypeSupported(mime));
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, supportedMime
          ? { mimeType: supportedMime, audioBitsPerSecond: 64_000 }
          : { audioBitsPerSecond: 64_000 });
      } catch {
        recorder = new MediaRecorder(stream);
      }
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      keepRecordingRef.current = true;
      recorder.ondataavailable = (event) => {
        if (event.data.size) audioChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setPageError("Houve um problema durante a gravação. Tente novamente.");
        stopRecording(false);
      };
      recorder.onstop = () => {
        clearRecordingTimer();
        stream.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        if (!mountedRef.current) return;
        setIsRecording(false);
        if (!keepRecordingRef.current) {
          audioChunksRef.current = [];
          setRecordingSeconds(0);
          return;
        }
        const duration = Math.max(1, Math.min(
          MAX_RECORDING_SECONDS,
          Math.round((nowMs() - recordingStartedAtRef.current) / 1_000),
        ));
        const mimeType = baseAudioMimeType(recorder.mimeType || audioChunksRef.current[0]?.type || "audio/webm");
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        audioChunksRef.current = [];
        setRecordingSeconds(0);
        if (!blob.size || blob.size > MAX_AUDIO_BYTES) {
          setPageError(ERROR_TEXT.PUBLIC_AGENT_AUDIO_TOO_LARGE);
          return;
        }
        const url = URL.createObjectURL(blob);
        objectUrlsRef.current.add(url);
        setAudioDraft({
          messageId: crypto.randomUUID(),
          transcriptionRequestId: crypto.randomUUID(),
          blob,
          url,
          duration,
          mimeType,
          filename: audioFilename(mimeType),
        });
      };
      recordingStartedAtRef.current = nowMs();
      setRecordingSeconds(0);
      setIsRecording(true);
      recorder.start(250);
      analytics("AgentVoiceRecordingStarted", slug);
      recordingIntervalRef.current = window.setInterval(() => {
        const elapsed = Math.floor((nowMs() - recordingStartedAtRef.current) / 1_000);
        setRecordingSeconds(Math.min(elapsed, MAX_RECORDING_SECONDS));
        if (elapsed >= MAX_RECORDING_SECONDS) stopRecording(true);
      }, 250);
    } catch (error) {
      const denied = error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name);
      setPageError(denied
        ? "Para enviar áudio, permita o acesso ao microfone nas configurações do navegador."
        : "Não consegui acessar o microfone agora. Você pode escrever sua mensagem.");
    }
  }

  function deleteAudioDraft() {
    if (!audioDraft) return;
    URL.revokeObjectURL(audioDraft.url);
    objectUrlsRef.current.delete(audioDraft.url);
    setAudioDraft(null);
  }

  function sendAudioDraft() {
    if (!audioDraft || audioBusy || sending || initializing) return;
    const payload: AudioPayload = { ...audioDraft };
    audioPayloadsRef.current.set(payload.messageId, payload);
    setMessages((current) => [
      ...current,
      {
        id: payload.messageId,
        direction: "user",
        createdAt: new Date().toISOString(),
        source: "audio",
        transcriptionRequestId: payload.transcriptionRequestId,
        kind: "audio",
        content: "Mensagem de voz",
        audioUrl: payload.url,
        audioDuration: payload.duration,
        audioState: "transcribing",
      },
    ]);
    setAudioDraft(null);
    setQuickReplies([]);
    analytics("AgentVoiceMessageSent", slug, { duration_seconds: payload.duration });
    void transcribeAndSend(payload.messageId);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const mobileInput = navigator.maxTouchPoints > 0
      || window.matchMedia("(pointer: coarse)").matches;
    if (event.key === "Enter" && !event.shiftKey && !mobileInput && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void sendMessage(input);
    }
  }

  const style = {
    "--pa-accent": theme.accent || "#2f6d4f",
    "--pa-accent-strong": theme.accentStrong || "#1f4f3a",
    "--pa-navy": theme.navy || "#173f59",
    "--pa-background": theme.background || "#f4f1e8",
  } as React.CSSProperties;

  return (
    <main id="conteudo-principal" className="public-agent-page" style={style}>
      <h1 className="public-agent-sr-only">Conversa com a {agentName}, atendimento digital da Évora Urbanismo</h1>
      <section className="public-agent-shell">
        <section className="public-agent-chat-card" aria-label={`Conversa com a ${agentName}`} aria-busy={initializing || sending || audioBusy}>
          <div className="public-agent-chat-head">
            <div className="public-agent-avatar" aria-hidden="true">
              {activeAvatarSource ? (
                <Image
                  alt=""
                  height={44}
                  priority
                  src={activeAvatarSource}
                  unoptimized
                  width={44}
                  onError={() => setFailedAvatarSources((current) => new Set(current).add(activeAvatarSource))}
                />
              ) : "B"}
            </div>
            <div>
              <strong>{agentName}</strong>
              <span>Atendimento digital · Évora Urbanismo</span>
            </div>
            {converted && <em className="public-agent-captured">Atendimento registrado</em>}
          </div>

          <div className="public-agent-messages" role="log" aria-label="Histórico da conversa" aria-live="off">
            {visibleMessages.map((message) => (
              <article key={message.id} className={`public-agent-message ${message.direction}`}>
                <div className="public-agent-message-content">
                  {message.kind === "audio" ? (
                    <AudioMessageView
                      message={message}
                      disabled={audioBusy || sending}
                      onRetry={(messageId) => void transcribeAndSend(messageId)}
                    />
                  ) : (
                    <p>{message.content}</p>
                  )}
                  {message.simulation && <SimulationView simulation={message.simulation} />}
                  {message.commercial && (
                    <CommercialUnitsView
                      commercial={message.commercial}
                      disabled={initializing || sending || audioBusy || isRecording || Boolean(audioDraft)}
                      onSimulate={(unit) => void sendMessage(`Simular condições do lote ${unit.unitCode}`)}
                    />
                  )}
                  {message.attachments?.map((attachment, index) => (
                    <AttachmentView
                      attachment={attachment}
                      key={attachment.id || `${message.id}-attachment-${index}`}
                    />
                  ))}
                  {(message.createdAt || message.deliveryState) && (
                    <footer className="public-agent-message-meta">
                      {message.createdAt && (
                        <time dateTime={message.createdAt}>{formatClock(message.createdAt)}</time>
                      )}
                      {message.direction === "user" && message.deliveryState === "sending" && <span>Enviando…</span>}
                      {message.direction === "user" && message.deliveryState === "sent" && <span aria-label="Mensagem enviada">✓</span>}
                      {message.direction === "user" && message.deliveryState === "failed" && (
                        <button
                          type="button"
                          onClick={() => retryMessage(message)}
                          disabled={sending || audioBusy}
                        >
                          Tentar novamente
                        </button>
                      )}
                    </footer>
                  )}
                </div>
              </article>
            ))}
            {sending && (
              <div className="public-agent-message assistant public-agent-typing" aria-label={`${agentName} está digitando`}>
                <span /><span /><span />
              </div>
            )}
            <div ref={endRef} />
          </div>
          <p className="public-agent-live" role="status" aria-live="polite">
            {sending
              ? `${agentName} está preparando uma resposta.`
              : messages.at(-1)?.direction === "assistant"
              ? messages.at(-1)?.content
              : ""}
          </p>

          {!initializing && quickReplies.length > 0 && (
            <div className="public-agent-quick-replies">
              {quickReplies.map((reply) => (
                <button
                  key={reply}
                  type="button"
                  onClick={() => void sendMessage(reply)}
                  disabled={sending || audioBusy || isRecording || Boolean(audioDraft)}
                >
                  {reply}
                </button>
              ))}
            </div>
          )}

          {pageError && <div className="public-agent-alert" role="alert">{pageError}</div>}

          {isRecording ? (
            <div className="public-agent-recording-composer" role="group" aria-label="Gravando mensagem de voz">
              <button
                className="public-agent-audio-action secondary"
                type="button"
                onClick={() => stopRecording(false)}
                aria-label="Descartar gravação"
              >
                <PublicAgentIcon name="trash" />
              </button>
              <div className="public-agent-recording-status">
                <span className="public-agent-recording-dot" />
                <b>{formatDuration(recordingSeconds)}</b>
                <span className="public-agent-wave" aria-hidden="true"><i /><i /><i /><i /><i /></span>
              </div>
              <button
                className="public-agent-audio-action"
                type="button"
                onClick={() => stopRecording(true)}
                aria-label="Parar gravação"
              >
                <PublicAgentIcon name="stop" />
              </button>
            </div>
          ) : audioDraft ? (
            <div className="public-agent-audio-draft" aria-label="Prévia da mensagem de voz">
              <button
                className="public-agent-audio-action secondary"
                type="button"
                onClick={deleteAudioDraft}
                aria-label="Excluir mensagem de voz"
              >
                <PublicAgentIcon name="trash" />
              </button>
              <div>
                <audio aria-label="Ouvir mensagem de voz antes de enviar" controls preload="metadata" src={audioDraft.url} />
                <span>{formatDuration(audioDraft.duration)}</span>
              </div>
              <button
                className="public-agent-audio-action"
                type="button"
                onClick={sendAudioDraft}
                disabled={audioBusy || sending}
                aria-label="Enviar mensagem de voz"
              >
                <PublicAgentIcon name="send" />
              </button>
            </div>
          ) : (
            <div className="public-agent-composer">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => {
                  setInput(event.target.value.slice(0, 800));
                  event.currentTarget.style.height = "auto";
                  event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 112)}px`;
                }}
                onKeyDown={handleKeyDown}
                placeholder={initializing ? "Iniciando atendimento..." : converted ? "Continue a conversa, se precisar" : "Mensagem"}
                disabled={initializing || audioBusy}
                aria-label={`Mensagem para a ${agentName}`}
                maxLength={800}
                rows={1}
              />
              <button
                type="button"
                onClick={() => input.trim() ? void sendMessage(input) : void startRecording()}
                disabled={initializing || sending || audioBusy}
                aria-label={input.trim() ? "Enviar mensagem" : "Gravar mensagem de voz"}
              >
                <PublicAgentIcon name={input.trim() ? "send" : "mic"} />
              </button>
            </div>
          )}
          <p className="public-agent-disclosure">
            Atendimento comercial com IA. Esta conversa e os dados enviados
            ficam registrados para atendimento, segurança e histórico
            comercial. Valores e disponibilidade são consultados na plataforma
            da Évora.{" "}
            <a
              href="mailto:relacionamento@evoraurbanismo.com.br?subject=Privacidade%20-%20Atendimento%20Vit%C3%B3ria"
            >
              Falar sobre privacidade
            </a>
            .
          </p>
        </section>
      </section>
    </main>
  );
}
