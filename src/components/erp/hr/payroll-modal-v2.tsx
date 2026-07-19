"use client";
import { FormEvent, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ErpData } from "../types";
import { analyzeComprehensivePaymentRisk } from "../operational-cash";
import { money } from "../utils";
import { PanelTitle } from "../views-dashboard";
import { monthlyCostLines } from "./monthly-costs";

export function PayrollModalV2({ data, close, mutate }: { data: ErpData; close: () => void; mutate: (operation: () => Promise<void>, success: string) => Promise<void> }) {
  const now = new Date();
  const initialMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const [referenceMonth, setReferenceMonth] = useState(initialMonth);
  const [paymentDate, setPaymentDate] = useState(`${initialMonth.slice(0, 8)}${String(data.settings.salary_payment_day || 5).padStart(2, "0")}`);
  const [error, setError] = useState("");
  const lines = useMemo(() => monthlyCostLines(data, referenceMonth), [data, referenceMonth]);
  const gross = lines.reduce((sum, line) => sum + line.base_salary + line.variable_earnings, 0);
  const charges = lines.reduce((sum, line) => sum + line.employer_charges, 0);
  const benefits = lines.reduce((sum, line) => sum + line.benefits, 0);
  const advances = lines.reduce((sum, line) => sum + line.advances, 0);
  const net = lines.reduce((sum, line) => sum + line.net_amount, 0);
  const total = net + charges;
  const risk = useMemo(() => analyzeComprehensivePaymentRisk(data, { amount: total, dueDate: paymentDate }), [data, total, paymentDate]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    if (!lines.length) { setError("Não há colaboradores ativos para compor a folha."); return; }
    if (total <= 0) { setError("A folha não possui valor. Verifique salários, benefícios e eventos."); return; }
    await mutate(async () => {
      const client = getSupabase(); if (!client) throw new Error("Supabase indisponível.");
      const run = await client.from("hr_payroll_runs").insert({ organization_id: data.organization.id, reference_month: referenceMonth, payment_date: paymentDate, status: "calculada", gross_total: gross, charges_total: charges, benefits_total: benefits, advances_total: advances, net_total: net, projected_cash_balance: risk.projectedBalance, recommended_payment_date: risk.recommendedDate, cash_risk: risk.risky, created_by: data.session.user.id }).select("id").single();
      if (run.error) throw new Error(run.error.message);
      const items = await client.from("hr_payroll_items").insert(lines.map(line => ({ ...line, payroll_run_id: run.data.id })));
      if (items.error) throw new Error(items.error.message);
      const saved = await client.from("hr_payroll_runs").select("net_total,charges_total").eq("id", run.data.id).single();
      if (saved.error || Number(saved.data?.net_total || 0) + Number(saved.data?.charges_total || 0) <= 0) throw new Error("Os totais da folha não foram persistidos.");
    }, risk.risky ? "Folha salva com alerta de caixa." : "Folha salva e enviada para aprovação.");
    close();
  }

  return <div className="modal-backdrop" onMouseDown={close}><form className="modal large" onSubmit={submit} onMouseDown={event => event.stopPropagation()}><PanelTitle eyebrow="NOVA FOLHA" title="Gerar folha de pagamento" /><button className="modal-close" type="button" onClick={close}>×</button><div className="form-grid"><label>Mês de referência<input type="month" value={referenceMonth.slice(0, 7)} onChange={event => setReferenceMonth(`${event.target.value}-01`)} /></label><label>Data de pagamento<input type="date" value={paymentDate} onChange={event => setPaymentDate(event.target.value)} /></label></div><section className="payroll-preview"><article><small>Colaboradores</small><strong>{lines.length}</strong></article><article><small>Remuneração bruta</small><strong>{money.format(gross)}</strong></article><article><small>Encargos estimados</small><strong>{money.format(charges)}</strong></article><article><small>Impacto total</small><strong>{money.format(total)}</strong></article></section>{risk.risky && <div className={`cash-risk-alert ${risk.level}`}><strong>Impacto incompatível com o caixa</strong><p>{risk.reason}</p>{risk.recommendedDate && <button type="button" onClick={() => setPaymentDate(risk.recommendedDate!)}>Usar data recomendada</button>}</div>}{error && <div className="feedback error">{error}</div>}<div className="info-box">Ao aprovar, a folha será lançada automaticamente como conta a pagar no fluxo de caixa.</div><footer><button type="button" onClick={close}>Cancelar</button><button className="primary">Calcular e salvar folha</button></footer></form></div>;
}