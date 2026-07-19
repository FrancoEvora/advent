"use client";

import { FormEvent, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ErpData } from "../types";
import { analyzeComprehensivePaymentRisk } from "../operational-cash";
import { money } from "../utils";
import { PanelTitle } from "../views-dashboard";
import { monthlyCostLines } from "./monthly-costs";

export function PayrollModal({ data, close, mutate }: { data: ErpData; close: () => void; mutate: (operation: () => Promise<void>, success: string) => Promise<void> }) {
  const now = new Date(); const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const [referenceMonth, setReferenceMonth] = useState(month);
  const [paymentDate, setPaymentDate] = useState(`${month.slice(0, 8)}${String(data.settings.salary_payment_day || 5).padStart(2, "0")}`);
  const lines = useMemo(() => monthlyCostLines(data, referenceMonth), [data, referenceMonth]);
  const gross = lines.reduce((sum, line) => sum + line.base_salary + line.variable_earnings, 0);
  const charges = lines.reduce((sum, line) => sum + line.employer_charges, 0);
  const benefits = lines.reduce((sum, line) => sum + line.benefits, 0);
  const advances = lines.reduce((sum, line) => sum + line.advances, 0);
  const net = lines.reduce((sum, line) => sum + line.net_amount, 0);
  const risk = useMemo(() => analyzeComprehensivePaymentRisk(data, { amount: net + charges, dueDate: paymentDate }), [data, net, charges, paymentDate]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await mutate(async () => {
      const client = getSupabase(); if (!client) throw new Error("Supabase indisponível.");
      const runResult = await client.from("hr_payroll_runs").insert({ organization_id: data.organization.id, reference_month: referenceMonth, payment_date: paymentDate, status: "calculada", gross_total: gross, charges_total: charges, benefits_total: benefits, advances_total: advances, net_total: net, projected_cash_balance: risk.projectedBalance, recommended_payment_date: risk.recommendedDate, cash_risk: risk.risky, created_by: data.session.user.id }).select("id").single();
      if (runResult.error) throw new Error(runResult.error.message);
      const itemResult = await client.from("hr_payroll_items").insert(lines.map(line => ({ ...line, payroll_run_id: runResult.data.id })));
      if (itemResult.error) throw new Error(itemResult.error.message);
    }, risk.risky ? "Folha calculada com alerta de caixa." : "Folha calculada e enviada para aprovação."); close();
  }

  return <div className="modal-backdrop" onMouseDown={close}><form className="modal large" onSubmit={submit} onMouseDown={event => event.stopPropagation()}><PanelTitle eyebrow="NOVA FOLHA" title="Gerar folha de pagamento" /><button className="modal-close" type="button" onClick={close}>×</button><div className="form-grid"><label>Mês de referência<input type="month" value={referenceMonth.slice(0, 7)} onChange={event => setReferenceMonth(`${event.target.value}-01`)} /></label><label>Data de pagamento<input type="date" value={paymentDate} onChange={event => setPaymentDate(event.target.value)} /></label></div><section className="payroll-preview"><article><small>Colaboradores</small><strong>{lines.length}</strong></article><article><small>Remuneração bruta</small><strong>{money.format(gross)}</strong></article><article><small>Encargos estimados</small><strong>{money.format(charges)}</strong></article><article><small>Impacto total</small><strong>{money.format(net + charges)}</strong></article></section>{risk.risky && <div className={`cash-risk-alert ${risk.level}`}><strong>Impacto incompatível com o caixa</strong><p>{risk.reason}</p>{risk.recommendedDate && <button type="button" onClick={() => setPaymentDate(risk.recommendedDate!)}>Usar data recomendada</button>}</div>}<div className="info-box">Cálculo gerencial baseado nos salários, benefícios, percentuais e eventos cadastrados. A conferência contábil e trabalhista continua obrigatória.</div><footer><button type="button" onClick={close}>Cancelar</button><button className="primary">Calcular folha</button></footer></form></div>;
}
