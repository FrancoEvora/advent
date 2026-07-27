"use client";

import Image from "next/image";
import {
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getSupabase } from "@/lib/supabase";
import type {
  PartnerKind,
  PartnerNegotiation,
  PartnerNegotiationStatus,
  PartnerNegotiationTerms,
  PartnerNegotiationType,
  PartnerPayment,
  PartnerPaymentPortalPayload,
  PartnerPaymentStatus,
} from "./partner-types";

const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const shortDate = new Intl.DateTimeFormat("pt-BR");
const dateTime = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
});

const paymentStatus: Record<
  PartnerPaymentStatus,
  { label: string; detail: string; tone: string; step: number }
> = {
  em_analise: {
    label: "Em análise",
    detail: "Informações sendo conferidas pela equipe responsável.",
    tone: "analysis",
    step: 0,
  },
  previsto: {
    label: "Previsto",
    detail:
      "Janela estimada para orientação. Ainda não existe uma data efetivamente programada.",
    tone: "forecast",
    step: 1,
  },
  programado: {
    label: "Programado",
    detail:
      "Data registrada na programação atual. O pagamento somente estará concluído após a confirmação da liquidação.",
    tone: "scheduled",
    step: 2,
  },
  em_processamento: {
    label: "Em processamento",
    detail:
      "O processamento foi iniciado. A conclusão depende da confirmação da liquidação.",
    tone: "processing",
    step: 3,
  },
  pago: {
    label: "Pago",
    detail: "Liquidação confirmada pela Évora Urbanismo.",
    tone: "paid",
    step: 4,
  },
  suspenso: {
    label: "Suspenso",
    detail: "A programação está temporariamente suspensa para conferência.",
    tone: "suspended",
    step: 0,
  },
};

const negotiationTypeLabels: Record<PartnerNegotiationType, string> = {
  prorrogacao: "Alteração de vencimento",
  parcelamento: "Parcelamento",
  antecipacao_desconto: "Antecipação com desconto",
  compensacao: "Compensação",
  contestacao: "Contestação",
  outro: "Outra negociação",
};

const negotiationStatusLabels: Record<PartnerNegotiationStatus, string> = {
  aberta: "Aberta",
  em_analise: "Em análise",
  contraproposta: "Contraproposta recebida",
  aguardando_parceiro: "Aguardando sua resposta",
  aceita_pelo_parceiro: "Resposta enviada",
  aprovada: "Aprovada",
  rejeitada: "Não aprovada",
  cancelada: "Cancelada",
  encerrada: "Encerrada",
};

const partnerKindLabels: Record<PartnerKind, string> = {
  fornecedor: "Fornecedor",
  credor_financeiro: "Credor financeiro",
  terrenista: "Terrenista",
  parceiro: "Parceiro",
};

