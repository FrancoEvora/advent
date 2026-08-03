"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ErpData, Organization, ViewId } from "../types";
import styles from "./insights-center.module.css";
import type {
  InsightDataset,
  InsightTrendPoint,
  ManagementInsight,
  ManagementInsightMetric,
  ManagementInsightRun,
  ManagementInsightSettings,
} from "./insights-types";

type InsightsCenterProps = {
  data: ErpData;
  organization?: Organization;
  can?: (permission: string) => boolean;
  onOpenArea?: (view: ViewId) => void;
};

type TabId = "insights" | "bi" | "rotinas";
type PeriodId = "7" | "30" | "90" | "365" | "custom" | "all";

const EMPTY_DATASET: InsightDataset = { runs: [], insights: [], metrics: [], settings: null };
const RESOLVED_STATUSES = new Set(["resolvido", "descartado", "cancelado"]);
const CRITICAL_SEVERITIES = new Set(["critical"]);
const HIGH_PRIORITIES = new Set(["high", "urgent"]);

const AREA_LABELS: Record<string, string> = {
  corporativo: "Corporativo",
  financeiro: "Financeiro",
  financial: "Financeiro",
  caixa: "Fluxo de caixa",
  comercial: "Comercial e vendas",
  vendas: "Comercial e vendas",
  crm: "CRM e leads",
  vendas_crm_sdr: "Vendas, CRM e SDR",
  marketing: "Marketing",
  obras: "Obras",
  construction: "Obras",
  compras: "Compras e serviços",
  procurement: "Compras e serviços",
  combustiveis: "Combustíveis",
  contratos: "Contratos",
  pos_venda: "Pós-venda",
  posvenda: "Pós-venda",
  pos_venda_agenda: "Pós-venda e agenda",
  rh: "Pessoas e RH",
  governanca: "Governança",
};

const VIEW_BY_AREA: Record<string, ViewId> = {
  financeiro: "financeiro",
  financial: "financeiro",
  caixa: "caixa",
  comercial: "crm",
  vendas: "crm",
  crm: "crm",
  vendas_crm_sdr: "crm",
  marketing: "crm",
  obras: "obras",
  construction: "obras",
  compras: "compras",
  procurement: "compras",
  combustiveis: "compras",
  contratos: "contratos_operacionais",
  pos_venda: "posvenda",
  posvenda: "posvenda",
  pos_venda_agenda: "posvenda",
  rh: "rh",
  governanca: "auditoria",
};

const PERMISSION_BY_VIEW: Partial<Record<ViewId, string>> = {
  financeiro: "financial.view",
  caixa: "financial.view",
  crm: "crm.view",
  obras: "construction.view",
  compras: "procurement.view",
  contratos_operacionais: "contracts.view",
  posvenda: "post_sale.view",
  rh: "hr.view",
  aprovacoes: "financial.approve",
  auditoria: "audit.view",
  configuracoes: "settings.manage",
};

const SEVERITY_LABELS: Record<string, string> = {
  info: "Informativo",
  warning: "Atenção",
  high: "Alto",
  critical: "Crítico",
};

const STATUS_LABELS: Record<string, string> = {
  novo: "Novo",
  aberto: "Aberto",
  reconhecido: "Reconhecido",
  em_tratamento: "Em tratamento",
  resolvido: "Resolvido",
  descartado: "Descartado",
};

const PRIORITY_LABELS: Record<string, string> = {
  urgent: "Urgente",
  high: "Alta",
  medium: "Média",
  low: "Baixa",
};

const RESPONSIBLE_ROLE_BY_AREA: Record<string, string> = {
  corporativo: "Diretoria executiva",
  financeiro: "Gerência financeira",
  financial: "Gerência financeira",
  caixa: "Tesouraria e gerência financeira",
  comercial: "Gerência comercial",
  vendas: "Gerência comercial",
  crm: "Coordenação de CRM e SDR",
  vendas_crm_sdr: "Coordenação de CRM e SDR",
  marketing: "Gestão de marketing",
  obras: "Coordenação de engenharia",
  construction: "Coordenação de engenharia",
  compras: "Gestão de suprimentos",
  procurement: "Gestão de suprimentos",
  combustiveis: "Gestão de frota e combustíveis",
  contratos: "Gestão de contratos e jurídico",
  pos_venda: "Coordenação de pós-venda",
  posvenda: "Coordenação de pós-venda",
  pos_venda_agenda: "Coordenação de pós-venda",
  rh: "Gestão de pessoas",
  governanca: "Controladoria e diretoria",
};

const PLAN_NATURE_BY_AREA: Record<string, string> = {
  corporativo: "Direcionamento corporativo",
  financeiro: "Caixa, cobrança e liquidez",
  financial: "Caixa, cobrança e liquidez",
  caixa: "Fluxo de caixa",
  comercial: "Pipeline e conversão",
  vendas: "Pipeline e conversão",
  crm: "SLA, qualificação e conversão",
  vendas_crm_sdr: "SLA, qualificação e conversão",
  marketing: "Aquisição e relacionamento",
  obras: "Cronograma físico-financeiro",
  construction: "Cronograma físico-financeiro",
  compras: "Suprimentos e aprovações",
  procurement: "Suprimentos e aprovações",
  combustiveis: "Conformidade operacional e fiscal",
  contratos: "Vigência, medição e conformidade",
  pos_venda: "Relacionamento e agenda",
  posvenda: "Relacionamento e agenda",
  pos_venda_agenda: "Relacionamento e agenda",
  rh: "Pessoas e obrigações",
  governanca: "Aprovações e continuidade",
};

const COMPLETION_CRITERION_BY_AREA: Record<string, string> = {
  corporativo: "Decisão registrada, responsável definido e impacto reavaliado na próxima rotina gerencial.",
  financeiro: "Título tratado, datas e valores conciliados e reflexo confirmado no fluxo de caixa.",
  financial: "Título tratado, datas e valores conciliados e reflexo confirmado no fluxo de caixa.",
  caixa: "Programação financeira ajustada, exposição recalculada e saldo projetado novamente validado.",
  comercial: "Oportunidade atualizada no CRM, responsável e próxima ação definidos e resultado mensurado.",
  vendas: "Oportunidade atualizada no CRM, responsável e próxima ação definidos e resultado mensurado.",
  crm: "Lead classificado, responsável e próxima interação registrados, sem SLA pendente.",
  vendas_crm_sdr: "Lead classificado, responsável e próxima interação registrados, sem SLA pendente.",
  marketing: "Ação executada, público e canal registrados e indicador de resultado atualizado.",
  obras: "Etapa reprogramada, responsável definido e avanço físico comprovado na Gestão de Obras.",
  construction: "Etapa reprogramada, responsável definido e avanço físico comprovado na Gestão de Obras.",
  compras: "Solicitação tratada, alçada concluída e pedido ou contratação atualizado no sistema.",
  procurement: "Solicitação tratada, alçada concluída e pedido ou contratação atualizado no sistema.",
  combustiveis: "Abastecimento conciliado com comprovante, equipamento e horímetro, sem pendência documental.",
  contratos: "Contrato, vigência, responsável e documentos atualizados, sem pendência crítica aberta.",
  pos_venda: "Demanda respondida, encaminhamento registrado e retorno confirmado com o cliente.",
  posvenda: "Demanda respondida, encaminhamento registrado e retorno confirmado com o cliente.",
  pos_venda_agenda: "Demanda respondida, encaminhamento registrado e retorno confirmado com o cliente.",
  rh: "Pendência tratada, documento ou evento registrado e conformidade conferida pela área responsável.",
  governanca: "Deliberação registrada, evidências anexadas e trilha de auditoria concluída.",
};

const RUN_STATUS_LABELS: Record<string, string> = {
  started: "Em execução",
  completed: "Concluído",
  failed: "Falhou",
};

