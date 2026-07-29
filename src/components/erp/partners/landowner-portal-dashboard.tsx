"use client";

import { useMemo, useState } from "react";
import type {
  LandownerPortalPublication,
  LandownerPortalPayload,
} from "./partner-types";

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

function day(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? "—" : date.format(parsed);
}

function timestamp(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : dateTime.format(parsed);
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
