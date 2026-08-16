"use client";

import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  PublicAgentExperience,
  PublicAgentMessage,
  PublicAgentProfile,
  PublicAgentStage,
} from "@/lib/public-agent/types";

type Props = {
  slug: string;
  experience: PublicAgentExperience;
};

type ContactCapture = {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  collecting?: boolean;
};

type CommercialUnit = {
  unitCode: string;
  blockCode?: string | null;
  lotNumber?: string | null;
  area?: number | null;
  frontage?: number | null;
  depth?: number | null;
  corner?: boolean;
  topography?: string | null;
  orientation?: string | null;
  listPrice?: number | null;
  pricePerSqm?: number | null;
  updatedAt?: string | null;
};

type CommercialPayload = {
  realTime?: boolean;
  asOf?: string | null;
  summary?: Record<string, unknown>;
  units?: CommercialUnit[];
};

type SharedDocument = {
  id: string;
  title: string;
  description?: string | null;
  category?: string | null;
  mimeType?: string | null;
  bytes?: number | null;
  url?: string | null;
  updatedAt?: string | null;
};

type GeneratedAsset = {
  id: string;
  kind?: string;
  url: string;
  mimeType?: string;
  promptSummary?: string | null;
  createdAt?: string;
};

type SessionResponse = {
  ok: boolean;
  error?: string;
  stage?: PublicAgentStage;
  profile?: PublicAgentProfile;
  contactCapture?: ContactCapture;
  contactConsented?: boolean;
  converted?: boolean;
  leadProtocol?: string | null;
  messages?: PublicAgentMessage[];
};

type MessageResponse = {
  ok: boolean;
  error?: string;
  reply?: string;
  stage?: PublicAgentStage;
  profile?: PublicAgentProfile;
  contactCapture?: ContactCapture;
  contactConsented?: boolean;
  requestContact?: boolean;
  handoffRequested?: boolean;
  quickReplies?: string[];
  commercialAction?: string;
  commercial?: CommercialPayload | null;
  documents?: SharedDocument[];
  imageBrief?: string | null;
  generatedAsset?: GeneratedAsset | null;
  converted?: boolean;
  leadProtocol?: string | null;
  degraded?: boolean;
};

type LeadResponse = {
  ok: boolean;
  error?: string;
  protocol?: string;
};

type ImageResponse = {
  ok: boolean;
  error?: string;
  asset?: GeneratedAsset;
};

type UiMessage = {
  id: string;
  direction: "user" | "assistant";
  content: string;
  commercial?: CommercialPayload | null;
  documents?: SharedDocument[];
  asset?: GeneratedAsset | null;
};

type ContactStep = "name" | "phone" | "email" | "city" | "consent" | null;
type AgentMotion = "idle" | "listening" | "thinking" | "speaking";

