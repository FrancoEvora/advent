"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { EntryStatus, EntryType, ErpData, FinancialEntry, RevenueCenter } from "../types";
import { canWriteFinance, dateAtNoon, daysUntil, downloadCsv, isSettled, money, shortDate, statusLabels } from "../utils";
import { overdueRecommendation } from "../analytics";
import { Empty } from "../views-dashboard";
import { EntryModal } from "./entry-modal";

export function FinanceView({ data, mutate }: { data: ErpData; mutate: (operation: () => Promise<void>, success: string) => Promise<void> }) {
  const [modal, setModal] = useState<FinancialEntry | "new" | null>(null);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"todos" | EntryType>("todos");
  const [status, setStatus] = useState<"todos" | EntryStatus>("todos");
  const [classification, setClassification] = useState("todos");
  const [revenueCenters, setRevenueCenters] = useState<RevenueCenter[]>(data.revenueCenters ?? []);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;
    supabase.from("revenue_centers").select("*").eq("organization_id", data.organization.id).order("code").then(({ data: rows }) => setRevenueCenters(rows ?? []));
  }, [data.organization.id]);

  const list = useMemo(() => data.entries.filter((entry) => {
    const classMatch = classification === "todos"
      || (classification.startsWith("cost:") && entry.cost_center_id === classification.slice(5))
      || (classification.startsWith("revenue:") && entry.revenue_center_id === classification.slice(8));
    return (type === "todos" || entry.type === type)
      && (status === "todos" || entry.status === status)
      && classMatch
      && `${entry.description} ${entry.category} ${entry.document_number || ""}`.toLowerCase().includes(query.toLowerCase());
  }).sort((a, b) => a.due_date.localeCompare(b.due_date)), [data.entries, type, status, classification, query]);

  const overdue = list.filter((entry) => !isSettled(entry) && entry.status !== "cancelado" && daysUntil(entry.due_date) < 0);

  async function settle(entry: FinancialEntry) {
    await mutate(async () => {
      const supabase = getSupabase(); if (!supabase) throw new Error("Supabase indisponível.");
      const nextStatus = entry.type === "entrada" ? "recebido" : "pago";
      const { error } = await supabase.from("financial_entries").update({ status: nextStatus, settlement_date: new Date().toISOString().slice(0, 10), treatment_status: "concluido" }).eq("id", entry.id);
      if (error) throw new Error(error.message);
    }, entry.type === "entrada" ? "Recebimento confirmado." : "Pagamento confirmado.");
  }

  async function remove(entry: FinancialEntry) {
    if (!confirm(`Excluir o lançamento “${entry.description}”?`)) return;
    await mutate(async () => {
      const supabase = getSupabase(); if (!supabase) throw new Error("Supabase indisponível.");
      const { error } = await supabase.from("financial_entries").delete().eq("id", entry.id);
      if (error) throw new Error(error.message);
    }, "Lançamento excluído.");
  }

  function exportData() {
    downloadCsv("evora-financeiro.csv", ["Tipo", "Descrição", "Classificação", "Categoria", "Contraparte", "Valor", "Vencimento", "Status", "Aprovação", "Risco"], list.map((entry) => [
      entry.type,
      entry.description,
      entry.type === "saida" ? data.costCenters.find(c => c.id === entry.cost_center_id)?.name : revenueCenters.find(c => c.id === entry.revenue_center_id)?.name,
      data.categories.find(c => c.id === entry.category_id)?.name || entry.category,
      data.contacts.find(c => c.id === entry.contact_id)?.name,
      entry.amount,
      entry.due_date,
      entry.status,
      entry.approval_status,
      entry.cash_risk ? entry.cash_risk_level : "não",
    ]));
  }

  return <div className="stack">
    <section className="module-toolbar"><div className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar descrição, documento ou contraparte" /></div><div className="toolbar-actions"><button onClick={exportData}>⇩ Exportar</button>{canWriteFinance(data.membership.role) && <button className="primary" onClick={() => setModal("new")}>+ Adicionar lançamento</button>}</div></section>
    <section className="filters"><select value={type} onChange={(event) => setType(event.target.value as typeof type)}><option value="todos">Contas a pagar e receber</option><option value="saida">Contas a pagar</option><option value="entrada">Contas a receber</option></select><select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="todos">Todos os status</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select value={classification} onChange={(event) => setClassification(event.target.value)}><option value="todos">Todas as classificações</option><optgroup label="Centros de custo">{data.costCenters.filter(c => c.active).map(c => <option key={c.id} value={`cost:${c.id}`}>{c.code} · {c.name}</option>)}</optgroup><optgroup label="Centros de recebimento">{revenueCenters.filter(c => c.active).map(c => <option key={c.id} value={`revenue:${c.id}`}>{c.code} · {c.name}</option>)}</optgroup></select><span>{list.length} registros</span></section>
    {overdue.length > 0 && <section className="overdue-strip"><div><b>{overdue.length}</b><span><strong>Títulos vencidos exigem tratativa</strong><small>{money.format(overdue.reduce((sum, entry) => sum + Number(entry.amount), 0))} em exposição vencida</small></span></div><p>{overdueRecommendation(overdue[0])}</p></section>}
    <section className="panel finance-table"><div className="table-header"><span>Lançamento</span><span>Classificação</span><span>Vencimento</span><span>Status</span><span>Valor</span><span /></div>{list.map((entry) => <FinanceRow key={entry.id} entry={entry} data={data} revenueCenters={revenueCenters} onEdit={() => setModal(entry)} onSettle={() => settle(entry)} onRemove={() => remove(entry)} />)}{!list.length && <Empty text="Nenhum lançamento encontrado." />}</section>
    {modal && <EntryModal data={data} revenueCenters={revenueCenters} entry={modal === "new" ? null : modal} close={() => setModal(null)} mutate={mutate} />}
  </div>;
}