const dateTimeFormat = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const dateFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" });
const numberFormat = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
const compactNumberFormat = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
const moneyFormat = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 0,
});
const weekdayFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Sao_Paulo",
  weekday: "short",
});
const planDateFormat = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "UTC",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const saoPauloDatePartsFormat = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const DATA_FIELD_LABELS: Record<string, string> = {
  actual_pct: "Avanço realizado",
  activities_overdue: "Atividades vencidas",
  as_of: "Data de referência",
  cash_conversion_risk: "Risco de conversão em caixa",
  cash_risk: "Solicitações com risco de caixa",
  cash_risk_entries: "Lançamentos com risco de caixa",
  cash_risk_payrolls: "Folhas com risco de caixa",
  continuity_risk_contracts: "Contratos com risco de continuidade",
  continuity_risk_runs: "Execuções com risco de continuidade",
  conversion_risk_leads: "Leads com risco de conversão",
  cost_exposure: "Exposição de custo",
  coverage_pct: "Cobertura observada",
  decision: "Diretriz de decisão",
  decision_quality: "Qualidade da decisão",
  delayed_packages: "Etapas atrasadas",
  document_and_reconciliation_risk: "Pendências documentais e de conciliação",
  expiring_contracts: "Contratos próximos do vencimento",
  financial_exposure: "Exposição financeira",
  forecast_overrun: "Previsão acima do orçamento",
  governance_bottleneck: "Decisões no gargalo de aprovação",
  journey_actions_overdue: "Jornadas sem próxima ação",
  labor_and_cash_risk: "Obrigações trabalhistas e financeiras em risco",
  minimum_expected_pct: "Cobertura mínima esperada",
  metric_key: "Indicador de origem",
  missing_receipts: "Abastecimentos sem comprovante",
  open_leads: "Leads em aberto",
  open_receivables: "Recebíveis em aberto",
  operational_delay_requests: "Solicitações com risco de atraso operacional",
  overdue_amount: "Obrigações vencidas",
  overdue_approvals: "Aprovações vencidas",
  overdue_events: "Eventos de RH vencidos",
  overdue_needs: "Necessidades vencidas",
  overdue_receivables: "Recebíveis vencidos",
  payment_and_execution_risk: "Medições com risco financeiro e de execução",
  pending_approvals: "Aprovações pendentes",
  pending_measurements: "Medições pendentes",
  period_cost: "Custo do período",
  period_fuel_cost: "Custo de combustível no período",
  pipeline_at_risk: "Leads em risco no funil",
  planned_pct: "Avanço previsto",
  recent_backup_failures: "Backups recentes não concluídos",
  schedule_variance_pct: "Desvio do cronograma",
  sla_hours: "Limite de primeira resposta",
  sla_overdue: "Leads com SLA vencido",
  stagnation_hours: "Janela de estagnação",
  stagnant_leads: "Leads sem evolução",
  threshold_hours: "Limite de aprovação",
  tickets_sla_overdue: "Chamados com SLA vencido",
  unhandled_commitments: "Compromissos sem tratamento",
  variance_pct: "Desvio de avanço",
  window_days: "Janela de vencimento",
  window_hours: "Janela de verificação",
};

const ACTION_VERBS = [
  "anexar", "aplicar", "aprovar", "atribuir", "classificar", "conferir",
  "confirmar", "concluir", "definir", "encerrar", "iniciar", "notificar",
  "negociar", "ordenar", "registrar", "remover", "repetir", "repriorizar",
  "reprogramar", "revisar", "segmentar", "validar", "verificar",
];

function normalize(value: string | null | undefined) {
  return String(value || "").trim().toLocaleLowerCase("pt-BR");
}

function areaLabel(area: string) {
  const key = normalize(area);
  return AREA_LABELS[key] || area.replaceAll("_", " ").replace(/^./, value => value.toUpperCase());
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Não disponível";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Não disponível" : dateTimeFormat.format(date);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Sem prazo";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Sem prazo" : dateFormat.format(date);
}

function formatMetricValue(value: number | null | undefined, unit: string | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const numeric = Number(value);
  const normalizedUnit = normalize(unit);
  if (["brl", "currency", "money", "real", "reais"].includes(normalizedUnit)) return moneyFormat.format(numeric);
  if (["percent", "percentage", "percentual", "%", "pct"].includes(normalizedUnit)) return `${numberFormat.format(numeric)}%`;
  if (["count", "quantidade", "integer", "numero", "número"].includes(normalizedUnit)) return numberFormat.format(numeric);
  if (normalizedUnit === "days" || normalizedUnit === "dias") return `${numberFormat.format(numeric)} dias`;
  if (unit) return `${numberFormat.format(numeric)} ${unit}`;
  return numberFormat.format(numeric);
}

function isBusinessDayInSaoPaulo(value = new Date()) {
  return !["Sat", "Sun"].includes(weekdayFormat.format(value));
}

function dataFieldLabel(key: string) {
  const normalizedKey = normalize(key).replaceAll(" ", "_");
  if (DATA_FIELD_LABELS[normalizedKey]) return DATA_FIELD_LABELS[normalizedKey];
  const readable = normalizedKey.replaceAll("_", " ");
  return readable.replace(/^./, first => first.toLocaleUpperCase("pt-BR"));
}

function formatDataValue(key: string, value: string | number | boolean) {
  const normalizedKey = normalize(key).replaceAll(" ", "_");
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (typeof value === "number") {
    if (/(amount|exposure|cost|vgv|receivable|payable)/.test(normalizedKey)) return moneyFormat.format(value);
    if (/(^|_)(pct|percentage)(_|$)/.test(normalizedKey)) return `${numberFormat.format(value)}%`;
    if (normalizedKey.endsWith("_hours") || normalizedKey === "sla_hours") return `${numberFormat.format(value)} h`;
    if (normalizedKey.endsWith("_days")) return `${numberFormat.format(value)} dias`;
    return numberFormat.format(value);
  }
  if (/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return formatDateTime(value);
  return value.replaceAll("_", " ");
}

function displayItems(value: unknown): string[] {
  if (value === null || value === undefined || value === "") return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(item => displayItems(item));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
        return [`${dataFieldLabel(key)}: ${formatDataValue(key, item)}`];
      }
      const contents = displayItems(item);
      return contents.map(content => `${dataFieldLabel(key)}: ${content}`);
    });
  }
  return [];
}

function recommendationSteps(recommendation: string | null | undefined) {
  const content = String(recommendation || "").trim().replace(/[.;]+$/, "");
  if (!content) return [];
  const verbPattern = ACTION_VERBS.join("|");
  return content
    .split(new RegExp(`;\\s*|,\\s*(?=(?:${verbPattern})\\b)`, "i"))
    .map(step => step.trim().replace(/^./, first => first.toLocaleUpperCase("pt-BR")))
    .filter(Boolean)
    .slice(0, 5);
}

