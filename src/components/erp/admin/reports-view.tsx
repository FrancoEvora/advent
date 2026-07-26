"use client";

import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
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

  if (!availableAreas.length) {
    return <section className="panel"><Empty text="Seu perfil não possui acesso a nenhuma área da Central de Relatórios." /></section>;
  }

  return <div className="stack reports-hub">
    <section className="module-toolbar reports-toolbar">
      <div>
        <small>CONTROLADORIA E INTELIGÊNCIA CORPORATIVA</small>
        <h2>Central de relatórios</h2>
        <p>Indicadores integrados de todas as áreas autorizadas para o seu perfil.</p>
      </div>
      <div className="toolbar-actions">
        <button type="button" onClick={exportReport} disabled={dataLoading}>Exportar CSV</button>
        <button type="button" onClick={() => window.print()} disabled={dataLoading}>PDF / Imprimir</button>
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
  </div>;
}
