"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { calculatePace, type WorkPaceZone } from "../operations/work-progress";
import { brl } from "./utils";

function embed(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtube.com")) {
      const id = parsed.searchParams.get("v");
      return id ? `https://www.youtube.com/embed/${id}` : url;
    }
    if (parsed.hostname.includes("youtu.be"))
      return `https://www.youtube.com/embed/${parsed.pathname.slice(1)}`;
    return url;
  } catch {
    return url;
  }
}
function date(value: string) {
  return value
    ? new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString("pt-BR")
    : "—";
}
const portalPercentage = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const paceLabels: Record<WorkPaceZone, string> = {
  saudavel: "Dentro do ritmo",
  atencao: "Ritmo em atenção",
  risco: "Risco de atraso",
  critico: "Ritmo crítico",
};

interface PortalConstructionStage {
  id: string;
  code: string;
  name: string;
  actual_pct: number;
  planned_pct: number;
  status: "concluida" | "em_andamento" | "planejada";
}

interface PortalConstructionSummary {
  actual_pct: number;
  planned_pct: number;
  variance_pp: number;
  has_baseline: boolean;
  package_count: number;
  completed_count: number;
  last_updated: string | null;
  stages: PortalConstructionStage[];
}

interface PortalContentItem {
  id: string;
  content_type?: string;
  type?: string;
  title: string;
  subtitle?: string | null;
  body?: string | null;
  media_url?: string | null;
  cta_label?: string | null;
  cta_url?: string | null;
  featured: boolean;
}

interface PortalFinancialEntry {
  id: string;
  description: string;
  amount: number;
  due_date: string;
  status: string;
}

interface PortalDocument {
  id: string;
  name: string;
  type: string;
  notes?: string | null;
}

interface PortalMessage {
  id: string;
  sender_name?: string | null;
  sender_type: string;
  message: string;
  created_at: string;
}

interface PortalData {
  settings?: {
    theme_primary?: string | null;
    theme_accent?: string | null;
    show_works?: boolean | null;
  } | null;
  customer?: { name?: string | null } | null;
  contract: { number: string };
  project?: { name?: string | null } | null;
  unit?: { code?: string | null } | null;
  financial?: PortalFinancialEntry[] | null;
  content?: PortalContentItem[] | null;
  documents?: PortalDocument[] | null;
  messages?: PortalMessage[] | null;
  construction?: PortalConstructionSummary | null;
}

const clampPercent = (value: number) =>
  Math.min(100, Math.max(0, Number(value) || 0));
const formatPercent = (value: number) =>
  `${portalPercentage.format(clampPercent(value))}%`;
const formatVariance = (value: number) =>
  `${value > 0 ? "+" : ""}${portalPercentage.format(value)} pp`;

async function fetchPortalData(token: string): Promise<PortalData> {
  const client = getSupabase();
  if (!client) throw new Error("Portal indisponível.");
  const result = await client.rpc("get_post_sale_portal_v2", {
    p_token: token,
  });
  if (result.error || !result.data)
    throw new Error("Este acesso é inválido ou expirou.");
  return result.data as PortalData;
}

