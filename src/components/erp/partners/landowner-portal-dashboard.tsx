"use client";

import { useMemo, useState } from "react";
import type {
  LandownerPeriodMonth,
  LandownerPortalPublication,
  LandownerPortalPayload,
} from "./partner-types";
import { LandownerSalesMapView } from "./landowner-sales-map";

const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const number = new Intl.NumberFormat("pt-BR", {
  maximumFractionDigits: 2,
});
const date = new Intl.DateTimeFormat("pt-BR");
const dateTime = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
});
const monthName = new Intl.DateTimeFormat("pt-BR", {
  month: "short",
  year: "numeric",
});

function day(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? "—" : date.format(parsed);
}

function timestamp(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : dateTime.format(parsed);
}

function competence(value: string) {
  const parsed = new Date(`${value}-01T12:00:00`);
  return Number.isNaN(parsed.getTime())
    ? value
    : monthName.format(parsed).replace(".", "");
}

function amount(value: number | null | undefined) {
  return currency.format(Number(value || 0));
}

function percent(value: number | null | undefined) {
  return `${number.format(Number(value || 0))}%`;
}

function precisePercent(value: number | null | undefined) {
  return `${Number(value || 0).toLocaleString("pt-BR", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  })}%`;
}

function repassStatus(value: string) {
  const labels: Record<string, string> = {
    pago: "Pago com baixa confirmada",
    aguardando_baixa: "Aguardando baixa financeira",
    pendente: "Pendente",
    vencido: "Vencido",
    rascunho: "Em preparação",
  };
  return labels[value] || value.replaceAll("_", " ");
}

