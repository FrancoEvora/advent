"use client";

import { FormEvent, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ErpData } from "../types";
import { CurrencyInput } from "../currency-input";
import { analyzeComprehensivePaymentRisk } from "../operational-cash";
import { dateAtNoon, money, shortDate } from "../utils";
import { PanelTitle } from "../views-dashboard";

export function HrEventModal({ data, close, mutate }: { data: ErpData; close: () => void; mutate: (operation: () => Promise<void>, success: string) => Promise<void> }) {
  const today = new Date().toISOString().slice(0, 10);
  const [amount, setAmount] = useState(0); const [dueDate, setDueDate] = useState(today);
  const risk = useMemo(() => analyzeComprehensivePaymentRisk(data, { amount, dueDate }), [data, amount, dueDate]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    await mutate(async () => { const client = getSupabase(); if (!client) throw new Error("Supabase indisponível."); const result = await client.from("hr_events").insert({ organization_id: data.organization.id, employee_id: String(form.get("employee_id")), event_type: String(form.get("event_type")), reference_date: String(form.get("reference_date")), due_date: dueDate, amount: Number(form.get("amount") || 0), status: "previsto", cash_flow_impact: true, notes: String(form.get("notes") || "") || null, created_by: data.session.user.id }); if (result.error) throw new Error(result.error.message); }, risk.risky ? "Evento registrado com alerta de caixa." : "Evento de RH registrado."); close();
  }
  return <div className="modal-backdrop" onMouseDown={close}><form className="modal" onSubmit={submit} onMouseDown={event => event.stopPropagation()}><PanelTitle eyebrow="EVENTO DE PESSOAL" title="Férias, antecipação ou ocorrência" /><button className="modal-close" type="button" onClick={close}>×</button><div className="form-grid"><label className="span-2">Colaborador<select name="employee_id" required><option value="">Selecione</option>{data.hrEmployees.filter(item => item.active).map(item => <option key={item.id} value={item.id}>{item.full_name}</option>)}</select></label><label>Evento<select name="event_type"><option value="adiantamento">Antecipação / adiantamento</option><option value="ferias">Férias</option><option value="decimo_terceiro">13º salário</option><option value="bonus">Bônus</option><option value="desconto">Desconto</option><option value="afastamento">Afastamento</option><option value="desligamento">Desligamento</option><option value="outro">Outro</option></select></label><label>Referência<input name="reference_date" type="date" defaultValue={today} required /></label><label>Pagamento<input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} required /></label><label>Valor<CurrencyInput name="amount" required onValueChange={setAmount} /></label><label className="span-2">Observações<textarea name="notes" rows={3} /></label></div>{risk.risky && <div className={`cash-risk-alert ${risk.level}`}><strong>Impacto incompatível com o caixa</strong><p>{risk.reason}</p>{risk.recommendedDate && <button type="button" onClick={() => setDueDate(risk.recommendedDate!)}>Usar {shortDate.format(dateAtNoon(risk.recommendedDate))}</button>}<small>Saldo projetado: {money.format(risk.projectedBalance)}</small></div>}<footer><button type="button" onClick={close}>Cancelar</button><button className="primary">Registrar evento</button></footer></form></div>;
}
