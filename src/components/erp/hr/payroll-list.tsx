"use client";

import { getSupabase } from "@/lib/supabase";
import type { ErpData, HrPayrollRun } from "../types";
import { dateAtNoon, money, shortDate } from "../utils";
import { Empty } from "../views-dashboard";

export function PayrollList({ data, mutate, documents }: { data: ErpData; mutate: (operation: () => Promise<void>, success: string) => Promise<void>; documents: (run: HrPayrollRun) => void }) {
  async function approve(run: HrPayrollRun) {
    const total = Number(run.net_total) + Number(run.charges_total);
    if (total <= 0) { alert("A folha não pode ser aprovada com valor zerado. Recalcule a folha após conferir os salários."); return; }
    await mutate(async () => {
      const client = getSupabase(); if (!client) throw new Error("Supabase indisponível.");
      const result = await client.from("hr_payroll_runs").update({ status: "aprovada", approved_by: data.session.user.id, approved_at: new Date().toISOString() }).eq("id", run.id);
      if (result.error) throw new Error(result.error.message);
      const confirmation = await client.from("hr_payroll_runs").select("financial_entry_id").eq("id", run.id).single();
      if (confirmation.error) throw new Error(confirmation.error.message);
      if (!confirmation.data.financial_entry_id) throw new Error("A folha foi aprovada, mas o lançamento financeiro não foi gerado.");
    }, "Folha aprovada e lançada automaticamente no fluxo de caixa.");
  }

  return <div className="payroll-list">{data.hrPayrollRuns.map(run => <article key={run.id} className={run.cash_risk ? "risk" : ""}><div><span className={`purchase-status ${run.status}`}>{run.status}</span><strong>Folha {run.reference_month.slice(0, 7)}</strong><small>Pagamento em {shortDate.format(dateAtNoon(run.payment_date))}</small></div><span><small>Líquido</small><strong>{money.format(Number(run.net_total))}</strong></span><span><small>Encargos</small><strong>{money.format(Number(run.charges_total))}</strong></span><span><small>Impacto total</small><strong>{money.format(Number(run.net_total) + Number(run.charges_total))}</strong></span><div><button onClick={() => documents(run)}>Documentos</button>{run.financial_entry_id && <span className="cash-linked-badge">No fluxo de caixa</span>}{run.status === "calculada" && <button className="primary" onClick={() => approve(run)}>Aprovar e lançar</button>}</div></article>)}{!data.hrPayrollRuns.length && <Empty text="Nenhuma folha calculada." />}</div>;
}