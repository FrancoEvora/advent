import type { SalesData } from "../crm-v5/sales/types";
import type { PostSaleData } from "../post-sale/types";
import type { EntryStatus, EntryType, ErpData, FinancialEntry, RevenueCenter } from "../types";
import { aggregateCounterparties, agingBucket } from "../analytics";
import { daysUntil, isSettled } from "../utils";

export type ReportArea =
  | "financeiro"
  | "vendas"
  | "leads"
  | "obras"
  | "compras"
  | "combustiveis"
  | "contratos"
  | "posvenda"
  | "rh";

export type ReportFormat = "text" | "money" | "number" | "decimal" | "percent";

export type ReportColumn = {
  key: string;
  label: string;
  format: ReportFormat;
};

export type ReportRow = {
  id: string;
  label: string;
  detail?: string;
  values: Record<string, string | number | null | undefined>;
};

export type ReportKpi = {
  label: string;
  value: string;
  detail: string;
  tone?: string;
};

export type ReportResult = {
  eyebrow: string;
  title: string;
  description: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  kpis: ReportKpi[];
};

export type ReportFilters = {
  from: string;
  to: string;
  projectId: string;
  type: "todos" | EntryType;
  status: "todos" | EntryStatus;
  contactId: string;
};

type ReportContext = {
  data: ErpData;
  sales: SalesData;
  postSale: PostSaleData;
  revenueCenters: RevenueCenter[];
  filters: ReportFilters;
};

type Entity = Record<string, unknown>;

