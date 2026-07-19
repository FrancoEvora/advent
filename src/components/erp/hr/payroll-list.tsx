"use client";

import { getSupabase } from "@/lib/supabase";
import type { ErpData, HrPayrollRun } from "../types";
import { dateAtNoon, money, shortDate } from "../utils";
import { Empty } from "../views-dashboard";

export function PayrollList({ data, mutate, documents }: { data: ErpData; mutate: (operation: () => Promise<void>, success: string) => Promise<void>; documents: (run: HrPayrollRun) => void }) {
  async function approve(run: HrPayrollRun) {
    await mutate(async () => {
      const client = getSupabase(); if (!client) throw new Error("Supabase indisponível.");
      const result = await client.from("hr_payroll_runs").update({ status: "aprovada", approved_by: data.session.user.id, approved_at: new Date().toISOString() }).eq("id", run.id);
      if (result.error) throw new Error(result.error.message);
    }, "Folha aprovada e mantida na projeção de caixa.");
  }
  return <div className="payroll-list">{data.hrPayrollRuns.map(run => <article key={run.id} className={run.cash_risk ? "risk" : ""}><div><span className={`purchase-status ${run.status}`}>{run.status}</span><strong>Folha {run.reference_month.slice(0, 7)}</strong><small>Pagamento em {shortDate.format(dateAtNoon(run.payment_date))}</small></div><span><small>Líquido</small><strong>{money.format(Number(run.net_total))}</strong></span><span><small>Encargos</small><strong>{money.format(Number(run.charges_total))}</strong></span><span><small>Impacto total</small><strong>{money.format(Number(run.net_total) + Number(run.charges_total))}</strong></span><div><button onClick={() => documents(run)}>Documentos</button>{run.status === "calculada" && <button className="primary" onClick={() => approve(run)}>Aprovar</button>}</div></article>)}{!data.hrPayrollRuns.length && <Empty text="Nenhuma folha calculada." />}</div>;
}
