import { getSupabase } from "@/lib/supabase";

export type SignalArea =
  | "financeiro"
  | "aprovacoes"
  | "compras"
  | "obras"
  | "crm"
  | "combustiveis"
  | "contratos"
  | "rh"
  | "posvenda"
  | "marketing";

export type OperationalSignal = {
  id: string;
  sourceType: string;
  sourceId: string;
  sourceLabel: string;
  area: SignalArea;
  title: string;
  detail: string;
  recommendation: string;
  severity: "critical" | "attention" | "opportunity";
  score: number;
  dueAt: string | null;
  projectId: string | null;
  ownerUserId: string | null;
  impact: string | null;
};

export type OperationalFeed = {
  signals: OperationalSignal[];
  availableSources: number;
  totalSources: number;
  updatedAt: string;
};

type Entity = Record<string, unknown>;

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const terminalFinancialStatus = new Set(["pago", "recebido", "liquidado", "cancelado"]);
const terminalGenericStatus = new Set(["concluida", "concluído", "concluido", "fechado", "resolvido", "cancelado", "cancelada", "rejeitada", "recebida"]);
const pendingStatus = new Set(["pendente", "submetida", "solicitada", "aprovada", "previsto", "rascunho", "em_analise", "em análise"]);

export const signalAreaMeta: Record<SignalArea, { label: string; icon: string }> = {
  financeiro: { label: "Financeiro", icon: "R$" },
  aprovacoes: { label: "Aprovações", icon: "✓" },
  compras: { label: "Compras", icon: "▣" },
  obras: { label: "Obras", icon: "◒" },
  crm: { label: "CRM e SDR", icon: "◎" },
  combustiveis: { label: "Combustíveis", icon: "◈" },
  contratos: { label: "Contratos", icon: "▦" },
  rh: { label: "Pessoas", icon: "♧" },
  posvenda: { label: "Pós-venda", icon: "♥" },
  marketing: { label: "Marketing", icon: "◇" },
};

