"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  CrmConversationAttachment,
  CrmConversationHistoryResponse,
  CrmConversationMessage,
  CrmConversationSimulation,
  CrmConversationSummary,
} from "@/lib/crm/conversation-history";

import styles from "./lead-conversation-history.module.css";

type Props = {
  organizationId: string;
  crmRecordId: string;
  accessToken: string;
  leadName: string;
};

type HistoryRequest = Omit<Props, "leadName"> & {
  cursor: string | null;
  signal: AbortSignal;
};

type PendingScroll =
  | { mode: "bottom" }
  | { mode: "preserve"; scrollHeight: number; scrollTop: number };

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "long",
  year: "numeric",
});
const shortDateFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
});
const timeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const currencyFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

function timestamp(value: string | null) {
  if (!value) return "Sem mensagens";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Data indisponível";
  return `${shortDateFormatter.format(date)} · ${timeFormatter.format(date)}`;
}

function dayKey(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "data-indisponivel";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function dayLabel(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? dateFormatter.format(date)
    : "Data indisponível";
}

function channelLabel(channel: string) {
  switch (channel) {
    case "site":
      return "Site · Bia";
    case "whatsapp":
      return "WhatsApp";
    case "instagram":
      return "Instagram";
    case "facebook":
      return "Facebook";
    case "email":
      return "E-mail";
    default:
      return "Interno";
  }
}

function statusLabel(status: string) {
  switch (status) {
    case "ai_active":
      return "Bia atendendo";
    case "waiting_lead":
      return "Aguardando cliente";
    case "human_required":
      return "Requer atendimento humano";
    case "human_active":
      return "Equipe em atendimento";
    case "paused":
      return "Pausada";
    case "closed":
      return "Encerrada";
    case "shadow":
      return "Acompanhamento";
    default:
      return status.replaceAll("_", " ");
  }
}

function senderLabel(message: CrmConversationMessage) {
  if (message.actorType === "lead") return "Cliente";
  if (message.actorType === "ai") return "Bia";
  if (message.actorType === "human") return "Equipe Évora";
  return "Sistema";
}

function deliveryLabel(status: string) {
  switch (status) {
    case "read":
      return "Lida";
    case "delivered":
      return "Entregue";
    case "sent":
      return "Enviada";
    case "failed":
      return "Falhou";
    case "blocked":
      return "Bloqueada";
    case "prepared":
      return "Preparada";
    case "queued":
      return "Na fila";
    case "draft":
      return "Rascunho";
    default:
      return status;
  }
}

function sortMessages(messages: CrmConversationMessage[]) {
  return messages.slice().sort((first, second) => {
    const byDate =
      new Date(first.occurredAt).getTime() -
      new Date(second.occurredAt).getTime();
    return byDate || first.id.localeCompare(second.id);
  });
}

async function requestHistory({
  organizationId,
  crmRecordId,
  accessToken,
  cursor,
  signal,
}: HistoryRequest): Promise<CrmConversationHistoryResponse> {
  const response = await fetch("/api/crm/conversations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ organizationId, crmRecordId, cursor }),
    cache: "no-store",
    signal,
  });
  const payload = (await response.json().catch(() => null)) as
    | (CrmConversationHistoryResponse & { message?: string })
    | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.message || "Não foi possível carregar o histórico.");
  }
  return payload;
}

function requestErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Não foi possível carregar o histórico.";
}