const number = (value: unknown) => Number(value || 0);
const string = (value: unknown) => typeof value === "string" ? value : "";
const entityList = (values: unknown[]) => values as Entity[];
const pct = (value: number) => `${value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
const count = (value: number) => value.toLocaleString("pt-BR");
const currency = (value: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const normalized = (value: unknown) => string(value).trim().toLowerCase();
const labelize = (value: string) => value
  .replaceAll("_", " ")
  .replace(/\b\p{L}/gu, letter => letter.toUpperCase());

function inPeriod(value: unknown, filters: ReportFilters) {
  if (!filters.from && !filters.to) return true;
  const date = string(value).slice(0, 10);
  if (!date) return false;
  return (!filters.from || date >= filters.from) && (!filters.to || date <= filters.to);
}

function inProject(value: unknown, filters: ReportFilters) {
  return filters.projectId === "todos" || value === filters.projectId;
}

function projectName(data: ErpData, id: unknown) {
  return data.projects.find(project => project.id === id)?.name || "Sem empreendimento";
}

function contactName(data: ErpData, id: unknown) {
  const contact = data.contacts.find(item => item.id === id);
  return contact?.trade_name || contact?.name || "Sem fornecedor";
}

function group<T>(items: T[], key: (item: T) => string) {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const groupKey = key(item) || "Não informado";
    result.set(groupKey, [...(result.get(groupKey) || []), item]);
  }
  return [...result.entries()];
}

function kpi(label: string, value: string, detail: string, tone = ""): ReportKpi {
  return { label, value, detail, tone };
}

export const reportAreas: Array<{ id: ReportArea; label: string; icon: string; description: string }> = [
  { id: "financeiro", label: "Financeiro", icon: "R$", description: "Resultado, vencimentos e caixa" },
  { id: "vendas", label: "Vendas e VGV", icon: "◇", description: "Propostas, contratos e estoque" },
  { id: "leads", label: "Leads e CRM", icon: "◎", description: "Funil, origem e conversão" },
  { id: "obras", label: "Obras e EAP", icon: "◒", description: "Avanço, prazo e orçamento" },
  { id: "compras", label: "Compras e serviços", icon: "▣", description: "Solicitações, aprovações e riscos" },
  { id: "combustiveis", label: "Combustíveis", icon: "◈", description: "Consumo, custo e equipamentos" },
  { id: "contratos", label: "Contratos operacionais", icon: "▦", description: "Medições, horas e saldos" },
  { id: "posvenda", label: "Pós-venda", icon: "♥", description: "Jornadas, atendimento e satisfação" },
  { id: "rh", label: "Recursos humanos", icon: "♧", description: "Equipe, folha e eventos" },
];

export const reportModes: Record<ReportArea, Array<{ id: string; label: string }>> = {
  financeiro: [
    { id: "mensal", label: "Resultado mensal" },
    { id: "aging", label: "Aging de vencimentos" },
    { id: "devedores", label: "Principais devedores" },
    { id: "credores", label: "Principais credores" },
    { id: "classificacao", label: "Centros gerenciais" },
    { id: "projetos", label: "Empreendimentos" },
    { id: "categorias", label: "Categorias financeiras" },
    { id: "riscos", label: "Riscos de caixa" },
  ],
  vendas: [
    { id: "vendas_projetos", label: "Vendas e VGV por empreendimento" },
    { id: "vendas_contratos", label: "Contratos comerciais por situação" },
    { id: "vendas_estoque", label: "Estoque e potencial de venda" },
  ],
  leads: [
    { id: "leads_funil", label: "Funil comercial" },
    { id: "leads_origem", label: "Origem dos leads" },
    { id: "leads_temperatura", label: "Temperatura e prioridade" },
  ],
  obras: [
    { id: "obras_projetos", label: "Avanço físico por empreendimento" },
    { id: "obras_status", label: "Etapas da EAP por situação" },
    { id: "obras_prazos", label: "Desvios de prazo" },
  ],
  compras: [
    { id: "compras_status", label: "Solicitações por situação" },
    { id: "compras_projetos", label: "Compras por empreendimento" },
    { id: "compras_fornecedores", label: "Compromissos por fornecedor" },
  ],
  combustiveis: [
    { id: "combustiveis_projetos", label: "Consumo por empreendimento" },
    { id: "combustiveis_tipo", label: "Consumo por combustível" },
    { id: "combustiveis_equipamentos", label: "Consumo por equipamento" },
  ],
  contratos: [
    { id: "contratos_carteira", label: "Carteira de contratos" },
    { id: "contratos_medicoes", label: "Medições por situação" },
    { id: "contratos_horas", label: "Horas e horímetros de máquinas" },
  ],
  posvenda: [
    { id: "posvenda_jornadas", label: "Jornadas por empreendimento" },
    { id: "posvenda_atendimentos", label: "Atendimentos e SLA" },
    { id: "posvenda_satisfacao", label: "Satisfação e inspeções" },
  ],
  rh: [
    { id: "rh_departamentos", label: "Quadro por departamento" },
    { id: "rh_folha", label: "Folha de pagamento" },
    { id: "rh_eventos", label: "Eventos de pessoal" },
  ],
};

export function defaultMode(area: ReportArea) {
  return reportModes[area][0].id;
}

export function buildReport(area: ReportArea, mode: string, context: ReportContext): ReportResult {
  if (area === "financeiro") return financeReport(mode, context);
  if (area === "vendas") return salesReport(mode, context);
  if (area === "leads") return leadsReport(mode, context);
  if (area === "obras") return constructionReport(mode, context);
  if (area === "compras") return procurementReport(mode, context);
  if (area === "combustiveis") return fuelReport(mode, context);
  if (area === "contratos") return contractsReport(mode, context);
  if (area === "posvenda") return postSaleReport(mode, context);
  return hrReport(mode, context);
}

function financeReport(mode: string, { data, revenueCenters, filters }: ReportContext): ReportResult {
  const filtered = data.entries.filter(entry =>
    inPeriod(entry.due_date, filters)
    && inProject(entry.project_id, filters)
    && (filters.type === "todos" || entry.type === filters.type)
    && (filters.status === "todos" || entry.status === filters.status)
    && (filters.contactId === "todos" || entry.contact_id === filters.contactId)
  );
  const sum = (entries: FinancialEntry[], entryType: EntryType) => entries
    .filter(entry => entry.type === entryType)
    .reduce((total, entry) => total + number(entry.amount), 0);
  const baseRows = (groups: Array<{ label: string; test: (entry: FinancialEntry) => boolean }>) => groups
    .map((item, index) => {
      const entries = filtered.filter(item.test);
      const late = entries.filter(entry => !isSettled(entry) && daysUntil(entry.due_date) < 0);
      const incoming = sum(entries, "entrada");
      const outgoing = sum(entries, "saida");
      return {
        id: `${index}-${item.label}`,
        label: item.label,
        values: {
          entradas: incoming,
          saidas: outgoing,
          resultado: incoming - outgoing,
          vencido: late.reduce((total, entry) => total + number(entry.amount), 0),
          quantidade: entries.length,
        },
      };
    })
    .filter(row => number(row.values.quantidade) > 0)
    .sort((a, b) => number(b.values.entradas) + number(b.values.saidas) - number(a.values.entradas) - number(a.values.saidas));

  let rows: ReportRow[] = [];
  if (mode === "mensal") {
    const months = [...new Set(filtered.map(entry => (entry.competence_date || entry.due_date).slice(0, 7)))].sort();
    rows = baseRows(months.map(month => ({
      label: new Date(`${month}-15T12:00:00`).toLocaleDateString("pt-BR", { month: "long", year: "numeric" }),
      test: entry => (entry.competence_date || entry.due_date).startsWith(month),
    })));
  } else if (mode === "aging") {
    const buckets = ["A vencer", "1–15 dias", "16–30 dias", "31–60 dias", "61–90 dias", "> 90 dias"];
    rows = baseRows(buckets.map(bucket => ({ label: bucket, test: entry => agingBucket(entry) === bucket })));
  } else if (mode === "devedores" || mode === "credores") {
    const exposure = aggregateCounterparties({ ...data, entries: filtered }, mode === "devedores" ? "entrada" : "saida");
    rows = exposure.map(item => ({
      id: item.contactId,
      label: item.name,
      detail: `${item.overdueTitles} vencidos · maior atraso ${item.oldestDelay} dias`,
      values: {
        entradas: mode === "devedores" ? item.open : 0,
        saidas: mode === "credores" ? item.open : 0,
        resultado: mode === "devedores" ? item.open : -item.open,
        vencido: item.overdue,
        quantidade: item.titles,
      },
    }));
  } else if (mode === "classificacao") {
    rows = baseRows([
      ...data.costCenters.map(center => ({ label: `Custo · ${center.code} · ${center.name}`, test: (entry: FinancialEntry) => entry.cost_center_id === center.id })),
      ...revenueCenters.map(center => ({ label: `Recebimento · ${center.code || ""} · ${center.name}`, test: (entry: FinancialEntry) => entry.revenue_center_id === center.id })),
    ]);
  } else if (mode === "projetos") {
    rows = baseRows(data.projects.map(project => ({ label: `${project.code} · ${project.name}`, test: (entry: FinancialEntry) => entry.project_id === project.id })));
  } else if (mode === "categorias") {
    rows = baseRows(data.categories.map(category => ({ label: `${category.code} · ${category.name}`, test: (entry: FinancialEntry) => entry.category_id === category.id })));
  } else {
    rows = filtered.filter(entry => entry.cash_risk).map(entry => ({
      id: entry.id,
      label: entry.description,
      detail: `${labelize(entry.cash_risk_level || "risco")} · ${entry.recommended_due_date || "sem data recomendada"}`,
      values: {
        entradas: entry.type === "entrada" ? number(entry.amount) : 0,
        saidas: entry.type === "saida" ? number(entry.amount) : 0,
        resultado: entry.type === "entrada" ? number(entry.amount) : -number(entry.amount),
        vencido: number(entry.projected_balance),
        quantidade: 1,
      },
    }));
  }

  const incoming = sum(filtered, "entrada");
  const outgoing = sum(filtered, "saida");
  const overdue = filtered
    .filter(entry => !isSettled(entry) && daysUntil(entry.due_date) < 0)
    .reduce((total, entry) => total + number(entry.amount), 0);
  return {
    eyebrow: "CONTROLADORIA E FINANÇAS",
    title: reportModes.financeiro.find(item => item.id === mode)?.label || "Relatório financeiro",
    description: "Posição financeira consolidada com os filtros selecionados.",
    columns: [
      { key: "entradas", label: "Entradas", format: "money" },
      { key: "saidas", label: "Saídas", format: "money" },
      { key: "resultado", label: "Resultado", format: "money" },
      { key: "vencido", label: "Vencido / exposição", format: "money" },
      { key: "quantidade", label: "Qtd.", format: "number" },
    ],
    rows,
    kpis: [
      kpi("Entradas", currency(incoming), `${filtered.filter(entry => entry.type === "entrada").length} títulos`, "positive"),
      kpi("Saídas", currency(outgoing), `${filtered.filter(entry => entry.type === "saida").length} títulos`, "negative"),
      kpi("Resultado", currency(incoming - outgoing), "Período filtrado", "gold"),
      kpi("Exposição vencida", currency(overdue), "Títulos não liquidados", "warning"),
    ],
  };
}

function salesReport(mode: string, { data, sales, filters }: ReportContext): ReportResult {
  const proposals = sales.proposals.filter(item => inProject(item.project_id, filters) && inPeriod(item.accepted_at || item.submitted_at || item.created_at, filters));
  const contracts = sales.contracts.filter(item => inProject(item.project_id, filters) && inPeriod(item.signed_at || item.created_at, filters));
  const units = sales.units.filter(item => inProject(item.project_id, filters));
  const proposalValue = (proposalId: string) => number(sales.proposals.find(item => item.id === proposalId)?.sale_price);
  const signed = contracts.filter(item => item.status === "assinado");
  const signedValue = signed.reduce((sum, item) => sum + proposalValue(item.proposal_id), 0);
  const proposedVgv = proposals.filter(item => !["rejeitada", "recusada", "expirada", "cancelada"].includes(item.status)).reduce((sum, item) => sum + number(item.sale_price), 0);

  let columns: ReportColumn[];
  let rows: ReportRow[];
  if (mode === "vendas_contratos") {
    columns = [
      { key: "contratos", label: "Contratos", format: "number" },
      { key: "vgv", label: "Valor de venda", format: "money" },
      { key: "retencao", label: "Retenções", format: "money" },
      { key: "restituicao", label: "Restituições", format: "money" },
    ];
    rows = group(contracts, item => item.status).map(([status, items]) => ({
      id: status,
      label: labelize(status),
      values: {
        contratos: items.length,
        vgv: items.reduce((sum, item) => sum + proposalValue(item.proposal_id), 0),
        retencao: items.reduce((sum, item) => sum + number(item.retention_amount), 0),
        restituicao: items.reduce((sum, item) => sum + number(item.refund_amount), 0),
      },
    }));
  } else if (mode === "vendas_estoque") {
    columns = [
      { key: "unidades", label: "Unidades", format: "number" },
      { key: "disponiveis", label: "Disponíveis", format: "number" },
      { key: "reservadas", label: "Reservadas", format: "number" },
      { key: "vendidas", label: "Vendidas", format: "number" },
      { key: "vgv_estoque", label: "VGV em estoque", format: "money" },
    ];
    rows = group(units, item => projectName(data, item.project_id)).map(([project, items]) => ({
      id: project,
      label: project,
      values: {
        unidades: items.length,
        disponiveis: items.filter(item => item.status === "disponivel").length,
        reservadas: items.filter(item => item.status === "reservado").length,
        vendidas: items.filter(item => item.status === "vendido").length,
        vgv_estoque: items.filter(item => ["disponivel", "reservado"].includes(item.status)).reduce((sum, item) => sum + number(item.list_price), 0),
      },
    }));
  } else {
    columns = [
      { key: "propostas", label: "Propostas", format: "number" },
      { key: "contratos", label: "Contratos", format: "number" },
      { key: "vgv_proposto", label: "VGV proposto", format: "money" },
      { key: "vgv_vendido", label: "VGV vendido", format: "money" },
      { key: "desconto", label: "Desconto médio", format: "percent" },
    ];
    rows = data.projects
      .filter(project => filters.projectId === "todos" || project.id === filters.projectId)
      .map(project => {
        const projectProposals = proposals.filter(item => item.project_id === project.id);
        const projectContracts = contracts.filter(item => item.project_id === project.id);
        const projectSigned = projectContracts.filter(item => item.status === "assinado");
        return {
          id: project.id,
          label: project.name,
          detail: project.code,
          values: {
            propostas: projectProposals.length,
            contratos: projectContracts.length,
            vgv_proposto: projectProposals.reduce((sum, item) => sum + number(item.sale_price), 0),
            vgv_vendido: projectSigned.reduce((sum, item) => sum + proposalValue(item.proposal_id), 0),
            desconto: average(projectProposals.map(item => number(item.discount_pct) * 100)),
          },
        };
      })
      .filter(row => number(row.values.propostas) || number(row.values.contratos));
  }

  const available = units.filter(item => item.status === "disponivel");
  return {
    eyebrow: "INTELIGÊNCIA COMERCIAL",
    title: reportModes.vendas.find(item => item.id === mode)?.label || "Vendas e VGV",
    description: "Propostas, contratos assinados e estoque comercial sem exposição de dados pessoais.",
    columns,
    rows,
    kpis: [
      kpi("Propostas", count(proposals.length), `${proposals.filter(item => item.approval_status === "pendente").length} aguardando aprovação`, "gold"),
      kpi("Contratos assinados", count(signed.length), `${contracts.length} contratos no período`, "positive"),
      kpi("VGV vendido", currency(signedValue), `VGV proposto ${currency(proposedVgv)}`, "positive"),
      kpi("Estoque disponível", count(available.length), currency(available.reduce((sum, item) => sum + number(item.list_price), 0)), "gold"),
    ],
  };
}

function leadsReport(mode: string, { data, filters }: ReportContext): ReportResult {
  const leads = data.crmRecords.filter(item => inProject(item.project_id, filters) && inPeriod(item.created_at, filters));
  const selectedRecordIds = new Set(
    data.crmRecords
      .filter(item => inProject(item.project_id, filters))
      .map(item => item.id),
  );
  const open = leads.filter(item => item.record_status === "aberta");
  const won = leads.filter(item => item.record_status === "ganha");
  const pipeline = open.reduce((sum, item) => sum + number(item.estimated_value), 0);
  const columns: ReportColumn[] = [
    { key: "leads", label: "Leads", format: "number" },
    { key: "abertos", label: "Abertos", format: "number" },
    { key: "ganhos", label: "Ganhos", format: "number" },
    { key: "pipeline", label: "Pipeline", format: "money" },
    { key: "conversao", label: "Conversão", format: "percent" },
  ];
  const key = mode === "leads_origem"
    ? (item: typeof leads[number]) => item.source || "Não informada"
    : mode === "leads_temperatura"
      ? (item: typeof leads[number]) => labelize(item.temperature || item.priority || "não classificado")
      : (item: typeof leads[number]) => labelize(item.stage || "sem etapa");
  const rows = group(leads, key).map(([label, items]) => {
    const itemWon = items.filter(item => item.record_status === "ganha");
    return {
      id: label,
      label,
      values: {
        leads: items.length,
        abertos: items.filter(item => item.record_status === "aberta").length,
        ganhos: itemWon.length,
        pipeline: items.filter(item => item.record_status === "aberta").reduce((sum, item) => sum + number(item.estimated_value), 0),
        conversao: items.length ? itemWon.length / items.length * 100 : 0,
      },
    };
  }).sort((a, b) => number(b.values.leads) - number(a.values.leads));
  return {
    eyebrow: "CRM E AQUISIÇÃO",
    title: reportModes.leads.find(item => item.id === mode)?.label || "Leads e CRM",
    description: "Volume, valor potencial e conversão do funil comercial.",
    columns,
    rows,
    kpis: [
      kpi("Leads no período", count(leads.length), `${open.length} oportunidades abertas`, "gold"),
      kpi("Pipeline aberto", currency(pipeline), "Valor potencial informado", "positive"),
      kpi("Leads ganhos", count(won.length), `${pct(leads.length ? won.length / leads.length * 100 : 0)} de conversão`, "positive"),
      kpi("Próximas ações", count(data.crmActions.filter(item =>
        item.action_status === "pendente"
        && selectedRecordIds.has(item.crm_record_id)
        && inPeriod(item.scheduled_at, filters)
      ).length), "Atividades comerciais pendentes", "warning"),
    ],
  };
}

function constructionReport(mode: string, { data, filters }: ReportContext): ReportResult {
  const packages = data.constructionWorkPackages
    .filter(item =>
      !item.is_summary
      && !["cancelada", "cancelado"].includes(normalized(item.status))
      && inProject(item.project_id, filters)
    )
    .filter(item => inPeriod(item.planned_end || item.planned_start || item.created_at, filters));
  const today = new Date().toISOString().slice(0, 10);
  const delayed = packages.filter(item => item.planned_end && item.planned_end < today && number(item.actual_progress) < 100 && !["cancelada", "cancelado"].includes(item.status));
  const progress = (items: typeof packages, field: "actual_progress" | "planned_progress") => {
    const totalWeight = items.reduce((sum, item) => sum + number(item.weight_pct), 0);
    return totalWeight ? items.reduce((sum, item) => sum + number(item[field]) * number(item.weight_pct), 0) / totalWeight : average(items.map(item => number(item[field])));
  };
  const columns: ReportColumn[] = [
    { key: "etapas", label: "Etapas", format: "number" },
    { key: "previsto", label: "Previsto", format: "percent" },
    { key: "realizado", label: "Realizado", format: "percent" },
    { key: "desvio", label: "Desvio", format: "percent" },
    { key: "orcamento", label: "Orçamento", format: "money" },
    { key: "comprometido", label: "Comprometido", format: "money" },
  ];
  const key = mode === "obras_status"
    ? (item: typeof packages[number]) => labelize(item.status || "sem situação")
    : mode === "obras_prazos"
      ? (item: typeof packages[number]) => delayed.includes(item) ? "Em atraso" : number(item.actual_progress) >= 100 ? "Concluídas" : "No prazo"
      : (item: typeof packages[number]) => projectName(data, item.project_id);
  const rows = group(packages, key).map(([label, items]) => {
    const planned = progress(items, "planned_progress");
    const actual = progress(items, "actual_progress");
    return {
      id: label,
      label,
      detail: `${items.filter(item => delayed.includes(item)).length} etapa(s) atrasada(s)`,
      values: {
        etapas: items.length,
        previsto: planned,
        realizado: actual,
        desvio: actual - planned,
        orcamento: items.reduce((sum, item) => sum + number(item.budget_amount), 0),
        comprometido: items.reduce((sum, item) => sum + number(item.committed_amount), 0),
      },
    };
  });
  const planned = progress(packages, "planned_progress");
  const actual = progress(packages, "actual_progress");
  return {
    eyebrow: "ENGENHARIA E IMPLANTAÇÃO",
    title: reportModes.obras.find(item => item.id === mode)?.label || "Obras e EAP",
    description: "Os percentuais usam as mesmas etapas físicas e pesos da Gestão de Obras.",
    columns,
    rows,
    kpis: [
      kpi("Avanço realizado", pct(actual), `${packages.length} etapas físicas`, actual >= planned ? "positive" : "warning"),
      kpi("Avanço previsto", pct(planned), `Desvio de ${pct(actual - planned)}`, "gold"),
      kpi("Etapas atrasadas", count(delayed.length), "Prazo vencido e avanço abaixo de 100%", delayed.length ? "danger" : "positive"),
      kpi("Valor comprometido", currency(packages.reduce((sum, item) => sum + number(item.committed_amount), 0)), "Conforme EAP filtrada", "negative"),
    ],
  };
}

function procurementReport(mode: string, { data, filters }: ReportContext): ReportResult {
  const requests = data.purchaseRequests.filter(item => inProject(item.project_id, filters) && inPeriod(item.created_at, filters));
  const columns: ReportColumn[] = [
    { key: "solicitacoes", label: "Solicitações", format: "number" },
    { key: "estimado", label: "Valor estimado", format: "money" },
    { key: "risco", label: "Com risco", format: "number" },
    { key: "aprovadas", label: "Aprovadas / contratadas", format: "number" },
    { key: "financeiro", label: "Contas geradas", format: "number" },
  ];
  const key = mode === "compras_projetos"
    ? (item: typeof requests[number]) => projectName(data, item.project_id)
    : mode === "compras_fornecedores"
      ? (item: typeof requests[number]) => contactName(data, item.supplier_contact_id)
      : (item: typeof requests[number]) => labelize(item.status);
  const rows = group(requests, key).map(([label, items]) => ({
    id: label,
    label,
    values: {
      solicitacoes: items.length,
      estimado: items.reduce((sum, item) => sum + number(item.estimated_total), 0),
      risco: items.filter(item => item.cash_risk).length,
      aprovadas: items.filter(item => ["aprovada", "contratada", "recebida"].includes(item.status)).length,
      financeiro: items.filter(item => item.financial_entry_id).length,
    },
  })).sort((a, b) => number(b.values.estimado) - number(a.values.estimado));
  const total = requests.reduce((sum, item) => sum + number(item.estimated_total), 0);
  return {
    eyebrow: "SUPRIMENTOS E CONTRATAÇÕES",
    title: reportModes.compras.find(item => item.id === mode)?.label || "Compras e serviços",
    description: "Solicitações, compromissos e integração financeira de compras e serviços.",
    columns,
    rows,
    kpis: [
      kpi("Volume solicitado", currency(total), `${requests.length} solicitações`, "gold"),
      kpi("Aguardando aprovação", count(requests.filter(item => item.status === "submetida").length), "Fila de decisão", "warning"),
      kpi("Aprovadas / contratadas", count(requests.filter(item => ["aprovada", "contratada", "recebida"].includes(item.status)).length), "Solicitações ativas", "positive"),
      kpi("Risco de caixa", count(requests.filter(item => item.cash_risk && !["rejeitada", "cancelada"].includes(item.status)).length), "Compromissos a reprogramar", "danger"),
    ],
  };
}

function fuelReport(mode: string, { data, filters }: ReportContext): ReportResult {
  const projectRequests = data.fuelRequests.filter(item => inProject(item.project_id, filters));
  const projectRequestIds = new Set(projectRequests.map(item => item.id));
  const dispenses = data.fuelDispenses.filter(item => projectRequestIds.has(item.request_id) && inPeriod(item.dispensed_at, filters));
  const dispensedRequestIds = new Set(dispenses.map(item => item.request_id));
  const requestsInPeriod = projectRequests.filter(item => inPeriod(item.needed_at || item.submitted_at, filters));
  const requestsInPeriodIds = new Set(requestsInPeriod.map(item => item.id));
  const requestsForRows = projectRequests.filter(item => requestsInPeriodIds.has(item.id) || dispensedRequestIds.has(item.id));
  const dispenseByRequest = new Map<string, typeof dispenses>();
  for (const item of dispenses) dispenseByRequest.set(item.request_id, [...(dispenseByRequest.get(item.request_id) || []), item]);
  const key = mode === "combustiveis_tipo"
    ? (item: typeof requestsForRows[number]) => labelize(item.fuel_type)
    : mode === "combustiveis_equipamentos"
      ? (item: typeof requestsForRows[number]) => item.equipment_identifier || item.vehicle_identifier || item.plate_identifier || "Não identificado"
      : (item: typeof requestsForRows[number]) => projectName(data, item.project_id);
  const columns: ReportColumn[] = [
    { key: "solicitacoes", label: "Solicitações", format: "number" },
    { key: "solicitado", label: "Litros solicitados", format: "decimal" },
    { key: "abastecido", label: "Litros abastecidos", format: "decimal" },
    { key: "custo", label: "Custo", format: "money" },
    { key: "pendentes", label: "Pendentes", format: "number" },
  ];
  const rows = group(requestsForRows, key).map(([label, items]) => {
    const itemDispenses = items.flatMap(item => dispenseByRequest.get(item.id) || []);
    const itemRequests = items.filter(item => requestsInPeriodIds.has(item.id));
    return {
      id: label,
      label,
      detail: mode === "combustiveis_equipamentos"
        ? `${Math.max(0, ...itemDispenses.map(item => number(item.odometer))).toLocaleString("pt-BR")} km · ${Math.max(0, ...itemDispenses.map(item => number(item.hour_meter))).toLocaleString("pt-BR")} h registrados`
        : undefined,
      values: {
        solicitacoes: itemRequests.length,
        solicitado: itemRequests.reduce((sum, item) => sum + number(item.requested_liters), 0),
        abastecido: itemDispenses.reduce((sum, item) => sum + number(item.liters), 0),
        custo: itemDispenses.reduce((sum, item) => sum + number(item.total_amount), 0),
        pendentes: itemRequests.filter(item => ["solicitada", "submetida", "pendente", "aprovada"].includes(normalized(item.status))).length,
      },
    };
  }).sort((a, b) => number(b.values.custo) - number(a.values.custo));
  const liters = dispenses.reduce((sum, item) => sum + number(item.liters), 0);
  const cost = dispenses.reduce((sum, item) => sum + number(item.total_amount), 0);
  return {
    eyebrow: "GESTÃO DE COMBUSTÍVEIS",
    title: reportModes.combustiveis.find(item => item.id === mode)?.label || "Combustíveis",
    description: "Solicitações, abastecimentos registrados, custo e leitura dos equipamentos.",
    columns,
    rows,
    kpis: [
      kpi("Litros solicitados", count(Math.round(requestsInPeriod.reduce((sum, item) => sum + number(item.requested_liters), 0))), `${requestsInPeriod.length} solicitações`, "gold"),
      kpi("Litros abastecidos", count(Math.round(liters)), `${dispenses.length} abastecimentos`, "positive"),
      kpi("Custo abastecido", currency(cost), liters ? `${currency(cost / liters)} por litro` : "Sem abastecimentos", "negative"),
      kpi("Com comprovante", count(dispenses.filter(item => item.receipt_attachment_id).length), `${dispenses.length} registros no período`, "positive"),
    ],
  };
}

function contractsReport(mode: string, { data, filters }: ReportContext): ReportResult {
  const projectContracts = data.operationalContracts.filter(item => inProject(item.project_id, filters));
  const contracts = mode === "contratos_carteira"
    ? projectContracts.filter(item => inPeriod(item.start_date || item.created_at, filters))
    : projectContracts;
  const contractIds = new Set(contracts.map(item => item.id));
  const measurements = data.contractMeasurements.filter(item => contractIds.has(item.contract_id) && inPeriod(item.period_end || item.submitted_at, filters));
  const measurementIds = new Set(measurements.map(item => item.id));
  const measurementItems = data.contractMeasurementItems.filter(item => measurementIds.has(item.measurement_id));
  const columns: ReportColumn[] = mode === "contratos_horas"
    ? [
        { key: "medicoes", label: "Medições", format: "number" },
        { key: "horas", label: "Horas medidas", format: "decimal" },
        { key: "paradas", label: "Horas paradas", format: "decimal" },
        { key: "liquido", label: "Horas líquidas", format: "decimal" },
        { key: "valor", label: "Valor medido", format: "money" },
      ]
    : mode === "contratos_medicoes"
      ? [
          { key: "medicoes", label: "Medições", format: "number" },
          { key: "contratos", label: "Contratos", format: "number" },
          { key: "bruto", label: "Valor bruto", format: "money" },
          { key: "liquido", label: "Valor líquido", format: "money" },
          { key: "pendentes", label: "Pendentes", format: "number" },
        ]
    : [
        { key: "contratos", label: "Contratos", format: "number" },
        { key: "contratado", label: "Valor atual", format: "money" },
        { key: "medido", label: "Valor medido", format: "money" },
        { key: "saldo", label: "Saldo", format: "money" },
        { key: "pendentes", label: "Medições pendentes", format: "number" },
      ];

  let rows: ReportRow[];
  if (mode === "contratos_horas") {
    const equipmentItems = data.operationalContractItems.filter(item => contractIds.has(item.contract_id) && item.active);
    rows = equipmentItems.map(item => {
      const itemMeasurements = measurementItems.filter(measurement => measurement.contract_item_id === item.id);
      const measurementSet = new Set(itemMeasurements.map(measurement => measurement.measurement_id));
      const hours = itemMeasurements.reduce((sum, measurement) => sum + Math.max(0, number(measurement.meter_end) - number(measurement.meter_start)), 0);
      const downtime = itemMeasurements.reduce((sum, measurement) => sum + number(measurement.downtime_quantity), 0);
      const measuredValue = itemMeasurements.reduce((sum, measurement) => {
        const itemGross = measurement.gross_amount === null
          ? number(measurement.current_quantity) * number(measurement.unit_price_snapshot)
            + number(measurement.mobilization_amount)
            + number(measurement.demobilization_amount)
          : number(measurement.gross_amount);
        return sum + itemGross;
      }, 0);
      return {
        id: item.id,
        label: item.equipment_identifier || item.description,
        detail: `${data.operationalContracts.find(contract => contract.id === item.contract_id)?.contract_number || "Contrato"} · ${item.unit}`,
        values: {
          medicoes: measurementSet.size,
          horas: hours,
          paradas: downtime,
          liquido: Math.max(0, hours - downtime),
          valor: measuredValue,
        },
      };
    });
  } else if (mode === "contratos_medicoes") {
    rows = group(measurements, item => labelize(item.status || "sem situação")).map(([label, items]) => ({
      id: label,
      label,
      values: {
        medicoes: items.length,
        contratos: new Set(items.map(item => item.contract_id)).size,
        bruto: items.reduce((sum, item) => sum + number(item.gross_amount), 0),
        liquido: items.reduce((sum, item) => sum + number(item.net_amount), 0),
        pendentes: items.filter(item => ["rascunho", "submetida", "pendente"].includes(normalized(item.status))).length,
      },
    }));
  } else {
    rows = group(contracts, item => labelize(item.status)).map(([label, items]) => {
      const ids = new Set(items.map(item => item.id));
      const itemMeasurements = measurements.filter(item => ids.has(item.contract_id));
      const contracted = items.reduce((sum, item) => sum + number(item.current_amount), 0);
      const measured = itemMeasurements.reduce((sum, item) => sum + number(item.net_amount), 0);
      return {
        id: label,
        label,
        values: {
          contratos: items.length,
          contratado: contracted,
          medido: measured,
          saldo: contracted - measured,
          pendentes: itemMeasurements.filter(item => ["rascunho", "submetida", "pendente"].includes(normalized(item.status))).length,
        },
      };
    });
  }
  const totalContracted = contracts.reduce((sum, item) => sum + number(item.current_amount), 0);
  const totalMeasured = measurements.reduce((sum, item) => sum + number(item.net_amount), 0);
  const measuredHours = measurementItems.reduce((sum, item) => sum + Math.max(0, number(item.meter_end) - number(item.meter_start)), 0);
  return {
    eyebrow: "CONTRATOS E MEDIÇÕES",
    title: reportModes.contratos.find(item => item.id === mode)?.label || "Contratos operacionais",
    description: "Carteira contratada, medições financeiras e controle de horas e horímetros.",
    columns,
    rows,
    kpis: [
      kpi("Contratos vigentes", count(contracts.filter(item => item.status === "vigente").length), `${contracts.length} contratos filtrados`, "positive"),
      kpi("Valor contratado", currency(totalContracted), `Saldo ${currency(totalContracted - totalMeasured)}`, "gold"),
      kpi("Valor medido", currency(totalMeasured), `${measurements.length} medições`, "negative"),
      kpi("Horas medidas", count(Math.round(measuredHours)), `${count(Math.round(measurementItems.reduce((sum, item) => sum + number(item.downtime_quantity), 0)))} h paradas`, "warning"),
    ],
  };
}

function postSaleReport(mode: string, { data, postSale, filters }: ReportContext): ReportResult {
  const contracts = entityList(postSale.contracts).filter(item => inProject(item.project_id, filters));
  const contractIds = new Set(contracts.map(item => string(item.id)));
  const belongsToSelection = (contractId: string | null) =>
    contractId ? contractIds.has(contractId) : filters.projectId === "todos";
  const journeys = postSale.journeys.filter(item =>
    contractIds.has(item.contract_id)
    && inPeriod(item.updated_at || item.created_at, filters)
  );
  const tickets = postSale.tickets.filter(item => belongsToSelection(item.contract_id) && inPeriod(item.created_at, filters));
  const inspections = postSale.inspections.filter(item => contractIds.has(item.contract_id) && inPeriod(item.scheduled_at || item.created_at, filters));
  const surveys = postSale.surveys.filter(item => belongsToSelection(item.contract_id) && inPeriod(item.answered_at, filters));
  let columns: ReportColumn[];
  let rows: ReportRow[];

  if (mode === "posvenda_atendimentos") {
    columns = [
      { key: "tickets", label: "Chamados", format: "number" },
      { key: "abertos", label: "Abertos", format: "number" },
      { key: "resolvidos", label: "Resolvidos", format: "number" },
      { key: "sla", label: "SLA vencido", format: "number" },
      { key: "nota", label: "Nota média", format: "decimal" },
    ];
    rows = group(tickets, item => labelize(item.category || "sem categoria")).map(([label, items]) => ({
      id: label,
      label,
      values: {
        tickets: items.length,
        abertos: items.filter(item => !["resolvido", "fechado", "cancelado"].includes(normalized(item.status))).length,
        resolvidos: items.filter(item => ["resolvido", "fechado"].includes(normalized(item.status))).length,
        sla: items.filter(item => item.sla_due_at && item.sla_due_at < new Date().toISOString() && !item.resolved_at).length,
        nota: average(items.map(item => number(item.satisfaction_score)).filter(value => value > 0)),
      },
    }));
  } else if (mode === "posvenda_satisfacao") {
    columns = [
      { key: "respostas", label: "Respostas", format: "number" },
      { key: "nota", label: "Nota média", format: "decimal" },
      { key: "promotores", label: "Notas altas", format: "number" },
      { key: "inspecoes", label: "Inspeções", format: "number" },
      { key: "pendentes", label: "Inspeções pendentes", format: "number" },
    ];
    rows = group(surveys, item => labelize(item.survey_type || "satisfação")).map(([label, items]) => {
      const scores = items.map(item => number(item.score));
      const highScoreThreshold = Math.max(0, ...scores) > 5 ? 9 : 4;
      return {
        id: label,
        label,
        values: {
          respostas: items.length,
          nota: average(scores),
          promotores: scores.filter(score => score >= highScoreThreshold).length,
          inspecoes: inspections.length,
          pendentes: inspections.filter(item => !["concluida", "concluído", "cancelada"].includes(normalized(item.status))).length,
        },
      };
    });
  } else {
    columns = [
      { key: "contratos", label: "Clientes / contratos", format: "number" },
      { key: "jornadas", label: "Jornadas", format: "number" },
      { key: "progresso", label: "Progresso médio", format: "percent" },
      { key: "chamados", label: "Chamados abertos", format: "number" },
      { key: "inspecoes", label: "Inspeções pendentes", format: "number" },
    ];
    rows = data.projects
      .filter(project => filters.projectId === "todos" || project.id === filters.projectId)
      .map(project => {
        const projectContracts = contracts.filter(item => item.project_id === project.id);
        const ids = new Set(projectContracts.map(item => string(item.id)));
        const projectJourneys = journeys.filter(item => ids.has(item.contract_id));
        return {
          id: project.id,
          label: project.name,
          values: {
            contratos: projectContracts.length,
            jornadas: projectJourneys.length,
            progresso: average(projectJourneys.map(item => number(item.progress_pct))),
            chamados: tickets.filter(item => item.contract_id && ids.has(item.contract_id) && !["resolvido", "fechado", "cancelado"].includes(normalized(item.status))).length,
            inspecoes: inspections.filter(item => ids.has(item.contract_id) && !["concluida", "concluído", "cancelada"].includes(normalized(item.status))).length,
          },
        };
      })
      .filter(row => number(row.values.contratos) || number(row.values.jornadas));
  }

  const openTickets = tickets.filter(item => !["resolvido", "fechado", "cancelado"].includes(normalized(item.status)));
  return {
    eyebrow: "RELACIONAMENTO E ENTREGA",
    title: reportModes.posvenda.find(item => item.id === mode)?.label || "Pós-venda",
    description: "Acompanhamento agregado da carteira, jornadas, atendimentos e qualidade da entrega.",
    columns,
    rows,
    kpis: [
      kpi("Carteira pós-venda", count(contracts.length), `${journeys.length} jornadas monitoradas`, "gold"),
      kpi("Progresso das jornadas", pct(average(journeys.map(item => number(item.progress_pct)))), "Média da carteira filtrada", "positive"),
      kpi("Chamados abertos", count(openTickets.length), `${openTickets.filter(item => item.sla_due_at && item.sla_due_at < new Date().toISOString()).length} fora do SLA`, "warning"),
      kpi("Satisfação média", surveys.length ? average(surveys.map(item => number(item.score))).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) : "—", `${surveys.length} respostas`, "positive"),
    ],
  };
}

function hrReport(mode: string, { data, filters }: ReportContext): ReportResult {
  if (mode === "rh_folha") {
    const payrolls = data.hrPayrollRuns.filter(item => inPeriod(item.payment_date || item.reference_month, filters));
    const rows: ReportRow[] = payrolls.map(item => ({
      id: item.id,
      label: new Date(`${item.reference_month.slice(0, 7)}-15T12:00:00`).toLocaleDateString("pt-BR", { month: "long", year: "numeric" }),
      detail: labelize(item.status),
      values: {
        bruto: number(item.gross_total),
        encargos: number(item.charges_total),
        beneficios: number(item.benefits_total),
        liquido: number(item.net_total),
        risco: item.cash_risk ? "Sim" : "Não",
      },
    }));
    return {
      eyebrow: "PESSOAS E FOLHA",
      title: "Folha de pagamento",
      description: "Valores da folha e impactos de caixa por competência.",
      columns: [
        { key: "bruto", label: "Bruto", format: "money" },
        { key: "encargos", label: "Encargos", format: "money" },
        { key: "beneficios", label: "Benefícios", format: "money" },
        { key: "liquido", label: "Líquido", format: "money" },
        { key: "risco", label: "Risco de caixa", format: "text" },
      ],
      rows,
      kpis: [
        kpi("Folhas no período", count(payrolls.length), `${payrolls.filter(item => item.status === "aprovada").length} aprovadas`, "gold"),
        kpi("Total bruto", currency(payrolls.reduce((sum, item) => sum + number(item.gross_total), 0)), "Remuneração bruta", "positive"),
        kpi("Encargos e benefícios", currency(payrolls.reduce((sum, item) => sum + number(item.charges_total) + number(item.benefits_total), 0)), "Custo adicional", "negative"),
        kpi("Total líquido", currency(payrolls.reduce((sum, item) => sum + number(item.net_total), 0)), "Valor líquido calculado", "gold"),
      ],
    };
  }

  if (mode === "rh_eventos") {
    const events = data.hrEvents.filter(item => inPeriod(item.reference_date, filters));
    const rows: ReportRow[] = group(events, item => labelize(item.event_type)).map(([label, items]) => ({
      id: label,
      label,
      values: {
        eventos: items.length,
        valor: items.reduce((sum, item) => sum + number(item.amount), 0),
        previstos: items.filter(item => item.status === "previsto").length,
        aprovados: items.filter(item => item.status === "aprovado").length,
        pagos: items.filter(item => item.status === "pago").length,
      },
    }));
    return {
      eyebrow: "PESSOAS E EVENTOS",
      title: "Eventos de pessoal",
      description: "Férias, bônus, afastamentos e demais eventos com impacto operacional.",
      columns: [
        { key: "eventos", label: "Eventos", format: "number" },
        { key: "valor", label: "Valor", format: "money" },
        { key: "previstos", label: "Previstos", format: "number" },
        { key: "aprovados", label: "Aprovados", format: "number" },
        { key: "pagos", label: "Pagos", format: "number" },
      ],
      rows,
      kpis: [
        kpi("Eventos", count(events.length), "No período filtrado", "gold"),
        kpi("Valor previsto", currency(events.filter(item => item.status === "previsto").reduce((sum, item) => sum + number(item.amount), 0)), "Aguardando decisão", "warning"),
        kpi("Valor aprovado", currency(events.filter(item => item.status === "aprovado").reduce((sum, item) => sum + number(item.amount), 0)), "Compromisso aprovado", "positive"),
        kpi("Impacto no caixa", count(events.filter(item => item.cash_flow_impact).length), "Eventos com reflexo financeiro", "negative"),
      ],
    };
  }

  const employees = data.hrEmployees.filter(item => item.active);
  const rows: ReportRow[] = group(employees, item => item.department || "Sem departamento").map(([label, items]) => ({
    id: label,
    label,
    values: {
      colaboradores: items.length,
      salario: items.reduce((sum, item) => sum + number(item.base_salary), 0),
      encargos: items.reduce((sum, item) => sum + number(item.base_salary) * number(item.employer_charge_rate), 0),
      beneficios: items.reduce((sum, item) => sum + number(item.benefits_monthly), 0),
      custo: items.reduce((sum, item) => sum + number(item.base_salary) * (1 + number(item.employer_charge_rate)) + number(item.benefits_monthly), 0),
    },
  })).sort((a, b) => number(b.values.custo) - number(a.values.custo));
  const baseSalary = employees.reduce((sum, item) => sum + number(item.base_salary), 0);
  const totalCost = rows.reduce((sum, row) => sum + number(row.values.custo), 0);
  return {
    eyebrow: "PESSOAS E ESTRUTURA",
    title: "Quadro por departamento",
    description: "Composição do quadro ativo e custo mensal estimado por departamento.",
    columns: [
      { key: "colaboradores", label: "Colaboradores", format: "number" },
      { key: "salario", label: "Salários-base", format: "money" },
      { key: "encargos", label: "Encargos", format: "money" },
      { key: "beneficios", label: "Benefícios", format: "money" },
      { key: "custo", label: "Custo mensal", format: "money" },
    ],
    rows,
    kpis: [
      kpi("Colaboradores ativos", count(employees.length), `${rows.length} departamentos`, "positive"),
      kpi("Salários-base", currency(baseSalary), "Base mensal cadastrada", "gold"),
      kpi("Custo mensal estimado", currency(totalCost), "Salários, encargos e benefícios", "negative"),
      kpi("Eventos pendentes", count(data.hrEvents.filter(item => item.status === "previsto").length), "Aguardando tratamento", "warning"),
    ],
  };
}
