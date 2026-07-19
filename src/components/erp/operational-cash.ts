import type { ErpData, FinancialEntry } from "./types";
import { realizedBalance } from "./analytics";
import { isSettled } from "./utils";

export type OperationalCommitment = {
  id: string;
  source: "compra" | "folha" | "rh";
  date: string;
  amount: number;
  label: string;
};

export type ComprehensiveForecastPoint = {
  date: string;
  balance: number;
  incoming: number;
  outgoing: number;
  operational: number;
};

export type ComprehensiveRisk = {
  risky: boolean;
  level: "baixo" | "medio" | "alto" | "critico";
  projectedBalance: number;
  recommendedDate: string | null;
  reason: string;
};

const todayIso = () => new Date().toISOString().slice(0, 10);
const addDays = (value: string, days: number) => {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};
const belongsToAccount = (entry: FinancialEntry, accountId?: string | null) => !accountId || entry.bank_account_id === accountId;

export function operationalCommitments(data: ErpData): OperationalCommitment[] {
  const purchases = (data.purchaseRequests || [])
    .filter(request => ["aprovada", "contratada", "recebida"].includes(request.status) && request.payment_due_date && !request.financial_entry_id)
    .map(request => ({ id: request.id, source: "compra" as const, date: request.payment_due_date!, amount: Number(request.estimated_total), label: request.title }));

  const payroll = (data.hrPayrollRuns || [])
    .filter(run => ["calculada", "aprovada"].includes(run.status) && !run.financial_entry_id)
    .map(run => ({ id: run.id, source: "folha" as const, date: run.payment_date, amount: Number(run.net_total) + Number(run.charges_total), label: `Folha ${run.reference_month.slice(0, 7)}` }));

  const events = (data.hrEvents || [])
    .filter(event => ["previsto", "aprovado"].includes(event.status) && event.cash_flow_impact && event.due_date && !event.financial_entry_id)
    .map(event => ({ id: event.id, source: "rh" as const, date: event.due_date!, amount: Number(event.amount), label: event.event_type.replaceAll("_", " ") }));

  return [...purchases, ...payroll, ...events].filter(item => item.amount > 0);
}

export function buildComprehensiveForecast(data: ErpData, days = 90): ComprehensiveForecastPoint[] {
  const start = todayIso();
  let balance = realizedBalance(data);
  const pending = data.entries.filter(entry => !isSettled(entry) && entry.status !== "cancelado");
  const commitments = operationalCommitments(data);
  const points: ComprehensiveForecastPoint[] = [];
  for (let offset = 0; offset <= days; offset += 1) {
    const date = addDays(start, offset);
    const dayEntries = pending.filter(entry => entry.due_date === date);
    const incoming = dayEntries.filter(entry => entry.type === "entrada").reduce((sum, entry) => sum + Number(entry.amount), 0);
    const financialOutgoing = dayEntries.filter(entry => entry.type === "saida").reduce((sum, entry) => sum + Number(entry.amount), 0);
    const operational = commitments.filter(item => item.date === date).reduce((sum, item) => sum + item.amount, 0);
    const outgoing = financialOutgoing + operational;
    balance += incoming - outgoing;
    points.push({ date, balance, incoming, outgoing, operational });
  }
  return points;
}

export function analyzeComprehensivePaymentRisk(data: ErpData, candidate: { amount: number; dueDate: string; accountId?: string | null; excludeEntryId?: string | null }): ComprehensiveRisk {
  const amount = Number(candidate.amount || 0);
  if (!amount || !candidate.dueDate) return { risky: false, level: "baixo", projectedBalance: realizedBalance(data, candidate.accountId), recommendedDate: null, reason: "" };
  const minimum = Number(data.settings.minimum_cash_buffer || 0);
  const horizon = Math.max(30, Number(data.settings.forecast_horizon_days || 365));
  const financialEvents = data.entries
    .filter(entry => entry.id !== candidate.excludeEntryId && !isSettled(entry) && entry.status !== "cancelado" && belongsToAccount(entry, candidate.accountId))
    .map(entry => ({ date: entry.due_date, amount: entry.type === "entrada" ? Number(entry.amount) : -Number(entry.amount) }));
  const commitments = candidate.accountId ? [] : operationalCommitments(data).map(item => ({ date: item.date, amount: -item.amount }));
  const events = [...financialEvents, ...commitments];
  const balanceAt = (date: string) => events.filter(item => item.date <= date).reduce((balance, item) => balance + item.amount, realizedBalance(data, candidate.accountId));
  const projectedBalance = balanceAt(candidate.dueDate) - amount;
  if (projectedBalance >= minimum) return { risky: false, level: "baixo", projectedBalance, recommendedDate: null, reason: "Compromisso compatível com a disponibilidade projetada." };

  let recommendedDate: string | null = null;
  for (let offset = 1; offset <= horizon; offset += 1) {
    const date = addDays(candidate.dueDate < todayIso() ? todayIso() : candidate.dueDate, offset);
    if (balanceAt(date) - amount >= minimum) { recommendedDate = date; break; }
  }
  const deficit = minimum - projectedBalance;
  const level = !recommendedDate || projectedBalance < -Math.max(amount * 0.5, minimum) ? "critico" : projectedBalance < 0 ? "alto" : "medio";
  const reason = recommendedDate
    ? `O compromisso reduziria o caixa projetado para ${projectedBalance.toFixed(2)}. A primeira data com cobertura mínima é ${recommendedDate}.`
    : `O compromisso reduziria o caixa projetado para ${projectedBalance.toFixed(2)} e não há cobertura no horizonte analisado.`;
  return { risky: true, level, projectedBalance, recommendedDate, reason: `${reason} Déficit estimado: ${deficit.toFixed(2)}.` };
}