function Attachment({ attachment }: { attachment: CrmConversationAttachment }) {
  if (attachment.url && attachment.mimeType?.startsWith("video/")) {
    return (
      <figure className={styles.mediaCard}>
        <video controls playsInline preload="metadata" src={attachment.url} />
        <figcaption>
          <strong>{attachment.title}</strong>
          {attachment.description && <small>{attachment.description}</small>}
        </figcaption>
      </figure>
    );
  }
  if (attachment.url && attachment.mimeType?.startsWith("audio/")) {
    return (
      <section className={styles.fileCard}>
        <strong>{attachment.title}</strong>
        <audio controls preload="none" src={attachment.url} />
      </section>
    );
  }
  if (attachment.type === "image" && attachment.url) {
    return (
      <a
        className={styles.imageCard}
        href={attachment.url}
        rel="noreferrer"
        target="_blank"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt={attachment.title} loading="lazy" src={attachment.url} />
        <span>
          <strong>{attachment.title}</strong>
          <small>
            {attachment.disclaimer || attachment.description || "Abrir imagem"}
          </small>
        </span>
      </a>
    );
  }
  if (attachment.type === "project" && !attachment.url) {
    return (
      <section className={styles.projectCard}>
        <small>{attachment.badge || "Empreendimento"}</small>
        <strong>{attachment.title}</strong>
        {attachment.description && <span>{attachment.description}</span>}
      </section>
    );
  }
  if (!attachment.url) return null;
  return (
    <a
      className={styles.fileCard}
      href={attachment.url}
      rel="noreferrer"
      target="_blank"
    >
      <span aria-hidden="true">↗</span>
      <span>
        <strong>{attachment.title}</strong>
        <small>
          {attachment.badge || attachment.description || "Abrir arquivo"}
        </small>
      </span>
    </a>
  );
}

function Simulation({ simulation }: { simulation: CrmConversationSimulation }) {
  return (
    <section className={styles.simulationCard}>
      <small>SIMULAÇÃO COMERCIAL</small>
      <strong>
        {simulation.unitCode || simulation.projectName || "Condição apresentada"}
      </strong>
      <div>
        {simulation.price !== null && (
          <span>
            Valor <b>{currencyFormatter.format(simulation.price)}</b>
          </span>
        )}
        {simulation.downPayment !== null && (
          <span>
            Entrada <b>{currencyFormatter.format(simulation.downPayment)}</b>
          </span>
        )}
        {simulation.scenarios.map((scenario) => (
          <span key={`${scenario.months}-${scenario.monthlyPayment}`}>
            {scenario.months} meses
            <b>{currencyFormatter.format(scenario.monthlyPayment)}/mês</b>
          </span>
        ))}
      </div>
    </section>
  );
}

function ConversationSummary({ conversation }: { conversation: CrmConversationSummary }) {
  return (
    <article className={styles.conversationCard}>
      <div>
        <strong>{channelLabel(conversation.channel)}</strong>
        <small>{statusLabel(conversation.status)}</small>
      </div>
      <time dateTime={conversation.lastMessageAt || conversation.startedAt}>
        {timestamp(conversation.lastMessageAt || conversation.startedAt)}
      </time>
    </article>
  );
}