const closedNegotiationStatuses = new Set<PartnerNegotiationStatus>([
  "aprovada",
  "rejeitada",
  "cancelada",
  "encerrada",
]);

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const day = value.slice(0, 10);
  const parsed = new Date(`${day}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? "—" : shortDate.format(parsed);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : dateTime.format(parsed);
}

function optionalNumber(value: FormDataEntryValue | null) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function scheduledPaymentDate(payment: PartnerPayment) {
  if (
    !["programado", "em_processamento", "pago"].includes(
      payment.public_status,
    )
  ) {
    return null;
  }
  return payment.scheduled_payment_date || payment.scheduled_date || null;
}

function confirmedPaymentDate(payment: PartnerPayment) {
  if (payment.public_status !== "pago") return null;
  return payment.paid_on || payment.paid_at || null;
}

function processingStartedDate(payment: PartnerPayment) {
  if (!["em_processamento", "pago"].includes(payment.public_status)) {
    return null;
  }
  return payment.processing_started_at || null;
}

function paymentForecast(payment: PartnerPayment) {
  if (!payment.forecast_start && !payment.forecast_end) return null;
  if (payment.forecast_start === payment.forecast_end) {
    return formatDate(payment.forecast_start);
  }
  return `${formatDate(payment.forecast_start)} a ${formatDate(payment.forecast_end)}`;
}

function paymentExecutionSummary(
  payment: PartnerPayment,
  scheduledDate: string | null,
  processingDate: string | null,
  paidDate: string | null,
) {
  switch (payment.public_status) {
    case "pago":
      return {
        label: "PAGAMENTO CONCLUÍDO",
        value: paidDate ? formatDate(paidDate) : "Liquidação confirmada",
        detail: "A conclusão do pagamento foi confirmada pela Évora.",
      };
    case "em_processamento":
      return {
        label: "PROCESSAMENTO INICIADO",
        value: processingDate
          ? formatDateTime(processingDate)
          : "Em processamento",
        detail: scheduledDate
          ? `Programado para ${formatDate(scheduledDate)}. A liquidação ainda não foi confirmada.`
          : "A ordem foi iniciada, mas a liquidação ainda não foi confirmada.",
      };
    case "programado":
      return {
        label: "PROGRAMAÇÃO EFETIVA REGISTRADA",
        value: scheduledDate ? formatDate(scheduledDate) : "Data não publicada",
        detail:
          "Esta é a data atualmente definida para encaminhamento. Ela não representa confirmação de pagamento.",
      };
    case "suspenso":
      return {
        label: "PROGRAMAÇÃO SUSPENSA",
        value: "Sem data ativa",
        detail:
          "A programação anterior não deve ser considerada enquanto a conferência estiver em andamento.",
      };
    default:
      return {
        label: "SEM PROGRAMAÇÃO EFETIVA",
        value: "Aguardando definição de data",
        detail:
          payment.public_status === "previsto"
            ? "A previsão abaixo é apenas informativa e não representa uma programação."
            : "Nenhuma data efetiva de pagamento foi publicada.",
      };
  }
}

async function requestPortal(
  token: string,
  documentLast4: string,
): Promise<PartnerPaymentPortalPayload> {
  const client = getSupabase();
  if (!client) throw new Error("O portal está temporariamente indisponível.");
  const result = await client.rpc("get_partner_payment_portal", {
    p_token: token,
    p_document_last4: documentLast4,
  });
  if (result.error || !result.data) {
    throw new Error(
      result.error?.message.includes("Credenciais")
        ? "Não foi possível validar os dados informados. Confira os quatro dígitos e tente novamente."
        : "Não foi possível abrir este acesso agora.",
    );
  }
  const payload = result.data as unknown as PartnerPaymentPortalPayload;
  if (
    !payload ||
    typeof payload !== "object" ||
    !payload.organization ||
    !payload.partner ||
    !payload.access ||
    !payload.policy
  ) {
    throw new Error("Não foi possível abrir este acesso agora.");
  }
  return {
    ...payload,
    payments: Array.isArray(payload.payments) ? payload.payments : [],
    negotiations: Array.isArray(payload.negotiations)
      ? payload.negotiations
      : [],
  };
}

export function PartnerPaymentPortal() {
  const [token, setToken] = useState("");
  const [tokenRead, setTokenRead] = useState(false);
  const [accessClosed, setAccessClosed] = useState(false);
  const tokenRef = useRef("");
  const normalizedToken = token.trim().toLowerCase();
  const tokenIsValid = /^[a-f0-9]{64}$/.test(normalizedToken);
  const [documentLast4, setDocumentLast4] = useState("");
  const [verifiedDocumentLast4, setVerifiedDocumentLast4] = useState("");
  const [portal, setPortal] = useState<PartnerPaymentPortalPayload | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [negotiationOpen, setNegotiationOpen] = useState(false);
  const [selectedPaymentId, setSelectedPaymentId] = useState("");
  const [selectedNegotiationId, setSelectedNegotiationId] = useState("");
  const [messageBusyId, setMessageBusyId] = useState("");

  useEffect(() => {
    function readTokenFromFragment() {
      const fragment = window.location.hash.startsWith("#")
        ? window.location.hash.slice(1)
        : window.location.hash;
      const nextToken = new URLSearchParams(fragment)
        .get("acesso")
        ?.trim()
        .toLowerCase();
      const normalizedFragmentToken = nextToken || "";
      tokenRef.current = normalizedFragmentToken;
      setToken(normalizedFragmentToken);
      setTokenRead(true);
      setAccessClosed(false);
      setPortal(null);
      setVerifiedDocumentLast4("");
      setDocumentLast4("");
      setSelectedNegotiationId("");
      setSelectedPaymentId("");
      setNegotiationOpen(false);
      setError("");
      setFeedback("");
    }

    readTokenFromFragment();
    window.addEventListener("hashchange", readTokenFromFragment);
    return () =>
      window.removeEventListener("hashchange", readTokenFromFragment);
  }, []);

  const summary = useMemo(() => {
    const payments = portal?.payments || [];
    const actionable = payments.filter(
      payment =>
        payment.public_status !== "pago" &&
        payment.public_status !== "suspenso",
    );
    const scheduled = actionable
      .map(payment => ({
        payment,
        date: scheduledPaymentDate(payment),
      }))
      .filter(
        (
          item,
        ): item is {
          payment: PartnerPayment;
          date: string;
        } => Boolean(item.date),
      )
      .sort((a, b) => a.date.localeCompare(b.date));
    const activeNegotiations = (portal?.negotiations || []).filter(
      negotiation => !closedNegotiationStatuses.has(negotiation.status),
    );
    return {
      publishedAmount: payments
        .filter(payment => payment.public_status !== "pago")
        .reduce((total, payment) => total + Number(payment.amount || 0), 0),
      nextScheduledPayment: scheduled[0] || null,
      processing: payments.filter(
        payment => payment.public_status === "em_processamento",
      ).length,
      activeNegotiations: activeNegotiations.length,
    };
  }, [portal]);

  async function loadPortal(last4 = verifiedDocumentLast4) {
    if (!tokenIsValid || !/^\d{4}$/.test(last4)) return;
    const requestToken = normalizedToken;
    setLoading(true);
    setError("");
    try {
      const nextPortal = await requestPortal(requestToken, last4);
      if (tokenRef.current !== requestToken) return;
      setPortal(nextPortal);
      setVerifiedDocumentLast4(last4);
      if (
        selectedNegotiationId &&
        !nextPortal.negotiations.some(
          negotiation => negotiation.id === selectedNegotiationId,
        )
      ) {
        setSelectedNegotiationId("");
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível abrir este acesso.",
      );
      if (!portal) setVerifiedDocumentLast4("");
    } finally {
      setLoading(false);
    }
  }

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback("");
    if (!/^\d{4}$/.test(documentLast4)) {
      setError("Informe exatamente os quatro últimos dígitos do CPF ou CNPJ.");
      return;
    }
    await loadPortal(documentLast4);
  }

  function openNegotiation(paymentId = "") {
    setSelectedPaymentId(paymentId);
    setNegotiationOpen(true);
    setFeedback("");
    requestAnimationFrame(() => {
      document
        .getElementById("partner-new-negotiation")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function createNegotiation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!portal || !verifiedDocumentLast4) return;
    const form = new FormData(event.currentTarget);
    const message = String(form.get("message") || "").trim();
    if (message.length < 10) {
      setError("Descreva a solicitação com pelo menos 10 caracteres.");
      return;
    }
    setLoading(true);
    setError("");
    setFeedback("");
    try {
      const client = getSupabase();
      if (!client)
        throw new Error("O portal está temporariamente indisponível.");
      const result = await client.rpc("open_partner_negotiation", {
        p_token: normalizedToken,
        p_document_last4: verifiedDocumentLast4,
        p_financial_entry_id:
          String(form.get("financial_entry_id") || "") || null,
        p_negotiation_type: String(form.get("negotiation_type")),
        p_message: message,
        p_proposed_due_date:
          String(form.get("proposed_due_date") || "") || null,
        p_proposed_installments: optionalNumber(
          form.get("proposed_installments"),
        ),
        p_proposed_discount_pct: optionalNumber(
          form.get("proposed_discount_pct"),
        ),
        p_proposed_amount: optionalNumber(form.get("proposed_amount")),
      });
      if (result.error || !result.data) {
        throw new Error(
          result.error?.message ||
            "Não foi possível validar este acesso para registrar a negociação.",
        );
      }
      setFeedback(
        "Negociação registrada. A equipe responsável poderá responder por este canal.",
      );
      setNegotiationOpen(false);
      setSelectedPaymentId("");
      await loadPortal();
      if (typeof result.data === "string") {
        setSelectedNegotiationId(result.data);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível registrar a negociação.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function sendMessage(
    event: FormEvent<HTMLFormElement>,
    negotiation: PartnerNegotiation,
  ) {
    event.preventDefault();
    if (!verifiedDocumentLast4) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const message = String(data.get("message") || "").trim();
    if (!message) return;
    setMessageBusyId(negotiation.id);
    setError("");
    setFeedback("");
    try {
      const client = getSupabase();
      if (!client)
        throw new Error("O portal está temporariamente indisponível.");
      const result = await client.rpc("post_partner_negotiation_message", {
        p_token: normalizedToken,
        p_document_last4: verifiedDocumentLast4,
        p_negotiation_id: negotiation.id,
        p_message: message,
      });
      if (result.error || !result.data) {
        throw new Error(
          result.error?.message ||
            "Não foi possível validar este acesso para enviar a mensagem.",
        );
      }
      form.reset();
      setFeedback("Mensagem enviada e registrada na negociação.");
      await loadPortal();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível enviar a mensagem.",
      );
    } finally {
      setMessageBusyId("");
    }
  }

  function closePortal() {
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    tokenRef.current = "";
    setToken("");
    setAccessClosed(true);
    setPortal(null);
    setVerifiedDocumentLast4("");
    setDocumentLast4("");
    setSelectedNegotiationId("");
    setFeedback("");
    setError("");
  }

  if (!tokenRead) {
    return (
      <PartnerState
        title="Abrindo acesso protegido"
        text="Aguarde enquanto validamos o endereço do portal."
        pending
      />
    );
  }

  if (!tokenIsValid) {
    return (
      <PartnerState
        title={accessClosed ? "Consulta encerrada" : "Acesso indisponível"}
        text={
          accessClosed
            ? "O acesso foi removido deste navegador. Abra novamente o link recebido quando precisar consultar."
            : "Este endereço não corresponde a um acesso válido. Solicite um novo link à equipe responsável."
        }
      />
    );
  }

  if (!portal) {
    return (
      <main className="partner-access-page">
        <style jsx>{partnerStyles}</style>
        <section className="partner-access-card">
          <div className="partner-access-brand">
            <Image
              src="/evora-brand.svg"
              width={230}
              height={62}
              priority
              alt="Évora Urbanismo"
            />
            <span>PORTAL DE PARCEIROS E PAGAMENTOS</span>
          </div>
          <div className="partner-access-copy">
            <small>ACESSO INDIVIDUAL E PROTEGIDO</small>
            <h1>Acompanhe pagamentos e negociações com clareza.</h1>
            <p>
              Consulte apenas as informações publicadas para sua empresa,
              acompanhe cada etapa do processamento e fale diretamente com a
              equipe responsável.
            </p>
          </div>
          <form className="partner-access-form" onSubmit={authenticate}>
            <label htmlFor="partner-document-last4">
              Últimos 4 dígitos do CPF ou CNPJ
            </label>
            <div>
              <input
                id="partner-document-last4"
                value={documentLast4}
                onChange={event =>
                  setDocumentLast4(
                    event.target.value.replace(/\D/g, "").slice(0, 4),
                  )
                }
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                placeholder="••••"
                aria-describedby="partner-access-help"
                autoFocus
                required
              />
              <button
                className="partner-primary-button"
                disabled={loading || documentLast4.length !== 4}
              >
                {loading ? "Validando..." : "Acessar portal"}
              </button>
            </div>
            <p id="partner-access-help">
              Para sua segurança, o acesso é bloqueado temporariamente após
              tentativas consecutivas incorretas.
            </p>
            {error && (
              <div className="partner-feedback partner-feedback-error" role="alert">
                {error}
              </div>
            )}
          </form>
          <footer className="partner-access-security">
            <span aria-hidden="true">✓</span>
            <p>
              O portal não expõe fluxo de caixa, dados bancários nem
              informações de outros parceiros.
            </p>
          </footer>
        </section>
      </main>
    );
  }

  const partnerName =
    portal.partner.trade_name || portal.partner.name || "Parceiro";
  const organizationName =
    portal.organization.trade_name ||
    portal.organization.name ||
    "Évora Urbanismo";
  const selectedNegotiation =
    portal.negotiations.find(
      negotiation => negotiation.id === selectedNegotiationId,
    ) ||
    portal.negotiations[0] ||
    null;

  return (
    <main className="partner-portal-root">
      <style jsx>{partnerStyles}</style>
      <header className="partner-portal-topbar">
        <div className="partner-portal-brand">
          <Image
            src="/evora-brand.svg"
            width={190}
            height={52}
            priority
            alt="Évora Urbanismo"
          />
          <span>Portal de Parceiros e Pagamentos</span>
        </div>
        <div className="partner-portal-top-actions">
          <button
            className="partner-icon-button"
            type="button"
            onClick={() => loadPortal()}
            disabled={loading}
            title="Atualizar informações"
          >
            ↻
          </button>
          <button
            className="partner-secondary-button"
            type="button"
            onClick={closePortal}
          >
            Encerrar consulta
          </button>
        </div>
      </header>

      <section className="partner-portal-hero">
        <div>
          <small>{partnerKindLabels[portal.partner.kind]}</small>
          <h1>Olá, {partnerName}.</h1>
          <p>
            Informações publicadas por {organizationName}. Atualização em{" "}
            {formatDateTime(portal.generated_at)}.
          </p>
        </div>
        <aside>
          <span>ACESSO PROTEGIDO</span>
          <strong>{portal.access.label || `Final •${portal.access.token_hint}`}</strong>
          <small>Válido até {formatDate(portal.access.expires_at)}</small>
        </aside>
      </section>

      <div className="partner-content-shell">
        {(error || feedback) && (
          <div
            className={`partner-feedback ${
              error ? "partner-feedback-error" : "partner-feedback-success"
            }`}
            role={error ? "alert" : "status"}
            aria-live="polite"
          >
            <span>{error || feedback}</span>
            <button
              type="button"
              onClick={() => {
                setError("");
                setFeedback("");
              }}
              aria-label="Fechar aviso"
            >
              ×
            </button>
          </div>
        )}

        <section className="partner-summary-grid" aria-label="Resumo">
          <article>
            <small>VALORES PUBLICADOS EM ABERTO</small>
            <strong>{currency.format(summary.publishedAmount)}</strong>
            <span>{portal.payments.length} título(s) visível(is)</span>
          </article>
          <article>
            <small>PRÓXIMA PROGRAMAÇÃO EFETIVA</small>
            <strong>
              {summary.nextScheduledPayment
                ? formatDate(summary.nextScheduledPayment.date)
                : "Sem data programada"}
            </strong>
            <span>
              {summary.nextScheduledPayment
                ? "Data registrada; pagamento ainda não confirmado"
                : "Previsões informativas não são consideradas aqui"}
            </span>
          </article>
          <article>
            <small>EM PROCESSAMENTO</small>
            <strong>{summary.processing}</strong>
            <span>ordem(ns) em processamento bancário</span>
          </article>
          <article>
            <small>NEGOCIAÇÕES ATIVAS</small>
            <strong>{summary.activeNegotiations}</strong>
            <span>canal(is) com acompanhamento registrado</span>
          </article>
        </section>

        <section className="partner-section partner-payments-section">
          <div className="partner-section-heading">
            <div>
              <small>PAGAMENTOS E STATUS</small>
              <h2>Programação e conclusão</h2>
              <p>
                O vencimento é a data contratual. A programação efetiva é a
                data registrada para encaminhar o pagamento. Somente o status
                “Pago” confirma a conclusão.
              </p>
            </div>
            <button
              className="partner-primary-button"
              type="button"
              onClick={() => openNegotiation()}
            >
              + Solicitar negociação
            </button>
          </div>

          <div
            className="partner-payment-guide"
            aria-label="Como interpretar as etapas do pagamento"
          >
            <article>
              <span>1</span>
              <div>
                <strong>Vencimento contratual</strong>
                <p>Data original da obrigação.</p>
              </div>
            </article>
            <article>
              <span>2</span>
              <div>
                <strong>Programação efetiva</strong>
                <p>Data definida e publicada para encaminhamento.</p>
              </div>
            </article>
            <article>
              <span>3</span>
              <div>
                <strong>Em processamento</strong>
                <p>Ordem de pagamento iniciada.</p>
              </div>
            </article>
            <article>
              <span>4</span>
              <div>
                <strong>Pago</strong>
                <p>Liquidação efetivamente confirmada.</p>
              </div>
            </article>
          </div>

          <div className="partner-payment-list">
            {portal.payments.map(payment => (
              <PaymentCard
                key={payment.id}
                payment={payment}
                onNegotiate={() => openNegotiation(payment.id)}
              />
            ))}
            {!portal.payments.length && (
              <div className="partner-empty-state">
                <span aria-hidden="true">▤</span>
                <h3>Nenhum pagamento publicado</h3>
                <p>
                  Não há títulos disponibilizados neste portal no momento.
                  Isso não altera eventuais obrigações registradas em outros
                  documentos.
                </p>
              </div>
            )}
          </div>
        </section>

        {negotiationOpen && (
          <NewNegotiation
            payments={portal.payments}
            selectedPaymentId={selectedPaymentId}
            setSelectedPaymentId={setSelectedPaymentId}
            close={() => setNegotiationOpen(false)}
            submit={createNegotiation}
            busy={loading}
          />
        )}

        <section className="partner-section partner-negotiations-section">
          <div className="partner-section-heading">
            <div>
              <small>CANAL DE COMUNICAÇÃO</small>
              <h2>Negociações e acordos</h2>
              <p>
                Todas as mensagens ficam vinculadas ao parceiro e, quando
                selecionado, ao respectivo título.
              </p>
            </div>
          </div>

          {portal.negotiations.length ? (
            <div className="partner-negotiation-layout">
              <nav
                className="partner-negotiation-list"
                aria-label="Negociações"
              >
                {portal.negotiations.map(negotiation => {
                  const linkedPayment = portal.payments.find(
                    payment =>
                      payment.id === negotiation.financial_entry_id,
                  );
                  return (
                    <button
                      type="button"
                      key={negotiation.id}
                      className={
                        selectedNegotiation?.id === negotiation.id
                          ? "partner-negotiation-item partner-active"
                          : "partner-negotiation-item"
                      }
                      onClick={() =>
                        setSelectedNegotiationId(negotiation.id)
                      }
                    >
                      <span
                        className={`partner-negotiation-status partner-status-${negotiation.status}`}
                      >
                        {negotiationStatusLabels[negotiation.status]}
                      </span>
                      <strong>{negotiation.subject}</strong>
                      <small>
                        {linkedPayment?.description || "Negociação geral"}
                      </small>
                      <time>{formatDateTime(negotiation.updated_at)}</time>
                    </button>
                  );
                })}
              </nav>
              {selectedNegotiation && (
                <NegotiationThread
                  negotiation={selectedNegotiation}
                  payment={portal.payments.find(
                    payment =>
                      payment.id ===
                      selectedNegotiation.financial_entry_id,
                  )}
                  busy={messageBusyId === selectedNegotiation.id}
                  onSubmit={event =>
                    sendMessage(event, selectedNegotiation)
                  }
                />
              )}
            </div>
          ) : (
            <div className="partner-empty-state partner-empty-compact">
              <span aria-hidden="true">↔</span>
              <h3>Nenhuma negociação aberta</h3>
              <p>
                Use “Solicitar negociação” para registrar uma proposta ou
                dúvida com histórico e acompanhamento.
              </p>
            </div>
          )}
        </section>

        <section className="partner-policy-section">
          <header>
            <small>ENTENDA AS SITUAÇÕES</small>
            <h2>Transparência sem promessas indevidas</h2>
          </header>
          <div>
            <article>
              <i className="partner-policy-dot partner-dot-forecast" />
              <strong>Previsto</strong>
              <p>{portal.policy.forecast}</p>
            </article>
            <article>
              <i className="partner-policy-dot partner-dot-scheduled" />
              <strong>Programado</strong>
              <p>{portal.policy.scheduled}</p>
            </article>
            <article>
              <i className="partner-policy-dot partner-dot-processing" />
              <strong>Em processamento</strong>
              <p>{portal.policy.processing}</p>
            </article>
            <article>
              <i className="partner-policy-dot partner-dot-paid" />
              <strong>Pago</strong>
              <p>{portal.policy.paid}</p>
            </article>
          </div>
        </section>
      </div>

      <footer className="partner-portal-footer">
        <Image
          src="/evora-brand.svg"
          width={150}
          height={42}
          alt="Évora Urbanismo"
        />
        <p>
          Canal institucional de parceiros. As negociações somente alteram
          condições após aprovação e formalização pela Évora Urbanismo.
        </p>
        <small>© 2026 Évora Urbanismo · Gestão integrada</small>
      </footer>
    </main>
  );
}

function PaymentCard({
  payment,
  onNegotiate,
}: {
  payment: PartnerPayment;
  onNegotiate: () => void;
}) {
  const status = paymentStatus[payment.public_status];
  const scheduledDate = scheduledPaymentDate(payment);
  const processingDate = processingStartedDate(payment);
  const paidDate = confirmedPaymentDate(payment);
  const forecast = paymentForecast(payment);
  const executionSummary = paymentExecutionSummary(
    payment,
    scheduledDate,
    processingDate,
    paidDate,
  );
  return (
    <article className={`partner-payment-card partner-tone-${status.tone}`}>
      <header>
        <span className="partner-payment-status">
          <i />
          {status.label}
        </span>
        <time>Atualizado em {formatDateTime(payment.updated_at)}</time>
      </header>
      <div className="partner-payment-main">
        <div>
          <small>
            {payment.project_name || "Corporativo"}
            {payment.document_number
              ? ` · Documento ${payment.document_number}`
              : ""}
          </small>
          <h3>{payment.description}</h3>
          {Number(payment.installment_total || 0) > 1 && (
            <span>
              Parcela {payment.installment_number || "—"} de{" "}
              {payment.installment_total}
            </span>
          )}
        </div>
        <strong>{currency.format(Number(payment.amount || 0))}</strong>
      </div>

      <section
        className="partner-payment-execution-summary"
        aria-label="Situação efetiva do pagamento"
      >
        <small>{executionSummary.label}</small>
        <strong>{executionSummary.value}</strong>
        <p>{executionSummary.detail}</p>
      </section>

      <div className="partner-payment-date-groups">
        <section className="partner-payment-date-group">
          <header>
            <small>REFERÊNCIA DO TÍTULO</small>
            <p>Datas documentais e contratuais</p>
          </header>
          <div>
            <span>
              <small>Emissão</small>
              <strong>
                {payment.issue_date
                  ? formatDate(payment.issue_date)
                  : "Não informada"}
              </strong>
            </span>
            <span>
              <small>Vencimento contratual</small>
              <strong>{formatDate(payment.contractual_due_date)}</strong>
            </span>
          </div>
        </section>
        <section className="partner-payment-date-group partner-payment-date-group-execution">
          <header>
            <small>EXECUÇÃO DO PAGAMENTO</small>
            <p>Somente informações efetivamente publicadas</p>
          </header>
          <div>
            <span>
              <small>Programação efetiva</small>
              <strong>
                {scheduledDate
                  ? formatDate(scheduledDate)
                  : payment.public_status === "pago"
                    ? "Não registrada"
                    : "Não programado"}
              </strong>
            </span>
            <span>
              <small>Processamento iniciado</small>
              <strong>
                {processingDate
                  ? formatDateTime(processingDate)
                  : "Não iniciado"}
              </strong>
            </span>
            <span>
              <small>Pagamento confirmado</small>
              <strong>
                {paidDate ? formatDate(paidDate) : "Não confirmado"}
              </strong>
            </span>
          </div>
        </section>
      </div>
      {forecast && !scheduledDate && payment.public_status === "previsto" && (
        <div className="partner-payment-forecast">
          <strong>Previsão informativa</strong>
          <span>{forecast}</span>
          <small>Esta janela não representa programação de pagamento.</small>
        </div>
      )}
      <PaymentTimeline status={payment.public_status} />
      <p className="partner-payment-explanation">{status.detail}</p>
      {payment.public_note && (
        <div className="partner-payment-note">
          <strong>Atualização da equipe</strong>
          <p>{payment.public_note}</p>
        </div>
      )}
      <footer>
        <button
          className="partner-secondary-button"
          type="button"
          onClick={onNegotiate}
          disabled={payment.public_status === "pago"}
        >
          {payment.public_status === "pago"
            ? "Pagamento concluído"
            : "Negociar este pagamento"}
        </button>
      </footer>
    </article>
  );
}

function PaymentTimeline({ status }: { status: PartnerPaymentStatus }) {
  const current = paymentStatus[status].step;
  const suspended = status === "suspenso";
  const steps = [
    ["Análise", 0],
    ["Previsão", 1],
    ["Programado", 2],
    ["Processamento", 3],
    ["Pago", 4],
  ] as const;
  return (
    <div
      className={`partner-payment-timeline ${suspended ? "partner-suspended" : ""}`}
      aria-label={`Andamento: ${paymentStatus[status].label}`}
    >
      {steps.map(([label, step]) => (
        <span
          key={label}
          className={
            !suspended && step <= current ? "partner-step-done" : ""
          }
        >
          <i>{!suspended && step < current ? "✓" : step + 1}</i>
          <small>{label}</small>
        </span>
      ))}
    </div>
  );
}

function NewNegotiation({
  payments,
  selectedPaymentId,
  setSelectedPaymentId,
  close,
  submit,
  busy,
}: {
  payments: PartnerPayment[];
  selectedPaymentId: string;
  setSelectedPaymentId: (value: string) => void;
  close: () => void;
  submit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  busy: boolean;
}) {
  const [type, setType] =
    useState<PartnerNegotiationType>("prorrogacao");
  return (
    <section
      className="partner-section partner-new-negotiation"
      id="partner-new-negotiation"
    >
      <div className="partner-section-heading">
        <div>
          <small>NOVA SOLICITAÇÃO</small>
          <h2>Proponha uma negociação</h2>
          <p>
            Sua proposta será registrada para análise. O envio não altera
            automaticamente vencimentos, valores ou contratos.
          </p>
        </div>
        <button
          className="partner-close-button"
          type="button"
          onClick={close}
          aria-label="Fechar negociação"
        >
          ×
        </button>
      </div>
      <form className="partner-negotiation-form" onSubmit={submit}>
        <label className="partner-field partner-span-2">
          <span>Pagamento relacionado</span>
          <select
            name="financial_entry_id"
            value={selectedPaymentId}
            onChange={event => setSelectedPaymentId(event.target.value)}
          >
            <option value="">Negociação geral</option>
            {payments
              .filter(payment => payment.public_status !== "pago")
              .map(payment => (
                <option key={payment.id} value={payment.id}>
                  {payment.description} · {currency.format(payment.amount)}
                </option>
              ))}
          </select>
        </label>
        <label className="partner-field partner-span-2">
          <span>Tipo de negociação</span>
          <select
            name="negotiation_type"
            value={type}
            onChange={event =>
              setType(event.target.value as PartnerNegotiationType)
            }
          >
            {Object.entries(negotiationTypeLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {(type === "prorrogacao" || type === "parcelamento") && (
          <label className="partner-field">
            <span>Data proposta</span>
            <input name="proposed_due_date" type="date" />
          </label>
        )}
        {type === "parcelamento" && (
          <label className="partner-field">
            <span>Quantidade de parcelas</span>
            <input
              name="proposed_installments"
              type="number"
              min="1"
              max="120"
              inputMode="numeric"
            />
          </label>
        )}
        {type === "antecipacao_desconto" && (
          <label className="partner-field">
            <span>Desconto proposto (%)</span>
            <input
              name="proposed_discount_pct"
              type="number"
              min="0"
              max="100"
              step="0.01"
              inputMode="decimal"
            />
          </label>
        )}
        {["antecipacao_desconto", "compensacao", "contestacao"].includes(
          type,
        ) && (
          <label className="partner-field">
            <span>Valor proposto</span>
            <input
              name="proposed_amount"
              type="number"
              min="0.01"
              step="0.01"
              inputMode="decimal"
              placeholder="0,00"
            />
          </label>
        )}
        <label className="partner-field partner-span-4">
          <span>Explique sua proposta</span>
          <textarea
            name="message"
            rows={5}
            minLength={10}
            maxLength={4000}
            placeholder="Descreva as condições pretendidas, o motivo e outras informações relevantes."
            required
          />
          <small>Entre 10 e 4.000 caracteres.</small>
        </label>
        <footer className="partner-span-4">
          <button
            className="partner-secondary-button"
            type="button"
            onClick={close}
          >
            Cancelar
          </button>
          <button className="partner-primary-button" disabled={busy}>
            {busy ? "Registrando..." : "Enviar para análise"}
          </button>
        </footer>
      </form>
    </section>
  );
}

function NegotiationThread({
  negotiation,
  payment,
  busy,
  onSubmit,
}: {
  negotiation: PartnerNegotiation;
  payment?: PartnerPayment;
  busy: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  const closed = closedNegotiationStatuses.has(negotiation.status);
  return (
    <article className="partner-negotiation-thread">
      <header>
        <div>
          <span
            className={`partner-negotiation-status partner-status-${negotiation.status}`}
          >
            {negotiationStatusLabels[negotiation.status]}
          </span>
          <h3>{negotiation.subject}</h3>
          <p>
            {payment
              ? `${payment.description} · ${currency.format(payment.amount)}`
              : "Negociação geral"}
          </p>
        </div>
        <small>Aberta em {formatDateTime(negotiation.opened_at)}</small>
      </header>

      <TermsSummary terms={negotiation.current_terms} />

      <div className="partner-message-thread" aria-live="polite">
        {negotiation.messages.map(message => (
          <div
            key={message.id}
            className={`partner-message partner-message-${message.sender_kind}`}
          >
            <header>
              <strong>
                {message.sender_kind === "parceiro"
                  ? "Você"
                  : message.sender_name || "Évora Urbanismo"}
              </strong>
              <time>{formatDateTime(message.created_at)}</time>
            </header>
            <p>{message.body}</p>
            {Object.keys(message.terms_snapshot || {}).length > 0 && (
              <TermsSummary terms={message.terms_snapshot} compact />
            )}
          </div>
        ))}
      </div>

      {closed ? (
        <div className="partner-thread-closed">
          <strong>Tratativa {negotiationStatusLabels[negotiation.status].toLowerCase()}</strong>
          <p>
            O histórico permanece disponível para consulta. Uma aprovação
            somente produz efeitos após a formalização correspondente.
          </p>
        </div>
      ) : (
        <form className="partner-message-form" onSubmit={onSubmit}>
          <label>
            <span>
              {negotiation.status === "contraproposta" ||
              negotiation.status === "aguardando_parceiro"
                ? "Responder à equipe"
                : "Adicionar mensagem"}
            </span>
            <textarea
              name="message"
              rows={3}
              minLength={1}
              maxLength={4000}
              placeholder="Escreva sua mensagem..."
              required
            />
          </label>
          <button className="partner-primary-button" disabled={busy}>
            {busy ? "Enviando..." : "Enviar mensagem"}
          </button>
        </form>
      )}
    </article>
  );
}

function TermsSummary({
  terms,
  compact = false,
}: {
  terms: PartnerNegotiationTerms;
  compact?: boolean;
}) {
  const items = [
    terms.proposed_due_date
      ? ["Data proposta", formatDate(terms.proposed_due_date)]
      : null,
    terms.proposed_installments
      ? ["Parcelas", String(terms.proposed_installments)]
      : null,
    terms.proposed_discount_pct !== undefined
      ? ["Desconto", `${Number(terms.proposed_discount_pct).toLocaleString("pt-BR")}%`]
      : null,
    terms.proposed_amount
      ? ["Valor proposto", currency.format(Number(terms.proposed_amount))]
      : null,
  ].filter((item): item is string[] => Boolean(item));
  if (!items.length) return null;
  return (
    <dl
      className={
        compact
          ? "partner-terms-summary partner-terms-compact"
          : "partner-terms-summary"
      }
    >
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PartnerState({
  title,
  text,
  pending = false,
}: {
  title: string;
  text: string;
  pending?: boolean;
}) {
  return (
    <main className="partner-access-page">
      <style jsx>{partnerStyles}</style>
      <section className="partner-access-card partner-state-card">
        <Image
          src="/evora-brand.svg"
          width={220}
          height={60}
          priority
          alt="Évora Urbanismo"
        />
        <span
          className={pending ? "partner-state-pending" : ""}
          aria-hidden="true"
        >
          {pending ? "…" : "!"}
        </span>
        <h1>{title}</h1>
        <p>{text}</p>
      </section>
    </main>
  );
}

const partnerStyles = `
  .partner-access-page,
  .partner-portal-root {
    --partner-navy: #123f59;
    --partner-navy-deep: #092b3f;
    --partner-blue: #1d6687;
    --partner-green: #78b72a;
    --partner-gold: #c69745;
    --partner-ink: #112a3a;
    --partner-muted: #62747e;
    --partner-line: #d9e2e4;
    --partner-soft: #f2f5f3;
    --partner-paper: #fbfcfa;
    min-height: 100vh;
    color: var(--partner-ink);
    background:
      radial-gradient(circle at 8% 4%, rgba(120, 183, 42, .1), transparent 25rem),
      linear-gradient(180deg, #f7f9f6 0, #eef2ef 100%);
    font-family: Arial, Helvetica, sans-serif;
  }
  .partner-access-page {
    display: grid;
    place-items: center;
    padding: 32px 20px;
  }
  .partner-access-card {
    width: min(100%, 980px);
    display: grid;
    grid-template-columns: 1.1fr .9fr;
    overflow: hidden;
    border: 1px solid rgba(18, 63, 89, .12);
    border-radius: 32px;
    background: rgba(255, 255, 255, .92);
    box-shadow: 0 30px 80px rgba(10, 43, 63, .14);
  }
  .partner-access-brand {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 26px 34px;
    border-bottom: 1px solid var(--partner-line);
  }
  .partner-access-brand span {
    color: var(--partner-navy);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: .12em;
  }
  .partner-access-copy {
    min-height: 390px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 48px;
    color: white;
    background:
      linear-gradient(140deg, rgba(120, 183, 42, .14), transparent 55%),
      var(--partner-navy-deep);
  }
  .partner-access-copy small,
  .partner-section-heading small,
  .partner-policy-section > header small,
  .partner-portal-hero small {
    color: var(--partner-green);
    font-size: 12px;
    font-weight: 900;
    letter-spacing: .13em;
  }
  .partner-access-copy h1 {
    max-width: 520px;
    margin: 14px 0 18px;
    font-size: clamp(34px, 5vw, 56px);
    line-height: 1;
    letter-spacing: -.04em;
  }
  .partner-access-copy p {
    max-width: 520px;
    margin: 0;
    color: rgba(255,255,255,.77);
    font-size: 17px;
    line-height: 1.6;
  }
  .partner-access-form {
    align-self: center;
    padding: 42px;
  }
  .partner-access-form > label {
    display: block;
    margin-bottom: 10px;
    font-weight: 800;
  }
  .partner-access-form > div:first-of-type {
    display: grid;
    grid-template-columns: 132px 1fr;
    gap: 10px;
  }
  .partner-access-form input {
    min-width: 0;
    padding: 15px;
    border: 1px solid #bfcdd1;
    border-radius: 13px;
    color: var(--partner-navy-deep);
    background: white;
    font-size: 22px;
    font-weight: 800;
    letter-spacing: .22em;
    text-align: center;
  }
  .partner-access-form > p {
    margin: 12px 0 0;
    color: var(--partner-muted);
    font-size: 12px;
    line-height: 1.5;
  }
  .partner-access-security {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 18px 34px;
    border-top: 1px solid var(--partner-line);
    background: #f4f7f4;
  }
  .partner-access-security span {
    display: grid;
    width: 28px;
    height: 28px;
    place-items: center;
    flex: 0 0 auto;
    border-radius: 50%;
    color: white;
    background: var(--partner-green);
    font-weight: 900;
  }
  .partner-access-security p {
    margin: 0;
    color: var(--partner-muted);
    font-size: 13px;
  }
  .partner-state-card {
    display: flex;
    min-height: 360px;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px;
    text-align: center;
  }
  .partner-state-card > span {
    display: grid;
    width: 54px;
    height: 54px;
    margin: 34px 0 10px;
    place-items: center;
    border-radius: 50%;
    color: white;
    background: #b8473e;
    font-size: 28px;
    font-weight: 900;
  }
  .partner-state-card > .partner-state-pending {
    color: var(--partner-navy);
    background: #e7efdf;
  }
  .partner-state-card h1 {
    margin: 8px 0;
    color: var(--partner-navy);
    font-size: 34px;
  }
  .partner-state-card p {
    max-width: 520px;
    color: var(--partner-muted);
    line-height: 1.6;
  }
  .partner-primary-button,
  .partner-secondary-button,
  .partner-icon-button,
  .partner-close-button {
    border: 0;
    border-radius: 12px;
    font: inherit;
    font-weight: 800;
    cursor: pointer;
    transition: transform .18s ease, box-shadow .18s ease, opacity .18s ease;
  }
  .partner-primary-button {
    padding: 14px 19px;
    color: white;
    background: var(--partner-navy);
    box-shadow: 0 9px 24px rgba(18, 63, 89, .17);
  }
  .partner-primary-button:hover:not(:disabled),
  .partner-secondary-button:hover:not(:disabled),
  .partner-icon-button:hover:not(:disabled) {
    transform: translateY(-1px);
  }
  .partner-primary-button:disabled,
  .partner-secondary-button:disabled,
  .partner-icon-button:disabled {
    opacity: .5;
    cursor: not-allowed;
  }
  .partner-secondary-button {
    padding: 12px 16px;
    border: 1px solid #cbd6d8;
    color: var(--partner-navy);
    background: white;
  }
  .partner-icon-button {
    width: 44px;
    height: 44px;
    color: var(--partner-navy);
    background: white;
    font-size: 22px;
  }
  .partner-close-button {
    width: 42px;
    height: 42px;
    color: var(--partner-muted);
    background: #edf1ef;
    font-size: 24px;
  }
  .partner-portal-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 20px max(24px, calc((100vw - 1240px) / 2));
    border-bottom: 1px solid rgba(18, 63, 89, .1);
    background: rgba(255,255,255,.91);
    backdrop-filter: blur(18px);
  }
  .partner-portal-brand {
    display: flex;
    align-items: center;
    gap: 20px;
  }
  .partner-portal-brand span {
    padding-left: 20px;
    border-left: 1px solid var(--partner-line);
    color: var(--partner-navy);
    font-size: 13px;
    font-weight: 800;
    letter-spacing: .06em;
  }
  .partner-portal-top-actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .partner-portal-hero {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 32px;
    padding: 60px max(24px, calc((100vw - 1240px) / 2)) 76px;
    color: white;
    background:
      radial-gradient(circle at 75% 0, rgba(120, 183, 42, .19), transparent 28rem),
      linear-gradient(125deg, var(--partner-navy-deep), var(--partner-navy));
  }
  .partner-portal-hero h1 {
    margin: 11px 0;
    font-size: clamp(38px, 6vw, 70px);
    line-height: 1;
    letter-spacing: -.045em;
  }
  .partner-portal-hero p {
    margin: 0;
    color: rgba(255,255,255,.72);
    font-size: 16px;
  }
  .partner-portal-hero aside {
    min-width: 260px;
    padding: 20px 22px;
    border: 1px solid rgba(255,255,255,.18);
    border-radius: 18px;
    background: rgba(255,255,255,.08);
  }
  .partner-portal-hero aside span,
  .partner-portal-hero aside strong,
  .partner-portal-hero aside small {
    display: block;
  }
  .partner-portal-hero aside span {
    color: var(--partner-green);
    font-size: 10px;
    font-weight: 900;
    letter-spacing: .12em;
  }
  .partner-portal-hero aside strong {
    margin: 8px 0;
    font-size: 16px;
  }
  .partner-portal-hero aside small {
    color: rgba(255,255,255,.67);
  }
  .partner-content-shell {
    width: min(calc(100% - 40px), 1240px);
    margin: -35px auto 0;
    position: relative;
  }
  .partner-feedback {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 18px;
    padding: 15px 18px;
    border-radius: 14px;
    box-shadow: 0 12px 35px rgba(9, 43, 63, .12);
  }
  .partner-feedback button {
    border: 0;
    color: inherit;
    background: transparent;
    font-size: 21px;
    cursor: pointer;
  }
  .partner-feedback-error {
    border: 1px solid #efc6c1;
    color: #8b3029;
    background: #fff1ef;
  }
  .partner-feedback-success {
    border: 1px solid #c8dfb0;
    color: #385f19;
    background: #f1f8e9;
  }
  .partner-summary-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 14px;
  }
  .partner-summary-grid article {
    min-width: 0;
    padding: 24px;
    border: 1px solid rgba(18, 63, 89, .11);
    border-radius: 20px;
    background: rgba(255,255,255,.96);
    box-shadow: 0 14px 42px rgba(9, 43, 63, .08);
  }
  .partner-summary-grid small,
  .partner-summary-grid strong,
  .partner-summary-grid span {
    display: block;
  }
  .partner-summary-grid small {
    min-height: 30px;
    color: var(--partner-muted);
    font-size: 10px;
    font-weight: 900;
    letter-spacing: .08em;
  }
  .partner-summary-grid strong {
    overflow-wrap: anywhere;
    margin: 9px 0 6px;
    color: var(--partner-navy);
    font-size: clamp(23px, 3vw, 34px);
    line-height: 1.05;
    letter-spacing: -.035em;
  }
  .partner-summary-grid span {
    color: var(--partner-muted);
    font-size: 12px;
    line-height: 1.4;
  }
  .partner-section {
    margin-top: 24px;
    padding: clamp(22px, 4vw, 38px);
    border: 1px solid rgba(18, 63, 89, .11);
    border-radius: 26px;
    background: rgba(255,255,255,.93);
    box-shadow: 0 18px 50px rgba(9, 43, 63, .07);
  }
  .partner-section-heading {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 25px;
  }
  .partner-section-heading h2,
  .partner-policy-section h2 {
    margin: 6px 0 8px;
    color: var(--partner-navy-deep);
    font-size: clamp(27px, 4vw, 40px);
    line-height: 1.05;
    letter-spacing: -.035em;
  }
  .partner-section-heading p {
    max-width: 720px;
    margin: 0;
    color: var(--partner-muted);
    line-height: 1.55;
  }
  .partner-payment-list {
    display: grid;
    gap: 16px;
  }
  .partner-payment-guide {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin: -5px 0 24px;
    padding: 12px;
    border: 1px solid #d9e3e3;
    border-radius: 16px;
    background: #f4f7f5;
  }
  .partner-payment-guide article {
    display: flex;
    min-width: 0;
    align-items: flex-start;
    gap: 10px;
    padding: 10px;
  }
  .partner-payment-guide article > span {
    display: grid;
    width: 25px;
    height: 25px;
    flex: 0 0 25px;
    place-items: center;
    border-radius: 50%;
    color: white;
    background: var(--partner-navy);
    font-size: 10px;
    font-weight: 900;
  }
  .partner-payment-guide strong {
    display: block;
    color: var(--partner-navy);
    font-size: 12px;
  }
  .partner-payment-guide p {
    margin: 4px 0 0;
    color: var(--partner-muted);
    font-size: 10px;
    line-height: 1.4;
  }
  .partner-payment-card {
    --partner-card-tone: var(--partner-blue);
    overflow: hidden;
    padding: 24px;
    border: 1px solid var(--partner-line);
    border-top: 4px solid var(--partner-card-tone);
    border-radius: 19px;
    background: var(--partner-paper);
  }
  .partner-tone-analysis { --partner-card-tone: #75838b; }
  .partner-tone-forecast { --partner-card-tone: var(--partner-gold); }
  .partner-tone-scheduled { --partner-card-tone: #3376a0; }
  .partner-tone-processing { --partner-card-tone: #7656a8; }
  .partner-tone-paid { --partner-card-tone: var(--partner-green); }
  .partner-tone-suspended { --partner-card-tone: #b8473e; }
  .partner-payment-card > header,
  .partner-payment-card > footer,
  .partner-payment-main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
  }
  .partner-payment-card > header time {
    color: var(--partner-muted);
    font-size: 11px;
  }
  .partner-payment-status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--partner-card-tone);
    font-size: 12px;
    font-weight: 900;
    letter-spacing: .04em;
    text-transform: uppercase;
  }
  .partner-payment-status i {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 0 4px color-mix(in srgb, currentColor 14%, transparent);
  }
  .partner-payment-main {
    align-items: flex-end;
    margin: 22px 0;
  }
  .partner-payment-main small,
  .partner-payment-main span {
    color: var(--partner-muted);
  }
  .partner-payment-main small {
    font-size: 11px;
    font-weight: 800;
    letter-spacing: .04em;
    text-transform: uppercase;
  }
  .partner-payment-main h3 {
    margin: 5px 0;
    color: var(--partner-navy-deep);
    font-size: 22px;
  }
  .partner-payment-main span {
    font-size: 12px;
  }
  .partner-payment-main > strong {
    flex: 0 0 auto;
    color: var(--partner-navy);
    font-size: clamp(25px, 4vw, 38px);
    line-height: 1;
    letter-spacing: -.04em;
  }
  .partner-payment-execution-summary {
    display: grid;
    grid-template-columns: minmax(0, auto) minmax(160px, auto) minmax(240px, 1fr);
    align-items: center;
    gap: 12px 18px;
    margin-bottom: 14px;
    padding: 16px 18px;
    border: 1px solid color-mix(in srgb, var(--partner-card-tone) 30%, white);
    border-left: 5px solid var(--partner-card-tone);
    border-radius: 13px;
    background: color-mix(in srgb, var(--partner-card-tone) 7%, white);
  }
  .partner-payment-execution-summary small {
    color: var(--partner-card-tone);
    font-size: 10px;
    font-weight: 900;
    letter-spacing: .06em;
  }
  .partner-payment-execution-summary strong {
    color: var(--partner-navy-deep);
    font-size: 18px;
  }
  .partner-payment-execution-summary p {
    margin: 0;
    color: var(--partner-muted);
    font-size: 11px;
    line-height: 1.5;
  }
  .partner-payment-date-groups {
    display: grid;
    grid-template-columns: minmax(250px, .8fr) minmax(0, 1.2fr);
    gap: 12px;
  }
  .partner-payment-date-group {
    min-width: 0;
    border: 1px solid var(--partner-line);
    border-radius: 13px;
    background: white;
  }
  .partner-payment-date-group > header {
    padding: 12px 14px 10px;
    border-bottom: 1px solid var(--partner-line);
    background: #f7f9f8;
  }
  .partner-payment-date-group > header small,
  .partner-payment-date-group > header p {
    display: block;
    margin: 0;
  }
  .partner-payment-date-group > header small {
    color: var(--partner-navy);
    font-size: 9px;
    font-weight: 900;
    letter-spacing: .07em;
  }
  .partner-payment-date-group > header p {
    margin-top: 3px;
    color: var(--partner-muted);
    font-size: 10px;
  }
  .partner-payment-date-group > div {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .partner-payment-date-group-execution > div {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .partner-payment-date-group span {
    min-width: 0;
    padding: 13px 14px 14px;
  }
  .partner-payment-date-group span + span {
    border-left: 1px solid var(--partner-line);
  }
  .partner-payment-date-group span small,
  .partner-payment-date-group span strong {
    display: block;
  }
  .partner-payment-date-group span small {
    margin-bottom: 5px;
    color: var(--partner-muted);
    font-size: 10px;
  }
  .partner-payment-date-group span strong {
    overflow-wrap: anywhere;
    color: var(--partner-navy);
    font-size: 14px;
  }
  .partner-payment-forecast {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 12px;
    padding: 12px 15px;
    border: 1px solid #ead9b8;
    border-radius: 12px;
    color: #72511a;
    background: #fff9ec;
    font-size: 12px;
  }
  .partner-payment-forecast strong,
  .partner-payment-forecast span {
    flex: 0 0 auto;
  }
  .partner-payment-forecast small {
    min-width: 0;
    margin-left: auto;
    color: #846d44;
    text-align: right;
  }
  .partner-payment-timeline {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    margin: 28px 0 12px;
  }
  .partner-payment-timeline span {
    position: relative;
    display: flex;
    min-width: 0;
    flex-direction: column;
    align-items: center;
    gap: 7px;
    color: #95a3a7;
    text-align: center;
  }
  .partner-payment-timeline span:not(:last-child)::after {
    content: "";
    position: absolute;
    top: 13px;
    left: calc(50% + 15px);
    width: calc(100% - 30px);
    height: 2px;
    background: #dbe3e4;
  }
  .partner-payment-timeline i {
    position: relative;
    z-index: 1;
    display: grid;
    width: 28px;
    height: 28px;
    place-items: center;
    border: 2px solid #c9d3d5;
    border-radius: 50%;
    background: var(--partner-paper);
    font-size: 10px;
    font-style: normal;
    font-weight: 900;
  }
  .partner-payment-timeline small {
    overflow-wrap: anywhere;
    font-size: 10px;
  }
  .partner-payment-timeline .partner-step-done {
    color: var(--partner-card-tone);
  }
  .partner-payment-timeline .partner-step-done i {
    border-color: var(--partner-card-tone);
    color: white;
    background: var(--partner-card-tone);
  }
  .partner-payment-timeline .partner-step-done:not(:last-child)::after {
    background: var(--partner-card-tone);
  }
  .partner-payment-timeline.partner-suspended {
    opacity: .5;
  }
  .partner-payment-explanation {
    margin: 0 0 16px;
    color: var(--partner-muted);
    font-size: 12px;
    text-align: center;
  }
  .partner-payment-note {
    margin: 15px 0;
    padding: 15px 17px;
    border-left: 3px solid var(--partner-card-tone);
    border-radius: 0 10px 10px 0;
    background: #edf2ef;
  }
  .partner-payment-note strong {
    color: var(--partner-navy);
    font-size: 12px;
  }
  .partner-payment-note p {
    margin: 5px 0 0;
    color: var(--partner-muted);
    line-height: 1.5;
  }
  .partner-payment-card > footer {
    justify-content: flex-end;
    padding-top: 16px;
    border-top: 1px solid var(--partner-line);
  }
  .partner-empty-state {
    display: flex;
    min-height: 230px;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px;
    border: 1px dashed #c6d2d3;
    border-radius: 18px;
    text-align: center;
  }
  .partner-empty-state > span {
    color: var(--partner-green);
    font-size: 35px;
  }
  .partner-empty-state h3 {
    margin: 12px 0 6px;
    color: var(--partner-navy);
  }
  .partner-empty-state p {
    max-width: 540px;
    margin: 0;
    color: var(--partner-muted);
    line-height: 1.55;
  }
  .partner-empty-compact {
    min-height: 170px;
  }
  .partner-new-negotiation {
    scroll-margin-top: 20px;
    border-color: rgba(120, 183, 42, .38);
    box-shadow: 0 18px 55px rgba(71, 112, 31, .1);
  }
  .partner-negotiation-form {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 16px;
  }
  .partner-field {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 7px;
  }
  .partner-field > span,
  .partner-message-form label > span {
    color: var(--partner-navy);
    font-size: 12px;
    font-weight: 800;
  }
  .partner-field input,
  .partner-field select,
  .partner-field textarea,
  .partner-message-form textarea {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    padding: 13px 14px;
    border: 1px solid #c5d1d4;
    border-radius: 11px;
    color: var(--partner-ink);
    background: white;
    font: inherit;
  }
  .partner-field textarea,
  .partner-message-form textarea {
    resize: vertical;
    line-height: 1.5;
  }
  .partner-field > small {
    color: var(--partner-muted);
    font-size: 10px;
  }
  .partner-span-2 { grid-column: span 2; }
  .partner-span-4 { grid-column: 1 / -1; }
  .partner-negotiation-form > footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding-top: 7px;
  }
  .partner-negotiation-layout {
    display: grid;
    grid-template-columns: minmax(245px, .72fr) minmax(0, 1.7fr);
    gap: 17px;
  }
  .partner-negotiation-list {
    display: flex;
    max-height: 650px;
    flex-direction: column;
    gap: 8px;
    overflow-y: auto;
  }
  .partner-negotiation-item {
    display: flex;
    width: 100%;
    min-width: 0;
    flex-direction: column;
    align-items: flex-start;
    padding: 16px;
    border: 1px solid var(--partner-line);
    border-radius: 13px;
    color: var(--partner-ink);
    background: #f8faf8;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .partner-negotiation-item.partner-active {
    border-color: var(--partner-green);
    background: #f1f7ea;
    box-shadow: inset 3px 0 var(--partner-green);
  }
  .partner-negotiation-item strong {
    margin: 9px 0 5px;
    color: var(--partner-navy);
  }
  .partner-negotiation-item small,
  .partner-negotiation-item time {
    color: var(--partner-muted);
    font-size: 11px;
  }
  .partner-negotiation-item time {
    margin-top: 10px;
  }
  .partner-negotiation-status {
    display: inline-flex;
    width: fit-content;
    padding: 5px 8px;
    border-radius: 999px;
    color: #4e616a;
    background: #e7ecec;
    font-size: 9px;
    font-weight: 900;
    letter-spacing: .04em;
    text-transform: uppercase;
  }
  .partner-status-contraproposta,
  .partner-status-aguardando_parceiro {
    color: #775018;
    background: #faedce;
  }
  .partner-status-aprovada {
    color: #3c641b;
    background: #e5f1d5;
  }
  .partner-status-rejeitada,
  .partner-status-cancelada {
    color: #8d3730;
    background: #f8dfdc;
  }
  .partner-negotiation-thread {
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--partner-line);
    border-radius: 17px;
    background: #f5f8f5;
  }
  .partner-negotiation-thread > header {
    display: flex;
    justify-content: space-between;
    gap: 20px;
    padding: 20px;
    border-bottom: 1px solid var(--partner-line);
    background: white;
  }
  .partner-negotiation-thread > header h3 {
    margin: 8px 0 5px;
    color: var(--partner-navy);
  }
  .partner-negotiation-thread > header p,
  .partner-negotiation-thread > header > small {
    margin: 0;
    color: var(--partner-muted);
    font-size: 11px;
  }
  .partner-terms-summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    margin: 14px 20px;
  }
  .partner-terms-summary div {
    min-width: 0;
    padding: 10px;
    border-radius: 9px;
    background: #eaf0eb;
  }
  .partner-terms-summary dt {
    color: var(--partner-muted);
    font-size: 9px;
    text-transform: uppercase;
  }
  .partner-terms-summary dd {
    overflow-wrap: anywhere;
    margin: 4px 0 0;
    color: var(--partner-navy);
    font-size: 12px;
    font-weight: 800;
  }
  .partner-terms-compact {
    margin: 10px 0 0;
  }
  .partner-message-thread {
    display: flex;
    max-height: 430px;
    min-height: 230px;
    flex-direction: column;
    gap: 11px;
    overflow-y: auto;
    padding: 20px;
  }
  .partner-message {
    width: min(84%, 610px);
    padding: 13px 15px;
    border: 1px solid var(--partner-line);
    border-radius: 14px 14px 14px 4px;
    background: white;
  }
  .partner-message-parceiro {
    align-self: flex-end;
    border-color: #cadeb5;
    border-radius: 14px 14px 4px 14px;
    background: #edf6e4;
  }
  .partner-message-sistema {
    width: auto;
    align-self: stretch;
    border-style: dashed;
    color: var(--partner-muted);
    background: transparent;
    text-align: center;
  }
  .partner-message > header {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    color: var(--partner-navy);
    font-size: 10px;
  }
  .partner-message > header time {
    color: var(--partner-muted);
  }
  .partner-message > p {
    margin: 8px 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .partner-message-form {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: end;
    gap: 12px;
    padding: 16px 20px 20px;
    border-top: 1px solid var(--partner-line);
    background: white;
  }
  .partner-message-form label {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .partner-thread-closed {
    margin: 0 20px 20px;
    padding: 14px 16px;
    border-radius: 11px;
    color: var(--partner-muted);
    background: #e9eeeb;
  }
  .partner-thread-closed strong {
    color: var(--partner-navy);
  }
  .partner-thread-closed p {
    margin: 5px 0 0;
    font-size: 12px;
    line-height: 1.5;
  }
  .partner-policy-section {
    margin: 24px 0 70px;
    padding: clamp(24px, 4vw, 38px);
    border-radius: 26px;
    color: white;
    background: var(--partner-navy-deep);
  }
  .partner-policy-section h2 {
    color: white;
  }
  .partner-policy-section > div {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    margin-top: 25px;
  }
  .partner-policy-section article {
    padding: 18px;
    border: 1px solid rgba(255,255,255,.13);
    border-radius: 15px;
    background: rgba(255,255,255,.06);
  }
  .partner-policy-section article strong {
    display: block;
    margin: 11px 0 6px;
  }
  .partner-policy-section article p {
    margin: 0;
    color: rgba(255,255,255,.64);
    font-size: 12px;
    line-height: 1.5;
  }
  .partner-policy-dot {
    display: block;
    width: 12px;
    height: 12px;
    border-radius: 50%;
  }
  .partner-dot-forecast { background: var(--partner-gold); }
  .partner-dot-scheduled { background: #63a7cf; }
  .partner-dot-processing { background: #a889d5; }
  .partner-dot-paid { background: var(--partner-green); }
  .partner-portal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 30px;
    padding: 30px max(24px, calc((100vw - 1240px) / 2));
    border-top: 1px solid rgba(18, 63, 89, .12);
    background: white;
  }
  .partner-portal-footer p {
    max-width: 650px;
    margin: 0;
    color: var(--partner-muted);
    font-size: 12px;
    line-height: 1.5;
    text-align: center;
  }
  .partner-portal-footer small {
    color: var(--partner-muted);
    white-space: nowrap;
  }
  @media (max-width: 980px) {
    .partner-access-card {
      grid-template-columns: 1fr;
    }
    .partner-access-copy {
      min-height: auto;
      padding: 42px;
    }
    .partner-summary-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .partner-payment-guide {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .partner-payment-date-groups {
      grid-template-columns: 1fr;
    }
    .partner-negotiation-layout {
      grid-template-columns: 1fr;
    }
    .partner-negotiation-list {
      display: grid;
      max-height: none;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .partner-policy-section > div {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 680px) {
    .partner-access-page {
      padding: 12px;
    }
    .partner-access-card {
      border-radius: 20px;
    }
    .partner-access-brand {
      align-items: flex-start;
      flex-direction: column;
      padding: 22px;
    }
    .partner-access-copy,
    .partner-access-form {
      padding: 28px 22px;
    }
    .partner-access-copy h1 {
      font-size: 38px;
    }
    .partner-access-form > div:first-of-type {
      grid-template-columns: 1fr;
    }
    .partner-access-security {
      align-items: flex-start;
      padding: 17px 22px;
    }
    .partner-portal-topbar,
    .partner-portal-hero,
    .partner-portal-footer {
      padding-left: 18px;
      padding-right: 18px;
    }
    .partner-portal-topbar {
      align-items: flex-start;
      flex-direction: column;
    }
    .partner-portal-brand {
      align-items: flex-start;
      flex-direction: column;
      gap: 8px;
    }
    .partner-portal-brand span {
      padding: 0;
      border: 0;
    }
    .partner-portal-top-actions {
      width: 100%;
      justify-content: space-between;
    }
    .partner-portal-hero {
      align-items: stretch;
      flex-direction: column;
      padding-top: 44px;
      padding-bottom: 60px;
    }
    .partner-portal-hero aside {
      min-width: 0;
    }
    .partner-content-shell {
      width: min(calc(100% - 24px), 1240px);
    }
    .partner-summary-grid,
    .partner-policy-section > div,
    .partner-negotiation-list {
      grid-template-columns: 1fr;
    }
    .partner-summary-grid article {
      padding: 20px;
    }
    .partner-section-heading {
      align-items: stretch;
      flex-direction: column;
    }
    .partner-section-heading > .partner-primary-button {
      width: 100%;
    }
    .partner-payment-card {
      padding: 18px;
    }
    .partner-payment-card > header,
    .partner-payment-main {
      align-items: flex-start;
      flex-direction: column;
    }
    .partner-payment-main > strong {
      max-width: 100%;
      overflow-wrap: anywhere;
    }
    .partner-payment-execution-summary {
      grid-template-columns: 1fr;
      gap: 5px;
    }
    .partner-payment-date-group > div,
    .partner-payment-date-group-execution > div {
      grid-template-columns: 1fr;
    }
    .partner-payment-date-group span + span {
      border-top: 1px solid var(--partner-line);
      border-left: 0;
    }
    .partner-payment-forecast {
      align-items: flex-start;
      flex-direction: column;
    }
    .partner-payment-forecast small {
      margin-left: 0;
      text-align: left;
    }
    .partner-payment-timeline {
      grid-template-columns: 1fr;
      gap: 8px;
      margin-left: 5px;
    }
    .partner-payment-timeline span {
      min-height: 32px;
      flex-direction: row;
      text-align: left;
    }
    .partner-payment-timeline span:not(:last-child)::after {
      top: 28px;
      left: 13px;
      width: 2px;
      height: 12px;
    }
    .partner-payment-guide {
      grid-template-columns: 1fr;
    }
    .partner-payment-explanation {
      text-align: left;
    }
    .partner-negotiation-form {
      grid-template-columns: 1fr;
    }
    .partner-span-2,
    .partner-span-4 {
      grid-column: 1;
    }
    .partner-negotiation-form > footer {
      flex-direction: column-reverse;
    }
    .partner-negotiation-form > footer button {
      width: 100%;
    }
    .partner-negotiation-thread > header {
      flex-direction: column;
    }
    .partner-terms-summary {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .partner-message {
      width: 92%;
      box-sizing: border-box;
    }
    .partner-message-form {
      grid-template-columns: 1fr;
    }
    .partner-message-form button {
      width: 100%;
    }
    .partner-portal-footer {
      align-items: flex-start;
      flex-direction: column;
    }
    .partner-portal-footer p {
      text-align: left;
    }
  }
  @media print {
    .partner-portal-top-actions,
    .partner-primary-button,
    .partner-secondary-button,
    .partner-icon-button,
    .partner-negotiations-section,
    .partner-new-negotiation {
      display: none !important;
    }
    .partner-portal-root {
      background: white;
    }
    .partner-content-shell {
      width: 100%;
      margin: 0;
    }
    .partner-summary-grid article,
    .partner-section,
    .partner-payment-card {
      break-inside: avoid;
      box-shadow: none;
    }
  }
`;
