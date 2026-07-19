"use client";
import { useMemo, useState } from "react";
import type { ErpData, FinancialEntry, ViewId } from "./types";
import { dateAtNoon, daysUntil, isSettled, money, shortDate, sumEntries } from "./utils";

export function DashboardView({ data, go }: { data: ErpData; go: (view: ViewId) => void }) {
  const received = sumEntries(data.entries, "entrada", true), paid = sumEntries(data.entries, "saida", true);
  const receivable = sumEntries(data.entries, "entrada", false), payable = sumEntries(data.entries, "saida", false);
  const overdue = data.entries.filter((entry) => !isSettled(entry) && daysUntil(entry.due_date) < 0);
  const pendingApprovals = data.approvals.filter((item) => item.status === "pendente");
  const upcoming = data.entries.filter((entry) => !isSettled(entry)).sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 7);
  const byCenter = useMemo(() => data.costCenters.map((center) => ({ center, total: data.entries.filter((entry) => entry.cost_center_id === center.id && entry.type === "saida").reduce((sum, entry) => sum + Number(entry.amount), 0) })).filter((item) => item.total > 0).sort((a, b) => b.total - a.total).slice(0, 5), [data]);
  const maxCenter = Math.max(...byCenter.map((item) => item.total), 1);
  return <div className="dashboard-grid">
    <section className="executive-card"><div><small>SALDO REALIZADO</small><h2>Posição financeira consolidada</h2><strong>{money.format(received - paid)}</strong><p>Entradas recebidas menos saídas liquidadas.</p></div><button onClick={() => go("caixa")}>Abrir fluxo projetado →</button></section>
    <section className="kpi-grid">
      <Kpi label="A receber" value={money.format(receivable)} tone="positive" detail={`${data.entries.filter((e) => e.type === "entrada" && !isSettled(e)).length} títulos`} />
      <Kpi label="A pagar" value={money.format(payable)} tone="negative" detail={`${data.entries.filter((e) => e.type === "saida" && !isSettled(e)).length} títulos`} />
      <Kpi label="Resultado projetado" value={money.format(receivable - payable)} tone="gold" detail="Carteira pendente" />
      <Kpi label="Exposição vencida" value={money.format(overdue.reduce((sum, e) => sum + Number(e.amount), 0))} tone="warning" detail={`${overdue.length} vencimentos`} />
    </section>
    <section className="panel span-2"><PanelTitle eyebrow="AGENDA FINANCEIRA" title="Próximos vencimentos" action="Ver lançamentos" onAction={() => go("financeiro")} />
      <div className="table-list">{upcoming.map((entry) => <EntryRow key={entry.id} entry={entry} data={data} />)}{!upcoming.length && <Empty text="Nenhum compromisso pendente." />}</div>
    </section>
    <section className="panel"><PanelTitle eyebrow="CUSTOS" title="Maiores centros de custo" />
      <div className="ranking">{byCenter.map(({ center, total }) => <div key={center.id}><label><span>{center.code} · {center.name}</span><strong>{money.format(total)}</strong></label><i><b style={{ width: `${total / maxCenter * 100}%` }} /></i></div>)}{!byCenter.length && <Empty text="Sem despesas classificadas." />}</div>
    </section>
    <section className="panel"><PanelTitle eyebrow="GOVERNANÇA" title="Atenções da diretoria" />
      <div className="attention-list"><button onClick={() => go("aprovacoes")}><b>{pendingApprovals.length}</b><span><strong>Aprovações pendentes</strong><small>Movimentos aguardando decisão</small></span>›</button><button onClick={() => go("financeiro")}><b>{overdue.length}</b><span><strong>Títulos vencidos</strong><small>Necessitam regularização</small></span>›</button><button onClick={() => go("usuarios")}><b>{data.invitations.filter((i) => !i.accepted_at).length}</b><span><strong>Convites em aberto</strong><small>Gestão de acessos</small></span>›</button></div>
    </section>
  </div>;
}