export function LeadConversationHistory({
  organizationId,
  crmRecordId,
  accessToken,
  leadName,
}: Props) {
  const [opened, setOpened] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialError, setInitialError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [loadMoreError, setLoadMoreError] = useState("");
  const [conversations, setConversations] = useState<CrmConversationSummary[]>([]);
  const [messages, setMessages] = useState<CrmConversationMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const refreshRequestRef = useRef(0);
  const loadMoreRequestRef = useRef(0);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollRef = useRef<PendingScroll | null>(null);

  const loadInitial = useCallback(
    async (refresh = false) => {
      if (!accessToken) {
        const message = "Sua sessão precisa ser renovada para abrir o histórico.";
        if (refresh || loaded) setRefreshError(message);
        else setInitialError(message);
        return;
      }
      const requestId = refreshRequestRef.current + 1;
      refreshRequestRef.current = requestId;
      refreshControllerRef.current?.abort();
      loadMoreRequestRef.current += 1;
      loadMoreControllerRef.current?.abort();
      loadMoreControllerRef.current = null;
      const controller = new AbortController();
      refreshControllerRef.current = controller;
      if (refresh || loaded) setRefreshing(true);
      else setLoading(true);
      setInitialError("");
      setRefreshError("");
      setLoadMoreError("");
      setLoadingMore(false);

      try {
        const payload = await requestHistory({
          organizationId,
          crmRecordId,
          accessToken,
          cursor: null,
          signal: controller.signal,
        });
        if (requestId !== refreshRequestRef.current) return;
        pendingScrollRef.current = { mode: "bottom" };
        setConversations(payload.conversations);
        setMessages(sortMessages(payload.messages));
        setHasMore(payload.pagination.hasMore);
        setNextCursor(payload.pagination.nextCursor);
        setLoaded(true);
      } catch (requestError) {
        if (requestError instanceof Error && requestError.name === "AbortError") {
          return;
        }
        if (requestId !== refreshRequestRef.current) return;
        const message = requestErrorMessage(requestError);
        if (refresh || loaded) setRefreshError(message);
        else setInitialError(message);
      } finally {
        if (requestId === refreshRequestRef.current) {
          refreshControllerRef.current = null;
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [accessToken, crmRecordId, loaded, organizationId],
  );

  const loadMore = useCallback(async () => {
    if (
      !nextCursor ||
      loadingMore ||
      refreshing ||
      loadMoreControllerRef.current
    ) {
      return;
    }
    if (!accessToken) {
      setLoadMoreError("Sua sessão precisa ser renovada para continuar.");
      return;
    }

    const requestId = loadMoreRequestRef.current + 1;
    loadMoreRequestRef.current = requestId;
    const controller = new AbortController();
    loadMoreControllerRef.current = controller;
    setLoadingMore(true);
    setLoadMoreError("");

    const timeline = timelineRef.current;
    const pendingScroll: PendingScroll | null = timeline
      ? {
          mode: "preserve",
          scrollHeight: timeline.scrollHeight,
          scrollTop: timeline.scrollTop,
        }
      : null;

    try {
      const payload = await requestHistory({
        organizationId,
        crmRecordId,
        accessToken,
        cursor: nextCursor,
        signal: controller.signal,
      });
      if (requestId !== loadMoreRequestRef.current) return;
      pendingScrollRef.current = pendingScroll;
      setConversations(payload.conversations);
      setMessages((current) => {
        const merged = new Map(current.map((message) => [message.id, message]));
        for (const message of payload.messages) merged.set(message.id, message);
        return sortMessages([...merged.values()]);
      });
      setHasMore(payload.pagination.hasMore);
      setNextCursor(payload.pagination.nextCursor);
    } catch (requestError) {
      if (requestError instanceof Error && requestError.name === "AbortError") {
        return;
      }
      if (requestId === loadMoreRequestRef.current) {
        setLoadMoreError(requestErrorMessage(requestError));
      }
    } finally {
      if (requestId === loadMoreRequestRef.current) {
        loadMoreControllerRef.current = null;
        setLoadingMore(false);
      }
    }
  }, [
    accessToken,
    crmRecordId,
    loadingMore,
    nextCursor,
    organizationId,
    refreshing,
  ]);

  useEffect(
    () => () => {
      refreshRequestRef.current += 1;
      loadMoreRequestRef.current += 1;
      refreshControllerRef.current?.abort();
      loadMoreControllerRef.current?.abort();
    },
    [],
  );

  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    const timeline = timelineRef.current;
    if (!pending || !timeline) return;
    if (pending.mode === "bottom") {
      timeline.scrollTop = timeline.scrollHeight;
    } else {
      timeline.scrollTop =
        pending.scrollTop + timeline.scrollHeight - pending.scrollHeight;
    }
    pendingScrollRef.current = null;
  }, [messages]);

  const conversationById = useMemo(
    () => new Map(conversations.map((item) => [item.id, item])),
    [conversations],
  );

  return (
    <section className={styles.section}>
      <details
        open={opened}
        onToggle={(event) => {
          const isOpen = event.currentTarget.open;
          setOpened(isOpen);
          if (isOpen && !loaded && !loading) void loadInitial();
        }}
      >
        <summary>
          <span>
            <small>ATENDIMENTO E AUDITORIA</small>
            <strong>Histórico completo de conversas</strong>
          </span>
          <span className={styles.summaryMeta}>
            {loaded
              ? `${messages.length}${hasMore ? "+" : ""} ${
                  messages.length === 1 && !hasMore ? "mensagem" : "mensagens"
                }`
              : "Abrir"}
          </span>
        </summary>

        <div className={styles.content} aria-live="polite">
          <header className={styles.header}>
            <div>
              <strong>{leadName}</strong>
              <p>
                Conversas registradas no CRM, em ordem cronológica, incluindo
                Bia e atendimento humano.
              </p>
            </div>
            {loaded && (
              <button
                type="button"
                onClick={() => void loadInitial(true)}
                disabled={refreshing || loadingMore}
              >
                {refreshing ? "Atualizando…" : "Atualizar"}
              </button>
            )}
          </header>

          {loading && (
            <div className={styles.loading} role="status">
              <i />
              <span>Carregando conversas…</span>
            </div>
          )}

          {!loading && !loaded && initialError && (
            <div className={styles.error} role="alert">
              <strong>Não foi possível abrir o histórico</strong>
              <span>{initialError}</span>
              <button type="button" onClick={() => void loadInitial()}>
                Tentar novamente
              </button>
            </div>
          )}

          {loaded && refreshError && (
            <div className={styles.inlineError} role="alert">
              <span>Não foi possível atualizar: {refreshError}</span>
              <button type="button" onClick={() => void loadInitial(true)}>
                Tentar novamente
              </button>
            </div>
          )}

          {!loading && loaded && conversations.length === 0 && (
            <div className={styles.empty}>
              <strong>Nenhuma conversa vinculada a este lead</strong>
              <span>
                Quando um atendimento da Bia ou de outro canal for associado a
                este cadastro, as mensagens aparecerão aqui.
              </span>
            </div>
          )}

          {!loading && conversations.length > 0 && (
            <>
              <div className={styles.conversationGrid}>
                {conversations.map((conversation) => (
                  <ConversationSummary
                    conversation={conversation}
                    key={conversation.id}
                  />
                ))}
              </div>

              <div
                aria-label="Linha do tempo das conversas"
                className={styles.timeline}
                ref={timelineRef}
                tabIndex={0}
              >
                {loadMoreError && (
                  <div className={styles.inlineError} role="alert">
                    <span>
                      Não foi possível carregar as mensagens anteriores: {loadMoreError}
                    </span>
                    <button type="button" onClick={() => void loadMore()}>
                      Tentar novamente
                    </button>
                  </div>
                )}

                {hasMore && (
                  <button
                    className={styles.loadMore}
                    type="button"
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                  >
                    {loadingMore
                      ? "Carregando mensagens anteriores…"
                      : "Carregar mensagens anteriores"}
                  </button>
                )}

                {messages.map((message, index) => {
                  const prior = index > 0 ? messages[index - 1] : null;
                  const showDay =
                    !prior || dayKey(prior.occurredAt) !== dayKey(message.occurredAt);
                  const conversation = conversationById.get(message.conversationId);
                  return (
                    <Fragment key={message.id}>
                      {showDay && (
                        <div className={styles.dayDivider}>
                          <span>{dayLabel(message.occurredAt)}</span>
                        </div>
                      )}
                      <article
                        className={`${styles.message} ${
                          message.direction === "inbound"
                            ? styles.inbound
                            : message.direction === "outbound"
                              ? styles.outbound
                              : styles.internal
                        }`}
                      >
                        <header>
                          <strong>{senderLabel(message)}</strong>
                          <span>{channelLabel(conversation?.channel || message.channel)}</span>
                        </header>
                        <p>{message.content}</p>

                        {message.audio && (
                          <section className={styles.audio}>
                            <span aria-hidden="true">◉</span>
                            <audio
                              aria-label={`Mensagem de voz de ${senderLabel(message)}`}
                              controls
                              preload="none"
                              src={message.audio.url}
                            />
                            {message.audio.durationSeconds !== null && (
                              <small>{Math.ceil(message.audio.durationSeconds)} s</small>
                            )}
                          </section>
                        )}

                        {message.simulation && (
                          <Simulation simulation={message.simulation} />
                        )}

                        {message.attachments.length > 0 && (
                          <div className={styles.attachments}>
                            {message.attachments.map((attachment, attachmentIndex) => (
                              <Attachment
                                attachment={attachment}
                                key={
                                  attachment.id ||
                                  `${message.id}-attachment-${attachmentIndex}`
                                }
                              />
                            ))}
                          </div>
                        )}

                        <footer>
                          <time dateTime={message.occurredAt}>
                            {timeFormatter.format(new Date(message.occurredAt))}
                          </time>
                          {message.direction !== "inbound" && (
                            <span>{deliveryLabel(message.deliveryStatus)}</span>
                          )}
                        </footer>
                      </article>
                    </Fragment>
                  );
                })}

                {messages.length === 0 && (
                  <div className={styles.empty}>
                    <strong>Canal criado, ainda sem mensagens</strong>
                    <span>O histórico será atualizado após a primeira interação.</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </details>
    </section>
  );
}
