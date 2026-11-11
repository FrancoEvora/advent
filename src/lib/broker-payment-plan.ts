export type AmortizationMethod = "price" | "sacoc";
export type PaymentRow = { installment_number: number; installment_type: "entrada" | "mensal" | "balao"; due_date: string; amount: number };
export type BrokerPlanInput = {
  salePrice: number; downPayment: number; downCount: number; downDue: string; downRate: number;
  downFrequencyDays: number; months: number; monthlyRate: number; method: AmortizationMethod;
  firstDue: string; graceMonths: number; balloonTotal: number; balloonCount: number; balloonFrequency: number;
};
export const methodLabels = { price: "Price (parcelas constantes)", sacoc: "SACOC (gradiente mensal)" } as const;
export const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

// Calendar arithmetic, anchored to the original day: Jan 31 -> Feb 28 -> Mar 31.
export function calendarMonth(date: string, months: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(months)) return "";
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}
export function entryDate(date: string, index: number, frequencyDays: number): string {
  if (!date) return "";
  if (frequencyDays === 30) return calendarMonth(date, index);
  const target = new Date(`${date}T12:00:00Z`);
  target.setUTCDate(target.getUTCDate() + index * Math.max(1, frequencyDays));
  return target.toISOString().slice(0, 10);
}
export function nextMonthlyDate(downDue: string, count: number, frequencyDays: number): string {
  return calendarMonth(entryDate(downDue, Math.max(0, count - 1), frequencyDays), 1);
}
function annuity(principal: number, count: number, rate: number) {
  return rate ? principal * rate / (1 - (1 + rate) ** -count) : principal / count;
}
export function buildBrokerPlan(input: BrokerPlanInput): PaymentRow[] {
  const rows: PaymentRow[] = [];
  if (!input.firstDue || !input.downDue || !Number.isInteger(input.months) || !Number.isInteger(input.downCount) || !Number.isInteger(input.balloonCount) || input.months < 0 || input.months > 360 || input.downCount < 1 || input.downCount > 36 || input.balloonCount < 0 || input.balloonCount > 30) return rows;
  const add = (type: PaymentRow["installment_type"], date: string, amount: number) => rows.push({ installment_number: rows.length + 1, installment_type: type, due_date: date, amount: roundMoney(amount) });
  if (input.downPayment > 0) {
    const each = roundMoney(annuity(input.downPayment, input.downCount, input.downRate));
    for (let i = 0; i < input.downCount; i++) add("entrada", entryDate(input.downDue, i, input.downFrequencyDays), !input.downRate ? roundMoney(input.downPayment * (i + 1) / input.downCount) - roundMoney(input.downPayment * i / input.downCount) : each);
  }
  const principal = Math.max(0, input.salePrice - input.downPayment - input.balloonTotal);
  if (principal > 0 && input.months > 0) {
    const fixed = roundMoney(annuity(principal, input.months, input.monthlyRate));
    for (let i = 0; i < input.months; i++) {
      // SACOC: equal principal quotas, each accumulated at compound monthly interest to its term.
      const amount = !input.monthlyRate ? roundMoney(principal * (i + 1) / input.months) - roundMoney(principal * i / input.months) : input.method === "sacoc" ? principal / input.months * (1 + input.monthlyRate) ** (i + 1) : fixed;
      add("mensal", calendarMonth(input.firstDue, i + input.graceMonths), amount);
    }
  }
  // Annual balloons coincide with the 12th, 24th, ... monthly due dates.
  for (let i = 1; i <= input.balloonCount; i++) add("balao", calendarMonth(input.firstDue, i * input.balloonFrequency - 1 + input.graceMonths), roundMoney(input.balloonTotal * i / input.balloonCount) - roundMoney(input.balloonTotal * (i - 1) / input.balloonCount));
  // Keep numbering identical to the server; display order may be chronological.
  return rows;
}
