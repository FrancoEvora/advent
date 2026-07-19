"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { EntryStatus, EntryType, ErpData, RevenueCenter } from "../types";
import { aggregateCounterparties, agingBucket } from "../analytics";
import { daysUntil, downloadCsv, isSettled, money, statusLabels } from "../utils";
import { Empty, Kpi, PanelTitle } from "../views-dashboard";

type Mode = "mensal" | "aging" | "devedores" | "credores" | "classificacao" | "projetos" | "categorias" | "riscos";
type Row = { label: string; entradas: number; saidas: number; vencido: number; quantidade: number; detalhe?: string };

export function ReportsView({ data }: { data: ErpData }) {
  const [mode, setMode] = useState<Mode>("mensal");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [type, setType] = useState<"todos" | EntryType>("todos");
  const [status, setStatus] = useState<"todos" | EntryStatus>("todos");
  const [project, setProject] = useState("todos");
  const [contact, setContact] = useState("todos");
  const [revenueCenters, setRevenueCenters] = useState<RevenueCenter[]>([]);

  useEffect(() => {
    const supabase = getSupabase(); if (!supabase) return;
    supabase.from("revenue_centers").select("*").eq("organization_id", data.organization.id).order("code").then(({ data: rows }) => setRevenueCenters(rows ?? []));
  }, [data.organization.id]);

  const filtered = useMemo(() => data.entries.filter(entry => (!from || entry.due_date >= from) && (!to || entry.due_date <= to) && (type === "todos" || entry.type === type) && (status === "todos" || entry.status === status) && (project === "todos" || entry.project_id === project) && (contact === "todos" || entry.contact_id === contact)), [data.entries, from, to, type, status, project, contact]);

  const rows = useMemo<Row[]>(() => {
    const sum = (entries: typeof filtered, entryType: EntryType) => entries.filter(entry => entry.type === entryType).reduce((total, entry) => total + Number(entry.amount), 0);
    const build = (groups: Array<{ id: string; label: string; test: (entry: typeof filtered[number]) => boolean }>) => groups.map(group => {
      const entries = filtered.filter(group.test);
      const late = entries.filter(entry => !isSettled(entry) && daysUntil(entry.due_date) < 0);
      return { label: group.label, entradas: sum(entries, "entrada"), saidas: sum(entries, "saida"), vencido: late.reduce((total, entry) => total + Number(entry.amount), 0), quantidade: entries.length };
    }).filter(row => row.quantidade > 0).sort((a, b) => (b.entradas + b.saidas) - (a.entradas + a.saidas));

    if (mode === "mensal") {
      const months = [...new Set(filtered.map(entry => (entry.competence_date || entry.due_date).slice(0, 7)))].sort();
      return build(months.map(month => ({ id: month, label: new Date(`${month}-15T12:00:00`).toLocaleDateString("pt-BR", { month: "long", year: "numeric" }), test: entry => (entry.competence_date || entry.due_date).startsWith(month) })));
    }
    if (mode === "aging") {
      const buckets = ["A vencer", "1–15 dias", "16–30 dias", "31–60 dias", "61–90 dias", "> 90 dias"];
      return build(buckets.map(bucket => ({ id: bucket, label: bucket, test: entry => agingBucket(entry) === bucket })));
    }
    if (mode === "devedores" || mode === "credores") {
      const exposure = aggregateCounterparties({ ...data, entries: filtered }, mode === "devedores" ? "entrada" : "saida");
      return exposure.map(item => ({ label: item.name, entradas: mode === "devedores" ? item.open : 0, saidas: mode === "credores" ? item.open : 0, vencido: item.overdue, quantidade: item.titles, detalhe: `${item.overdueTitles} vencidos · maior atraso ${item.oldestDelay} dias` }));
    }
    if (mode === "classificacao") {
      const costs = data.costCenters.map(center => ({ id: center.id, label: `Custo · ${center.code} · ${center.name}`, test: (entry: typeof filtered[number]) => entry.cost_center_id === center.id }));
      const revenues = revenueCenters.map(center => ({ id: center.id, label: `Recebimento · ${center.code} · ${center.name}`, test: (entry: typeof filtered[number]) => entry.revenue_center_id === center.id }));
      return build([...costs, ...revenues]);
    }
    if (mode === "projetos") return build(data.projects.map(item => ({ id: item.id, label: `${item.code} · ${item.name}`, test: (entry: typeof filtered[number]) => entry.project_id === item.id })));
    if (mode === "categorias") return build(data.categories.map(item => ({ id: item.id, label: `${item.code} · ${item.name}`, test: (entry: typeof filtered[number]) => entry.category_id === item.id })));
    return filtered.filter(entry => entry.cash_risk).map(entry => ({ label: entry.description, entradas: 0, saidas: Number(entry.amount), vencido: entry.projected_balance ?? 0, quantidade: 1, detalhe: `${entry.cash_risk_level || "risco"} · ${entry.recommended_due_date || "sem data recomendada"}` }));
  }, [data, filtered, mode, revenueCenters]);

  const incoming = filtered.filter(entry => entry.type === "entrada").reduce((total, entry) => total + Number(entry.amount), 0);
  const outgoing = filtered.filter(entry => entry.type === "saida").reduce((total, entry) => total + Number(entry.amount), 0);
  const overdue = filtered.filter(entry => !isSettled(entry) && daysUntil(entry.due_date) < 0).reduce((total, entry) => total + Number(entry.amount), 0);

  function exportReport() {
    downloadCsv(`evora-relatorio-${mode}.csv`, ["Classificação", "Entradas", "Saídas", "Resultado", "Vencido", "Quantidade", "Detalhe"], rows.map(row => [row.label, row.entradas, row.saidas, row.entradas - row.saidas, row.vencido, row.quantidade, row.detalhe]));
  }

  return <div className="stack">
    <section className="module-toolbar reports-toolbar"><div><small>CONTROLADORIA E INTELIGÊNCIA</small><h2>Central de relatórios</h2></div><div className="toolbar-actions"><button onClick={exportReport}>Exportar CSV</button><button onClick={() => window.print()}>PDF / Imprimir</button></div></section>
    <section className="report-filters"><label>Relatório<select value={mode} onChange={event => setMode(event.target.value as Mode)}><option value="mensal">Resultado mensal</option><option value="aging">Aging de vencimentos</option><option value="devedores">Principais devedores</option><option value="credores">Principais credores</option><option value="classificacao">Centros gerenciais</option><option value="projetos">Empreendimentos</option><option value="categorias">Categorias financeiras</option><option value="riscos">Riscos de caixa</option></select></label><label>De<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label><label>Até<input type="date" value={to} onChange={event => setTo(event.target.value)} /></label><label>Movimento<select value={type} onChange={event => setType(event.target.value as typeof type)}><option value="todos">Todos</option><option value="entrada">Entradas</option><option value="saida">Saídas</option></select></label><label>Status<select value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="todos">Todos</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Empreendimento<select value={project} onChange={event => setProject(event.target.value)}><option value="todos">Todos</option>{data.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Contraparte<select value={contact} onChange={event => setContact(event.target.value)}><option value="todos">Todas</option>{data.contacts.map(item => <option key={item.id} value={item.id}>{item.trade_name || item.name}</option>)}</select></label></section>
    <section className="kpi-grid four"><Kpi label="Entradas" value={money.format(incoming)} detail={`${filtered.filter(entry => entry.type === "entrada").length} títulos`} tone="positive" /><Kpi label="Saídas" value={money.format(outgoing)} detail={`${filtered.filter(entry => entry.type === "saida").length} títulos`} tone="negative" /><Kpi label="Resultado" value={money.format(incoming - outgoing)} detail="Período filtrado" tone="gold" /><Kpi label="Exposição vencida" value={money.format(overdue)} detail="Títulos não liquidados" tone="warning" /></section>
    <section className="panel"><PanelTitle eyebrow="ANÁLISE CONSOLIDADA" title="Resultado do relatório" /><div className="report-table report-table-v3"><header><span>Classificação</span><span>Entradas</span><span>Saídas</span><span>Resultado</span><span>Vencido</span><span>Qtd.</span></header>{rows.map((row, index) => <article key={`${row.label}-${index}`}><div><strong>{row.label}</strong>{row.detalhe && <small>{row.detalhe}</small>}</div><span className="entrada">{money.format(row.entradas)}</span><span className="saida">{money.format(row.saidas)}</span><b>{money.format(row.entradas - row.saidas)}</b><span className={row.vencido ? "late" : ""}>{money.format(row.vencido)}</span><span>{row.quantidade}</span></article>)}{!rows.length && <Empty text="Nenhum dado encontrado para os filtros selecionados." />}</div></section>
  </div>;
}
