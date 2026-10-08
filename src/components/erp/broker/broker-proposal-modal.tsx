"use client";

import { useRef, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase";
import { CurrencyInput } from "../crm-v5/sales/currency-input";
import { buildPlan } from "../crm-v5/sales/utils";
import { money, today } from "./broker-format";
import type { BrokerData } from "./load-broker-data";
import { BrokerLeadSelect } from "./broker-lead-select";
import styles from "./broker-workspace.module.css";

export function BrokerProposalModal({ loaded, initialLeadId, initialUnitId, close, done }: { loaded: BrokerData; initialLeadId?: string; initialUnitId?: string; close: () => void; done: (message: string) => Promise<void> }) {
  const [leadId, setLeadId] = useState(initialLeadId || "");
  const [unitId, setUnitId] = useState(initialUnitId || "");
  const initial = loaded.units.find(unit => unit.id === initialUnitId);
  const [price, setPrice] = useState(Number(initial?.list_price || 0));
  const [down, setDown] = useState(0);
  const [downCount, setDownCount] = useState(1);
  const [months, setMonths] = useState(120);
  const [rate, setRate] = useState<number | null>(null);
  const [balloons, setBalloons] = useState(0);
  const [balloonCount, setBalloonCount] = useState(0);
  const [firstDue, setFirstDue] = useState(today);
  const [downDue, setDownDue] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef<string | null>(null);
  const lead = loaded.crm.records.find(row => row.id === leadId);
  const unit = loaded.units.find(row => row.id === unitId);
  const policyId = loaded.commerce.lead_policies.find(row => row.record_id === leadId)?.policy_id;
  const policy = loaded.commerce.policies.find(row => row.project_id === unit?.project_id && (!policyId || row.id === policyId));
  const monthlyRate = rate === null ? Number(policy?.monthly_interest_rate || 0) : rate / 100;
  const plan = firstDue && downDue ? buildPlan({ salePrice: price, downPayment: down, installments: months, monthlyRate, graceMonths: policy?.grace_months || 0, balloonTotal: balloons, balloonCount, balloonFrequency: policy?.balloon_frequency_months || 12, firstDueDate: firstDue, downPaymentInstallments: downCount, downPaymentFirstDueDate: downDue, downPaymentFrequencyDays: policy?.down_payment_frequency_days || 30, downPaymentRate: Number(policy?.down_payment_interest_rate || 0) }) : [];
  function changeUnit(id: string) {
    const selected = loaded.units.find(row => row.id === id);
    const selectedPolicy = loaded.commerce.policies.find(row => row.project_id === selected?.project_id && (!policyId || row.id === policyId));
    setUnitId(id); setPrice(Number(selected?.list_price || 0)); setDown(Number(selected?.list_price || 0) * Number(selectedPolicy?.min_down_payment_pct || 0)); setMonths(selectedPolicy?.max_installments || 120); setRate(null);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError("");
    try {
      if (!lead || !unit || !policy) throw new Error("Selecione o lead, o lote e uma política comercial vigente.");
      if (down + balloons > price || (balloons > 0 && !balloonCount)) throw new Error("Revise a entrada e os balões.");
      requestId.current ??= crypto.randomUUID();
      const form = new FormData(event.currentTarget);
      const result = await getSupabase()!.rpc("submit_broker_proposal", { p_record_id: lead.id, p_unit_id: unit.id, p_request_id: requestId.current, p_terms: { sale_price: price, down_payment: down, down_count: downCount, months, monthly_rate: monthlyRate, balloon_total: balloons, balloon_count: balloonCount, first_due: firstDue, down_due: downDue, conditions: String(form.get("conditions") || "") } });
      if (result.error) throw result.error;
      await done(`Proposta ${result.data.number} encaminhada para aprovação. O lote está reservado e vinculado à proposta.`); close();
    } catch (cause) { setError(cause instanceof Error ? cause.message : (cause as { message?: string })?.message || "Não foi possível encaminhar a proposta."); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop"><form className={`modal large ${styles.detail}`} role="dialog" aria-modal="true" aria-label="Proposta e reserva de lote" onSubmit={submit}>
    <button type="button" className="modal-close" disabled={busy} onClick={close} aria-label="Fechar proposta">×</button>
    <header><small>PROPOSTA E RESERVA</small><h2>Encaminhar proposta</h2><p>A reserva será criada junto com a proposta. As condições dependem da aprovação da Diretoria.</p></header>
    <fieldset disabled={busy} className={styles.formGrid}>
      <BrokerLeadSelect required leads={loaded.crm.records.filter(row => row.record_status === "aberta")} value={leadId} onChange={id => { setLeadId(id); setUnitId(""); setPrice(0); }} />
      <label>Lote disponível<select required value={unitId} onChange={e => changeUnit(e.target.value)}><option value="">Selecione o lote</option>{loaded.units.filter(row => !lead?.project_id || row.project_id === lead.project_id).map(row => <option key={row.id} value={row.id}>{row.unit_code} · {row.area} m² · {money.format(row.list_price)}</option>)}</select></label>
      <label>Valor proposto<CurrencyInput name="sale_price" value={price} onValueChange={setPrice} /></label><label>Entrada<CurrencyInput name="down_payment" value={down} onValueChange={setDown} /></label>
      <label>Parcelas da entrada<input required type="number" min={1} max={36} value={downCount} onChange={e => setDownCount(Number(e.target.value))} /></label><label>Primeiro vencimento da entrada<input required type="date" min={today()} value={downDue} onChange={e => setDownDue(e.target.value)} /></label>
      <label>Parcelas mensais<input required type="number" min={0} max={360} value={months} onChange={e => setMonths(Number(e.target.value))} /></label><label>Primeiro vencimento mensal<input required type="date" min={today()} value={firstDue} onChange={e => setFirstDue(e.target.value)} /></label>
      <label>Juros mensais (%)<input required type="number" min={0} max={10} step="0.001" value={rate ?? Number(policy?.monthly_interest_rate || 0) * 100} onChange={e => setRate(Number(e.target.value))} /></label><label>Total em balões<CurrencyInput name="balloon_total" value={balloons} onValueChange={value => { setBalloons(value); if (!value) setBalloonCount(0); }} /></label>
      <label>Quantidade de balões<input required type="number" min={0} max={30} value={balloonCount} onChange={e => setBalloonCount(Number(e.target.value))} /></label><label>Condições solicitadas<textarea name="conditions" maxLength={4000} rows={3} /></label>
    </fieldset>
    {policy && <div className={styles.guidance}><strong>{policy.name}</strong><p>Correção: {policy.indexer || "Sem indexador"}. Reserva por {policy.reservation_validity_hours} horas. {policy.grace_months > 0 ? `Carência de ${policy.grace_months} meses.` : ""}</p><p>Parcela mensal estimada: <strong>{money.format(plan.find(row => row.installment_type === "mensal")?.amount || 0)}</strong>. Balões a cada {policy.balloon_frequency_months} meses.</p></div>}
    {unit && !policy && <p role="alert">Não há política comercial vigente para este atendimento. Solicite a configuração à Diretoria.</p>}
    {error && <p className="feedback error" role="alert">{error}</p>}
    <footer className={styles.actions}><button type="button" disabled={busy} onClick={close}>Cancelar</button><button className="primary" disabled={busy || !policy || !lead || price <= 0}>{busy ? "Encaminhando…" : "Encaminhar proposta"}</button></footer>
  </form></div>;
}