export function LandownerPortalDashboard({
  portal,
}: {
  portal: LandownerPortalPayload;
}) {
  const publications = portal.publications;
  const [publicationId, setPublicationId] = useState(
    publications[0]?.id || "",
  );

  const publication = useMemo(
    () =>
      publications.find(item => item.id === publicationId) ||
      publications[0] ||
      null,
    [publicationId, publications],
  );

  if (!publication) {
    return (
      <section className="landowner-public-empty">
        <span aria-hidden="true">◇</span>
        <div>
          <h2>Nenhum fechamento publicado</h2>
          <p>
            A Évora ainda não disponibilizou indicadores comerciais,
            financeiros ou físicos para este acesso.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="landowner-public-root">
      <header className="landowner-public-heading">
        <div>
          <small>PAINEL DO TERRENISTA</small>
          <h2>Visão consolidada do empreendimento</h2>
          <p>
            Fechamento versionado, com dados publicados expressamente pela
            Évora e sem informações pessoais dos compradores.
          </p>
        </div>
        {publications.length > 1 && (
          <label>
            <span>Empreendimento</span>
            <select
              value={publication.id}
              onChange={event => setPublicationId(event.target.value)}
            >
              {publications.map(item => (
                <option value={item.id} key={item.id}>
                  {item.project.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      <div className="landowner-public-context">
        <div>
          <small>{publication.project.code}</small>
          <strong>{publication.project.name}</strong>
          <span>
            Período de {day(publication.period.start)} a{" "}
            {day(publication.period.end)}
          </span>
          {publication.period.position_note && (
            <span>{publication.period.position_note}.</span>
          )}
        </div>
        <div>
          <small>PUBLICAÇÃO CONTROLADA</small>
          <strong>Versão {publication.version}</strong>
          <span>Publicada em {timestamp(publication.published_at)}</span>
        </div>
      </div>

      {publication.public_note && (
        <aside className="landowner-public-note">
          <b>Comunicado da Évora</b>
          <p>{publication.public_note}</p>
        </aside>
      )}

      <LandownerSummary publication={publication} />
      {publication.sales_map && (
        <LandownerSalesMapView
          key={`sales-map-${publication.id}`}
          map={publication.sales_map}
        />
      )}
      {publication.period_statement && (
        <PeriodStatementSection
          key={publication.id}
          publication={publication}
        />
      )}

      <div className="landowner-public-sections">
        {publication.construction && (
          <ConstructionSection publication={publication} />
        )}
        {publication.delinquency && (
          <DelinquencySection publication={publication} />
        )}
        {publication.repasses && (
          <RepassSection publication={publication} />
        )}
        {publication.sales_conditions && (
          <SalesConditionsSection publication={publication} />
        )}
      </div>

      <footer className="landowner-public-governance">
        <span aria-hidden="true">✓</span>
        <p>
          {portal.governance_note} Datas de vencimento não equivalem a
          liquidação; repasses pagos dependem de baixa financeira confirmada.
        </p>
      </footer>
    </section>
  );
}

function PeriodStatementSection({
  publication,
}: {
  publication: LandownerPortalPublication;
}) {
  const statement = publication.period_statement!;
  const delinquencyVisible =
    statement.visibility?.delinquency !== false;
  const repassesVisible = statement.visibility?.repasses !== false;
  const rows = useMemo(
    () =>
      [...(statement.months || [])].sort((left, right) =>
        left.month.localeCompare(right.month),
      ),
    [statement.months],
  );
  const firstMonth = rows[0]?.month || "";
  const lastMonth = rows[rows.length - 1]?.month || "";
  const [fromMonth, setFromMonth] = useState(firstMonth);
  const [toMonth, setToMonth] = useState(lastMonth);

  const selectedRows = useMemo(
    () =>
      rows.filter(
        row =>
          (!fromMonth || row.month >= fromMonth) &&
          (!toMonth || row.month <= toMonth),
      ),
    [fromMonth, rows, toMonth],
  );

  const flowTotals = useMemo(
    () =>
      selectedRows.reduce(
        (totals, row) => ({
          received: totals.received + Number(row.received_amount || 0),
          repassDue:
            totals.repassDue + Number(row.repass_due_amount || 0),
          repassed: totals.repassed + Number(row.repassed_amount || 0),
        }),
        { received: 0, repassDue: 0, repassed: 0 },
      ),
    [selectedRows],
  );
  const closing =
    selectedRows[selectedRows.length - 1] ||
    rows[rows.length - 1] ||
    null;
  const chartMaximum = Math.max(
    1,
    ...selectedRows.flatMap(row => {
      const values = [Number(row.received_amount || 0)];
      if (delinquencyVisible) {
        values.push(Number(row.overdue_amount || 0));
      }
      if (repassesVisible) {
        values.push(Number(row.repass_due_amount || 0));
      }
      return values;
    }),
  );

  function barWidth(value: number | null | undefined) {
    const numeric = Number(value || 0);
    return numeric > 0
      ? `${Math.max(2, (numeric / chartMaximum) * 100)}%`
      : "0%";
  }

  function chooseLastMonths(count: number | null) {
    if (!rows.length) return;
    const startIndex =
      count === null ? 0 : Math.max(0, rows.length - count);
    setFromMonth(rows[startIndex].month);
    setToMonth(rows[rows.length - 1].month);
  }

  if (!rows.length) return null;

  return (
    <article className="landowner-public-card landowner-period-card">
      <header>
        <div>
          <small>DEMONSTRATIVO FINANCEIRO PUBLICADO</small>
          <h3>Recebimentos, inadimplência e repasses</h3>
          <p>
            Consulte qualquer mês ou intervalo dentro deste fechamento.
          </p>
        </div>
        <strong>
          {repassesVisible
            ? statement.configured
              ? precisePercent(statement.contractual_percentage)
              : "Regra não informada"
            : "Fechamento publicado"}
        </strong>
      </header>

      <div className="landowner-period-toolbar">
        <label>
          <span>Mês inicial</span>
          <input
            type="month"
            min={firstMonth}
            max={toMonth || lastMonth}
            value={fromMonth}
            onChange={event => {
              const next = event.target.value;
              setFromMonth(next);
              if (toMonth && next > toMonth) setToMonth(next);
            }}
          />
        </label>
        <label>
          <span>Mês final</span>
          <input
            type="month"
            min={fromMonth || firstMonth}
            max={lastMonth}
            value={toMonth}
            onChange={event => {
              const next = event.target.value;
              setToMonth(next);
              if (fromMonth && next < fromMonth) setFromMonth(next);
            }}
          />
        </label>
        <div className="landowner-period-shortcuts" aria-label="Períodos rápidos">
          <button type="button" onClick={() => chooseLastMonths(1)}>
            Último mês
          </button>
          <button type="button" onClick={() => chooseLastMonths(3)}>
            3 meses
          </button>
          <button type="button" onClick={() => chooseLastMonths(6)}>
            6 meses
          </button>
          <button type="button" onClick={() => chooseLastMonths(12)}>
            12 meses
          </button>
          <button type="button" onClick={() => chooseLastMonths(null)}>
            Todo o fechamento
          </button>
        </div>
      </div>

      <div className="landowner-period-kpis">
        <span>
          <small>Recebido no período</small>
          <strong>{amount(flowTotals.received)}</strong>
          <i>Baixas entre os meses selecionados</i>
        </span>
        {delinquencyVisible && (
          <span>
            <small>Inadimplência no encerramento</small>
            <strong>{amount(closing?.overdue_amount)}</strong>
            <i>
              {percent(closing?.overdue_rate_pct)} ·{" "}
              {closing?.overdue_installments || 0} parcela(s)
            </i>
          </span>
        )}
        {repassesVisible && (
          <>
            <span>
              <small>Repasse devido no período</small>
              <strong>
                {statement.configured ? amount(flowTotals.repassDue) : "—"}
              </strong>
              <i>Recebido × percentual contratual</i>
            </span>
            <span>
              <small>Repasses realizados no período</small>
              <strong>{amount(flowTotals.repassed)}</strong>
              <i>Pagamentos com baixa confirmada</i>
            </span>
          </>
        )}
      </div>

      <div className="landowner-period-chart">
        <div className="landowner-period-legend" aria-hidden="true">
          <span className="received">Recebido</span>
          {delinquencyVisible && (
            <span className="overdue">Inadimplência</span>
          )}
          {repassesVisible && (
            <span className="repass">Repasse devido</span>
          )}
        </div>
        {selectedRows.map(row => (
          <article key={row.month}>
            <time dateTime={row.month}>{competence(row.month)}</time>
            <div>
              <span>
                <i>
                  <b
                    className="received"
                    style={{ width: barWidth(row.received_amount) }}
                  />
                </i>
                <strong>{amount(row.received_amount)}</strong>
              </span>
              {delinquencyVisible && (
                <span>
                  <i>
                    <b
                      className="overdue"
                      style={{ width: barWidth(row.overdue_amount) }}
                    />
                  </i>
                  <strong>{amount(row.overdue_amount)}</strong>
                </span>
              )}
              {repassesVisible && (
                <span>
                  <i>
                    <b
                      className="repass"
                      style={{ width: barWidth(row.repass_due_amount) }}
                    />
                  </i>
                  <strong>
                    {row.repass_due_amount == null
                      ? "—"
                      : amount(row.repass_due_amount)}
                  </strong>
                </span>
              )}
            </div>
          </article>
        ))}
      </div>

      <div
        className="landowner-period-table"
        role="region"
        aria-label="Demonstrativo mensal detalhado"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th scope="col">Competência</th>
              <th scope="col">Recebido</th>
              {delinquencyVisible && (
                <>
                  <th scope="col">Inadimplência</th>
                  <th scope="col">Índice</th>
                </>
              )}
              {repassesVisible && (
                <>
                  <th scope="col">Repasse devido</th>
                  <th scope="col">Repassado</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {selectedRows.map((row: LandownerPeriodMonth) => (
              <tr key={row.month}>
                <th scope="row">{competence(row.month)}</th>
                <td>{amount(row.received_amount)}</td>
                {delinquencyVisible && (
                  <>
                    <td>{amount(row.overdue_amount)}</td>
                    <td>{percent(row.overdue_rate_pct)}</td>
                  </>
                )}
                {repassesVisible && (
                  <>
                    <td>
                      {row.repass_due_amount == null
                        ? "—"
                        : amount(row.repass_due_amount)}
                    </td>
                    <td>{amount(row.repassed_amount)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="landowner-period-basis">
        <p>{statement.basis}</p>
        <small>{statement.reconstruction_note}</small>
      </div>
    </article>
  );
}

function LandownerSummary({
  publication,
}: {
  publication: LandownerPortalPublication;
}) {
  const summary = publication.summary;
  if (!summary) return null;

  const cards = [
    summary.total_lots !== undefined
      ? {
          label: "Lotes vendidos",
          value: `${summary.sold_lots || 0} de ${summary.total_lots}`,
          detail: `${summary.available_lots || 0} disponíveis atualmente`,
        }
      : null,
    summary.total_vgv !== undefined
      ? {
          label: "VGV total",
          value: amount(summary.total_vgv),
          detail: "Tabela vigente das unidades ativas",
        }
      : null,
    summary.sold_vgv !== undefined
      ? {
          label: "VGV vendido",
          value: amount(summary.sold_vgv),
          detail: `${percent(summary.sold_vgv_pct)} do VGV total`,
        }
      : null,
    summary.vso_pct !== undefined
      ? {
          label: "VSO do período",
          value: percent(summary.vso_pct),
          detail: `${summary.sales_in_period || 0} venda(s) assinada(s)`,
        }
      : null,
  ].filter(
    (
      card,
    ): card is {
      label: string;
      value: string;
      detail: string;
    } => Boolean(card),
  );

  if (!cards.length) return null;

  return (
    <>
      <div className="landowner-public-kpis">
        {cards.map(card => (
          <article key={card.label}>
            <small>{card.label}</small>
            <strong title={card.value}>{card.value}</strong>
            <span>{card.detail}</span>
          </article>
        ))}
      </div>
      {summary.vso_basis && (
        <p className="landowner-public-basis">
          <b>Base da VSO:</b> {summary.vso_basis}.
        </p>
      )}
    </>
  );
}

function ConstructionSection({
  publication,
}: {
  publication: LandownerPortalPublication;
}) {
  const work = publication.construction!;
  const actual = Math.max(0, Math.min(100, Number(work.actual_progress_pct)));
  const planned = Math.max(0, Math.min(100, Number(work.planned_progress_pct)));

  return (
    <article className="landowner-public-card landowner-work-card">
      <header>
        <div>
          <small>ANDAMENTO DA OBRA</small>
          <h3>Avanço físico consolidado</h3>
        </div>
        <strong>{percent(actual)}</strong>
      </header>
      <div className="landowner-work-bars">
        <label>
          <span>
            <b>Realizado</b>
            <strong>{percent(actual)}</strong>
          </span>
          <i>
            <b style={{ width: `${actual}%` }} />
          </i>
        </label>
        <label>
          <span>
            <b>Previsto</b>
            <strong>{percent(planned)}</strong>
          </span>
          <i>
            <b style={{ width: `${planned}%` }} />
          </i>
        </label>
      </div>
      <p>
        Desvio: <b>{percent(work.deviation_pct)}</b> · {work.stage_count}{" "}
        etapa(s) · {work.source}
      </p>
      {!!work.stages?.length && (
        <div className="landowner-work-stages">
          {work.stages.map(stage => (
            <div key={stage.id}>
              <span>
                <small>{stage.code}</small>
                <strong>{stage.name}</strong>
              </span>
              <b>{percent(stage.actual_progress_pct)}</b>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function DelinquencySection({
  publication,
}: {
  publication: LandownerPortalPublication;
}) {
  const data = publication.delinquency!;
  return (
    <article className="landowner-public-card landowner-delinquency-card">
      <header>
        <div>
          <small>CARTEIRA DE RECEBÍVEIS</small>
          <h3>Inadimplência</h3>
        </div>
        <strong>{percent(data.overdue_rate_pct)}</strong>
      </header>
      <div className="landowner-mini-kpis">
        <span>
          <small>Carteira aberta</small>
          <strong>{amount(data.open_total)}</strong>
        </span>
        <span>
          <small>Saldo vencido</small>
          <strong>{amount(data.overdue_amount)}</strong>
        </span>
        <span>
          <small>Parcelas vencidas</small>
          <strong>{data.overdue_installments}</strong>
        </span>
      </div>
      <p>{data.basis}.</p>
    </article>
  );
}

function RepassSection({
  publication,
}: {
  publication: LandownerPortalPublication;
}) {
  const repasses = publication.repasses!;
  const contractualPercentage = Number(
    repasses.contractual_percentage || 0,
  );
  const hasContractualRule =
    contractualPercentage > 0 && contractualPercentage <= 100;
  const overpaidAmount = Number(repasses.overpaid_amount || 0);
  const hasExecutionSummary = [
    repasses.paid_amount,
    repasses.due_not_repassed,
    repasses.total_not_repassed,
  ].some(value => value !== undefined);
  const hasExecutionDetails = Boolean(repasses.entries?.length);
  return (
    <article className="landowner-public-card landowner-repass-card">
      <header>
        <div>
          <small>PRESTAÇÃO DE CONTAS</small>
          <h3>Repasses do terrenista</h3>
        </div>
      </header>
      {!hasContractualRule && !repasses.configured && (
        <div className="landowner-repass-unconfigured">
          <b>Percentual contratual não informado nesta versão</b>
          <p>
            Este fechamento não contém uma regra percentual publicada para o
            empreendimento. O portal não presume percentuais ou valores
            contratuais automaticamente.
          </p>
        </div>
      )}
      {hasContractualRule && (
        <section
          className="landowner-contract-accounting"
          aria-labelledby={`landowner-contract-accounting-${publication.id}`}
        >
          <header>
            <div>
              <small>REGRA CONTRATUAL PUBLICADA</small>
              <h4 id={`landowner-contract-accounting-${publication.id}`}>
                Apuração sobre recebimentos liquidados
              </h4>
            </div>
            <strong>{precisePercent(contractualPercentage)}</strong>
          </header>
          <div className="landowner-mini-kpis">
            <span>
              <small>Base recebida</small>
              <strong>{amount(repasses.receipts_basis_amount)}</strong>
            </span>
            <span>
              <small>Direito contratual</small>
              <strong>{amount(repasses.contractual_entitlement)}</strong>
            </span>
            <span>
              <small>Saldo contratual a repassar</small>
              <strong>{amount(repasses.contractual_balance)}</strong>
            </span>
            <span>
              <small>Saldo ainda sem programação</small>
              <strong>{amount(repasses.unprogrammed_amount)}</strong>
            </span>
          </div>
          {overpaidAmount > 0 && (
            <div className="landowner-contract-overpaid" role="note">
              <b>Repasse acima do direito apurado</b>
              <span>
                {amount(overpaidAmount)} será conciliado no fechamento
                financeiro.
              </span>
            </div>
          )}
        </section>
      )}

      {(hasExecutionSummary || hasExecutionDetails) && (
        <>
          <div className="landowner-repass-execution-heading">
            <b>Execução dos repasses</b>
            <span>Pagamentos e contas classificadas neste fechamento</span>
          </div>
          {hasExecutionSummary && (
            <div className="landowner-mini-kpis">
              {repasses.paid_amount !== undefined && (
                <span>
                  <small>Valores repassados</small>
                  <strong>{amount(repasses.paid_amount)}</strong>
                </span>
              )}
              {repasses.due_not_repassed !== undefined && (
                <span>
                  <small>Devidos e não repassados</small>
                  <strong>{amount(repasses.due_not_repassed)}</strong>
                </span>
              )}
              {repasses.total_not_repassed !== undefined && (
                <span>
                  <small>Total ainda não repassado</small>
                  <strong>{amount(repasses.total_not_repassed)}</strong>
                </span>
              )}
            </div>
          )}
          {hasExecutionSummary && repasses.basis && <p>{repasses.basis}.</p>}
          {hasExecutionDetails && (
            <div className="landowner-repass-list">
              {repasses.entries!.map(entry => (
                <div key={entry.id}>
                  <span>
                    <strong>{entry.description}</strong>
                    <small>
                      Vence {day(entry.due_date)}
                      {entry.scheduled_payment_date
                        ? ` · programado ${day(
                            entry.scheduled_payment_date,
                          )}`
                        : ""}
                    </small>
                  </span>
                  <span>
                    <strong>{amount(entry.amount)}</strong>
                    <small>{repassStatus(entry.status)}</small>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </article>
  );
}

function SalesConditionsSection({
  publication,
}: {
  publication: LandownerPortalPublication;
}) {
  const conditions = publication.sales_conditions!;
  return (
    <article className="landowner-public-card landowner-sales-card">
      <header>
        <div>
          <small>CONDIÇÕES COMERCIAIS</small>
          <h3>Perfil das vendas assinadas</h3>
        </div>
      </header>
      {conditions.average_sale_price !== undefined && (
        <div className="landowner-mini-kpis">
          <span>
            <small>Ticket médio</small>
            <strong>{amount(conditions.average_sale_price)}</strong>
          </span>
          <span>
            <small>Entrada média</small>
            <strong>{percent(conditions.average_down_payment_pct)}</strong>
          </span>
          <span>
            <small>Prazo médio</small>
            <strong>
              {number.format(Number(conditions.average_installments || 0))}{" "}
              parcelas
            </strong>
          </span>
          <span>
            <small>Desconto médio</small>
            <strong>{percent(conditions.average_discount_pct)}</strong>
          </span>
        </div>
      )}
      {!!conditions.sales?.length && (
        <div className="landowner-sales-table">
          <div className="landowner-sales-head">
            <span>Lote / contrato</span>
            <span>Venda</span>
            <span>Entrada / saldo</span>
            <span>Condição</span>
          </div>
          {conditions.sales.map(sale => (
            <div key={`${sale.contract_number}-${sale.unit_code}`}>
              <span>
                <strong>{sale.unit_code}</strong>
                <small>{sale.contract_number || "Contrato sem número"}</small>
              </span>
              <span>
                <strong>{amount(sale.sale_price)}</strong>
                <small>{day(sale.sale_date)}</small>
              </span>
              <span>
                <strong>{amount(sale.down_payment)}</strong>
                <small>Saldo {amount(sale.financed_amount)}</small>
              </span>
              <span>
                <strong>{sale.installments_count} parcela(s)</strong>
                <small>
                  {sale.indexer || "Sem indexador"}
                  {sale.monthly_interest_rate
                    ? ` · ${percent(
                        Number(sale.monthly_interest_rate) * 100,
                      )} a.m.`
                    : ""}
                </small>
              </span>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