function FinanceRow({ entry, data, revenueCenters, onEdit, onSettle, onRemove }: { entry: FinancialEntry; data: ErpData; revenueCenters: RevenueCenter[]; onEdit: () => void; onSettle: () => void; onRemove: () => void }) {
  const classification = entry.type === "saida" ? data.costCenters.find(c => c.id === entry.cost_center_id) : revenueCenters.find(c => c.id === entry.revenue_center_id);
  const category = data.categories.find(c => c.id === entry.category_id);
  const contact = data.contacts.find(c => c.id === entry.contact_id);
  const project = data.projects.find(p => p.id === entry.project_id);
  const late = !isSettled(entry) && entry.status !== "cancelado" && daysUntil(entry.due_date) < 0;
  return <article className={`finance-row ${entry.cash_risk ? "cash-risk-row" : ""}`}><div className="finance-main"><i className={entry.type}>{entry.type === "entrada" ? "↓" : "↑"}</i><span><strong>{entry.description}</strong><small>{contact?.trade_name || contact?.name || "Contraparte não informada"} · {project?.name || "Corporativo"}</small></span></div><div><strong>{category?.name || entry.category}</strong><small>{classification ? `${classification.code || ""} · ${classification.name}` : entry.type === "saida" ? "Sem centro de custo" : "Sem centro de recebimento"}</small></div><div><strong className={late ? "late" : ""}>{shortDate.format(dateAtNoon(entry.due_date))}</strong><small>{late ? `${Math.abs(daysUntil(entry.due_date))} dias em atraso` : entry.installment_total > 1 ? `${entry.installment_number}/${entry.installment_total}` : "Parcela única"}</small></div><div><span className={`status ${entry.status}`}>{statusLabels[entry.status]}</span><small className={`approval ${entry.approval_status}`}>{entry.approval_status}</small>{entry.cash_risk && <small className={`risk-badge ${entry.cash_risk_level}`}>Risco {entry.cash_risk_level}</small>}</div><b className={entry.type}>{entry.type === "saida" ? "−" : "+"}{money.format(Number(entry.amount))}</b><div className="row-actions"><button onClick={onEdit} title="Editar">✎</button>{!isSettled(entry) && entry.approval_status === "aprovado" && <button onClick={onSettle} title="Liquidar">✓</button>}<button onClick={onRemove} title="Excluir">×</button></div>{late && <div className="row-recommendation"><strong>Recomendação:</strong> {overdueRecommendation(entry)}</div>}</article>;
}
