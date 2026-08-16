"use client";

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

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

type SessionResponse = {
  ok: boolean;
  error?: string;
  stage?: PublicAgentStage;
  profile?: PublicAgentProfile;
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
  requestContact?: boolean;
  handoffRequested?: boolean;
  quickReplies?: string[];
  converted?: boolean;
  degraded?: boolean;
};

type LeadResponse = {
  ok: boolean;
  error?: string;
  protocol?: string;
};

type UiMessage = {
  id: string;
  direction: "user" | "assistant";
  content: string;
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
};

function analytics(event: string, slug: string, extra: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  const target = window as AnalyticsWindow;
  target.dataLayer?.push({ event, agent_experience: slug, ...extra });
  target.fbq?.("trackCustom", event, { agent_experience: slug, ...extra });
}

function initialGreeting(agentName: string) {
  return `Olá, sou a ${agentName}, assistente virtual da Évora Urbanismo. Posso te ajudar a conhecer o Solaris e encontrar uma opção adequada para morar ou investir. O que você procura?`;
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

function phoneMask(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 2) return digits;
  if (digits.length <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
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
  const [contactOpen, setContactOpen] = useState(false);
  const [converted, setConverted] = useState(false);
  const [protocol, setProtocol] = useState<string | null>(null);
  const [leadBusy, setLeadBusy] = useState(false);
  const [leadError, setLeadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const startedRef = useRef(false);

  const visibleMessages = useMemo(() => {
    if (messages.length) return messages;
    return [{ id: "welcome", direction: "assistant" as const, content: initialGreeting(experience.agentName) }];
  }, [messages, experience.agentName]);

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
        setConverted(Boolean(payload.converted));
        setProtocol(payload.leadProtocol || null);
        if (payload.converted) setQuickReplies([]);
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
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, sending, contactOpen]);

  async function sendMessage(value: string) {
    const message = value.trim();
    if (!message || sending || initializing) return;
    setInput("");
    setPageError(null);
    setQuickReplies([]);
    setMessages((current) => [
      ...current,
      { id: `user-${Date.now()}`, direction: "user", content: message },
    ]);
    setSending(true);
    analytics("AgentMessageSent", slug, { stage });
    try {
      const response = await fetch("/api/public-agent/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, message }),
      });
      const payload = (await response.json()) as MessageResponse;
      if (!response.ok || !payload.ok || !payload.reply) {
        throw new Error(payload.error || "PUBLIC_AGENT_MESSAGE_UNAVAILABLE");
      }
      setMessages((current) => [
        ...current,
        { id: `assistant-${Date.now()}`, direction: "assistant", content: payload.reply || "" },
      ]);
      setStage(payload.stage || "discovery");
      setProfile(payload.profile || {});
      setQuickReplies(payload.quickReplies || []);
      setConverted(Boolean(payload.converted));
      if (payload.requestContact || payload.handoffRequested) setContactOpen(true);
      analytics("AgentReplyReceived", slug, {
        stage: payload.stage,
        contact_requested: Boolean(payload.requestContact),
        degraded: Boolean(payload.degraded),
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setMessages((current) => [
        ...current,
        {
          id: `assistant-error-${Date.now()}`,
          direction: "assistant",
          content: ERROR_TEXT[code] || "Tive uma instabilidade neste momento. Posso registrar seu contato para a equipe continuar o atendimento?",
        },
      ]);
      if (!ERROR_TEXT[code]) setContactOpen(true);
    } finally {
      setSending(false);
      window.setTimeout(() => inputRef.current?.focus(), 100);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage(input);
    }
  }

  async function submitLead(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (leadBusy) return;
    setLeadError(null);
    setLeadBusy(true);
    try {
      const response = await fetch("/api/public-agent/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          name,
          phone,
          email,
          city,
          marketingConsent: consent,
          profile,
          website,
        }),
      });
      const payload = (await response.json()) as LeadResponse;
      if (!response.ok || !payload.ok) throw new Error(payload.error || "PUBLIC_AGENT_LEAD_UNAVAILABLE");
      const leadProtocol = payload.protocol || null;
      setConverted(true);
      setProtocol(leadProtocol);
      setContactOpen(false);
      setQuickReplies([]);
      setStage("completed");
      setMessages((current) => [
        ...current,
        {
          id: `assistant-success-${Date.now()}`,
          direction: "assistant",
          content: `Pronto, ${name.trim().split(/\s+/)[0]}. Seu atendimento foi registrado${leadProtocol ? ` com o protocolo ${leadProtocol}` : ""}. Um especialista da Évora dará continuidade com todo o contexto da nossa conversa.`,
        },
      ]);
      analytics("QualifiedLead", slug, { protocol: leadProtocol });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setLeadError(ERROR_TEXT[code] || "Não foi possível registrar agora. Revise os dados e tente novamente.");
    } finally {
      setLeadBusy(false);
    }
  }

  const style = {
    "--pa-accent": theme.accent || "#2f6d4f",
    "--pa-accent-strong": theme.accentStrong || "#1f4f3a",
    "--pa-navy": theme.navy || "#173f59",
    "--pa-background": theme.background || "#f4f1e8",
  } as React.CSSProperties;

  return (
    <main className="public-agent-page" style={style}>
      <div className="public-agent-ambient public-agent-ambient-one" />
      <div className="public-agent-ambient public-agent-ambient-two" />
      <header className="public-agent-header">
        <a className="public-agent-brand" href="/atendimento/solaris" aria-label="Évora Urbanismo">
          <img src="/evora-brand.svg" alt="Évora Urbanismo" />
        </a>
        <div className="public-agent-header-project">
          <span>{experience.name}</span>
          <b>Atendimento inteligente</b>
        </div>
      </header>

      <section className="public-agent-shell">
        <aside className="public-agent-story" aria-label="Apresentação do Solaris">
          <span className="public-agent-eyebrow">{experience.eyebrow}</span>
          <h1>{experience.title}</h1>
          <p>{experience.subtitle}</p>
          <div className="public-agent-landscape" aria-hidden="true">
            <span className="public-agent-sun" />
            <span className="public-agent-hill public-agent-hill-back" />
            <span className="public-agent-hill public-agent-hill-front" />
            <span className="public-agent-water" />
          </div>
          <div className="public-agent-trust-grid">
            {(theme.trustItems || []).map((item) => (
              <div key={item} className="public-agent-trust-item">
                <span>✓</span>
                <p>{item}</p>
              </div>
            ))}
          </div>
          <button className="public-agent-human-link" type="button" onClick={() => setContactOpen(true)}>
            Prefere falar com uma pessoa? <strong>Solicitar especialista</strong>
          </button>
        </aside>

        <section className="public-agent-chat-card" aria-label="Conversa com a Vitória">
          <div className="public-agent-chat-head">
            <div className="public-agent-avatar" aria-hidden="true">V</div>
            <div>
              <strong>{experience.agentName}</strong>
              <span><i /> Assistente virtual da Évora</span>
            </div>
            {converted && <em className="public-agent-captured">Atendimento registrado</em>}
          </div>

          <div className="public-agent-messages" aria-live="polite">
            {visibleMessages.map((message) => (
              <div key={message.id} className={`public-agent-message ${message.direction}`}>
                <p>{message.content}</p>
              </div>
            ))}
            {sending && (
              <div className="public-agent-message assistant public-agent-typing" aria-label="Vitória está digitando">
                <span /><span /><span />
              </div>
            )}
            <div ref={endRef} />
          </div>

          {!initializing && quickReplies.length > 0 && !converted && (
            <div className="public-agent-quick-replies">
              {quickReplies.map((reply) => (
                <button key={reply} type="button" onClick={() => void sendMessage(reply)} disabled={sending}>
                  {reply}
                </button>
              ))}
            </div>
          )}

          {pageError && <div className="public-agent-alert" role="alert">{pageError}</div>}

          <div className="public-agent-composer">
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value.slice(0, 800))}
              onKeyDown={handleKeyDown}
              placeholder={initializing ? "Iniciando atendimento..." : converted ? "Continue a conversa, se precisar" : "Escreva sua mensagem"}
              disabled={initializing || sending}
              aria-label="Mensagem para a Vitória"
            />
            <button
              type="button"
              onClick={() => void sendMessage(input)}
              disabled={initializing || sending || !input.trim()}
              aria-label="Enviar mensagem"
            >
              <span>➜</span>
            </button>
          </div>
          <p className="public-agent-disclosure">
            A Vitória é uma assistente virtual. Informações comerciais finais são confirmadas pela equipe da Évora.
          </p>
        </section>
      </section>

      <footer className="public-agent-footer">
        <span>Évora Urbanismo</span>
        <p>{theme.privacyNotice || "Seus dados são usados somente para este atendimento e para o contato solicitado."}</p>
      </footer>

      {contactOpen && !converted && (
        <div className="public-agent-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setContactOpen(false);
        }}>
          <section className="public-agent-contact-card" role="dialog" aria-modal="true" aria-labelledby="public-agent-contact-title">
            <button className="public-agent-modal-close" type="button" onClick={() => setContactOpen(false)} aria-label="Fechar">×</button>
            <span className="public-agent-contact-kicker">Continuidade sem repetir informações</span>
            <h2 id="public-agent-contact-title">Um especialista recebe todo o contexto da conversa.</h2>
            <p>Informe apenas os dados necessários para a equipe continuar o atendimento.</p>
            <form onSubmit={submitLead}>
              <label>
                Nome
                <input value={name} onChange={(event) => setName(event.target.value.slice(0, 180))} required autoComplete="name" />
              </label>
              <div className="public-agent-form-grid">
                <label>
                  Telefone com DDD
                  <input value={phone} onChange={(event) => setPhone(phoneMask(event.target.value))} required inputMode="tel" autoComplete="tel" placeholder="(34) 99999-9999" />
                </label>
                <label>
                  Cidade
                  <input value={city} onChange={(event) => setCity(event.target.value.slice(0, 180))} autoComplete="address-level2" />
                </label>
              </div>
              <label>
                E-mail <small>opcional</small>
                <input value={email} onChange={(event) => setEmail(event.target.value.slice(0, 320))} type="email" autoComplete="email" />
              </label>
              <label className="public-agent-honeypot" aria-hidden="true">
                Site
                <input value={website} onChange={(event) => setWebsite(event.target.value)} tabIndex={-1} autoComplete="off" />
              </label>
              <label className="public-agent-consent">
                <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} required />
                <span>Autorizo a Évora Urbanismo a entrar em contato sobre o Solaris pelos dados informados. Posso retirar esta autorização a qualquer momento.</span>
              </label>
              {leadError && <div className="public-agent-alert" role="alert">{leadError}</div>}
              <button className="public-agent-submit" type="submit" disabled={leadBusy || !consent}>
                {leadBusy ? "Registrando atendimento..." : "Continuar com um especialista"}
              </button>
            </form>
          </section>
        </div>
      )}

      {converted && protocol && (
        <div className="public-agent-protocol" title="Protocolo do atendimento">
          Protocolo <strong>{protocol}</strong>
        </div>
      )}
    </main>
  );
}