export function CashView({ data }: { data: ErpData }) {
  const [period, setPeriod] = useState(30);
  const pending = data.entries.filter((entry) => !isSettled(entry) && daysUntil(entry.due_date) <= period);
  const incoming = pending.filter((entry) => entry.type === "entrada").reduce((sum, entry) => sum + Number(entry.amount), 0);
  const outgoing = pending.filter((entry) => entry.type === "saida").reduce((sum, entry) => sum + Number(entry.amount), 0);
  const max = Math.max(incoming, outgoing, 1);
  const accounts = data.bankAccounts.map((account) => ({ account, inflow: data.entries.filter((e) => e.bank_account_id === account.id && e.type === "entrada" && isSettled(e)).reduce((s, e) => s + Number(e.amount), 0), outflow: data.entries.filter((e) => e.bank_account_id === account.id && e.type === "saida" && isSettled(e)).reduce((s, e) => s + Number(e.amount), 0) }));
  return <div className="stack">
    <section className="cash-hero"><div><small>FLUXO PROJETADO · {period} DIAS</small><strong>{money.format(incoming - outgoing)}</strong><p>Resultado previsto entre recebimentos e pagamentos pendentes.</p></div><div>{[7, 30, 60, 90, 180].map((value) => <button className={period === value ? "active" : ""} key={value} onClick={() => setPeriod(value)}>{value} dias</button>)}</div></section>
    <section className="kpi-grid three"><Kpi label="Entradas previstas" value={money.format(incoming)} tone="positive" detail={`${pending.filter(e => e.type === "entrada").length} títulos`} /><Kpi label="Saídas previstas" value={money.format(outgoing)} tone="negative" detail={`${pending.filter(e => e.type === "saida").length} títulos`} /><Kpi label="Índice de cobertura" value={outgoing ? `${Math.round(incoming / outgoing * 100)}%` : "—"} tone="gold" detail="Entradas / saídas" /></section>
    <section className="panel"><PanelTitle eyebrow="COMPARATIVO" title="Entradas versus saídas" /><div className="bars"><label><span>Entradas</span><strong>{money.format(incoming)}</strong></label><i><b className="in" style={{ width: `${incoming / max * 100}%` }} /></i><label><span>Saídas</span><strong>{money.format(outgoing)}</strong></label><i><b className="out" style={{ width: `${outgoing / max * 100}%` }} /></i></div></section>
    <section className="panel"><PanelTitle eyebrow="DISPONIBILIDADE" title="Saldos por conta" /><div className="account-grid">{accounts.map(({ account, inflow, outflow }) => <article key={account.id}><small>{account.bank_name || account.account_type}</small><h3>{account.name}</h3><strong>{money.format(Number(account.initial_balance) + inflow - outflow)}</strong><span>Saldo calculado</span></article>)}</div></section>
  </div>;
}

export function PanelTitle({ eyebrow, title, action, onAction }: { eyebrow: string; title: string; action?: string; onAction?: () => void }) { return <div className="panel-title"><div><small>{eyebrow}</small><h3>{title}</h3></div>{action && <button onClick={onAction}>{action}</button>}</div>; }
export function Kpi({ label, value, detail, tone = "" }: { label: string; value: string; detail: string; tone?: string }) { return <article className={`kpi ${tone}`}><small>{label}</small><strong>{value}</strong><span>{detail}</span></article>; }
export function Empty({ text }: { text: string }) { return <div className="empty"><b>◇</b><strong>{text}</strong></div>; }

function EntryRow({ entry, data }: { entry: FinancialEntry; data: ErpData }) {
  const center = data.costCenters.find((item) => item.id === entry.cost_center_id);
  const category = data.categories.find((item) => item.id === entry.category_id);
  const late = daysUntil(entry.due_date) < 0;
  return <article className="entry-row"><i className={entry.type}>{entry.type === "entrada" ? "↓" : "↑"}</i><div><strong>{entry.description}</strong><small>{category?.name || entry.category} · {center?.name || "Sem centro de custo"}</small></div><span className={late ? "late" : ""}>{shortDate.format(dateAtNoon(entry.due_date))}</span><b className={entry.type}>{entry.type === "saida" ? "−" : "+"}{money.format(Number(entry.amount))}</b></article>;
}