type SpeechRecognitionEventLike = Event & {
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: Event & { error?: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type AnalyticsWindow = Window & {
  dataLayer?: Array<Record<string, unknown>>;
  fbq?: (...args: unknown[]) => void;
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

const ERROR_TEXT: Record<string, string> = {
  PUBLIC_AGENT_RATE_LIMIT: "Você enviou muitas mensagens em pouco tempo. Aguarde alguns minutos e tente novamente.",
  PUBLIC_AGENT_SESSION_INACTIVE: "Esta conversa expirou. Atualize a página para iniciar um novo atendimento.",
  PUBLIC_AGENT_PHONE_INVALID: "Informe um telefone brasileiro válido, com DDD.",
  PUBLIC_AGENT_EMAIL_INVALID: "Revise o e-mail informado.",
  PUBLIC_AGENT_IMAGE_RATE_LIMIT: "O limite de simulações visuais desta sessão foi atingido. Um especialista pode continuar com você.",
};

const DEFAULT_QUICK_REPLIES = [
  "Quero conhecer o Solaris",
  "Quero investir",
  "Quero ver lotes disponíveis",
  "Quero agendar uma visita",
];

const FEATURE_ACTIONS = [
  { icon: "⌂", label: "Empreendimentos", prompt: "Apresente os empreendimentos atuais da Évora Urbanismo e me ajude a escolher." },
  { icon: "◇", label: "Lotes disponíveis", prompt: "Quero ver lotes disponíveis, com áreas e valores atuais." },
  { icon: "▦", label: "Simular condições", prompt: "Quero simular condições de pagamento com os parâmetros comerciais vigentes." },
  { icon: "▤", label: "Documentos", prompt: "Quero acessar os documentos comerciais disponíveis." },
  { icon: "◉", label: "Agendar visita", prompt: "Quero agendar uma visita ao empreendimento." },
];

function analytics(event: string, slug: string, extra: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  const target = window as AnalyticsWindow;
  target.dataLayer?.push({ event, agent_experience: slug, ...extra });
  target.fbq?.("trackCustom", event, { agent_experience: slug, ...extra });
}

function initialGreeting(agentName: string) {
  return `Olá! Sou a ${agentName}, especialista virtual da Évora Urbanismo. Posso apresentar nossos empreendimentos, consultar opções disponíveis, simular condições e organizar sua visita. O que você procura hoje?`;
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
    .map((message) => ({
      id: String(message.id),
      direction: message.direction as "user" | "assistant",
      content: message.content,
    }));
}

function money(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(value);
}

function area(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(value)} m²`;
}

function fileSize(value?: number | null) {
  if (!value || value < 1) return "Documento";
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

function phoneMask(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 2) return digits;
  if (digits.length <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

function cleanPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  const national = digits.startsWith("55") && digits.length > 11 ? digits.slice(2) : digits;
  return /^\d{10,11}$/.test(national) ? national : null;
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim().toLowerCase());
}

function isSkip(value: string) {
  return /^(pular|prefiro não|não tenho|nao tenho|sem e-mail|sem email|agora não|agora nao)$/i.test(value.trim());
}

function isConsent(value: string) {
  return /\b(sim|autorizo|confirmo|pode registrar|pode entrar em contato|de acordo)\b/i.test(value);
}

function isRefusal(value: string) {
  return /\b(não autorizo|nao autorizo|não quero|nao quero|agora não|agora nao|prefiro não|prefiro nao)\b/i.test(value);
}

function messageId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function VitoriaImmersiveExperience({ slug, experience }: Props) {
  const theme = experience.theme || {};
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [profile, setProfile] = useState<PublicAgentProfile>({});
  const [stage, setStage] = useState<PublicAgentStage>("welcome");
  const [input, setInput] = useState("");
  const [quickReplies, setQuickReplies] = useState<string[]>(
    Array.isArray(theme.quickReplies) && theme.quickReplies.length ? theme.quickReplies : DEFAULT_QUICK_REPLIES,
  );
  const [initializing, setInitializing] = useState(true);
  const [sending, setSending] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [converted, setConverted] = useState(false);
  const [protocol, setProtocol] = useState<string | null>(null);
  const [contactCapture, setContactCapture] = useState<ContactCapture>({});
  const [contactStep, setContactStep] = useState<ContactStep>(null);
  const [contactBusy, setContactBusy] = useState(false);
  const [motion, setMotion] = useState<AgentMotion>("idle");
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(true);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [housePanelOpen, setHousePanelOpen] = useState(false);
  const [houseBrief, setHouseBrief] = useState({
    style: "Contemporânea integrada à natureza",
    bedrooms: "3 suítes",
    floors: "Térrea",
    pool: "Com piscina",
    lotArea: "450 m²",
    notes: "",
  });
  const [imageBusy, setImageBusy] = useState(false);
  const [latestAsset, setLatestAsset] = useState<GeneratedAsset | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceTranscriptRef = useRef("");
  const startedRef = useRef(false);

  const visibleMessages = useMemo(() => {
    if (messages.length) return messages;
    return [{ id: "welcome", direction: "assistant" as const, content: initialGreeting(experience.agentName) }];
  }, [messages, experience.agentName]);

  const latestAssistantMessage = useMemo(
    () => [...visibleMessages].reverse().find((message) => message.direction === "assistant"),
    [visibleMessages],
  );

  const portraitUrl = experience.heroImageUrl || "/vitoria/vitoria-portrait.webp";

  const speak = useCallback((text: string, force = false) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window) || (!autoSpeak && !force)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.replace(/[*_#`]/g, "").slice(0, 1500));
    utterance.lang = "pt-BR";
    utterance.rate = 0.98;
    utterance.pitch = 1.02;
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find((voice) => /pt-BR/i.test(voice.lang) && /female|luciana|francisca|maria|brasil/i.test(voice.name))
      || voices.find((voice) => /pt-BR/i.test(voice.lang));
    if (preferred) utterance.voice = preferred;
    utterance.onstart = () => setMotion("speaking");
    utterance.onend = () => setMotion("idle");
    utterance.onerror = () => setMotion("idle");
    window.speechSynthesis.speak(utterance);
  }, [autoSpeak]);

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
        setMessages(mapStoredMessages(payload.messages || []));
        setStage(payload.stage || "welcome");
        setProfile(payload.profile || {});
        setContactCapture(payload.contactCapture || {});
        setConverted(Boolean(payload.converted));
        setProtocol(payload.leadProtocol || null);
        if (payload.converted) setQuickReplies([]);
        if (!startedRef.current) {
          startedRef.current = true;
          analytics("AgentStarted", slug, { resumed: Boolean(payload.messages?.length) });
        }
      } catch (error) {
        if (!active) return;
        const code = error instanceof Error ? error.message : "";
        setPageError(ERROR_TEXT[code] || "Não foi possível iniciar o atendimento. Atualize a página ou tente novamente em instantes.");
      } finally {
        if (active) setInitializing(false);
      }
    }
    void start();
    return () => {
      active = false;
      recognitionRef.current?.abort();
      if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, [slug]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, sending, contactStep, latestAsset]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const target = window as AnalyticsWindow;
    setVoiceSupported(Boolean(target.SpeechRecognition || target.webkitSpeechRecognition));
  }, []);

  const appendAssistant = useCallback((content: string, extra: Partial<UiMessage> = {}) => {
    setMessages((current) => [
      ...current,
      { id: messageId("assistant"), direction: "assistant", content, ...extra },
    ]);
  }, []);

  const startContactFlow = useCallback(() => {
    if (converted || contactStep) return;
    setStage("contact");
    setContactStep(contactCapture.name ? "phone" : "name");
    appendAssistant(
      contactCapture.name
        ? `Perfeito, ${String(contactCapture.name).split(/\s+/)[0]}. Qual telefone com DDD a equipe da Évora pode usar para continuar este atendimento?`
        : "Eu mesma registro tudo aqui na conversa, sem formulário. Como posso chamar você?",
    );
    analytics("AgentContactFlowStarted", slug);
  }, [appendAssistant, contactCapture.name, contactStep, converted, slug]);

  const convertContact = useCallback(async (capture: ContactCapture) => {
    const name = capture.name?.trim() || "";
    const phone = capture.phone?.trim() || "";
    setContactBusy(true);
    setMotion("thinking");
    try {
      const response = await fetch("/api/public-agent/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          name,
          phone,
          email: capture.email || null,
          city: capture.city || null,
          marketingConsent: false,
          serviceContactConsent: true,
          profile,
          website: "",
        }),
      });
      const payload = (await response.json()) as LeadResponse;
      if (!response.ok || !payload.ok) throw new Error(payload.error || "PUBLIC_AGENT_LEAD_UNAVAILABLE");
      setConverted(true);
      setProtocol(payload.protocol || null);
      setContactStep(null);
      setQuickReplies([]);
      setStage("completed");
      const firstName = name.split(/\s+/)[0];
      const confirmation = `Pronto, ${firstName}. Seu atendimento foi registrado${payload.protocol ? ` com o protocolo ${payload.protocol}` : ""}. A equipe da Évora receberá o histórico completo para continuar sem que você precise repetir as informações.`;
      appendAssistant(confirmation);
      speak(confirmation);
      analytics("QualifiedLead", slug, { protocol: payload.protocol || null });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      appendAssistant(ERROR_TEXT[code] || "Não consegui concluir o registro agora. Podemos tentar novamente ou continuar conversando por aqui.");
      setContactStep("consent");
    } finally {
      setContactBusy(false);
      setMotion("idle");
    }
  }, [appendAssistant, profile, slug, speak]);

  const handleContactMessage = useCallback(async (message: string) => {
    if (!contactStep) return false;
    const clean = message.trim();
    setMessages((current) => [...current, { id: messageId("user"), direction: "user", content: clean }]);

    if (contactStep === "name") {
      const candidate = clean.replace(/^(meu nome é|sou o|sou a|pode me chamar de)\s+/i, "").trim();
      if (candidate.length < 2 || candidate.length > 180 || /\d{4,}/.test(candidate)) {
        appendAssistant("Não consegui identificar seu nome. Como você prefere ser chamado?");
        return true;
      }
      const next = { ...contactCapture, name: candidate, collecting: true };
      setContactCapture(next);
      setContactStep("phone");
      appendAssistant(`Prazer, ${candidate.split(/\s+/)[0]}. Qual telefone com DDD a equipe da Évora pode usar para continuar este atendimento?`);
      return true;
    }

    if (contactStep === "phone") {
      const candidate = cleanPhone(clean);
      if (!candidate) {
        appendAssistant("Revise o telefone, por favor. Informe DDD e número, como (34) 99999-9999.");
        return true;
      }
      const next = { ...contactCapture, phone: phoneMask(candidate), collecting: true };
      setContactCapture(next);
      setContactStep("email");
      appendAssistant("Deseja acrescentar um e-mail? É opcional — você também pode responder “pular”.");
      return true;
    }

    if (contactStep === "email") {
      if (!isSkip(clean) && !validEmail(clean)) {
        appendAssistant("Esse e-mail parece incompleto. Revise ou responda “pular”.");
        return true;
      }
      const next = { ...contactCapture, email: isSkip(clean) ? null : clean.toLowerCase(), collecting: true };
      setContactCapture(next);
      setContactStep("city");
      appendAssistant("Em qual cidade você mora? Essa informação também é opcional.");
      return true;
    }

    if (contactStep === "city") {
      const next = { ...contactCapture, city: isSkip(clean) ? null : clean.slice(0, 180), collecting: true };
      setContactCapture(next);
      setContactStep("consent");
      appendAssistant(`Para concluir: você autoriza a Évora Urbanismo a registrar estes dados e entrar em contato exclusivamente para continuar este atendimento?`);
      setQuickReplies(["Sim, autorizo", "Agora não"]);
      return true;
    }

    if (contactStep === "consent") {
      if (isRefusal(clean)) {
        setContactStep(null);
        setStage("discovery");
        setQuickReplies(DEFAULT_QUICK_REPLIES);
        appendAssistant("Sem problema. Seus dados não serão cadastrados. Podemos continuar conversando normalmente por aqui.");
        return true;
      }
      if (!isConsent(clean)) {
        appendAssistant("Preciso de uma confirmação explícita. Responda “Sim, autorizo” para registrar ou “Agora não” para continuar sem cadastro.");
        setQuickReplies(["Sim, autorizo", "Agora não"]);
        return true;
      }
      await convertContact(contactCapture);
      return true;
    }

    return false;
  }, [appendAssistant, contactCapture, contactStep, convertContact]);

  const sendMessage = useCallback(async (value: string) => {
    const message = value.trim();
    if (!message || sending || initializing || contactBusy) return;
    setInput("");
    setPageError(null);
    setQuickReplies([]);

    if (contactStep) {
      await handleContactMessage(message);
      return;
    }

    setMessages((current) => [...current, { id: messageId("user"), direction: "user", content: message }]);
    setSending(true);
    setMotion("thinking");
    analytics("AgentMessageSent", slug, { stage });
    try {
      const response = await fetch("/api/public-agent/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, message }),
      });
      const payload = (await response.json()) as MessageResponse;
      if (!response.ok || !payload.ok || !payload.reply) throw new Error(payload.error || "PUBLIC_AGENT_MESSAGE_UNAVAILABLE");
      const assistantMessage: UiMessage = {
        id: messageId("assistant"),
        direction: "assistant",
        content: payload.reply,
        commercial: payload.commercial || null,
        documents: payload.documents || [],
        asset: payload.generatedAsset || null,
      };
      setMessages((current) => [...current, assistantMessage]);
      setStage(payload.stage || "discovery");
      setProfile(payload.profile || profile);
      setContactCapture(payload.contactCapture || contactCapture);
      setQuickReplies(payload.quickReplies || []);
      setConverted(Boolean(payload.converted));
      if (payload.leadProtocol) setProtocol(payload.leadProtocol);
      if (payload.generatedAsset) setLatestAsset(payload.generatedAsset);
      setMotion("idle");
      speak(payload.reply);
      analytics("AgentReplyReceived", slug, {
        stage: payload.stage,
        contact_requested: Boolean(payload.requestContact),
        commercial_action: payload.commercialAction || null,
        degraded: Boolean(payload.degraded),
      });
      if ((payload.requestContact || payload.handoffRequested) && !payload.converted) {
        setQuickReplies((current) => current.length ? current : ["Continuar com um especialista", "Continuar por aqui"]);
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const fallback = ERROR_TEXT[code] || "Tive uma instabilidade ao consultar o Enterprise. Posso tentar novamente ou registrar seu contato para a equipe continuar.";
      appendAssistant(fallback);
      setQuickReplies(["Tentar novamente", "Falar com especialista"]);
      setMotion("idle");
    } finally {
      setSending(false);
      window.setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [appendAssistant, contactBusy, contactCapture, contactStep, handleContactMessage, initializing, profile, sending, slug, speak, stage]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage(input);
    }
  }

  function startVoice() {
    if (sending || initializing || contactBusy) return;
    const target = window as AnalyticsWindow;
    const Constructor = target.SpeechRecognition || target.webkitSpeechRecognition;
    if (!Constructor) {
      setVoiceSupported(false);
      setPageError("A entrada por voz não está disponível neste navegador. Você pode continuar digitando normalmente.");
      return;
    }
    if (motion === "listening") {
      recognitionRef.current?.stop();
      return;
    }
    window.speechSynthesis?.cancel();
    const recognition = new Constructor();
    recognition.lang = "pt-BR";
    recognition.continuous = false;
    recognition.interimResults = true;
    voiceTranscriptRef.current = "";
    recognition.onstart = () => {
      setMotion("listening");
      setVoiceEnabled(true);
      setPageError(null);
      analytics("AgentVoiceStarted", slug);
    };
    recognition.onresult = (event) => {
      let transcript = "";
      for (let index = 0; index < event.results.length; index += 1) transcript += event.results[index][0]?.transcript || "";
      voiceTranscriptRef.current = transcript.trim();
      setInput(transcript.trim());
    };
    recognition.onerror = (event) => {
      setMotion("idle");
      if (event.error !== "no-speech" && event.error !== "aborted") {
        setPageError("Não consegui ouvir com clareza. Tente novamente ou digite sua mensagem.");
      }
    };
    recognition.onend = () => {
      setMotion("idle");
      const transcript = voiceTranscriptRef.current.trim();
      if (transcript) void sendMessage(transcript);
    };
    recognitionRef.current = recognition;
    recognition.start();
  }

  async function generateHouseImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (imageBusy) return;
    const brief = [
      `Residência ${houseBrief.style}`,
      houseBrief.floors,
      houseBrief.bedrooms,
      houseBrief.pool,
      `para lote aproximado de ${houseBrief.lotArea}`,
      houseBrief.notes,
      "ambientação paisagística elegante, linguagem arquitetônica compatível com um empreendimento residencial de alto padrão",
    ].filter(Boolean).join(", ");
    setImageBusy(true);
    setMotion("thinking");
    setHousePanelOpen(false);
    setMessages((current) => [...current, { id: messageId("user"), direction: "user", content: `Crie uma simulação conceitual: ${brief}.` }]);
    try {
      const response = await fetch("/api/public-agent/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, brief, profile }),
      });
      const payload = (await response.json()) as ImageResponse;
      if (!response.ok || !payload.ok || !payload.asset?.url) throw new Error(payload.error || "PUBLIC_AGENT_IMAGE_UNAVAILABLE");
      setLatestAsset(payload.asset);
      const reply = "Preparei uma simulação conceitual para ajudar você a visualizar a ideia. Ela é ilustrativa e não substitui projeto arquitetônico, análise urbanística ou aprovação técnica.";
      appendAssistant(reply, { asset: payload.asset });
      speak(reply);
      analytics("AgentImageGenerated", slug);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const reply = ERROR_TEXT[code] || "A geração visual está temporariamente indisponível. Registrei o conceito na conversa e um especialista pode desenvolver essa referência com você.";
      appendAssistant(reply);
      setQuickReplies(["Tentar outra simulação", "Falar com especialista"]);
    } finally {
      setImageBusy(false);
      setMotion("idle");
    }
  }

  function actionClick(label: string, prompt: string) {
    if (label === "Simular casa") {
      setHousePanelOpen(true);
      return;
    }
    if (label === "Falar com especialista") {
      startContactFlow();
      return;
    }
    void sendMessage(prompt);
  }

  const statusText = initializing
    ? "Conectando ao Enterprise"
    : motion === "listening"
      ? "Estou ouvindo"
      : motion === "thinking"
        ? "Consultando o Enterprise"
        : motion === "speaking"
          ? "Respondendo"
          : "Online agora";

  return (
    <main className={`vitoria-page motion-${motion}`}>
      <div className="vitoria-noise" aria-hidden="true" />
      <header className="vitoria-header">
        <a href="/" className="vitoria-brand" aria-label="Évora Urbanismo">
          <img src="/evora-brand.svg" alt="Évora Urbanismo" />
        </a>
        <div className="vitoria-header-center">
          <span>ATENDIMENTO INTELIGENTE</span>
          <strong>{experience.name || "Évora Urbanismo"}</strong>
        </div>
        <div className="vitoria-header-actions">
          <button type="button" onClick={() => setHistoryExpanded((value) => !value)} aria-label="Alternar histórico">
            <span aria-hidden="true">◫</span><em>Conversa</em>
          </button>
          <button
            type="button"
            className={autoSpeak ? "active" : ""}
            onClick={() => {
              setAutoSpeak((value) => !value);
              if (autoSpeak) window.speechSynthesis?.cancel();
            }}
            aria-label="Ativar ou desativar voz da Vitória"
          >
            <span aria-hidden="true">◖</span><em>{autoSpeak ? "Voz ativa" : "Ativar voz"}</em>
          </button>
        </div>
      </header>

      <section className="vitoria-stage">
        <aside className="vitoria-visual" aria-label="Vitória, especialista virtual da Évora Urbanismo">
          <div className="vitoria-portrait-wrap">
            <img className="vitoria-portrait" src={portraitUrl} alt="Vitória, especialista virtual da Évora Urbanismo" />
            <div className="vitoria-portrait-shade" />
            <div className="vitoria-orbit orbit-one" />
            <div className="vitoria-orbit orbit-two" />
            <div className="vitoria-identity">
              <span className="vitoria-kicker">VITÓRIA</span>
              <h1>Sua especialista em <em>Évora Urbanismo.</em></h1>
              <p>Informação comercial, visão imobiliária e atendimento consultivo em uma única conversa.</p>
            </div>
            <div className="vitoria-live-status">
              <i />
              <span>{statusText}</span>
            </div>
            <button className="vitoria-voice-orb" type="button" onClick={startVoice} disabled={!voiceSupported || sending || initializing} aria-label="Falar com a Vitória">
              <span className="vitoria-orb-rings" aria-hidden="true" />
              <span className="vitoria-mic" aria-hidden="true">●</span>
            </button>
            <div className="vitoria-wave" aria-hidden="true">
              {Array.from({ length: 34 }).map((_, index) => <i key={index} style={{ "--bar": index } as React.CSSProperties} />)}
            </div>
          </div>
          <div className="vitoria-visual-actions">
            <button type="button" onClick={() => actionClick("Empreendimentos", "Apresente os empreendimentos da Évora Urbanismo.")}><span>⌂</span> Quero morar</button>
            <button type="button" onClick={() => actionClick("Investir", "Quero conhecer as melhores opções da Évora para investir.")}><span>↗</span> Quero investir</button>
            <button type="button" onClick={startContactFlow}><span>◎</span> Falar com especialista</button>
          </div>
        </aside>

        <section className={`vitoria-conversation ${historyExpanded ? "expanded" : ""}`} aria-label="Conversa com a Vitória">
          <div className="vitoria-conversation-head">
            <div>
              <span>Olá.</span>
              <h2>Como posso ajudar?</h2>
            </div>
            <div className="vitoria-badges">
              <span><i /> Base Évora conectada</span>
              <span>Dados comerciais em tempo real</span>
            </div>
          </div>

          <div className="vitoria-tools" aria-label="Atalhos de atendimento">
            {FEATURE_ACTIONS.map((action) => (
              <button key={action.label} type="button" onClick={() => actionClick(action.label, action.prompt)} disabled={sending || initializing}>
                <span aria-hidden="true">{action.icon}</span>{action.label}
              </button>
            ))}
            <button type="button" onClick={() => setHousePanelOpen(true)} disabled={sending || initializing}>
              <span aria-hidden="true">✦</span>Simular casa
            </button>
          </div>

          <div className="vitoria-chat-scroll" aria-live="polite">
            {visibleMessages.map((message) => (
              <article key={message.id} className={`vitoria-message ${message.direction}`}>
                {message.direction === "assistant" && <div className="vitoria-mini-avatar"><img src={portraitUrl} alt="" /></div>}
                <div className="vitoria-message-content">
                  <p>{message.content}</p>
                  {message.direction === "assistant" && (
                    <button className="vitoria-read-aloud" type="button" onClick={() => speak(message.content, true)} aria-label="Ouvir esta resposta">◖ Ouvir</button>
                  )}
                  {message.commercial?.units && message.commercial.units.length > 0 && (
                    <div className="vitoria-unit-grid">
                      {message.commercial.units.slice(0, 6).map((unit) => (
                        <button key={unit.unitCode} type="button" className="vitoria-unit-card" onClick={() => void sendMessage(`Quero detalhes e uma simulação para o lote ${unit.unitCode}.`)}>
                          <span className="vitoria-unit-image"><i /><b>{unit.corner ? "Esquina" : "Disponível"}</b></span>
                          <strong>{unit.unitCode}</strong>
                          <small>{area(unit.area) || "Área sob consulta"}</small>
                          <em>{money(unit.listPrice) || "Valor sob consulta"}</em>
                          <span className="vitoria-unit-link">Ver detalhes →</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {message.documents && message.documents.length > 0 && (
                    <div className="vitoria-doc-grid">
                      {message.documents.slice(0, 6).map((document) => (
                        <a key={document.id} className="vitoria-doc-card" href={document.url || "#"} target={document.url ? "_blank" : undefined} rel="noreferrer" onClick={(event) => { if (!document.url) event.preventDefault(); }}>
                          <span>PDF</span>
                          <div><strong>{document.title}</strong><small>{document.description || fileSize(document.bytes)}</small></div>
                          <b>↗</b>
                        </a>
                      ))}
                    </div>
                  )}
                  {message.asset?.url && (
                    <figure className="vitoria-generated-card">
                      <img src={message.asset.url} alt="Simulação conceitual de residência gerada por inteligência artificial" />
                      <figcaption>Simulação conceitual gerada por IA. Não constitui projeto arquitetônico ou aprovação.</figcaption>
                    </figure>
                  )}
                </div>
              </article>
            ))}
            {(sending || contactBusy || imageBusy) && (
              <article className="vitoria-message assistant">
                <div className="vitoria-mini-avatar"><img src={portraitUrl} alt="" /></div>
                <div className="vitoria-typing" aria-label="Vitória está processando"><i /><i /><i /><span>{imageBusy ? "Criando sua referência visual" : "Consultando a base Évora"}</span></div>
              </article>
            )}
            <div ref={endRef} />
          </div>

          {!initializing && quickReplies.length > 0 && !converted && (
            <div className="vitoria-quick-replies">
              {quickReplies.slice(0, 6).map((reply) => (
                <button
                  key={reply}
                  type="button"
                  onClick={() => {
                    if (/especialista/i.test(reply)) startContactFlow();
                    else void sendMessage(reply);
                  }}
                  disabled={sending || contactBusy}
                >
                  {reply}
                </button>
              ))}
            </div>
          )}

          {pageError && <div className="vitoria-alert" role="alert">{pageError}</div>}

          <div className="vitoria-composer">
            <button className={`vitoria-composer-mic ${motion === "listening" ? "active" : ""}`} type="button" onClick={startVoice} disabled={!voiceSupported || sending || initializing} aria-label="Falar com a Vitória">●</button>
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value.slice(0, 1200))}
              onKeyDown={handleKeyDown}
              placeholder={motion === "listening" ? "Estou ouvindo..." : initializing ? "Conectando ao Enterprise..." : converted ? "Continue a conversa" : "Fale ou digite sua mensagem..."}
              disabled={initializing || sending || contactBusy}
              aria-label="Mensagem para a Vitória"
            />
            <button className="vitoria-send" type="button" onClick={() => void sendMessage(input)} disabled={initializing || sending || contactBusy || !input.trim()} aria-label="Enviar mensagem">➤</button>
          </div>
          <p className="vitoria-disclosure">A Vitória é uma assistente de inteligência artificial. Condições finais são confirmadas pela equipe da Évora Urbanismo.</p>
        </section>
      </section>

      <section className="vitoria-resource-strip" aria-label="Recursos da Vitória">
        <button type="button" onClick={() => void sendMessage("Quero conhecer o Solaris Residencial e seus diferenciais.")}>
          <span className="resource-art resource-solaris" /><strong>Solaris Residencial</strong><small>Lotes a partir de 360 m²</small>
        </button>
        <button type="button" onClick={() => void sendMessage("Apresente o Parque das Árvores e sua proposta urbanística.")}>
          <span className="resource-art resource-park" /><strong>Parque das Árvores</strong><small>Bairro planejado</small>
        </button>
        <button type="button" onClick={() => setHousePanelOpen(true)}>
          <span className="resource-art resource-house" /><strong>Simulação de casa</strong><small>Visualize uma ideia com IA</small>
        </button>
        <button type="button" onClick={() => void sendMessage("Mostre os documentos comerciais disponíveis para consulta.")}>
          <span className="resource-art resource-docs" /><strong>Documentos</strong><small>Materiais aprovados</small>
        </button>
        <button type="button" onClick={startContactFlow}>
          <span className="resource-art resource-human" /><strong>Atendimento humano</strong><small>Continue com um especialista</small>
        </button>
      </section>

      <footer className="vitoria-footer">
        <span>ÉVORA URBANISMO</span>
        <p>Atendimento seguro e confidencial • LGPD • Informações comerciais sujeitas a confirmação</p>
        {protocol && <strong>Protocolo {protocol}</strong>}
      </footer>

      {housePanelOpen && (
        <div className="vitoria-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHousePanelOpen(false); }}>
          <form className="vitoria-house-panel" onSubmit={generateHouseImage}>
            <button className="vitoria-modal-close" type="button" onClick={() => setHousePanelOpen(false)} aria-label="Fechar">×</button>
            <span className="vitoria-panel-kicker">SIMULAÇÃO CONCEITUAL COM IA</span>
            <h3>Como você imagina sua casa?</h3>
            <p>Defina uma direção inicial. A imagem será uma referência visual, não um projeto arquitetônico.</p>
            <div className="vitoria-house-grid">
              <label>Estilo<input value={houseBrief.style} onChange={(event) => setHouseBrief((current) => ({ ...current, style: event.target.value.slice(0, 120) }))} /></label>
              <label>Quartos<input value={houseBrief.bedrooms} onChange={(event) => setHouseBrief((current) => ({ ...current, bedrooms: event.target.value.slice(0, 80) }))} /></label>
              <label>Pavimentos<select value={houseBrief.floors} onChange={(event) => setHouseBrief((current) => ({ ...current, floors: event.target.value }))}><option>Térrea</option><option>Dois pavimentos</option></select></label>
              <label>Área do lote<input value={houseBrief.lotArea} onChange={(event) => setHouseBrief((current) => ({ ...current, lotArea: event.target.value.slice(0, 40) }))} /></label>
              <label>Piscina<select value={houseBrief.pool} onChange={(event) => setHouseBrief((current) => ({ ...current, pool: event.target.value }))}><option>Com piscina</option><option>Sem piscina</option><option>Com spa e piscina</option></select></label>
              <label className="wide">Outras preferências<textarea value={houseBrief.notes} onChange={(event) => setHouseBrief((current) => ({ ...current, notes: event.target.value.slice(0, 500) }))} placeholder="Ex.: garagem para dois carros, madeira, grandes vãos, varanda..." /></label>
            </div>
            <button className="vitoria-generate" type="submit" disabled={imageBusy}>✦ Gerar simulação conceitual</button>
          </form>
        </div>
      )}

      <style jsx global>{`
        :root{color-scheme:dark}.vitoria-page{--gold:#d4a653;--gold-2:#f0cf88;--ink:#05090c;--panel:#0b1116;--panel-2:#10171d;--line:rgba(217,177,95,.2);--muted:#9ba4aa;--cyan:#38e6d3;position:relative;isolation:isolate;min-height:100dvh;overflow:hidden;background:radial-gradient(circle at 18% 18%,rgba(94,63,29,.22),transparent 28%),radial-gradient(circle at 92% 8%,rgba(25,66,70,.15),transparent 24%),linear-gradient(145deg,#030608 0%,#071016 48%,#020506 100%);color:#f7f3ea;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.vitoria-page *{box-sizing:border-box}.vitoria-page button,.vitoria-page input,.vitoria-page select,.vitoria-page textarea{font:inherit}.vitoria-page button{cursor:pointer}.vitoria-noise{position:fixed;z-index:-1;inset:0;opacity:.035;pointer-events:none;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.75'/%3E%3C/svg%3E")}.vitoria-header{position:relative;z-index:20;display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:30px;width:min(1500px,calc(100% - 48px));min-height:84px;margin:0 auto;border-bottom:1px solid rgba(255,255,255,.07)}.vitoria-brand{display:inline-flex;align-items:center}.vitoria-brand img{width:145px;height:auto;filter:brightness(0) invert(1) sepia(.45) saturate(1.2)}.vitoria-header-center{display:grid;gap:4px;padding-left:24px;border-left:1px solid rgba(255,255,255,.1)}.vitoria-header-center span{color:var(--gold);font-size:9px;font-weight:800;letter-spacing:.24em}.vitoria-header-center strong{font-size:13px;font-weight:600}.vitoria-header-actions{display:flex;gap:9px}.vitoria-header-actions button{display:flex;align-items:center;gap:8px;min-height:42px;padding:0 14px;border:1px solid rgba(255,255,255,.1);border-radius:14px;background:rgba(10,15,19,.8);color:#cfd5d8}.vitoria-header-actions button.active{border-color:rgba(56,230,211,.42);color:var(--cyan)}.vitoria-header-actions span{font-size:16px}.vitoria-header-actions em{font-size:11px;font-style:normal}.vitoria-stage{position:relative;z-index:1;display:grid;grid-template-columns:minmax(420px,.9fr) minmax(560px,1.1fr);gap:18px;width:min(1500px,calc(100% - 48px));min-height:calc(100dvh - 202px);margin:18px auto 0}.vitoria-visual,.vitoria-conversation{min-height:720px;border:1px solid rgba(255,255,255,.08);border-radius:28px;background:linear-gradient(145deg,rgba(16,21,25,.96),rgba(5,9,12,.94));box-shadow:0 30px 90px rgba(0,0,0,.42);overflow:hidden}.vitoria-visual{display:grid;grid-template-rows:minmax(0,1fr) auto}.vitoria-portrait-wrap{position:relative;min-height:630px;overflow:hidden;background:#090b0d}.vitoria-portrait{position:absolute;inset:-2%;width:104%;height:104%;object-fit:cover;object-position:center top;transform:scale(1.015);animation:vitoria-breathe 9s ease-in-out infinite;filter:saturate(.92) contrast(1.04)}.vitoria-portrait-shade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(2,5,7,.88) 0%,rgba(2,5,7,.34) 46%,rgba(2,5,7,.04) 70%),linear-gradient(0deg,rgba(2,5,7,.9) 0%,transparent 44%),radial-gradient(circle at 60% 38%,transparent 0%,rgba(0,0,0,.18) 70%)}.vitoria-orbit{position:absolute;border:1px solid rgba(56,230,211,.18);border-radius:50%;pointer-events:none}.orbit-one{right:-80px;bottom:120px;width:280px;height:280px;animation:vitoria-spin 24s linear infinite}.orbit-two{right:42px;bottom:214px;width:84px;height:84px;border-color:rgba(212,166,83,.28);animation:vitoria-spin 12s linear infinite reverse}.vitoria-identity{position:absolute;left:clamp(25px,4vw,56px);bottom:118px;width:min(430px,76%)}.vitoria-kicker{color:var(--gold-2);font-size:10px;font-weight:800;letter-spacing:.34em}.vitoria-identity h1{margin:13px 0 17px;font-family:Georgia,"Times New Roman",serif;font-size:clamp(35px,4.2vw,65px);font-weight:500;line-height:1.01;letter-spacing:-.035em}.vitoria-identity h1 em{display:block;color:var(--gold-2);font-style:normal}.vitoria-identity p{max-width:390px;margin:0;color:#c4cacd;font-size:14px;line-height:1.65}.vitoria-live-status{position:absolute;left:28px;top:26px;display:flex;align-items:center;gap:9px;padding:9px 13px;border:1px solid rgba(255,255,255,.12);border-radius:999px;background:rgba(4,9,12,.68);backdrop-filter:blur(12px);color:#d8dddf;font-size:11px}.vitoria-live-status i{width:7px;height:7px;border-radius:50%;background:#42d57a;box-shadow:0 0 0 4px rgba(66,213,122,.1),0 0 15px rgba(66,213,122,.65)}.vitoria-voice-orb{position:absolute;right:36px;bottom:91px;display:grid;place-items:center;width:72px;height:72px;border:1px solid rgba(56,230,211,.56);border-radius:50%;background:radial-gradient(circle,rgba(56,230,211,.22),rgba(3,10,12,.94) 65%);color:#fff;box-shadow:0 0 0 9px rgba(56,230,211,.055),0 0 34px rgba(56,230,211,.22)}.vitoria-voice-orb:disabled{opacity:.45}.vitoria-orb-rings{position:absolute;inset:-12px;border:1px solid rgba(56,230,211,.18);border-radius:50%;animation:vitoria-pulse 2.6s ease-out infinite}.vitoria-mic{position:relative;width:17px;height:26px;border:2px solid var(--cyan);border-radius:10px;background:transparent;color:transparent}.vitoria-mic:after{content:"";position:absolute;left:50%;bottom:-8px;width:18px;height:9px;transform:translateX(-50%);border:2px solid var(--cyan);border-top:0;border-radius:0 0 12px 12px}.vitoria-wave{position:absolute;right:118px;bottom:114px;display:flex;align-items:center;gap:3px;height:28px}.vitoria-wave i{display:block;width:2px;height:calc(5px + (var(--bar) % 7) * 2px);border-radius:5px;background:linear-gradient(180deg,var(--cyan),var(--gold));opacity:.65;animation:vitoria-wave 1.25s ease-in-out infinite;animation-delay:calc(var(--bar) * -35ms)}.motion-listening .vitoria-wave i,.motion-speaking .vitoria-wave i{opacity:1;animation-duration:.55s}.motion-listening .vitoria-voice-orb{box-shadow:0 0 0 13px rgba(56,230,211,.08),0 0 52px rgba(56,230,211,.5)}.motion-thinking .vitoria-orbit{border-color:rgba(212,166,83,.65)}.vitoria-visual-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:14px;border-top:1px solid rgba(255,255,255,.07);background:rgba(4,8,10,.95)}.vitoria-visual-actions button{display:flex;align-items:center;justify-content:center;gap:8px;min-height:45px;border:1px solid rgba(212,166,83,.22);border-radius:13px;background:rgba(255,255,255,.025);color:#e7e1d5;font-size:11px}.vitoria-visual-actions button:hover{border-color:var(--gold);background:rgba(212,166,83,.08)}.vitoria-visual-actions span{color:var(--gold);font-size:16px}.vitoria-conversation{display:grid;grid-template-rows:auto auto minmax(300px,1fr) auto auto auto;transition:.3s ease}.vitoria-conversation-head{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding:28px 30px 18px}.vitoria-conversation-head>div:first-child span{color:var(--gold-2);font-family:Georgia,serif;font-size:17px}.vitoria-conversation-head h2{margin:4px 0 0;font-family:Georgia,"Times New Roman",serif;font-size:clamp(35px,4vw,58px);font-weight:500;line-height:1}.vitoria-badges{display:grid;justify-items:end;gap:7px}.vitoria-badges span{display:flex;align-items:center;gap:7px;color:#aab2b6;font-size:9px}.vitoria-badges i{width:6px;height:6px;border-radius:50%;background:#43d47a}.vitoria-tools{display:flex;gap:7px;overflow-x:auto;padding:5px 28px 15px;scrollbar-width:none}.vitoria-tools::-webkit-scrollbar{display:none}.vitoria-tools button{display:flex;align-items:center;gap:8px;flex:0 0 auto;min-height:39px;padding:0 12px;border:1px solid rgba(212,166,83,.22);border-radius:999px;background:rgba(255,255,255,.025);color:#d9dde0;font-size:10px;white-space:nowrap}.vitoria-tools button:hover{border-color:var(--gold);color:#fff}.vitoria-tools span{color:var(--gold);font-size:14px}.vitoria-chat-scroll{min-height:0;overflow-y:auto;padding:14px 28px 10px;scrollbar-width:thin;scrollbar-color:rgba(212,166,83,.28) transparent}.vitoria-message{display:flex;align-items:flex-start;gap:10px;margin:0 0 16px}.vitoria-message.user{justify-content:flex-end}.vitoria-mini-avatar{width:35px;height:35px;flex:0 0 auto;overflow:hidden;border:1px solid rgba(212,166,83,.46);border-radius:50%}.vitoria-mini-avatar img{width:100%;height:100%;object-fit:cover;object-position:center top}.vitoria-message-content{max-width:min(82%,680px)}.vitoria-message-content>p{margin:0;padding:14px 16px;border:1px solid rgba(255,255,255,.08);border-radius:16px 16px 16px 4px;background:linear-gradient(145deg,rgba(28,34,38,.98),rgba(18,24,29,.98));color:#edf0f1;font-size:13px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 13px 30px rgba(0,0,0,.15)}.vitoria-message.user .vitoria-message-content>p{border-color:rgba(212,166,83,.3);border-radius:16px 16px 4px 16px;background:linear-gradient(135deg,#8d642a,#b58743);color:#fff}.vitoria-read-aloud{margin:5px 0 0 7px;padding:3px 0;border:0;background:transparent;color:#76838a;font-size:9px}.vitoria-read-aloud:hover{color:var(--cyan)}.vitoria-typing{display:flex;align-items:center;gap:6px;min-height:43px;padding:0 14px;border:1px solid rgba(255,255,255,.08);border-radius:16px 16px 16px 4px;background:#151c21;color:#8e999f}.vitoria-typing i{width:6px;height:6px;border-radius:50%;background:var(--gold);animation:vitoria-dot 1.2s ease-in-out infinite}.vitoria-typing i:nth-child(2){animation-delay:.14s}.vitoria-typing i:nth-child(3){animation-delay:.28s}.vitoria-typing span{margin-left:5px;font-size:10px}.vitoria-unit-grid{display:grid;grid-template-columns:repeat(3,minmax(150px,1fr));gap:8px;margin-top:8px}.vitoria-unit-card{display:grid;gap:4px;padding:0 0 12px;overflow:hidden;border:1px solid rgba(255,255,255,.09);border-radius:13px;background:#11181d;color:#fff;text-align:left}.vitoria-unit-image{position:relative;height:80px;background:linear-gradient(145deg,#486950,#1a332b 55%,#907044);overflow:hidden}.vitoria-unit-image:before,.vitoria-unit-image:after{content:"";position:absolute;left:-10%;right:-10%;border-radius:50%}.vitoria-unit-image:before{height:54px;bottom:-24px;background:#2e563f}.vitoria-unit-image:after{height:38px;bottom:-20px;background:#8a6c38}.vitoria-unit-image i{position:absolute;left:13px;top:13px;width:32px;height:32px;border:1px solid rgba(255,255,255,.45);border-radius:50%;background:rgba(255,255,255,.08)}.vitoria-unit-image b{position:absolute;right:8px;top:8px;padding:4px 7px;border-radius:999px;background:rgba(3,9,7,.65);color:#a5e5b7;font-size:7px;text-transform:uppercase}.vitoria-unit-card>strong,.vitoria-unit-card>small,.vitoria-unit-card>em,.vitoria-unit-link{margin:0 11px}.vitoria-unit-card>strong{margin-top:5px;color:#f1ece4;font-size:12px}.vitoria-unit-card>small{color:#8f9aa0;font-size:9px}.vitoria-unit-card>em{color:var(--gold-2);font-size:12px;font-style:normal;font-weight:750}.vitoria-unit-link{margin-top:3px;color:#b8c1c5;font-size:8px}.vitoria-doc-grid{display:grid;gap:7px;margin-top:8px}.vitoria-doc-card{display:grid;grid-template-columns:38px 1fr auto;align-items:center;gap:10px;min-height:58px;padding:8px 11px;border:1px solid rgba(255,255,255,.08);border-radius:12px;background:#10171c;color:inherit;text-decoration:none}.vitoria-doc-card>span{display:grid;place-items:center;width:35px;height:39px;border-radius:8px;background:linear-gradient(145deg,#7f3c36,#b35a4e);font-size:8px;font-weight:850}.vitoria-doc-card div{display:grid;gap:3px}.vitoria-doc-card strong{font-size:11px}.vitoria-doc-card small{color:#8c979c;font-size:8px}.vitoria-doc-card>b{color:var(--gold);font-size:15px}.vitoria-generated-card{margin:9px 0 0;overflow:hidden;border:1px solid rgba(212,166,83,.25);border-radius:16px;background:#090e11}.vitoria-generated-card img{display:block;width:100%;max-height:390px;object-fit:cover}.vitoria-generated-card figcaption{padding:9px 12px;color:#939da2;font-size:8px;line-height:1.45}.vitoria-quick-replies{display:flex;gap:7px;overflow-x:auto;padding:5px 28px 11px;scrollbar-width:none}.vitoria-quick-replies::-webkit-scrollbar{display:none}.vitoria-quick-replies button{flex:0 0 auto;min-height:34px;padding:0 12px;border:1px solid rgba(212,166,83,.3);border-radius:999px;background:transparent;color:#e6dccb;font-size:9px}.vitoria-quick-replies button:hover{background:rgba(212,166,83,.09)}.vitoria-alert{margin:0 28px 9px;padding:9px 11px;border:1px solid rgba(255,116,101,.25);border-radius:10px;background:rgba(112,31,24,.18);color:#ffb5ab;font-size:9px;line-height:1.5}.vitoria-composer{display:grid;grid-template-columns:48px minmax(0,1fr) 48px;gap:8px;margin:0 24px 12px;padding:7px;border:1px solid rgba(212,166,83,.22);border-radius:21px;background:rgba(7,12,15,.96);box-shadow:0 15px 40px rgba(0,0,0,.2)}.vitoria-composer input{height:45px;border:0;outline:0;background:transparent;color:#fff;font-size:12px}.vitoria-composer input::placeholder{color:#707b81}.vitoria-composer-mic,.vitoria-send{display:grid;place-items:center;width:45px;height:45px;border:0;border-radius:15px}.vitoria-composer-mic{position:relative;background:#171f24;color:transparent}.vitoria-composer-mic:before{content:"";width:13px;height:21px;border:2px solid var(--gold);border-radius:8px}.vitoria-composer-mic:after{content:"";position:absolute;bottom:9px;width:19px;height:9px;border:2px solid var(--gold);border-top:0;border-radius:0 0 12px 12px}.vitoria-composer-mic.active{background:rgba(56,230,211,.13);box-shadow:0 0 25px rgba(56,230,211,.3)}.vitoria-composer-mic.active:before,.vitoria-composer-mic.active:after{border-color:var(--cyan)}.vitoria-send{background:linear-gradient(145deg,var(--gold-2),#a8752f);color:#071013;font-size:17px;box-shadow:0 7px 20px rgba(212,166,83,.16)}.vitoria-composer button:disabled{opacity:.42;box-shadow:none}.vitoria-disclosure{margin:0 20px 12px;color:#657077;font-size:8px;text-align:center}.vitoria-resource-strip{position:relative;z-index:1;display:grid;grid-template-columns:repeat(5,1fr);gap:9px;width:min(1500px,calc(100% - 48px));margin:14px auto 0}.vitoria-resource-strip>button{display:grid;grid-template-columns:74px 1fr;grid-template-rows:1fr 1fr;column-gap:12px;align-items:end;min-height:90px;padding:9px;border:1px solid rgba(255,255,255,.08);border-radius:17px;background:linear-gradient(145deg,#11181d,#090e11);color:#f3eee6;text-align:left;overflow:hidden}.vitoria-resource-strip>button:hover{transform:translateY(-2px);border-color:rgba(212,166,83,.35)}.resource-art{grid-row:1/3;position:relative;display:block;width:74px;height:70px;border-radius:11px;overflow:hidden;background:linear-gradient(145deg,#48694e,#9c7540)}.resource-art:after{content:"";position:absolute;inset:0;background:linear-gradient(0deg,rgba(0,0,0,.3),transparent)}.resource-park{background:linear-gradient(145deg,#355f43,#8f9d63)}.resource-house{background:linear-gradient(145deg,#604c3f,#c8a064)}.resource-house:before{content:"⌂";position:absolute;inset:0;display:grid;place-items:center;color:#fff;font-size:37px}.resource-docs{background:linear-gradient(145deg,#26313a,#8b744d)}.resource-docs:before{content:"▤";position:absolute;inset:0;display:grid;place-items:center;color:#fff;font-size:33px}.resource-human{background:linear-gradient(145deg,#244f50,#a87d3b)}.resource-human:before{content:"◎";position:absolute;inset:0;display:grid;place-items:center;color:#fff;font-size:34px}.vitoria-resource-strip strong{align-self:end;font-size:11px}.vitoria-resource-strip small{align-self:start;color:#89949a;font-size:8px}.vitoria-footer{position:relative;z-index:1;display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:25px;width:min(1500px,calc(100% - 48px));min-height:64px;margin:14px auto 0;border-top:1px solid rgba(255,255,255,.07);color:#707c82}.vitoria-footer>span{color:var(--gold);font-family:Georgia,serif;font-size:13px;letter-spacing:.14em}.vitoria-footer p{margin:0;text-align:center;font-size:8px}.vitoria-footer strong{color:#b7c0c4;font-size:9px}.vitoria-modal-backdrop{position:fixed;z-index:100;inset:0;display:grid;place-items:center;padding:22px;background:rgba(0,0,0,.72);backdrop-filter:blur(12px)}.vitoria-house-panel{position:relative;width:min(700px,100%);max-height:calc(100dvh - 44px);overflow:auto;padding:34px;border:1px solid rgba(212,166,83,.3);border-radius:25px;background:linear-gradient(145deg,#11191f,#070b0e);box-shadow:0 40px 130px rgba(0,0,0,.65)}.vitoria-modal-close{position:absolute;right:14px;top:14px;display:grid;place-items:center;width:36px;height:36px;border:1px solid rgba(255,255,255,.1);border-radius:50%;background:#171e23;color:#fff;font-size:22px}.vitoria-panel-kicker{color:var(--gold);font-size:9px;font-weight:850;letter-spacing:.2em}.vitoria-house-panel h3{margin:9px 0 10px;font-family:Georgia,serif;font-size:37px;font-weight:500}.vitoria-house-panel>p{max-width:580px;margin:0 0 24px;color:#9da7ac;font-size:11px;line-height:1.55}.vitoria-house-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.vitoria-house-grid label{display:grid;gap:6px;color:#c8cfd2;font-size:9px}.vitoria-house-grid input,.vitoria-house-grid select,.vitoria-house-grid textarea{width:100%;border:1px solid rgba(255,255,255,.1);border-radius:11px;outline:0;background:#0b1115;color:#fff}.vitoria-house-grid input,.vitoria-house-grid select{height:44px;padding:0 11px}.vitoria-house-grid textarea{min-height:90px;padding:11px;resize:vertical}.vitoria-house-grid .wide{grid-column:1/-1}.vitoria-generate{width:100%;min-height:49px;margin-top:17px;border:0;border-radius:13px;background:linear-gradient(145deg,var(--gold-2),#9c6c29);color:#071013;font-weight:850}.vitoria-generate:disabled{opacity:.5}@keyframes vitoria-breathe{0%,100%{transform:scale(1.015) translate3d(0,0,0)}50%{transform:scale(1.045) translate3d(-.4%,.3%,0)}}@keyframes vitoria-spin{to{transform:rotate(360deg)}}@keyframes vitoria-pulse{0%{transform:scale(.84);opacity:.7}100%{transform:scale(1.4);opacity:0}}@keyframes vitoria-wave{0%,100%{transform:scaleY(.4)}50%{transform:scaleY(1.25)}}@keyframes vitoria-dot{0%,60%,100%{transform:translateY(0);opacity:.45}30%{transform:translateY(-4px);opacity:1}}@media(max-width:1180px){.vitoria-stage{grid-template-columns:minmax(360px,.78fr) minmax(500px,1.22fr)}.vitoria-resource-strip{grid-template-columns:repeat(3,1fr)}.vitoria-badges{display:none}.vitoria-unit-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:900px){.vitoria-header{width:calc(100% - 28px);min-height:70px}.vitoria-brand img{width:118px}.vitoria-header-center{display:none}.vitoria-header-actions em{display:none}.vitoria-stage{grid-template-columns:1fr;width:calc(100% - 22px);min-height:auto;margin-top:10px}.vitoria-visual{min-height:auto}.vitoria-portrait-wrap{min-height:470px}.vitoria-identity{bottom:90px}.vitoria-voice-orb{right:25px;bottom:82px;width:61px;height:61px}.vitoria-wave{right:94px;bottom:102px}.vitoria-conversation{min-height:690px}.vitoria-resource-strip{width:calc(100% - 22px);grid-template-columns:1fr 1fr}.vitoria-footer{width:calc(100% - 28px)}}@media(max-width:600px){.vitoria-page{overflow:visible}.vitoria-header{position:sticky;top:0;z-index:40;min-height:61px;background:rgba(3,7,9,.88);backdrop-filter:blur(18px)}.vitoria-brand img{width:105px}.vitoria-header-actions button{min-height:37px;padding:0 10px}.vitoria-stage{display:block}.vitoria-visual{border-radius:22px 22px 0 0;border-bottom:0}.vitoria-portrait-wrap{min-height:390px}.vitoria-portrait{object-position:56% top}.vitoria-portrait-shade{background:linear-gradient(0deg,rgba(2,5,7,.94),transparent 58%),linear-gradient(90deg,rgba(2,5,7,.62),transparent 70%)}.vitoria-identity{left:21px;bottom:74px;width:70%}.vitoria-identity h1{font-size:36px}.vitoria-identity p{display:none}.vitoria-live-status{left:17px;top:17px}.vitoria-voice-orb{right:19px;bottom:63px;width:58px;height:58px}.vitoria-wave{display:none}.vitoria-visual-actions{grid-template-columns:1fr 1fr 1fr;padding:9px}.vitoria-visual-actions button{padding:7px;font-size:8px}.vitoria-conversation{min-height:650px;border-radius:0 0 22px 22px}.vitoria-conversation-head{padding:24px 18px 14px}.vitoria-conversation-head h2{font-size:39px}.vitoria-tools{padding:4px 17px 12px}.vitoria-chat-scroll{padding:13px 15px 9px}.vitoria-message-content{max-width:88%}.vitoria-message-content>p{padding:12px 13px;font-size:12px}.vitoria-unit-grid{grid-template-columns:1fr 1fr}.vitoria-quick-replies{padding:4px 15px 10px}.vitoria-alert{margin:0 15px 8px}.vitoria-composer{position:sticky;bottom:7px;z-index:8;margin:0 10px 10px;grid-template-columns:43px 1fr 43px}.vitoria-composer-mic,.vitoria-send{width:40px;height:40px}.vitoria-resource-strip{grid-template-columns:1fr;gap:6px}.vitoria-resource-strip>button{min-height:78px}.vitoria-footer{grid-template-columns:1fr;text-align:center;padding:16px 0}.vitoria-footer p{text-align:center}.vitoria-house-panel{padding:28px 18px}.vitoria-house-panel h3{font-size:31px}.vitoria-house-grid{grid-template-columns:1fr}.vitoria-house-grid .wide{grid-column:auto}}@media(prefers-reduced-motion:reduce){.vitoria-page *{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}
      `}</style>
    </main>
  );
}
