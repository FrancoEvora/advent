import type { EntryType, ErpData, FinancialEntry } from "./types";
import { daysUntil, isSettled } from "./utils";

const DAY = 86_400_000;
const todayIso = () => new Date().toISOString().slice(0, 10);
const addDays = (value: string, days: number) => {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

export type CashRiskAnalysis = {
  risky: boolean;
  level: "baixo" | "medio" | "alto" | "critico";
  projectedBalance: number;
  recommendedDate: string | null;
  reason: string;
};

const belongsToAccount = (entry: FinancialEntry, accountId?: string | null) => !accountId || entry.bank_account_id === accountId;

export function realizedBalance(data: ErpData, accountId?: string | null) {
  const accounts = data.bankAccounts.filter((account) => account.active && (!accountId || account.id === accountId));
  const initial = accounts.reduce((sum, account) => sum + Number(account.initial_balance || 0), 0);
  const realized = data.entries
    .filter((entry) => belongsToAccount(entry, accountId) && isSettled(entry) && entry.status !== "cancelado")
    .reduce((sum, entry) => sum + (entry.type === "entrada" ? Number(entry.amount) : -Number(entry.amount)), 0);
  return initial + realized;
}

export function analyzePaymentRisk(
  data: ErpData,
  candidate: { amount: number; dueDate: string; accountId?: string | null; excludeEntryId?: string | null },
): CashRiskAnalysis {
  const amount = Number(candidate.amount || 0);
  if (!amount || !candidate.dueDate) return { risky: false, level: "baixo", projectedBalance: realizedBalance(data, candidate.accountId), recommendedDate: null, reason: "" };

  const minimum = Number(data.settings.minimum_cash_buffer || 0);
  const horizon = Math.max(30, Number(data.settings.forecast_horizon_days || 180));
  const start = todayIso();
  const events = data.entries
    .filter((entry) => entry.id !== candidate.excludeEntryId && !isSettled(entry) && entry.status !== "cancelado" && belongsToAccount(entry, candidate.accountId))
    .sort((a, b) => a.due_date.localeCompare(b.due_date));

  const balanceAt = (date: string) => events
    .filter((entry) => entry.due_date <= date)
    .reduce((balance, entry) => balance + (entry.type === "entrada" ? Number(entry.amount) : -Number(entry.amount)), realizedBalance(data, candidate.accountId));

  const projectedBalance = balanceAt(candidate.dueDate) - amount;
  const risky = projectedBalance < minimum;
  if (!risky) return { risky: false, level: "baixo", projectedBalance, recommendedDate: null, reason: "Pagamento compatível com a disponibilidade projetada." };

  let recommendedDate: string | null = null;
  for (let offset = 1; offset <= horizon; offset += 1) {
    const date = addDays(candidate.dueDate < start ? start : candidate.dueDate, offset);
    if (balanceAt(date) - amount >= minimum) { recommendedDate = date; break; }
  }

  const deficit = minimum - projectedBalance;
  const level = !recommendedDate || projectedBalance < -Math.max(amount * 0.5, minimum) ? "critico" : projectedBalance < 0 ? "alto" : "medio";
  const reason = recommendedDate
    ? `O pagamento reduziria o caixa projetado para ${projectedBalance.toFixed(2)}. A primeira data com cobertura mínima é ${recommendedDate}.`
    : `O pagamento reduziria o caixa projetado para ${projectedBalance.toFixed(2)} e não há cobertura suficiente no horizonte analisado.`;
  return { risky: true, level, projectedBalance, recommendedDate, reason: `${reason} Déficit estimado: ${deficit.toFixed(2)}.` };
}

export type ForecastPoint = { date: string; balance: number; incoming: number; outgoing: number };
export function buildForecast(data: ErpData, days = 90): ForecastPoint[] {
  const start = todayIso();
  let balance = realizedBalance(data);
  const pending = data.entries.filter((entry) => !isSettled(entry) && entry.status !== "cancelado");
  const points: ForecastPoint[] = [];
  for (let offset = 0; offset <= days; offset += 1) {
    const date = addDays(start, offset);
    const dayEntries = pending.filter((entry) => entry.due_date === date);
    const incoming = dayEntries.filter((entry) => entry.type === "entrada").reduce((sum, entry) => sum + Number(entry.amount), 0);
    const outgoing = dayEntries.filter((entry) => entry.type === "saida").reduce((sum, entry) => sum + Number(entry.amount), 0);
    balance += incoming - outgoing;
    points.push({ date, balance, incoming, outgoing });
  }
  return points;
}

export type CounterpartyExposure = {
  contactId: string;
  name: string;
  type: EntryType;
  open: number;
  overdue: number;
  titles: number;
  overdueTitles: number;
  oldestDelay: number;
};

export function aggregateCounterparties(data: ErpData, type: EntryType): CounterpartyExposure[] {
  return data.contacts.map((contact) => {
    const entries = data.entries.filter((entry) => entry.contact_id === contact.id && entry.type === type && !isSettled(entry) && entry.status !== "cancelado");
    const overdueEntries = entries.filter((entry) => daysUntil(entry.due_date) < 0);
    return {
      contactId: contact.id,
      name: contact.trade_name || contact.name,
      type,
      open: entries.reduce((sum, entry) => sum + Number(entry.amount), 0),
      overdue: overdueEntries.reduce((sum, entry) => sum + Number(entry.amount), 0),
      titles: entries.length,
      overdueTitles: overdueEntries.length,
      oldestDelay: overdueEntries.length ? Math.max(...overdueEntries.map((entry) => Math.abs(daysUntil(entry.due_date)))) : 0,
    };
  }).filter((item) => item.open > 0).sort((a, b) => (b.overdue - a.overdue) || (b.open - a.open));
}

export function overdueRecommendation(entry: FinancialEntry) {
  const delay = Math.abs(daysUntil(entry.due_date));
  if (entry.type === "entrada") {
    if (delay <= 5) return "Contato cordial imediato, confirmar recebimento do boleto e oferecer segunda via.";
    if (delay <= 15) return "Formalizar cobrança por e-mail e WhatsApp, registrar promessa de pagamento e nova data.";
    if (delay <= 30) return "Propor acordo ou parcelamento curto, com entrada e termo de reconhecimento da dívida.";
    return "Escalar para cobrança formal, avaliar protesto/notificação e suspender novos benefícios comerciais.";
  }
  if (delay <= 5) return "Contatar o credor, explicar o desvio e negociar nova data sem encargos.";
  if (delay <= 15) return "Priorizar fornecedores críticos, formalizar acordo e registrar cronograma de regularização.";
  if (delay <= 30) return "Renegociar prazo e encargos, avaliar parcelamento e submeter o acordo à diretoria.";
  return "Plano emergencial de regularização: priorização jurídica/operacional, negociação formal e aprovação executiva.";
}

export function agingBucket(entry: FinancialEntry) {
  const delay = Math.abs(Math.min(daysUntil(entry.due_date), 0));
  if (!delay) return "A vencer";
  if (delay <= 15) return "1–15 dias";
  if (delay <= 30) return "16–30 dias";
  if (delay <= 60) return "31–60 dias";
  if (delay <= 90) return "61–90 dias";
  return "> 90 dias";
}

export function daysBetween(from: string, to: string) {
  return Math.round((new Date(`${to}T12:00:00`).getTime() - new Date(`${from}T12:00:00`).getTime()) / DAY);
}
