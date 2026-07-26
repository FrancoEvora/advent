"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import Image from "next/image";
import type { EntryStatus, EntryType, ErpData } from "../types";
import { useSalesData } from "../crm-v5/sales/use-sales-data";
import { usePostSaleData } from "../post-sale/use-post-sale-data";
import { downloadCsv, money, statusLabels } from "../utils";
import { Empty, Kpi, PanelTitle } from "../views-dashboard";
import {
  buildReport,
  defaultMode,
  reportAreas,
  reportModes,
  type ReportArea,
  type ReportColumn,
  type ReportFilters,
} from "./report-model";

type ReportsViewProps = {
  data: ErpData;
  can?: (permission: string) => boolean;
};

const areaPermissions: Record<ReportArea, string> = {
  financeiro: "financial.view",
  vendas: "crm.view",
  leads: "crm.view",
  obras: "construction.view",
  compras: "procurement.view",
  combustiveis: "fuel.view",
  contratos: "contracts.view",
  posvenda: "post_sale.view",
  rh: "hr.view",
};

const numberFormat = new Intl.NumberFormat("pt-BR");
const decimalFormat = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 });

function formatValue(value: string | number | null | undefined, column: ReportColumn) {
  if (value === null || value === undefined || value === "") return "—";
  if (column.format === "text") return String(value);
  const numeric = Number(value || 0);
  if (column.format === "money") return money.format(numeric);
  if (column.format === "percent") return `${numeric.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  if (column.format === "decimal") return decimalFormat.format(numeric);
  return numberFormat.format(numeric);
}

function reportPeriodLabel(from: string, to: string) {
  if (!from && !to) return "Todo o histórico disponível";
  const date = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString("pt-BR");
  if (from && to) return `${date(from)} a ${date(to)}`;
  if (from) return `A partir de ${date(from)}`;
  return `Até ${date(to)}`;
}

export function ReportsView({ data, can }: ReportsViewProps) {
  const availableAreas = useMemo(
    () => reportAreas.filter(item => !can || can(areaPermissions[item.id])),
    [can],
  );
  const initialArea = availableAreas[0]?.id || "financeiro";
  const [area, setArea] = useState<ReportArea>(initialArea);
  const [mode, setMode] = useState(defaultMode(initialArea));
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [projectId, setProjectId] = useState("todos");
  const [type, setType] = useState<"todos" | EntryType>("todos");
  const [status, setStatus] = useState<"todos" | EntryStatus>("todos");
  const [contactId, setContactId] = useState("todos");
  const [generatedAt] = useState(() => new Date());
  const canSales = availableAreas.some(item => item.id === "vendas");
  const canPostSale = availableAreas.some(item => item.id === "posvenda");
  const { sales, loading: salesLoading, error: salesError } = useSalesData(data, canSales);
  const { postSale, loading: postSaleLoading, error: postSaleError } = usePostSaleData(data, canPostSale);

  const activeArea = availableAreas.some(item => item.id === area) ? area : initialArea;
  const activeMode = reportModes[activeArea].some(item => item.id === mode) ? mode : defaultMode(activeArea);
  const filters: ReportFilters = useMemo(() => ({
    from,
    to,
    projectId,
    type,
    status,
    contactId,
  }), [contactId, from, projectId, status, to, type]);

  const report = useMemo(
    () => buildReport(activeArea, activeMode, {
      data,
      sales,
      postSale,
      revenueCenters: data.revenueCenters || [],
      filters,
    }),
    [activeArea, activeMode, data, filters, postSale, sales],
  );

  const dataLoading = (activeArea === "vendas" && salesLoading) || (activeArea === "posvenda" && postSaleLoading);
  const dataError = activeArea === "vendas" ? salesError : activeArea === "posvenda" ? postSaleError : "";
  const usesProject = activeArea !== "rh";
  const isFinancial = activeArea === "financeiro";
  const gridStyle = { "--report-column-count": report.columns.length } as CSSProperties;
  const projectLabel = projectId === "todos"
    ? "Todos os empreendimentos"
    : data.projects.find(project => project.id === projectId)?.name || "Empreendimento selecionado";
  const chart = useMemo(() => {
    const column = report.columns.find(candidate =>
      candidate.format !== "text"
      && report.rows.some(row => Math.abs(Number(row.values[candidate.key] || 0)) > 0)
    );
    if (!column) return null;
    const rows = report.rows
      .map(row => ({ row, value: Number(row.values[column.key] || 0) }))
      .filter(item => Number.isFinite(item.value) && item.value !== 0)
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, 6);
    const maximum = Math.max(0, ...rows.map(item => Math.abs(item.value)));
    return maximum ? { column, rows, maximum } : null;
  }, [report]);
  const attentionKpis = report.kpis.filter(item => ["warning", "danger"].includes(item.tone || ""));
  const leadingRow = chart?.rows[0]?.row;
  const executiveStatus = !report.rows.length
    ? { tone: "neutral", label: "Base insuficiente", text: "Não há registros para formar uma conclusão com os filtros atuais." }
    : attentionKpis.length
      ? { tone: "attention", label: "Requer atenção", text: `${attentionKpis.length} indicador(es) pedem tratamento antes da próxima decisão.` }
      : { tone: "stable", label: "Leitura consolidada", text: `${report.rows.length} classificação(ões) analisadas com a base disponível.` };
  const recommendations = [
    ...attentionKpis.slice(0, 2).map(item => ({
      title: `Tratar ${item.label.toLowerCase()}`,
      detail: `${item.value} · ${item.detail}`,
      tone: "attention",
    })),
    ...(leadingRow ? [{
      title: `Abrir a composição de ${leadingRow.label}`,
      detail: chart ? `Maior concentração em ${chart.column.label.toLowerCase()}: ${formatValue(leadingRow.values[chart.column.key], chart.column)}.` : leadingRow.detail || "Maior concentração do recorte.",
      tone: "focus",
    }] : []),
    ...(!attentionKpis.length && report.rows.length ? [{
      title: "Comparar com o próximo fechamento",
      detail: "Salve este recorte como referência para identificar variações e exceções na próxima análise.",
      tone: "stable",
    }] : []),
  ].slice(0, 3);

  function selectArea(nextArea: ReportArea) {
    setArea(nextArea);
    setMode(defaultMode(nextArea));
    setProjectId("todos");
    setType("todos");
    setStatus("todos");
    setContactId("todos");
  }

  function clearFilters() {
    setFrom("");
    setTo("");
    setProjectId("todos");
    setType("todos");
    setStatus("todos");
    setContactId("todos");
  }

  function exportReport() {
    const headers = ["Classificação", "Detalhe", ...report.columns.map(column => column.label)];
    const rows = report.rows.map(row => [
      row.label,
      row.detail,
      ...report.columns.map(column => row.values[column.key]),
    ]);
    downloadCsv(`evora-${activeArea}-${activeMode}.csv`, headers, rows);
  }

  function printReport() {
    const cleanup = () => document.body.classList.remove("report-printing");
    document.body.classList.add("report-printing");
    window.addEventListener("afterprint", cleanup, { once: true });
    window.requestAnimationFrame(() => window.print());
    window.setTimeout(cleanup, 1500);
  }

  useEffect(() => () => document.body.classList.remove("report-printing"), []);

  if (!availableAreas.length) {
    return <section className="panel"><Empty text="Seu perfil não possui acesso a nenhuma área da Central de Relatórios." /></section>;
  }

  return <div className="stack reports-hub">
    <header className="report-print-header" aria-hidden="true">
      <Image src="/evora-brand.svg" alt="" width={240} height={80} />
      <div>
        <small>RELATÓRIO EXECUTIVO · {report.eyebrow}</small>
        <h1>{report.title}</h1>
        <p>{data.organization.trade_name || data.organization.name} · {projectLabel}</p>
      </div>
      <dl>
        <div><dt>Período</dt><dd>{reportPeriodLabel(from, to)}</dd></div>
        <div><dt>Emitido em</dt><dd>{generatedAt.toLocaleString("pt-BR")}</dd></div>
      </dl>
    </header>
    <section className="module-toolbar reports-toolbar">
      <div>
        <small>CONTROLADORIA E INTELIGÊNCIA CORPORATIVA</small>
        <h2>Central de relatórios</h2>
        <p>Indicadores integrados de todas as áreas autorizadas para o seu perfil.</p>
      </div>
      <div className="toolbar-actions">
        <button type="button" onClick={exportReport} disabled={dataLoading}>Exportar CSV</button>
        <button type="button" onClick={printReport} disabled={dataLoading}>PDF executivo</button>
      </div>
    </section>

    <nav className="report-area-selector" aria-label="Áreas da Central de Relatórios">
      {availableAreas.map(item => <button
        type="button"
        key={item.id}
        className={activeArea === item.id ? "active" : ""}
        aria-pressed={activeArea === item.id}
        onClick={() => selectArea(item.id)}
      >
        <i aria-hidden="true">{item.icon}</i>
        <span><strong>{item.label}</strong><small>{item.description}</small></span>
      </button>)}
    </nav>

    <section className="report-filters corporate-report-filters" aria-label="Filtros do relatório">
      <label>Área
        <select value={activeArea} onChange={event => selectArea(event.target.value as ReportArea)}>
          {availableAreas.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      <label>Relatório
        <select value={activeMode} onChange={event => setMode(event.target.value)}>
          {reportModes[activeArea].map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      <label>De<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label>
      <label>Até<input type="date" value={to} onChange={event => setTo(event.target.value)} /></label>
      {usesProject && <label>Empreendimento
        <select value={projectId} onChange={event => setProjectId(event.target.value)}>
          <option value="todos">Todos</option>
          {data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>}
      {isFinancial && <>
        <label>Movimento
          <select value={type} onChange={event => setType(event.target.value as typeof type)}>
            <option value="todos">Todos</option>
            <option value="entrada">Entradas</option>
            <option value="saida">Saídas</option>
          </select>
        </label>
        <label>Status
          <select value={status} onChange={event => setStatus(event.target.value as typeof status)}>
            <option value="todos">Todos</option>
            {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>Contraparte
          <select value={contactId} onChange={event => setContactId(event.target.value)}>
            <option value="todos">Todas</option>
            {data.contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.trade_name || contact.name}</option>)}
          </select>
        </label>
      </>}
      <button className="report-clear-filters" type="button" onClick={clearFilters}>Limpar filtros</button>
    </section>

    {dataLoading && <div className="report-data-state" role="status">Atualizando dados de {reportAreas.find(item => item.id === activeArea)?.label}…</div>}
    {dataError && <div className="feedback error" role="alert">{dataError}</div>}

    <section className="kpi-grid four report-kpis" aria-busy={dataLoading}>
      {report.kpis.map(item => <Kpi key={item.label} {...item} />)}
    </section>

    <section className="report-intelligence-grid" aria-label="Leitura executiva do relatório">
      <article className="report-executive-brief" data-tone={executiveStatus.tone}>
        <header>
          <span>PULSO DO RECORTE</span>
          <i>{executiveStatus.label}</i>
        </header>
        <h3>{executiveStatus.text}</h3>
        <dl>
          <div><dt>Base analisada</dt><dd>{report.rows.length} linhas</dd></div>
          <div><dt>Empreendimento</dt><dd>{projectLabel}</dd></div>
          <div><dt>Período</dt><dd>{reportPeriodLabel(from, to)}</dd></div>
        </dl>
      </article>

      <article className="report-distribution">
        <header>
          <div><span>DISTRIBUIÇÃO PRINCIPAL</span><h3>{chart?.column.label || "Sem série numérica"}</h3></div>
          <small>{chart ? `${chart.rows.length} maiores concentrações` : "Aguardando dados"}</small>
        </header>
        {chart ? <div className="report-bars">
          {chart.rows.map(({ row, value }) => <div key={row.id}>
            <span title={row.label}>{row.label}</span>
            <i><b style={{ width: `${Math.max(4, Math.abs(value) / chart.maximum * 100)}%` }} /></i>
            <strong>{formatValue(value, chart.column)}</strong>
          </div>)}
        </div> : <Empty text="Nenhuma série numérica disponível neste recorte." />}
      </article>
    </section>

    <section className="report-decision-panel">
      <header><div><small>PRÓXIMAS DECISÕES</small><h3>Leitura orientada à ação</h3></div><span>Gerado com os dados do relatório</span></header>
      <div>
        {recommendations.map((item, index) => <article key={`${item.title}-${index}`} data-tone={item.tone}>
          <b>{String(index + 1).padStart(2, "0")}</b>
          <span><strong>{item.title}</strong><small>{item.detail}</small></span>
        </article>)}
        {!recommendations.length && <Empty text="Alimente a base ou amplie os filtros para gerar recomendações." />}
      </div>
    </section>

    <section className="panel corporate-report-result" aria-busy={dataLoading}>
      <PanelTitle eyebrow={report.eyebrow} title={report.title} />
      <p className="report-description">{report.description}</p>
      <div className="corporate-report-table" style={gridStyle}>
        <table>
          <thead>
            <tr>
              <th scope="col">Classificação</th>
              {report.columns.map(column => <th scope="col" key={column.key}>{column.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {report.rows.map(row => <tr key={row.id}>
              <th scope="row"><strong>{row.label}</strong>{row.detail && <small>{row.detail}</small>}</th>
              {report.columns.map(column => <td key={column.key} data-label={column.label}>{formatValue(row.values[column.key], column)}</td>)}
            </tr>)}
          </tbody>
        </table>
        {!report.rows.length && !dataLoading && <Empty text="Nenhum dado encontrado para os filtros selecionados." />}
      </div>
    </section>
    <footer className="report-print-footer" aria-hidden="true">
      <span>Évora Gestão · Informação gerencial para uso interno</span>
      <span>{report.title} · {reportPeriodLabel(from, to)}</span>
    </footer>
  </div>;
}