function text(row: Entity, ...keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function numeric(row: Entity, ...keys: string[]) {
  for (const key of keys) {
    const value = Number(row[key]);
    if (Number.isFinite(value) && value !== 0) return value;
  }
  return 0;
}

function identifier(row: Entity) {
  return text(row, "id", "request_code", "measurement_code", "protocol_number") || "registro-sem-id";
}

function dateValue(row: Entity, ...keys: string[]) {
  const value = text(row, ...keys);
  return value && !Number.isNaN(new Date(value).getTime()) ? value : null;
}

function normalizedStatus(row: Entity) {
  return text(row, "status", "action_status", "record_status", "document_workflow_status").toLowerCase();
}

function overdue(value: string | null, now: Date) {
  return Boolean(value && new Date(value).getTime() < now.getTime());
}

function withinDays(value: string | null, now: Date, days: number) {
  if (!value) return false;
  const time = new Date(value).getTime();
  return time >= now.getTime() && time <= now.getTime() + days * 86_400_000;
}

function calendarDaysUntil(value: string | null, now: Date) {
  if (!value) return null;
  const target = new Date(`${value.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date(now);
  today.setHours(12, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

function scoreSignal(signal: Omit<OperationalSignal, "score">, now: Date) {
  const severity = signal.severity === "critical" ? 84 : signal.severity === "attention" ? 64 : 44;
  const deadline = overdue(signal.dueAt, now) ? 12 : withinDays(signal.dueAt, now, 2) ? 7 : withinDays(signal.dueAt, now, 7) ? 3 : 0;
  const impact = signal.impact ? 4 : 0;
  return Math.min(100, severity + deadline + impact);
}

function createSignal(signal: Omit<OperationalSignal, "score">, now: Date): OperationalSignal {
  return { ...signal, score: scoreSignal(signal, now) };
}

function financialSignals(rows: Entity[], now: Date) {
  return rows.flatMap(row => {
    const status = normalizedStatus(row);
    if (terminalFinancialStatus.has(status)) return [];
    const type = text(row, "type");
    const amount = numeric(row, "amount");
    const sourceId = identifier(row);
    const detail = text(row, "description") || "Lançamento financeiro sem descrição.";
    const projectId = text(row, "project_id") || null;
    const ownerUserId = text(row, "created_by", "user_id") || null;
    const impact = amount ? money.format(amount) : null;
    const contractualDueAt = dateValue(row, "due_date");
    const scheduledAt = type === "saida" ? dateValue(row, "scheduled_payment_date") : null;
    const contractualDays = calendarDaysUntil(contractualDueAt, now);
    const scheduledDays = calendarDaysUntil(scheduledAt, now);
    const cashRisk = row.cash_risk === true;
    const signals: OperationalSignal[] = [];

    if (contractualDays !== null && contractualDays < 0) {
      signals.push(createSignal({
        id: `financial_entries:${sourceId}:contractual-due`,
        sourceType: "financial_entries",
        sourceId,
        sourceLabel: "Financeiro",
        area: "financeiro",
        title: type === "entrada" ? "Recebimento vencido" : "Vencimento contratual do pagamento ultrapassado",
        detail,
        recommendation: type === "entrada"
          ? "Registrar a tratativa de cobrança e a próxima data de contato."
          : "Tratar o vencimento com o credor e manter a programação financeira separada da data contratual.",
        severity: "critical",
        dueAt: contractualDueAt,
        projectId,
        ownerUserId,
        impact,
      }, now));
    }

    if (scheduledAt && scheduledDays !== null && scheduledDays <= 7) {
      const scheduledLate = scheduledDays < 0;
      signals.push(createSignal({
        id: `financial_entries:${sourceId}:scheduled-payment`,
        sourceType: "financial_entries",
        sourceId,
        sourceLabel: "Programação financeira",
        area: "financeiro",
        title: scheduledLate
          ? "Pagamento programado não liquidado"
          : scheduledDays === 0
            ? "Pagamento programado para hoje"
            : "Pagamento programado nos próximos 7 dias",
        detail,
        recommendation: scheduledLate
          ? "Confirmar a execução e a baixa; se o pagamento não ocorreu, reprogramar com justificativa e comunicar o parceiro quando aplicável."
          : "Confirmar saldo, aprovação, documentos e instrução de pagamento antes da data programada.",
        severity: scheduledLate || cashRisk ? "critical" : "attention",
        dueAt: scheduledAt,
        projectId,
        ownerUserId,
        impact,
      }, now));
    }

    if (!signals.length && cashRisk) {
      const planningAt = scheduledAt || contractualDueAt || dateValue(row, "recommended_due_date");
      signals.push(createSignal({
        id: `financial_entries:${sourceId}:cash-risk`,
        sourceType: "financial_entries",
        sourceId,
        sourceLabel: "Financeiro",
        area: "financeiro",
        title: "Risco de caixa identificado",
        detail,
        recommendation: "Validar disponibilidade de caixa, aprovação e eventual reprogramação.",
        severity: "attention",
        dueAt: planningAt,
        projectId,
        ownerUserId,
        impact,
      }, now));
    }

    return signals;
  });
}

function approvalSignals(rows: Entity[], now: Date) {
  return rows.flatMap(row => {
    if (normalizedStatus(row) !== "pendente") return [];
    const dueAt = dateValue(row, "recommended_due_date", "created_at");
    return [createSignal({
      id: `approval_requests:${identifier(row)}`,
      sourceType: "approval_requests",
      sourceId: identifier(row),
      sourceLabel: "Aprovações",
      area: "aprovacoes",
      title: "Decisão financeira aguardando responsável",
      detail: text(row, "reason", "comment") || "Solicitação pendente de análise.",
      recommendation: "Abrir a solicitação, avaliar o impacto e registrar a decisão.",
      severity: overdue(dueAt, now) ? "critical" : "attention",
      dueAt,
      projectId: null,
      ownerUserId: text(row, "assigned_to") || null,
      impact: null,
    }, now)];
  });
}

function purchaseSignals(rows: Entity[], now: Date) {
  return rows.flatMap(row => {
    const status = normalizedStatus(row);
    const risk = row.cash_risk === true;
    if (!pendingStatus.has(status) && !risk) return [];
    const dueAt = dateValue(row, "needed_by", "payment_due_date", "recommended_payment_date");
    const amount = numeric(row, "estimated_total");
    return [createSignal({
      id: `purchase_requests:${identifier(row)}`,
      sourceType: "purchase_requests",
      sourceId: identifier(row),
      sourceLabel: "Compras e serviços",
      area: "compras",
      title: risk ? "Compra com risco de caixa" : "Solicitação aguardando avanço",
      detail: text(row, "title", "description") || "Solicitação de compra ou serviço.",
      recommendation: risk
        ? "Revisar data de pagamento, orçamento e alçada antes da aprovação."
        : "Definir responsável, fornecedor e data de atendimento.",
      severity: risk || overdue(dueAt, now) ? "critical" : "attention",
      dueAt,
      projectId: text(row, "project_id") || null,
      ownerUserId: text(row, "requested_by") || null,
      impact: amount ? money.format(amount) : null,
    }, now)];
  });
}

function constructionSignals(rows: Entity[], now: Date) {
  return rows.flatMap(row => {
    if (row.is_summary === true || terminalGenericStatus.has(normalizedStatus(row))) return [];
    const planned = numeric(row, "planned_progress");
    const actual = numeric(row, "actual_progress");
    const deviation = planned - actual;
    const dueAt = dateValue(row, "planned_end");
    if (deviation < 5 && !overdue(dueAt, now)) return [];
    return [createSignal({
      id: `construction_work_packages:${identifier(row)}`,
      sourceType: "construction_work_packages",
      sourceId: identifier(row),
      sourceLabel: "Gestão de obras",
      area: "obras",
      title: deviation >= 5 ? `Etapa com desvio de ${deviation.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} p.p.` : "Prazo de etapa vencido",
      detail: `${text(row, "wbs_code", "code")} · ${text(row, "name")}`.replace(/^ · /, ""),
      recommendation: "Atualizar avanço, causa do desvio, impacto e plano de recuperação.",
      severity: overdue(dueAt, now) || deviation >= 15 ? "critical" : "attention",
      dueAt,
      projectId: text(row, "project_id") || null,
      ownerUserId: text(row, "responsible_user_id") || null,
      impact: deviation > 0 ? `${deviation.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} p.p.` : null,
    }, now)];
  });
}

function crmSignals(rows: Entity[], now: Date) {
  return rows.flatMap(row => {
    if (normalizedStatus(row) !== "aberta") return [];
    const slaAt = dateValue(row, "sla_due_at");
    const nextAt = dateValue(row, "next_action_at", "stagnation_at");
    const priority = text(row, "priority").toLowerCase();
    const slaLate = overdue(slaAt, now);
    const actionLate = overdue(nextAt, now);
    if (!slaLate && !actionLate && !["alta", "urgente"].includes(priority)) return [];
    const amount = numeric(row, "estimated_value");
    return [createSignal({
      id: `crm_records:${identifier(row)}`,
      sourceType: "crm_records",
      sourceId: identifier(row),
      sourceLabel: "CRM e SDR",
      area: "crm",
      title: slaLate ? "SLA de primeiro atendimento vencido" : actionLate ? "Próxima ação comercial vencida" : "Lead prioritário sem decisão",
      detail: `${text(row, "person_name", "company_name") || "Lead"} · ${text(row, "stage") || "Etapa não definida"}`,
      recommendation: "Executar a próxima tentativa, registrar o resultado e atualizar a qualificação.",
      severity: slaLate || priority === "urgente" ? "critical" : "attention",
      dueAt: slaAt || nextAt,
      projectId: text(row, "project_id") || null,
      ownerUserId: text(row, "sdr_user_id", "owner_user_id") || null,
      impact: amount ? `Pipeline ${money.format(amount)}` : null,
    }, now)];
  });
}

function fuelSignals(rows: Entity[], now: Date) {
  return rows.flatMap(row => {
    const status = normalizedStatus(row);
    if (terminalGenericStatus.has(status) || !pendingStatus.has(status)) return [];
    const dueAt = dateValue(row, "needed_at", "planned_due_date");
    const liters = numeric(row, "requested_liters");
    return [createSignal({
      id: `fuel_requests:${identifier(row)}`,
      sourceType: "fuel_requests",
      sourceId: identifier(row),
      sourceLabel: "Gestão de combustíveis",
      area: "combustiveis",
      title: overdue(dueAt, now) ? "Abastecimento fora do prazo" : "Abastecimento aguardando aprovação",
      detail: `${text(row, "request_code") || "Solicitação"} · ${text(row, "equipment_identifier", "vehicle_identifier") || "Equipamento não informado"}`,
      recommendation: "Validar autorização, equipamento, leitura e comprovante fiscal.",
      severity: overdue(dueAt, now) ? "critical" : "attention",
      dueAt,
      projectId: text(row, "project_id") || null,
      ownerUserId: text(row, "created_by") || null,
      impact: liters ? `${liters.toLocaleString("pt-BR")} L` : null,
    }, now)];
  });
}

function contractSignals(rows: Entity[], now: Date) {
  return rows.flatMap(row => {
    const status = normalizedStatus(row);
    if (terminalGenericStatus.has(status) || !pendingStatus.has(status)) return [];
    const dueAt = dateValue(row, "due_date", "recommended_due_date", "payment_due_date", "period_end");
    const amount = numeric(row, "net_amount", "gross_amount");
    return [createSignal({
      id: `contract_measurements:${identifier(row)}`,
      sourceType: "contract_measurements",
      sourceId: identifier(row),
      sourceLabel: "Contratos e medições",
      area: "contratos",
      title: overdue(dueAt, now) ? "Medição ou pagamento fora do prazo" : "Medição aguardando tratamento",
      detail: text(row, "measurement_code", "invoice_number") || "Medição operacional pendente.",
      recommendation: "Conferir período, horas/horímetros, documentos e alçada de aprovação.",
      severity: overdue(dueAt, now) ? "critical" : "attention",
      dueAt,
      projectId: text(row, "project_id") || null,
      ownerUserId: text(row, "created_by") || null,
      impact: amount ? money.format(amount) : null,
    }, now)];
  });
}

function hrSignals(rows: Entity[], now: Date) {
  return rows.flatMap(row => {
    const status = normalizedStatus(row);
    const dueAt = dateValue(row, "due_date", "reference_date");
    if (status !== "previsto" || (!overdue(dueAt, now) && !withinDays(dueAt, now, 7))) return [];
    const amount = numeric(row, "amount");
    return [createSignal({
      id: `hr_events:${identifier(row)}`,
      sourceType: "hr_events",
      sourceId: identifier(row),
      sourceLabel: "Pessoas e RH",
      area: "rh",
      title: overdue(dueAt, now) ? "Evento de pessoal vencido" : "Evento de pessoal nos próximos 7 dias",
      detail: text(row, "event_type", "notes").replaceAll("_", " ") || "Evento de pessoal previsto.",
      recommendation: "Confirmar responsável, impacto operacional e reflexo no caixa.",
      severity: overdue(dueAt, now) ? "critical" : "attention",
      dueAt,
      projectId: null,
      ownerUserId: text(row, "created_by") || null,
      impact: amount ? money.format(amount) : null,
    }, now)];
  });
}

function genericServiceSignals(rows: Entity[], now: Date, area: "posvenda" | "marketing") {
  return rows.flatMap(row => {
    const status = normalizedStatus(row);
    if (terminalGenericStatus.has(status)) return [];
    const dueAt = dateValue(row, "sla_due_at", "due_at", "needed_by", "scheduled_at");
    if (!overdue(dueAt, now) && !withinDays(dueAt, now, 3)) return [];
    const label = area === "posvenda" ? "Pós-venda" : "Marketing";
    return [createSignal({
      id: `${area}:${identifier(row)}`,
      sourceType: area === "posvenda" ? "post_sale_tickets" : "marketing_requests",
      sourceId: identifier(row),
      sourceLabel: label,
      area,
      title: overdue(dueAt, now) ? `${label}: prazo ou SLA vencido` : `${label}: compromisso próximo`,
      detail: text(row, "title", "subject", "protocol_number", "description") || "Registro operacional requer acompanhamento.",
      recommendation: area === "posvenda"
        ? "Definir retorno ao cliente, responsável e previsão de solução."
        : "Confirmar entrega, canal, responsável e dependências da campanha.",
      severity: overdue(dueAt, now) ? "critical" : "attention",
      dueAt,
      projectId: text(row, "project_id") || null,
      ownerUserId: text(row, "owner_user_id", "assigned_to", "requested_by") || null,
      impact: null,
    }, now)];
  });
}

export async function loadOperationalSignals(organizationId: string): Promise<OperationalFeed> {
  const client = getSupabase();
  const updatedAt = new Date().toISOString();
  const sourceDefinitions = [
    { table: "financial_entries", build: financialSignals },
    { table: "approval_requests", build: approvalSignals },
    { table: "purchase_requests", build: purchaseSignals },
    { table: "construction_work_packages", build: constructionSignals },
    { table: "crm_records", build: crmSignals },
    { table: "fuel_requests", build: fuelSignals },
    { table: "contract_measurements", build: contractSignals },
    { table: "hr_events", build: hrSignals },
    { table: "post_sale_tickets", build: (rows: Entity[], now: Date) => genericServiceSignals(rows, now, "posvenda") },
    { table: "marketing_requests", build: (rows: Entity[], now: Date) => genericServiceSignals(rows, now, "marketing") },
  ];
  if (!client) return { signals: [], availableSources: 0, totalSources: sourceDefinitions.length, updatedAt };

  const now = new Date();
  const results = await Promise.all(sourceDefinitions.map(async definition => {
    const result = await client
      .from(definition.table)
      .select("*")
      .eq("organization_id", organizationId)
      .limit(250);
    return {
      ok: !result.error,
      signals: result.error ? [] : definition.build((result.data || []) as Entity[], now),
    };
  }));

  const signals = results
    .flatMap(result => result.signals)
    .sort((a, b) => b.score - a.score || (a.dueAt || "9999").localeCompare(b.dueAt || "9999"))
    .slice(0, 120);

  return {
    signals,
    availableSources: results.filter(result => result.ok).length,
    totalSources: results.length,
    updatedAt,
  };
}