function dateKey(value: string | null | undefined) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = saoPauloDatePartsFormat.formatToParts(date);
  const year = parts.find(part => part.type === "year")?.value;
  const month = parts.find(part => part.type === "month")?.value;
  const day = parts.find(part => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function parseDateKey(value: string | null | undefined) {
  const key = dateKey(value);
  if (!key) return null;
  const date = new Date(`${key}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatCalendarDate(value: string | null | undefined) {
  const date = parseDateKey(value);
  return date ? planDateFormat.format(date) : "Não informado";
}

function isBusinessCalendarDate(date: Date) {
  const weekday = date.getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

function moveToNextBusinessDate(value: Date) {
  const date = new Date(value);
  while (!isBusinessCalendarDate(date)) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function addBusinessDays(value: Date, days: number) {
  const date = moveToNextBusinessDate(value);
  let remaining = Math.max(0, Math.floor(days));
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (isBusinessCalendarDate(date)) remaining -= 1;
  }
  return date;
}

function countBusinessDays(start: Date, end: Date) {
  if (end.getTime() < start.getTime()) return 0;
  const cursor = new Date(start);
  let total = 0;
  while (cursor.getTime() <= end.getTime()) {
    if (isBusinessCalendarDate(cursor)) total += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return total;
}

type PaymentCriticalityFactor = {
  label: string;
  detail: string | null;
  weight: number | null;
  maximumWeight: number | null;
  direction: "increase" | "reduce" | "neutral";
};

type PaymentCriticalityQueueItem = {
  key: string;
  title: string;
  counterparty: string | null;
  dueAt: string | null;
  daysOverdue: number | null;
  amount: number | null;
  score: number | null;
  band: string;
  classification: string | null;
  factors: PaymentCriticalityFactor[];
  treatmentRank: number | null;
  paymentOrder: number | null;
  actionLabel: string | null;
  action: string | null;
  paymentGate: string | null;
  paymentGateReason: string | null;
  postponementImpact: string[];
  confidencePct: number | null;
};

type PaymentCriticalitySnapshot = {
  policyVersion: string | null;
  asOf: string | null;
  totalAmount: number | null;
  totalTitles: number | null;
  confidencePct: number | null;
  counts: Record<string, number | null>;
  amounts: Record<string, number | null>;
  queue: PaymentCriticalityQueueItem[];
};

const PAYMENT_CRITICALITY_BANDS = ["critical", "high", "medium", "low"] as const;
const PAYMENT_FACTOR_LABELS: Record<string, string> = {
  legal_fiscal_labor: "Obrigação legal, fiscal ou trabalhista",
  operational_continuity: "Continuidade da obra ou operação",
  overdue_age: "Tempo transcorrido desde o vencimento",
  cash_impact: "Impacto no caixa",
  financial_exposure: "Participação na exposição vencida",
  critical_supplier: "Fornecedor, insumo ou serviço crítico",
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return value !== null && value !== "" && Number.isFinite(number) ? number : null;
}

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function criticalityBandLabel(value: string | null | undefined) {
  const band = normalize(value);
  if (band === "critical") return "Crítica";
  if (band === "high") return "Alta";
  if (band === "medium" || band === "moderate") return "Média";
  if (band === "low") return "Baixa";
  return value || "Não classificada";
}

function paymentGateLabel(value: string | null | undefined) {
  const gate = normalize(value);
  if (gate === "eligible") return "Elegível, sujeito à aprovação";
  if (gate === "cash_approval_required") return "Exige deliberação de caixa";
  if (gate === "validation_required") return "Cadastro incompleto: validar antes de programar";
  if (gate === "blocked") return "Bloqueado: regularizar antes de pagar";
  if (gate === "pay") return "Priorizar programação";
  if (gate === "negotiate") return "Negociar antes de programar";
  if (gate === "unblock") return "Bloqueado: regularizar antes de pagar";
  if (gate === "schedule") return "Ordenar na programação";
  return value ? value.replaceAll("_", " ") : "Não informado";
}

function paymentClassificationLabel(value: unknown) {
  const labels: Record<string, string> = {
    labor: "Trabalhista",
    fiscal: "Fiscal",
    legal_regulatory: "Legal ou regulatória",
    operational_continuity: "Continuidade operacional",
    critical_supplier: "Fornecedor crítico",
    general_payable: "Obrigação financeira geral",
  };
  const values = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  const normalized = values.flatMap(item => typeof item === "string" && item.trim() ? [item.trim()] : []);
  return normalized.length ? normalized.map(item => labels[normalize(item)] || item.replaceAll("_", " ")).join(" · ") : null;
}

function bandMetric(source: Record<string, unknown> | null, bands: Record<string, unknown> | null, band: string, metric: "count" | "amount") {
  const direct = finiteNumber(source?.[band]);
  if (direct !== null) return direct;
  const bandRecord = recordValue(bands?.[band]);
  return finiteNumber(bandRecord?.[metric]);
}

function normalizePaymentFactors(value: unknown): PaymentCriticalityFactor[] {
  const source = Array.isArray(value)
    ? value.map((factor, index) => [`factor-${index}`, factor] as const)
    : Object.entries(recordValue(value) || {});
  return source.flatMap(([key, candidate]): PaymentCriticalityFactor[] => {
    const factor = recordValue(candidate);
    if (!factor) return [];
    const weight = finiteNumber(factor.score ?? factor.weight ?? factor.points);
    const maximumWeight = finiteNumber(factor.max_score ?? factor.maximum_score ?? factor.maxWeight);
    const explicitDirection = normalize(firstString(factor, ["direction", "effect"]));
    const triggered = typeof factor.triggered === "boolean" ? factor.triggered : null;
    return [{
      label: firstString(factor, ["label", "name", "factor"]) || PAYMENT_FACTOR_LABELS[normalize(key)] || dataFieldLabel(key),
      detail: firstString(factor, ["detail", "description", "reason"]),
      weight,
      maximumWeight,
      direction: explicitDirection === "reduce" || (weight !== null && weight < 0) || triggered === false || weight === 0
        ? "reduce"
        : explicitDirection === "neutral"
          ? "neutral"
          : "increase",
    }];
  });
}

function normalizePostponementImpact(value: unknown) {
  const source = recordValue(value);
  if (!source) return displayItems(value);
  const description = firstString(source, ["description", "impact", "summary"]);
  const items: string[] = description ? [description] : [];
  if (source.missed_schedule === true || source.missedSchedule === true) items.push("A programação efetiva registrada também foi descumprida.");
  const level = firstString(source, ["level", "band"]);
  if (level) items.push(`Nível registrado: ${criticalityBandLabel(level)}.`);
  return items;
}

function paymentCriticalitySnapshot(evidence: unknown): PaymentCriticalitySnapshot | null {
  const evidenceRecord = recordValue(evidence);
  const source = recordValue(evidenceRecord?.payment_criticality);
  if (!source) return null;

  const queueSource = Array.isArray(source.queue) ? source.queue : Array.isArray(source.items) ? source.items : [];
  const queue = queueSource.flatMap((candidate, index): PaymentCriticalityQueueItem[] => {
    const item = recordValue(candidate);
    if (!item) return [];
    const factors = normalizePaymentFactors(item.factors ?? item.signals);
    const postponementSource = item.postponement_impact ?? item.postponementImpact;
    const actionSource = recordValue(item.action);
    const paymentGateSource = recordValue(item.payment_gate ?? item.paymentGate);
    return [{
      key: firstString(item, ["entry_id", "entryId", "title_id", "id"]) || `queue-${index}`,
      title: firstString(item, ["title", "description", "label"]) || "Título sem descrição",
      counterparty: firstString(item, ["counterparty", "beneficiary", "supplier"]),
      dueAt: firstString(item, ["due_at", "dueDate", "due_date"]),
      daysOverdue: finiteNumber(item.days_overdue ?? item.daysOverdue),
      amount: finiteNumber(item.amount ?? item.open_amount),
      score: finiteNumber(item.score),
      band: normalize(firstString(item, ["band", "level", "criticality"]) || ""),
      classification: paymentClassificationLabel(item.classification) || firstString(item, ["nature"]),
      factors,
      treatmentRank: finiteNumber(item.treatment_rank ?? item.treatmentRank),
      paymentOrder: finiteNumber(item.recommended_payment_order ?? item.paymentOrder),
      actionLabel: actionSource ? firstString(actionSource, ["label", "code"]) : null,
      action: actionSource
        ? firstString(actionSource, ["recommendation", "description", "label"])
        : firstString(item, ["action", "recommended_action", "treatment"]),
      paymentGate: paymentGateSource
        ? firstString(paymentGateSource, ["status", "code"])
        : firstString(item, ["payment_gate", "cashDecision", "cash_decision"]),
      paymentGateReason: paymentGateSource ? firstString(paymentGateSource, ["reason", "description"]) : null,
      postponementImpact: normalizePostponementImpact(postponementSource),
      confidencePct: finiteNumber(item.confidence_pct ?? item.confidence),
    }];
  });

  const portfolio = recordValue(source.portfolio);
  const countsSource = recordValue(source.counts ?? portfolio?.counts);
  const amountsSource = recordValue(source.amounts ?? portfolio?.amounts);
  const bandsSource = recordValue(source.bands ?? portfolio?.bands);
  const counts: Record<string, number | null> = {};
  const amounts: Record<string, number | null> = {};
  PAYMENT_CRITICALITY_BANDS.forEach(band => {
    counts[band] = bandMetric(countsSource, bandsSource, band, "count");
    amounts[band] = bandMetric(amountsSource, bandsSource, band, "amount");
  });

  return {
    policyVersion: firstString(source, ["policy_version", "policyVersion"]),
    asOf: firstString(source, ["as_of", "asOf"]),
    totalAmount: finiteNumber(portfolio?.total_exposure ?? portfolio?.total_amount ?? source.total_amount ?? source.totalAmount),
    totalTitles: finiteNumber(portfolio?.total_titles ?? source.total_titles ?? source.totalTitles),
    confidencePct: finiteNumber(portfolio?.confidence_pct ?? source.confidence_pct ?? source.confidence),
    counts,
    amounts,
    queue,
  };
}

function planClassification(insight: ManagementInsight) {
  const severity = normalize(insight.severity);
  const priority = normalize(insight.priority);
  const content = normalize(`${insight.title} ${insight.summary}`);
  const nature = PLAN_NATURE_BY_AREA[normalize(insight.area)] || "Gestão e controle";
  if (content.includes("cobertura") || content.includes("dados insuficientes")) return `Qualidade de dados · ${nature}`;
  if (severity === "critical" || priority === "urgent") return `Corretiva crítica · ${nature}`;
  if (severity === "high" || priority === "high") return `Corretiva · ${nature}`;
  if (severity === "warning" || priority === "medium") return `Preventiva · ${nature}`;
  return `Monitoramento · ${nature}`;
}

function normalizedPriority(insight: ManagementInsight) {
  const priority = normalize(insight.priority);
  if (PRIORITY_LABELS[priority]) return priority;
  const severity = normalize(insight.severity);
  if (severity === "critical") return "urgent";
  if (severity === "high") return "high";
  if (severity === "warning") return "medium";
  return "low";
}

function recommendedBusinessDays(priority: string) {
  if (priority === "urgent") return 1;
  if (priority === "high") return 3;
  if (priority === "medium") return 5;
  return 10;
}

function recommendedPlan(insight: ManagementInsight, extractedSteps: string[]) {
  const area = normalize(insight.area);
  const priority = normalizedPriority(insight);
  const defaultBusinessDays = recommendedBusinessDays(priority);
  const start = moveToNextBusinessDate(parseDateKey(insight.acknowledged_at || insight.created_at) || new Date("2000-01-03T12:00:00Z"));
  const registeredDueDate = parseDateKey(insight.due_at);
  const hasUsableRegisteredDueDate = Boolean(registeredDueDate && registeredDueDate.getTime() >= start.getTime());
  const target = hasUsableRegisteredDueDate && registeredDueDate
    ? moveToNextBusinessDate(registeredDueDate)
    : addBusinessDays(start, defaultBusinessDays - 1);
  const businessDays = Math.max(1, countBusinessDays(start, target));
  const review = addBusinessDays(start, Math.max(0, Math.ceil(businessDays / 2) - 1));
  const completionCriterion = COMPLETION_CRITERION_BY_AREA[area]
    || "Evidências validadas, ação executada, registro atualizado e indicador reavaliado na próxima rotina.";
  const sequence = [
    `Validar as evidências registradas em ${areaLabel(insight.area)}.`,
    "Confirmar classificação, prioridade, datas e a pessoa que assumirá a função responsável.",
    ...extractedSteps.slice(0, 2),
    "Atualizar o item de origem e registrar o resultado do tratamento.",
    "Reavaliar o indicador na próxima rotina de insights.",
  ].filter((step, index, items) => items.findIndex(item => normalize(item) === normalize(step)) === index).slice(0, 6);

  return {
    classification: planClassification(insight),
    priority,
    priorityLabel: PRIORITY_LABELS[priority],
    responsibleRole: RESPONSIBLE_ROLE_BY_AREA[area] || "Gestor da área responsável",
    startAt: planDateFormat.format(start),
    reviewAt: planDateFormat.format(review),
    targetAt: planDateFormat.format(target),
    businessDays,
    deadlineOrigin: hasUsableRegisteredDueDate ? "prazo já registrado" : "prazo recomendado",
    sequence,
    completionCriterion,
  };
}

function parseTrendPoints(value: unknown): InsightTrendPoint[] {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { points?: unknown }).points)
      ? (value as { points: unknown[] }).points
      : [];

  return source.flatMap((point, index) => {
    if (typeof point === "number" && Number.isFinite(point)) return [{ label: String(index + 1), value: point }];
    if (!point || typeof point !== "object") return [];
    const candidate = point as Record<string, unknown>;
    const numeric = Number(candidate.value);
    if (!Number.isFinite(numeric)) return [];
    return [{
      value: numeric,
      label: String(candidate.label || candidate.at || candidate.date || candidate.period || index + 1),
      at: typeof candidate.at === "string" ? candidate.at : undefined,
      date: typeof candidate.date === "string" ? candidate.date : undefined,
      period: typeof candidate.period === "string" ? candidate.period : undefined,
    }];
  });
}

function isResolved(insight: ManagementInsight) {
  return RESOLVED_STATUSES.has(normalize(insight.status));
}

function runInsightCount(run: ManagementInsightRun) {
  if (!run.executive_summary || typeof run.executive_summary !== "object") return null;
  const insights = (run.executive_summary as { insights?: unknown }).insights;
  if (!insights || typeof insights !== "object") return null;
  const total = Number((insights as { total?: unknown }).total);
  return Number.isFinite(total) ? total : null;
}

function insightTimestamp(insight: ManagementInsight) {
  return new Date(insight.created_at).getTime();
}

function findFinancialRisk(metrics: ManagementInsightMetric[], insights: ManagementInsight[]) {
  const metric = metrics.find(item => normalize(item.metric_key) === "overdue_payables_trusted_v1")
    || metrics.find(item => normalize(item.metric_key) === "overdue_payables")
    || metrics.find(item => {
      const key = normalize(item.metric_key);
      return key.includes("risk") && (key.includes("finance") || key.includes("cash"));
    });
  if (metric && metric.numeric_value !== null) return { value: Number(metric.numeric_value), unit: metric.unit || "BRL" };

  const amounts = insights
    .filter(item => ["financeiro", "financial", "caixa"].includes(normalize(item.area)) && !isResolved(item))
    .flatMap(item => Object.entries(item.impact && typeof item.impact === "object" ? item.impact as Record<string, unknown> : {}))
    .filter(([key]) => ["exposure", "risco", "risk"].some(term => normalize(key).includes(term)))
    .map(([, value]) => Number(value))
    .filter(Number.isFinite);
  return amounts.length ? { value: amounts.reduce((sum, value) => sum + value, 0), unit: "BRL" } : null;
}

function TrendChart({ metric }: { metric: ManagementInsightMetric }) {
  const points = parseTrendPoints(metric.trend_points);
  if (!points.length) return <DataGap text="Esta métrica ainda não possui série histórica gravada." compact />;

  const values = points.map(point => point.value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const spread = maximum - minimum || Math.max(Math.abs(maximum), 1);
  const left = 34;
  const top = 20;
  const width = 660;
  const height = 176;
  const coordinates = points.map((point, index) => {
    const x = points.length === 1 ? left + width / 2 : left + (index / (points.length - 1)) * width;
    const y = top + height - ((point.value - minimum) / spread) * height;
    return { ...point, x, y };
  });
  const polyline = coordinates.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");

  return <div className={styles.trendChart}>
    <div className={styles.chartSummary}>
      <span><small>Mínimo</small><strong>{formatMetricValue(minimum, metric.unit)}</strong></span>
      <span><small>Atual</small><strong>{formatMetricValue(points.at(-1)?.value, metric.unit)}</strong></span>
      <span><small>Máximo</small><strong>{formatMetricValue(maximum, metric.unit)}</strong></span>
    </div>
    <svg viewBox="0 0 728 236" role="img" aria-label={`Tendência de ${metric.label}`}>
      {[0, 1, 2, 3].map(index => <line key={index} x1="34" x2="694" y1={20 + index * 58.7} y2={20 + index * 58.7} />)}
      {coordinates.length > 1 ? <polyline points={polyline} /> : null}
      {coordinates.map((point, index) => <g key={`${point.label}-${index}`}>
        <circle cx={point.x} cy={point.y} r="5" />
        {(index === 0 || index === coordinates.length - 1 || coordinates.length <= 5) ? <text x={point.x} y="225" textAnchor={index === 0 ? "start" : index === coordinates.length - 1 ? "end" : "middle"}>{point.label}</text> : null}
      </g>)}
    </svg>
  </div>;
}

function DataGap({ text, compact = false }: { text: string; compact?: boolean }) {
  return <div className={`${styles.dataGap} ${compact ? styles.dataGapCompact : ""}`} role="status">
    <span aria-hidden="true">◇</span>
    <div><strong>Lacuna de dados</strong><p>{text}</p></div>
  </div>;
}

export function InsightsCenter({ data, organization, can, onOpenArea }: InsightsCenterProps) {
  const activeOrganization = organization || data.organization;
  const organizationId = activeOrganization.id;
  const [dataset, setDataset] = useState<InsightDataset>(EMPTY_DATASET);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<TabId>("insights");
  const [period, setPeriod] = useState<PeriodId>("30");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [area, setArea] = useState("todos");
  const [severity, setSeverity] = useState("todos");
  const [status, setStatus] = useState("todos");
  const [selectedMetricId, setSelectedMetricId] = useState("");

  const mayManage = can ? can("insights.manage") : data.membership.role === "admin";
  const mayRun = can ? can("insights.run") || mayManage : mayManage;
  const mayTreat = can ? can("insights.assign") || mayManage : mayManage;
  const isBusinessDay = isBusinessDayInSaoPaulo();

  const load = useCallback(async (quiet = false) => {
    const client = getSupabase();
    if (!client) {
      setError("A conexão com a base de dados não está disponível.");
      setLoading(false);
      return;
    }
    if (quiet) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const [runsResult, insightsResult, metricsResult, settingsResult] = await Promise.all([
        client.from("insight_runs").select("*").eq("organization_id", organizationId).order("started_at", { ascending: false }).limit(100),
        client.from("insights").select("*").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(2000),
        client.from("insight_metrics").select("*").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(2000),
        client.from("insight_settings").select("*").eq("organization_id", organizationId).maybeSingle(),
      ]);
      const failure = [runsResult, insightsResult, metricsResult, settingsResult].find(result => result.error);
      if (failure?.error) throw failure.error;
      setDataset({
        runs: (runsResult.data || []) as ManagementInsightRun[],
        insights: (insightsResult.data || []) as ManagementInsight[],
        metrics: (metricsResult.data || []) as ManagementInsightMetric[],
        settings: (settingsResult.data || null) as ManagementInsightSettings | null,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar a Central de Insights.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [organizationId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const latestRun = dataset.runs.find(run => normalize(run.status) === "completed") || dataset.runs[0] || null;
  const latestRunTime = latestRun?.completed_at || latestRun?.started_at || null;
  const nextRunAt = dataset.settings?.next_run_at || null;
  const anchorTimestamp = latestRunTime ? new Date(latestRunTime).getTime() : null;

  const areas = useMemo(() => {
    const values = new Set<string>();
    dataset.insights.forEach(item => item.area && values.add(item.area));
    dataset.metrics.forEach(item => item.area && values.add(item.area));
    return [...values].sort((left, right) => areaLabel(left).localeCompare(areaLabel(right), "pt-BR"));
  }, [dataset.insights, dataset.metrics]);

  const filteredInsights = useMemo(() => dataset.insights.filter(insight => {
    const timestamp = insightTimestamp(insight);
    if (period !== "all" && period !== "custom" && anchorTimestamp) {
      const cutoff = anchorTimestamp - Number(period) * 86_400_000;
      if (timestamp < cutoff || timestamp > anchorTimestamp) return false;
    }
    if (period === "custom") {
      if (from && timestamp < new Date(`${from}T00:00:00`).getTime()) return false;
      if (to && timestamp > new Date(`${to}T23:59:59`).getTime()) return false;
    }
    if (area !== "todos" && insight.area !== area) return false;
    if (severity !== "todos" && normalize(insight.severity) !== severity) return false;
    if (status !== "todos" && normalize(insight.status) !== status) return false;
    return true;
  }), [anchorTimestamp, area, dataset.insights, from, period, severity, status, to]);

  const currentRunMetrics = useMemo(() => {
    const runId = latestRun?.id;
    const source = runId ? dataset.metrics.filter(metric => metric.run_id === runId) : dataset.metrics;
    return area === "todos" ? source : source.filter(metric => metric.area === area);
  }, [area, dataset.metrics, latestRun?.id]);

  const trendMetrics = useMemo(
    () => currentRunMetrics.filter(metric => parseTrendPoints(metric.trend_points).length > 0),
    [currentRunMetrics],
  );
  const selectedMetric = trendMetrics.find(metric => metric.id === selectedMetricId) || trendMetrics[0] || null;

  const openInsights = filteredInsights.filter(insight => !isResolved(insight));
  const criticalCount = openInsights.filter(insight => CRITICAL_SEVERITIES.has(normalize(insight.severity))).length;
  const highPriorityCount = openInsights.filter(insight => HIGH_PRIORITIES.has(normalize(insight.priority))).length;
  const financialRisk = findFinancialRisk(currentRunMetrics, filteredInsights);
  const coverageMetric = currentRunMetrics.find(metric => normalize(metric.metric_key).includes("coverage") || normalize(metric.metric_key).includes("cobertura"));
  const coverage = area === "todos"
    ? latestRun?.data_coverage_pct ?? null
    : coverageMetric?.numeric_value ?? null;

  const decisions = useMemo(() => filteredInsights.slice().sort((left, right) => {
    const leftClosed = isResolved(left) ? 1 : 0;
    const rightClosed = isResolved(right) ? 1 : 0;
    if (leftClosed !== rightClosed) return leftClosed - rightClosed;
    const severityScore = (item: ManagementInsight) => CRITICAL_SEVERITIES.has(normalize(item.severity)) ? 3 : normalize(item.severity) === "high" ? 2 : normalize(item.severity) === "warning" ? 1 : 0;
    return severityScore(right) - severityScore(left) || insightTimestamp(right) - insightTimestamp(left);
  }), [filteredInsights]);

  const areaComparisons = useMemo(() => {
    const grouped = new Map<string, { total: number; critical: number; open: number }>();
    filteredInsights.forEach(insight => {
      const current = grouped.get(insight.area) || { total: 0, critical: 0, open: 0 };
      current.total += 1;
      if (CRITICAL_SEVERITIES.has(normalize(insight.severity))) current.critical += 1;
      if (!isResolved(insight)) current.open += 1;
      grouped.set(insight.area, current);
    });
    return [...grouped.entries()]
      .map(([key, values]) => ({ area: key, ...values }))
      .sort((left, right) => right.open - left.open || right.critical - left.critical);
  }, [filteredInsights]);
  const comparisonMaximum = Math.max(0, ...areaComparisons.map(item => item.total));

  async function updateInsight(insight: ManagementInsight, nextStatus: "reconhecido" | "resolvido") {
    if (!mayTreat) return;
    const client = getSupabase();
    if (!client) return;
    if (nextStatus === "resolvido" && !window.confirm(`Confirmar a resolução do insight “${insight.title}”?`)) return;
    setActionBusy(insight.id);
    setError("");
    setMessage("");
    const result = await client.rpc("set_insight_status", {
      p_insight_id: insight.id,
      p_status: nextStatus,
      p_note: null,
      p_due_at: insight.due_at,
      p_responsible_user_id: insight.responsible_user_id,
    });
    if (result.error) setError(result.error.message);
    else {
      setMessage(nextStatus === "resolvido" ? "Insight marcado como resolvido." : "Insight reconhecido e incluído no acompanhamento.");
      await load(true);
    }
    setActionBusy(null);
  }

  async function runManualAnalysis() {
    if (!mayRun) return;
    if (!isBusinessDay) {
      setMessage("A geração de insights está disponível apenas de segunda a sexta-feira (horário de São Paulo).");
      return;
    }
    if (!window.confirm("Executar agora uma análise extraordinária de todas as áreas habilitadas?")) return;
    const client = getSupabase();
    if (!client) return;
    setActionBusy("manual-run");
    setError("");
    setMessage("");
    const result = await client.rpc("generate_management_insights", {
      p_organization_id: organizationId,
      p_period_start: null,
      p_period_end: null,
    });
    if (result.error) setError(result.error.message);
    else {
      setMessage("Análise extraordinária solicitada. A nova execução será exibida no histórico.");
      await load(true);
    }
    setActionBusy(null);
  }

  function openRelatedArea(insight: ManagementInsight) {
    const view = VIEW_BY_AREA[normalize(insight.related_view)] || VIEW_BY_AREA[normalize(insight.area)];
    const requiredPermission = view ? PERMISSION_BY_VIEW[view] : null;
    if (view && onOpenArea && (!requiredPermission || !can || can(requiredPermission))) onOpenArea(view);
  }

  const filtersActive = period !== "30" || from || to || area !== "todos" || severity !== "todos" || status !== "todos";

  if (loading) return <section className={styles.loading} aria-live="polite"><span /><strong>Consolidando dados executivos...</strong></section>;

  return <div className={styles.center}>
    <section className={styles.hero}>
      <div className={styles.heroCopy}>
        <small>INTELIGÊNCIA GERENCIAL CONTÍNUA</small>
        <h2>Central de Insights e BI</h2>
        <p>Leituras financeiras, comerciais e operacionais registradas com evidências, prioridade e encaminhamento executivo.</p>
      </div>
      <dl className={styles.runFacts}>
        <div><dt>Última geração</dt><dd>{formatDateTime(latestRunTime)}</dd></div>
        <div><dt>Próxima rotina</dt><dd>{formatDateTime(nextRunAt)}</dd></div>
        <div><dt>Situação</dt><dd>{latestRun ? RUN_STATUS_LABELS[normalize(latestRun.status)] || latestRun.status : "Nenhuma execução"}</dd></div>
      </dl>
      <button type="button" className={styles.refreshButton} onClick={() => void load(true)} disabled={refreshing}>
        <span aria-hidden="true">↻</span>{refreshing ? "Atualizando" : "Atualizar dados"}
      </button>
    </section>

    {error ? <div className={styles.feedbackError} role="alert"><strong>Não foi possível concluir a operação.</strong><span>{error}</span></div> : null}
    {message ? <button type="button" className={styles.feedbackSuccess} onClick={() => setMessage("")}><span>{message}</span><b aria-label="Fechar aviso">×</b></button> : null}

    <section className={styles.filters} aria-label="Filtros da Central de Insights">
      <label>Período
        <select value={period} onChange={event => setPeriod(event.target.value as PeriodId)}>
          <option value="7">Últimos 7 dias</option>
          <option value="30">Últimos 30 dias</option>
          <option value="90">Últimos 90 dias</option>
          <option value="365">Últimos 12 meses</option>
          <option value="all">Todo o histórico</option>
          <option value="custom">Período personalizado</option>
        </select>
      </label>
      {period === "custom" ? <>
        <label>De<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label>
        <label>Até<input type="date" value={to} onChange={event => setTo(event.target.value)} /></label>
      </> : null}
      <label>Área
        <select value={area} onChange={event => setArea(event.target.value)}>
          <option value="todos">Todas as áreas</option>
          {areas.map(item => <option key={item} value={item}>{areaLabel(item)}</option>)}
        </select>
      </label>
      <label>Severidade
        <select value={severity} onChange={event => setSeverity(event.target.value)}>
          <option value="todos">Todas</option>
          <option value="critical">Crítica</option>
          <option value="high">Alta</option>
          <option value="warning">Atenção</option>
          <option value="info">Informativa</option>
        </select>
      </label>
      <label>Status
        <select value={status} onChange={event => setStatus(event.target.value)}>
          <option value="todos">Todos</option>
          <option value="novo">Novo</option>
          <option value="reconhecido">Reconhecido</option>
          <option value="em_tratamento">Em tratamento</option>
          <option value="resolvido">Resolvido</option>
        </select>
      </label>
      {filtersActive ? <button type="button" className={styles.clearFilters} onClick={() => { setPeriod("30"); setFrom(""); setTo(""); setArea("todos"); setSeverity("todos"); setStatus("todos"); }}>Limpar filtros</button> : null}
    </section>

    <section className={styles.kpis} aria-label="Indicadores executivos do recorte">
      <article data-tone={criticalCount ? "critical" : "stable"}><small>Decisões críticas</small><strong>{numberFormat.format(criticalCount)}</strong><span>{criticalCount ? "exigem decisão executiva" : "nenhuma no recorte"}</span></article>
      <article data-tone={highPriorityCount ? "warning" : "stable"}><small>Alta prioridade</small><strong>{numberFormat.format(highPriorityCount)}</strong><span>insights ainda não resolvidos</span></article>
      <article data-tone={financialRisk?.value ? "critical" : "neutral"}><small>Risco financeiro</small><strong>{financialRisk ? formatMetricValue(financialRisk.value, financialRisk.unit) : "—"}</strong><span>{financialRisk ? "exposição identificada na base" : "métrica não disponível"}</span></article>
      <article data-tone={coverage !== null && coverage < 80 ? "warning" : "stable"}><small>Cobertura de dados</small><strong>{coverage === null ? "—" : `${numberFormat.format(Number(coverage))}%`}</strong><span>{coverage === null ? "a rotina ainda não aferiu a cobertura" : "fontes analisadas na última rotina"}</span></article>
    </section>

    <nav className={styles.tabs} role="tablist" aria-label="Visões da Central de Insights">
      <button type="button" role="tab" aria-selected={tab === "insights"} className={tab === "insights" ? styles.activeTab : ""} onClick={() => setTab("insights")}><span>01</span>Insights</button>
      <button type="button" role="tab" aria-selected={tab === "bi"} className={tab === "bi" ? styles.activeTab : ""} onClick={() => setTab("bi")}><span>02</span>BI executivo</button>
      <button type="button" role="tab" aria-selected={tab === "rotinas"} className={tab === "rotinas" ? styles.activeTab : ""} onClick={() => setTab("rotinas")}><span>03</span>Rotinas</button>
    </nav>

    {tab === "insights" ? <section role="tabpanel" className={styles.tabPanel}>
      <header className={styles.sectionHeading}>
        <div><small>FILA DE DECISÕES</small><h3>O que fazer, por que fazer e como começar</h3><p>Cada recomendação usa exclusivamente os dados registrados na plataforma e permanece rastreável até a resolução.</p></div>
        <span>{decisions.length} registro(s) no recorte</span>
      </header>
      {!latestRun ? <DataGap text="Nenhuma rotina foi executada. Assim que a primeira análise for concluída, os insights aparecerão aqui." /> : null}
      {latestRun && !decisions.length ? <DataGap text="Não há insights correspondentes aos filtros atuais. Ajuste o período ou aguarde a próxima execução." /> : null}
      <div className={styles.decisionList}>
        {decisions.map(insight => {
          const criticality = paymentCriticalitySnapshot(insight.evidence);
          const displaySummary = criticality && criticality.totalAmount !== null && criticality.totalTitles !== null
            ? `Há ${moneyFormat.format(criticality.totalAmount)} em ${numberFormat.format(criticality.totalTitles)} obrigação(ões) vencida(s), aprovada(s) e não liquidada(s).`
            : insight.summary;
          const evidenceRecord = recordValue(insight.evidence);
          const evidence = displayItems(criticality && evidenceRecord
            ? Object.fromEntries(Object.entries(evidenceRecord).filter(([key]) => key !== "payment_criticality"))
            : insight.evidence);
          const impact = displayItems(insight.impact);
          const steps = recommendationSteps(insight.recommendation);
          const plan = recommendedPlan(insight, steps);
          const highestSnapshotBand = criticality
            ? PAYMENT_CRITICALITY_BANDS.find(band => Number(criticality.counts[band] || 0) > 0) || criticality.queue[0]?.band || ""
            : "";
          const registeredSeverity = normalize(insight.severity);
          const criticalityLevel = highestSnapshotBand === "medium"
            ? "moderate"
            : highestSnapshotBand || (registeredSeverity === "warning" ? "moderate" : registeredSeverity) || "low";
          const decisionSuggestion = steps[0] || insight.recommendation;
          const relatedView = VIEW_BY_AREA[normalize(insight.related_view)] || VIEW_BY_AREA[normalize(insight.area)];
          const relatedPermission = relatedView ? PERMISSION_BY_VIEW[relatedView] : null;
          const mayOpenRelated = Boolean(relatedView && onOpenArea && (!relatedPermission || !can || can(relatedPermission)));
          return <article key={insight.id} className={styles.decisionCard} data-severity={normalize(insight.severity)} data-resolved={isResolved(insight)}>
            <header>
              <div className={styles.badges}>
                <span data-kind="area">{areaLabel(insight.area)}</span>
                <span data-kind="severity">{SEVERITY_LABELS[normalize(insight.severity)] || insight.severity}</span>
                <span data-kind="status">{STATUS_LABELS[normalize(insight.status)] || insight.status}</span>
              </div>
              <time dateTime={insight.created_at}>{formatDateTime(insight.created_at)}</time>
            </header>
            <div className={styles.decisionTitle}>
              <div><h4>{insight.title}</h4><p>{displaySummary}</p></div>
              <span className={styles.confidence}><small>Confiança</small><strong>{insight.confidence_pct === null ? "—" : `${numberFormat.format(Number(insight.confidence_pct))}%`}</strong></span>
            </div>
            <section className={styles.decisionCallout}>
              <small>DECISÃO SUGERIDA</small>
              <strong>{decisionSuggestion || "A rotina não registrou uma decisão sugerida."}</strong>
            </section>
            {criticality ? <section className={styles.criticalityPanel} data-level={criticalityLevel} aria-label={`Análise estruturada de criticidade para ${insight.title}`}>
              <header>
                <div><small>CRITICIDADE POR TÍTULO</small><strong>Maior faixa: {criticalityBandLabel(highestSnapshotBand)}</strong></div>
                <span>{criticality.policyVersion ? `Política ${criticality.policyVersion}` : "Snapshot registrado"}</span>
              </header>
              <div className={styles.criticalitySnapshotSummary}>
                <div><small>DATA DE REFERÊNCIA</small><strong>{formatCalendarDate(criticality.asOf)}</strong></div>
                <div><small>TÍTULOS CLASSIFICADOS</small><strong>{criticality.totalTitles === null ? "—" : numberFormat.format(criticality.totalTitles)}</strong></div>
                <div><small>EXPOSIÇÃO CLASSIFICADA</small><strong>{criticality.totalAmount === null ? "—" : moneyFormat.format(criticality.totalAmount)}</strong></div>
                <div><small>CONFIANÇA DA CARTEIRA</small><strong>{criticality.confidencePct === null ? "—" : `${numberFormat.format(criticality.confidencePct)}%`}</strong></div>
              </div>
              <div className={styles.criticalityBands}>
                {PAYMENT_CRITICALITY_BANDS.map(band => <article key={`${insight.id}-band-${band}`} data-band={band}>
                  <small>{criticalityBandLabel(band)}</small>
                  <strong>{criticality.counts[band] === null ? "—" : numberFormat.format(Number(criticality.counts[band]))}</strong>
                  <span>{criticality.amounts[band] === null ? "valor não informado" : moneyFormat.format(Number(criticality.amounts[band]))}</span>
                </article>)}
              </div>
              <section className={styles.priorityQueue}>
                <header><div><small>FILA RECOMENDADA</small><strong>Prioridade individual — não classificação única do total</strong></div><span>{criticality.queue.length} item(ns) no snapshot</span></header>
                {criticality.queue.length ? <div className={styles.priorityQueueList}>
                  {criticality.queue.slice(0, 5).map((item, queueIndex) => {
                    const increasingFactors = item.factors.filter(factor => factor.direction !== "reduce");
                    const reducingFactors = item.factors.filter(factor => factor.direction === "reduce");
                    return <article key={`${insight.id}-${item.key}`} className={styles.queueItem} data-band={item.band}>
                      <header>
                        <b>{item.treatmentRank === null ? queueIndex + 1 : numberFormat.format(item.treatmentRank)}</b>
                        <div><strong>{item.title}</strong><span>{item.counterparty || "Contraparte não informada"}</span></div>
                        <div className={styles.queueScore}><small>{criticalityBandLabel(item.band)}</small><strong>{item.score === null ? "—" : numberFormat.format(item.score)}{item.score === null ? "" : "/100"}</strong></div>
                      </header>
                      <dl className={styles.queueFacts}>
                        <div><dt>Valor</dt><dd>{item.amount === null ? "Não informado" : moneyFormat.format(item.amount)}</dd></div>
                        <div><dt>Vencimento</dt><dd>{formatCalendarDate(item.dueAt)}{item.daysOverdue === null ? null : <small>{numberFormat.format(item.daysOverdue)} dia(s) de atraso</small>}</dd></div>
                        <div><dt>Classificação</dt><dd>{item.classification || "Não informada"}</dd></div>
                        <div><dt>Ordem de pagamento</dt><dd>{item.paymentOrder === null ? "Não elegível ou não definida" : `${numberFormat.format(item.paymentOrder)}ª posição`}</dd></div>
                        <div><dt>Liberação financeira</dt><dd>{paymentGateLabel(item.paymentGate)}{item.paymentGateReason ? <small>{item.paymentGateReason}</small> : null}</dd></div>
                      </dl>
                      <div className={styles.queueAnalysis}>
                        <section><small>AÇÃO RECOMENDADA</small>{item.actionLabel ? <strong>{item.actionLabel}</strong> : null}<p>{item.action || "Não registrada no snapshot."}</p></section>
                        <section><small>IMPACTO DE ADIAMENTO</small>{item.postponementImpact.length ? <ul>{item.postponementImpact.slice(0, 3).map((value, index) => <li key={`${item.key}-postponement-${index}`}>{value}</li>)}</ul> : <p>Não registrado no snapshot.</p>}</section>
                        <section><small>CONFIANÇA</small><p>{item.confidencePct === null ? "Não informada" : `${numberFormat.format(item.confidencePct)}%`}</p></section>
                      </div>
                      <div className={styles.queueFactors}>
                        <section data-direction="increase"><small>FATORES QUE AUMENTAM</small>{increasingFactors.length ? <ul>{increasingFactors.slice(0, 6).map((factor, index) => <li key={`${item.key}-factor-up-${index}`}><strong>{factor.label}{factor.weight === null ? "" : ` (+${numberFormat.format(factor.weight)}${factor.maximumWeight === null ? "" : `/${numberFormat.format(factor.maximumWeight)}`})`}</strong>{factor.detail ? <span>{factor.detail}</span> : null}</li>)}</ul> : <p>Nenhum fator de elevação registrado.</p>}</section>
                        <section data-direction="reduce"><small>FATORES QUE REDUZEM</small>{reducingFactors.length ? <ul>{reducingFactors.slice(0, 6).map((factor, index) => <li key={`${item.key}-factor-down-${index}`}><strong>{factor.label}{factor.weight === null ? "" : ` (${numberFormat.format(factor.weight)}${factor.maximumWeight === null ? "" : `/${numberFormat.format(factor.maximumWeight)}`})`}</strong>{factor.detail ? <span>{factor.detail}</span> : null}</li>)}</ul> : <p>Nenhum redutor foi registrado para este título.</p>}</section>
                      </div>
                    </article>;
                  })}
                </div> : <DataGap text="O snapshot foi gravado, mas não contém a fila individual de títulos. Nenhum score foi estimado pela interface." compact />}
              </section>
              <p className={styles.criticalityMethod}>Scores, faixas, fatores e sequência são lidos do snapshot gravado no insight. A interface não recalcula nem atribui a criticidade de um título ao valor total da carteira.</p>
            </section> : <section className={`${styles.criticalityPanel} ${styles.criticalityFallback}`} data-level={criticalityLevel} aria-label={`Criticidade registrada para ${insight.title}`}>
              <header><div><small>CRITICIDADE REGISTRADA</small><strong>{SEVERITY_LABELS[normalize(insight.severity)] || insight.severity}</strong></div><span>Sem score estruturado</span></header>
              <div className={styles.criticalityFallbackGrid}>
                <div><small>Severidade</small><strong>{SEVERITY_LABELS[normalize(insight.severity)] || insight.severity}</strong></div>
                <div><small>Prioridade</small><strong>{PRIORITY_LABELS[normalizedPriority(insight)]}</strong></div>
                <div><small>Prazo registrado</small><strong>{formatDate(insight.due_at)}</strong></div>
                <div><small>Status</small><strong>{STATUS_LABELS[normalize(insight.status)] || insight.status}</strong></div>
              </div>
              <div className={styles.postponementImpact}><small>IMPACTO DE ADIAMENTO</small>{impact.length ? <ul>{impact.slice(0, 3).map((item, index) => <li key={`${insight.id}-fallback-impact-${index}`}>{item}</li>)}</ul> : <p>Não há impacto estruturado suficiente para classificar o adiamento.</p>}</div>
              <p className={styles.criticalityMethod}>Sem snapshot persistido, a tela não inventa score, fatores ou posição de fila. Ela exibe apenas a severidade, a prioridade, o prazo, o status e o impacto registrados pela rotina.</p>
            </section>}
            <div className={styles.decisionEvidence}>
              <section className={styles.recommendation}><small>O QUE A ARISA FARIA</small><p>{insight.recommendation || "A rotina não registrou recomendação para este caso."}</p></section>
              <section className={styles.justification}><small>JUSTIFICATIVA</small><p>{displaySummary}</p>{impact.length ? <ul>{impact.slice(0, 4).map((item, index) => <li key={`${insight.id}-i-${index}`}>{item}</li>)}</ul> : null}</section>
              <section><small>DADOS QUE EMBASAM</small>{evidence.length ? <ul>{evidence.slice(0, 5).map((item, index) => <li key={`${insight.id}-e-${index}`}>{item}</li>)}</ul> : <p>Não há evidência registrada para detalhar esta recomendação.</p>}</section>
            </div>
            <section className={styles.recommendedPlan} aria-label={`Plano recomendado para ${insight.title}`}>
              <header>
                <div><small>PLANO RECOMENDADO PARA AVALIAÇÃO</small><strong>Encaminhamento sugerido pela análise</strong></div>
                <span>Sugestão · aguardando validação</span>
              </header>
              <dl className={styles.planFacts}>
                <div><dt>Natureza do plano</dt><dd>{plan.classification}</dd></div>
                <div data-priority={plan.priority}><dt>Prioridade sugerida</dt><dd>{plan.priorityLabel}</dd></div>
                <div><dt>Função responsável</dt><dd>{plan.responsibleRole}</dd></div>
                <div><dt>Início sugerido</dt><dd>{plan.startAt}</dd></div>
                <div><dt>Revisão sugerida</dt><dd>{plan.reviewAt}</dd></div>
                <div><dt>Conclusão sugerida</dt><dd>{plan.targetAt}<small>{plan.businessDays === 1 ? "1 dia útil" : `${plan.businessDays} dias úteis`} · {plan.deadlineOrigin}</small></dd></div>
              </dl>
              <div className={styles.planFlow}>
                <section>
                  <small>SEQUÊNCIA RECOMENDADA</small>
                  <ol>{plan.sequence.map((step, index) => <li key={`${insight.id}-plan-step-${index}`}><b>{index + 1}</b><span>{step}</span></li>)}</ol>
                </section>
                <section className={styles.completionCriterion}>
                  <small>CRITÉRIO DE CONCLUSÃO</small>
                  <p>{plan.completionCriterion}</p>
                </section>
              </div>
            </section>
            <footer>
              <div><small>Prazo registrado no sistema</small><strong>{formatDate(insight.due_at)}</strong></div>
              <div className={styles.cardActions}>
                {!isResolved(insight) && normalize(insight.status) !== "reconhecido" && mayTreat ? <button type="button" onClick={() => void updateInsight(insight, "reconhecido")} disabled={actionBusy === insight.id}>Reconhecer</button> : null}
                {!isResolved(insight) && mayTreat ? <button type="button" onClick={() => void updateInsight(insight, "resolvido")} disabled={actionBusy === insight.id}>Marcar resolvido</button> : null}
                {mayOpenRelated ? <button type="button" className={styles.primaryAction} onClick={() => openRelatedArea(insight)}>Abrir área relacionada <span aria-hidden="true">→</span></button> : null}
              </div>
            </footer>
          </article>;
        })}
      </div>
    </section> : null}

    {tab === "bi" ? <section role="tabpanel" className={styles.tabPanel}>
      <header className={styles.sectionHeading}>
        <div><small>BUSINESS INTELLIGENCE</small><h3>Pulso executivo integrado</h3><p>Tendências e comparativos formados somente por métricas persistidas na última rotina.</p></div>
        <span>{currentRunMetrics.length} métrica(s) disponível(is)</span>
      </header>
      {!currentRunMetrics.length ? <DataGap text="A última rotina não gravou métricas para este recorte. Isso é tratado como ausência de cobertura, não como resultado zero." /> : <>
        <div className={styles.metricGrid}>
          {currentRunMetrics.slice(0, 8).map(metric => <article key={metric.id}>
            <small>{areaLabel(metric.area)}</small>
            <h4>{metric.label}</h4>
            <strong>{formatMetricValue(metric.numeric_value, metric.unit)}</strong>
            <span data-trend={Number(metric.variation_pct) > 0 ? "up" : Number(metric.variation_pct) < 0 ? "down" : "flat"}>
              {metric.variation_pct === null ? "Sem comparativo" : `${Number(metric.variation_pct) > 0 ? "+" : ""}${numberFormat.format(Number(metric.variation_pct))}% vs. período anterior`}
            </span>
          </article>)}
        </div>
        <div className={styles.biGrid}>
          <section className={styles.chartPanel}>
            <header><div><small>TENDÊNCIA</small><h4>{selectedMetric?.label || "Série histórica"}</h4></div>{trendMetrics.length ? <label><span className={styles.srOnly}>Selecionar métrica</span><select value={selectedMetric?.id || ""} onChange={event => setSelectedMetricId(event.target.value)}>{trendMetrics.map(metric => <option key={metric.id} value={metric.id}>{metric.label}</option>)}</select></label> : null}</header>
            {selectedMetric ? <TrendChart metric={selectedMetric} /> : <DataGap text="Nenhuma métrica do recorte possui pontos de tendência gravados." compact />}
          </section>
          <section className={styles.chartPanel}>
            <header><div><small>COMPARATIVO</small><h4>Insights por área</h4></div><span>abertos / total</span></header>
            {areaComparisons.length ? <div className={styles.areaBars}>
              {areaComparisons.map(item => <article key={item.area}>
                <div><strong>{areaLabel(item.area)}</strong><span>{item.open} / {item.total}</span></div>
                <div className={styles.barTrack}><i style={{ width: `${comparisonMaximum ? (item.total / comparisonMaximum) * 100 : 0}%` }} /><b style={{ width: `${item.total ? (item.critical / item.total) * 100 : 0}%` }} /></div>
                <small>{item.critical} crítico(s)</small>
              </article>)}
            </div> : <DataGap text="Não há insights no período para formar um comparativo entre áreas." compact />}
          </section>
        </div>
      </>}
    </section> : null}

    {tab === "rotinas" ? <section role="tabpanel" className={styles.tabPanel}>
      <header className={styles.sectionHeading}>
        <div><small>GOVERNANÇA DA ANÁLISE</small><h3>Rotinas automáticas e histórico</h3><p>Uma rotina automática por dia útil, de segunda a sexta-feira, às 06:00, com execução extraordinária e rastreabilidade.</p></div>
        {mayRun ? <div className={styles.manualControl}>
          <button type="button" className={styles.manualButton} disabled={actionBusy === "manual-run" || !isBusinessDay} onClick={() => void runManualAnalysis()}>{actionBusy === "manual-run" ? "Solicitando..." : isBusinessDay ? "Executar análise extraordinária" : "Disponível no próximo dia útil"}</button>
          {!isBusinessDay ? <small>A geração de insights está disponível apenas de segunda a sexta-feira (horário de São Paulo).</small> : null}
        </div> : null}
      </header>
      <div className={styles.routineGrid}>
        <article className={styles.scheduleCard}>
          <small>PROGRAMAÇÃO ATIVA</small>
          <div className={styles.scheduleStatus} data-enabled={dataset.settings?.enabled === true}><i /> <strong>{dataset.settings ? dataset.settings.enabled ? "Rotina automática ativa" : "Rotina automática pausada" : "Configuração não localizada"}</strong></div>
          {dataset.settings ? <>
            <dl>
              <div><dt>Dias de execução</dt><dd>Segunda a sexta-feira</dd></div>
              <div><dt>Horários</dt><dd>{dataset.settings.run_times?.length ? dataset.settings.run_times.join(" · ") : "Não definidos"}</dd></div>
              <div><dt>Fuso horário</dt><dd>{dataset.settings.timezone || "Não definido"}</dd></div>
              <div><dt>Próxima execução</dt><dd>{formatDateTime(dataset.settings.next_run_at)}</dd></div>
              <div><dt>Áreas cobertas</dt><dd>{dataset.settings.areas?.length ? dataset.settings.areas.map(areaLabel).join(", ") : "Não definidas"}</dd></div>
            </dl>
          </> : <DataGap text="As definições da rotina ainda não foram gravadas para esta organização." compact />}
        </article>
        <article className={styles.methodCard}>
          <small>MÉTODO E QUALIDADE</small>
          <h4>Leitura multidisciplinar com rastreabilidade</h4>
          <ol>
            <li><b>1</b><span><strong>Validação da base</strong><small>Fontes, período e cobertura são aferidos antes da análise.</small></span></li>
            <li><b>2</b><span><strong>Cruzamento gerencial</strong><small>Financeiro, comercial e operação são comparados no mesmo ciclo.</small></span></li>
            <li><b>3</b><span><strong>Fila de decisão</strong><small>Cada conclusão registra evidência, impacto, recomendação e confiança.</small></span></li>
          </ol>
        </article>
      </div>
      <section className={styles.runHistory}>
        <header><div><small>HISTÓRICO DE GERAÇÕES</small><h4>Execuções recentes</h4></div><span>{dataset.runs.length} execução(ões)</span></header>
        {dataset.runs.length ? <div className={styles.runTable} role="table" aria-label="Histórico de rotinas de insights">
          <div role="row" className={styles.tableHeader}><span role="columnheader">Data e hora</span><span role="columnheader">Origem</span><span role="columnheader">Status</span><span role="columnheader">Cobertura</span><span role="columnheader">Resultado</span></div>
          {dataset.runs.slice(0, 20).map(run => <div role="row" key={run.id}>
            <span role="cell"><strong>{formatDateTime(run.completed_at || run.started_at)}</strong><small>{run.period_start || run.period_end ? `${formatDate(run.period_start)} a ${formatDate(run.period_end)}` : "Período não informado"}</small></span>
            <span role="cell">{run.trigger_source === "scheduled" ? "Automática" : run.trigger_source === "manual" ? "Extraordinária" : run.trigger_source === "implantacao" ? "Implantação" : run.trigger_source}</span>
            <span role="cell"><i data-status={normalize(run.status)}>{RUN_STATUS_LABELS[normalize(run.status)] || run.status}</i></span>
            <span role="cell">{run.data_coverage_pct === null ? "—" : `${numberFormat.format(Number(run.data_coverage_pct))}%`}</span>
            <span role="cell">{run.error_message || (runInsightCount(run) === null ? "Resultado não quantificado" : `${numberFormat.format(Number(runInsightCount(run)))} insight(s)`)}</span>
          </div>)}
        </div> : <DataGap text="Ainda não existe histórico de geração para esta organização." compact />}
      </section>
    </section> : null}

    <footer className={styles.dataFooter}>
      <span>Organização: <strong>{activeOrganization.trade_name || activeOrganization.name}</strong></span>
      <span>Fonte: <strong>base integrada da plataforma</strong></span>
      <span>Itens do recorte: <strong>{compactNumberFormat.format(filteredInsights.length)}</strong></span>
    </footer>
  </div>;
}
