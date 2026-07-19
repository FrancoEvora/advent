import type { ErpData } from "./types";

export type OperationalCommitment = {
  id: string;
  source: "compra" | "folha" | "rh";
  date: string;
  amount: number;
  label: string;
};

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