export function CustomerPortalV64({ token }: { token: string }) {
  const [data, setData] = useState<PortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [referenceTime] = useState(() => Date.now());
  useEffect(() => {
    let active = true;
    void fetchPortalData(token)
      .then((portalData) => {
        if (!active) return;
        setData(portalData);
        setError("");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Este acesso é inválido ou expirou.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token]);

  const financial = useMemo<PortalFinancialEntry[]>(
    () => data?.financial || [],
    [data],
  );
  const summary = useMemo(() => {
    const result = {
      paid: 0,
      overdue: 0,
      due: 0,
      open: 0,
      paidCount: 0,
      overdueCount: 0,
      dueCount: 0,
      openCount: 0,
    };
    const now = referenceTime,
      limit = referenceTime + 30 * 86400000;
    for (const item of financial) {
      const amount = Number(item.amount || 0),
        status = String(item.status || "").toLowerCase(),
        time = item.due_date
          ? new Date(`${item.due_date}T12:00:00`).getTime()
          : 0;
      if (["recebido", "pago", "liquidado"].includes(status)) {
        result.paid += amount;
        result.paidCount++;
      } else if (status === "vencido" || (time && time < now)) {
        result.overdue += amount;
        result.overdueCount++;
      } else if (time && time <= limit) {
        result.due += amount;
        result.dueCount++;
      } else {
        result.open += amount;
        result.openCount++;
      }
    }
    return result;
  }, [financial, referenceTime]);

  async function quickRequest(subject: string, message: string) {
    setBusy(true);
    setFeedback("");
    const client = getSupabase();
    if (!client) {
      setFeedback("Portal indisponível.");
      setBusy(false);
      return;
    }
    const result = await client.rpc("send_portal_message", {
      p_token: token,
      p_subject: subject,
      p_message: message,
    });
    setFeedback(
      result.error
        ? result.error.message
        : "Solicitação enviada para a equipe de pós-venda.",
    );
    setBusy(false);
    if (!result.error) {
      try {
        setData(await fetchPortalData(token));
      } catch {
        setFeedback(
          "Solicitação enviada, mas o portal não conseguiu atualizar o histórico agora.",
        );
      }
    }
  }
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await quickRequest(
      String(form.get("subject") || "Atendimento"),
      String(form.get("message") || ""),
    );
    if (!error) event.currentTarget.reset();
  }

  if (loading)
    return (
      <div className="customer-portal-loading">
        <img src="/evora-brand.svg" alt="Évora Urbanismo" />
        <div className="spinner" />
        <p>Preparando seu portal...</p>
      </div>
    );
  if (error)
    return (
      <div className="customer-portal-error">
        <img src="/evora-brand.svg" alt="Évora Urbanismo" />
        <h1>Acesso indisponível</h1>
        <p>{error}</p>
      </div>
    );
  if (!data)
    return (
      <div className="customer-portal-error">
        <img src="/evora-brand.svg" alt="Évora Urbanismo" />
        <h1>Acesso indisponível</h1>
        <p>Não foi possível carregar os dados deste portal.</p>
      </div>
    );

  const cfg = data.settings || {},
    items: PortalContentItem[] = data.content || [],
    featured = items.filter((item) => item.featured),
    feed = items.filter((item) => !item.featured),
    first = String(data.customer?.name || "Cliente").split(" ")[0];
  const construction = (data.construction ||
    null) as PortalConstructionSummary | null;
  const constructionActual = clampPercent(construction?.actual_pct || 0);
  const constructionPlanned = clampPercent(construction?.planned_pct || 0);
  const constructionPace = construction?.has_baseline
    ? calculatePace(constructionActual, constructionPlanned)
    : null;
  const constructionStatus = !construction
    ? "Atualização técnica indisponível"
    : !construction.package_count
      ? "Estrutura da obra em preparação"
      : !construction.has_baseline
        ? "Linha de base ainda não informada"
        : constructionPace?.accelerated
          ? "Ritmo acelerado"
          : paceLabels[constructionPace?.zone || "critico"];
  const constructionUpdated = construction?.last_updated
    ? new Date(construction.last_updated).toLocaleDateString("pt-BR")
    : "—";
  const shortcuts = [
    {
      icon: "▤",
      label: "Extrato financeiro",
      hint: "Parcelas e vencimentos",
      href: "#financeiro",
    },
    {
      icon: "▧",
      label: "Segunda via do boleto",
      hint: "Solicitar ao financeiro",
      action: () =>
        quickRequest(
          "Segunda via de cobrança",
          `Solicito a segunda via da cobrança do contrato ${data.contract.number}.`,
        ),
    },
    {
      icon: "✓",
      label: "Valores pagos",
      hint: "Demonstrativo recebido",
      href: "#pagos",
    },
    {
      icon: "↗",
      label: "Antecipação ou quitação",
      hint: "Receber simulação",
      action: () =>
        quickRequest(
          "Antecipação ou quitação",
          `Solicito uma simulação de antecipação ou quitação do contrato ${data.contract.number}.`,
        ),
    },
    {
      icon: "▦",
      label: "Empreendimento",
      hint: "Obra e unidade",
      href: "#empreendimento",
    },
    {
      icon: "•••",
      label: "Acesso e senha",
      hint: "Atualizar segurança",
      action: () =>
        quickRequest(
          "Alteração de acesso",
          `Solicito orientação para alteração das credenciais de acesso ao portal do contrato ${data.contract.number}.`,
        ),
    },
  ];

  return (
    <div
      className="consumer-portal-v64"
      style={
        {
          "--portal-primary": cfg.theme_primary || "#1D5271",
          "--portal-accent": cfg.theme_accent || "#79B82B",
        } as React.CSSProperties
      }
    >
      <header className="consumer-top">
        <img src="/evora-brand.svg" alt="Évora Urbanismo" />
        <span>Portal do cliente</span>
        <b>●</b>
      </header>
      <section className="consumer-greeting">
        <small>OLÁ,</small>
        <h1>{first}</h1>
        <p>
          {data.project?.name} · Unidade {data.unit?.code}
        </p>
      </section>
      <main>
        <section className="consumer-shortcuts">
          {shortcuts.map((item) =>
            item.href ? (
              <a key={item.label} href={item.href}>
                <b>{item.icon}</b>
                <span>
                  {item.label}
                  <small>{item.hint}</small>
                </span>
              </a>
            ) : (
              <button key={item.label} disabled={busy} onClick={item.action}>
                <b>{item.icon}</b>
                <span>
                  {item.label}
                  <small>{item.hint}</small>
                </span>
              </button>
            ),
          )}
        </section>
        {feedback && (
          <button className="consumer-feedback" onClick={() => setFeedback("")}>
            {feedback}
            <span>×</span>
          </button>
        )}

        {cfg.show_works !== false && (
          <section
            id="empreendimento"
            className="consumer-card consumer-project-card"
          >
            <header>
              <div>
                <small>IMPLANTAÇÃO DO LOTEAMENTO</small>
                <h2>{data.project?.name}</h2>
              </div>
              <a href="#obra">Ver etapas</a>
            </header>
            {construction && construction.package_count > 0 ? (
              <div className="consumer-progress consumer-work-summary">
                <div
                  className="consumer-gauge"
                  style={
                    {
                      "--progress": `${constructionActual / 2}%`,
                    } as React.CSSProperties
                  }
                >
                  <strong>{formatPercent(constructionActual)}</strong>
                  <small>realizado</small>
                </div>
                <div>
                  <b>Avanço geral do empreendimento</b>
                  <span>
                    {constructionActual > 0
                      ? "Percentual físico ponderado pelas etapas da EAP"
                      : "Medições de avanço ainda não lançadas"}
                  </span>
                  <div className="consumer-work-metrics">
                    <span>
                      <small>Realizado</small>
                      <strong>{formatPercent(constructionActual)}</strong>
                    </span>
                    <span>
                      <small>Previsto</small>
                      <strong>
                        {construction.has_baseline
                          ? formatPercent(constructionPlanned)
                          : "—"}
                      </strong>
                    </span>
                    <span>
                      <small>Situação do ritmo</small>
                      <strong>{constructionStatus}</strong>
                    </span>
                  </div>
                  <p className="consumer-work-scope">
                    Este resumo acompanha a implantação geral do loteamento. Ele
                    não representa a execução individual da sua quadra ou do seu
                    lote.
                  </p>
                  <small className="consumer-work-updated">
                    Dados da Gestão de Obras atualizados em{" "}
                    {constructionUpdated}
                  </small>
                </div>
              </div>
            ) : (
              <div className="consumer-work-empty">
                <strong>Resumo físico em preparação</strong>
                <p>
                  A equipe técnica ainda não publicou medições da EAP deste
                  empreendimento.
                </p>
              </div>
            )}
          </section>
        )}

        <section className="consumer-card consumer-finance-summary">
          <header>
            <div>
              <small>FINANCEIRO</small>
              <h2>{financial.length} parcelas</h2>
            </div>
            <a href="#financeiro">Extrato financeiro</a>
          </header>
          <div className="consumer-status-bar">
            <i className="paid" style={{ flex: summary.paidCount || 0 }} />
            <i
              className="overdue"
              style={{ flex: summary.overdueCount || 0 }}
            />
            <i className="due" style={{ flex: summary.dueCount || 0 }} />
            <i className="open" style={{ flex: summary.openCount || 1 }} />
          </div>
          <div className="consumer-legend">
            <span>
              <i className="paid" />
              Pago <b>{summary.paidCount}</b>
            </span>
            <span>
              <i className="overdue" />
              Atraso <b>{summary.overdueCount}</b>
            </span>
            <span>
              <i className="due" />
              Vence <b>{summary.dueCount}</b>
            </span>
            <span>
              <i className="open" />
              Aberto <b>{summary.openCount}</b>
            </span>
          </div>
          <footer>
            <strong>{data.project?.name}</strong>
            <span>{data.unit?.code}</span>
          </footer>
        </section>

        {featured.length > 0 && (
          <section className="consumer-card consumer-feature">
            <header>
              <small>DESTAQUES</small>
              <h2>Novidades para você</h2>
            </header>
            <div>
              {featured.slice(0, 3).map((item) => (
                <article key={item.id}>
                  {item.media_url &&
                  (item.content_type || item.type) === "video" ? (
                    <iframe
                      src={embed(item.media_url)}
                      title={item.title}
                      allowFullScreen
                    />
                  ) : item.media_url ? (
                    <img src={item.media_url} alt="" />
                  ) : (
                    <span className="consumer-placeholder">É</span>
                  )}
                  <div>
                    <small>{item.content_type || item.type}</small>
                    <h3>{item.title}</h3>
                    <p>{item.subtitle || item.body}</p>
                    {item.cta_url && (
                      <a
                        href={item.cta_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {item.cta_label || "Saiba mais"}
                      </a>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        {cfg.show_works !== false && (
          <section id="obra" className="consumer-card consumer-work-details">
            <header>
              <div>
                <small>RESUMO FÍSICO REAL</small>
                <h2>Principais etapas da implantação</h2>
                <p>
                  Visão simplificada, alimentada pelas medições da Gestão de
                  Obras.
                </p>
              </div>
              {construction && construction.package_count > 0 && (
                <span
                  className={`consumer-pace consumer-pace-${constructionPace?.zone || "neutral"}`}
                >
                  {constructionStatus}
                </span>
              )}
            </header>
            {construction && construction.package_count > 0 ? (
              <>
                <div className="consumer-work-comparison">
                  <span>
                    <small>Realizado</small>
                    <strong>{formatPercent(constructionActual)}</strong>
                    <i>
                      <b style={{ width: `${constructionActual}%` }} />
                    </i>
                  </span>
                  <span>
                    <small>Previsto</small>
                    <strong>
                      {construction.has_baseline
                        ? formatPercent(constructionPlanned)
                        : "Não informado"}
                    </strong>
                    <i>
                      <b style={{ width: `${constructionPlanned}%` }} />
                    </i>
                  </span>
                  <span>
                    <small>Desvio</small>
                    <strong>
                      {construction.has_baseline
                        ? formatVariance(Number(construction.variance_pp || 0))
                        : "—"}
                    </strong>
                    <em>
                      {construction.completed_count} de{" "}
                      {construction.package_count} itens concluídos
                    </em>
                  </span>
                </div>
                <div className="consumer-milestones consumer-construction-stages">
                  {construction.stages.map((stage) => (
                    <article key={stage.id} data-status={stage.status}>
                      <div>
                        <small>{stage.code}</small>
                        <strong>{stage.name}</strong>
                        <span>
                          {stage.status === "concluida"
                            ? "Concluída"
                            : stage.status === "em_andamento"
                              ? "Em andamento"
                              : "Planejada"}
                        </span>
                      </div>
                      <b>{formatPercent(stage.actual_pct)}</b>
                      <div className="consumer-stage-bars">
                        <label>
                          <span>Realizado</span>
                          <i>
                            <b
                              style={{
                                width: `${clampPercent(stage.actual_pct)}%`,
                              }}
                            />
                          </i>
                        </label>
                        <label>
                          <span>Previsto</span>
                          <i>
                            <b
                              style={{
                                width: `${clampPercent(stage.planned_pct)}%`,
                              }}
                            />
                          </i>
                        </label>
                      </div>
                    </article>
                  ))}
                </div>
              </>
            ) : (
              <div className="consumer-work-empty">
                <strong>Nenhuma medição física disponível</strong>
                <p>
                  Quando a EAP receber medições na Gestão de Obras, o resumo
                  aparecerá automaticamente aqui.
                </p>
              </div>
            )}
          </section>
        )}

        {feed.length > 0 && (
          <section className="consumer-card consumer-news">
            <header>
              <small>CONTEÚDO</small>
              <h2>Notícias e orientações</h2>
            </header>
            <div>
              {feed.map((item) => (
                <article key={item.id}>
                  {item.media_url &&
                  (item.content_type || item.type) === "video" ? (
                    <iframe src={embed(item.media_url)} title={item.title} />
                  ) : item.media_url ? (
                    <img src={item.media_url} alt="" />
                  ) : null}
                  <div>
                    <h3>{item.title}</h3>
                    <p>{item.subtitle || item.body}</p>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        <section id="financeiro" className="consumer-card">
          <header>
            <small>EXTRATO FINANCEIRO</small>
            <h2>Parcelas do contrato</h2>
          </header>
          <div className="consumer-financial-list">
            {financial.map((item) => (
              <article key={item.id}>
                <span>
                  <strong>{item.description}</strong>
                  <small>{date(item.due_date)}</small>
                </span>
                <b>{brl.format(Number(item.amount))}</b>
                <i data-status={item.status}>{item.status}</i>
              </article>
            ))}
          </div>
        </section>

        <section id="pagos" className="consumer-card">
          <header>
            <small>DEMONSTRATIVO</small>
            <h2>Valores pagos</h2>
          </header>
          <div className="consumer-paid-total">
            <span>Total confirmado</span>
            <strong>{brl.format(summary.paid)}</strong>
          </div>
          <div className="consumer-financial-list">
            {financial
              .filter((item) =>
                ["recebido", "pago", "liquidado"].includes(
                  String(item.status).toLowerCase(),
                ),
              )
              .map((item) => (
                <article key={item.id}>
                  <span>
                    <strong>{item.description}</strong>
                    <small>{date(item.due_date)}</small>
                  </span>
                  <b>{brl.format(Number(item.amount))}</b>
                  <i data-status="recebido">recebido</i>
                </article>
              ))}
          </div>
        </section>

        <section id="documentos" className="consumer-card">
          <header>
            <small>DOCUMENTOS</small>
            <h2>Arquivos do contrato</h2>
          </header>
          <div className="consumer-documents">
            {(data.documents || []).map((doc) => (
              <article key={doc.id}>
                <b>▧</b>
                <span>
                  <strong>{doc.name}</strong>
                  <small>
                    {doc.type} · {doc.notes || "Documento disponível"}
                  </small>
                </span>
              </article>
            ))}
            {!data.documents?.length && <p>Nenhum documento foi liberado.</p>}
          </div>
        </section>

        <section id="atendimento" className="consumer-card consumer-contact">
          <div>
            <small>ATENDIMENTO</small>
            <h2>Fale com a Évora</h2>
            <p>Solicitações ficam vinculadas ao histórico do seu contrato.</p>
            <div>
              {(data.messages || []).slice(-5).map((message) => (
                <article key={message.id}>
                  <strong>{message.sender_name || message.sender_type}</strong>
                  <p>{message.message}</p>
                  <small>
                    {new Date(message.created_at).toLocaleString("pt-BR")}
                  </small>
                </article>
              ))}
            </div>
          </div>
          <form onSubmit={send}>
            <label>
              Assunto
              <input
                name="subject"
                required
                placeholder="Como podemos ajudar?"
              />
            </label>
            <label>
              Mensagem
              <textarea name="message" rows={5} required />
            </label>
            <button disabled={busy}>
              {busy ? "Enviando..." : "Enviar mensagem"}
            </button>
          </form>
        </section>
      </main>
      <footer className="consumer-footer">
        <img src="/evora-brand.svg" alt="Évora Urbanismo" />
        <span>
          Ambiente pessoal e protegido · Contrato {data.contract?.number}
        </span>
      </footer>
    </div>
  );
}
