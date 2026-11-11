"use client";

import { useRef, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase";
import { CurrencyInput } from "../crm-v5/sales/currency-input";
import { buildBrokerPlan, calendarMonth, nextMonthlyDate, methodLabels, roundMoney, type AmortizationMethod } from "@/lib/broker-payment-plan";
import { interestTiers, maximumBalloons, percentLabel, policyEntryRate, policyMonthlyRate } from "@/lib/commercial-policy";
import type { BrokerProposalDocument } from "@/lib/broker-proposal-pdf";
import { proposalCorrectionDescription } from "@/lib/proposal-correction";
import { BrokerPdfActions } from "./broker-pdf-actions";
import { money, today } from "./broker-format";
import type { BrokerData } from "./load-broker-data";
import { BrokerLeadSelect } from "./broker-lead-select";
import styles from "./broker-workspace.module.css";

const dateLabel = (value: string) => value ? value.split("-").reverse().join("/") : "—";
const rowLabels = { entrada: "Entrada", mensal: "Mensal", balao: "Balão anual" };

function findPolicy(loaded: BrokerData, leadId: string, projectId?: string) {
  const linked = loaded.commerce.lead_policies.find(row => row.record_id === leadId)?.policy_id;
  return loaded.commerce.policies.filter(row => row.project_id === projectId && (!linked || row.id === linked))
    .sort((a, b) => Number(b.is_default) - Number(a.is_default))[0];
}

export function BrokerProposalModal({ loaded, initialLeadId, initialUnitId, close, done }: { loaded: BrokerData; initialLeadId?: string; initialUnitId?: string; close: () => void; done: (message: string) => Promise<void> }) {
  const initial = loaded.units.find(unit => unit.id === initialUnitId);
  const initialPolicy = findPolicy(loaded, initialLeadId || "", initial?.project_id);
  const [leadId, setLeadId] = useState(initialLeadId || "");
  const [unitId, setUnitId] = useState(initialUnitId || "");
  const [price, setPrice] = useState(Number(initial?.list_price || 0));
  const [downPercent, setDownPercent] = useState(Number(initialPolicy?.min_down_payment_pct ?? 0.1) * 100);
  const [downCount, setDownCount] = useState(1);
  const [months, setMonths] = useState(initialPolicy?.max_installments || 120);
  const [withBalloons, setWithBalloons] = useState(false);
  const [balloonPercent, setBalloonPercent] = useState(Number(initialPolicy?.balloon_limit_pct ?? 0.4) * 100);
  const [requestedBalloonCount, setBalloonCount] = useState(4);
  const [downDueOverride, setDownDueOverride] = useState<string | null>(null);
  const [firstDueOverride, setFirstDueOverride] = useState<string | null>(null);
  const [method, setMethod] = useState<AmortizationMethod>("price");
  const [conditions, setConditions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const submitting = useRef(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  const lead = loaded.crm.records.find(row => row.id === leadId);
  const unit = loaded.units.find(row => row.id === unitId);
  const policy = findPolicy(loaded, leadId, unit?.project_id);
  const down = roundMoney(price * downPercent / 100);
  const monthlyRate = policyMonthlyRate(policy, months);
  const downRate = policyEntryRate(policy, downCount);
  const downFrequency = policy?.down_payment_frequency_days || 30;
  const maxBalloonCount = maximumBalloons(policy, months);
  const balloonCount = withBalloons ? Math.min(requestedBalloonCount, maxBalloonCount) : 0;
  const balloons = withBalloons ? roundMoney(price * balloonPercent / 100) : 0;
  const downDue = downDueOverride ?? (downCount > 1 ? calendarMonth(today(), 1) : today());
  const suggestedFirstDue = nextMonthlyDate(downDue, downCount, downFrequency);
  const firstDue = firstDueOverride ?? suggestedFirstDue;
  const principal = roundMoney(price - down - balloons);
  const plan = buildBrokerPlan({ salePrice: price, downPayment: down, downCount, downDue, downRate, downFrequencyDays: downFrequency, months, monthlyRate, method, firstDue, graceMonths: policy?.grace_months || 0, balloonTotal: balloons, balloonCount, balloonFrequency: policy?.balloon_frequency_months || 12 });
  const monthlyRows = plan.filter(row => row.installment_type === "mensal");
  const entryRows = plan.filter(row => row.installment_type === "entrada");
  const balloonRows = plan.filter(row => row.installment_type === "balao");
  const total = roundMoney(plan.reduce((sum, row) => sum + row.amount, 0));
  const maxDownCount = policy?.allow_down_payment_installments === false ? 1 : policy?.max_down_payment_installments || 1;
  const minDownPercent = Number(policy?.min_down_payment_pct ?? 0.1) * 100;
  const maxBalloonPercent = Number(policy?.balloon_limit_pct ?? 0.4) * 100;
  const validTerm = Number.isInteger(months) && months >= 1 && months <= (policy?.max_installments || 0);
  const validAmounts = price > 0 && principal >= 0 && downPercent >= minDownPercent && downPercent <= 100 && (!withBalloons || (balloonPercent > 0 && balloonPercent <= maxBalloonPercent && balloonCount > 0));

  function changeUnit(id: string, selectedLeadId = leadId) {
    const selected = loaded.units.find(row => row.id === id);
    const selectedPolicy = findPolicy(loaded, selectedLeadId, selected?.project_id);
    setUnitId(id); setPrice(Number(selected?.list_price || 0));
    setDownPercent(Number(selectedPolicy?.min_down_payment_pct ?? 0.1) * 100);
    setDownCount(1); setDownDueOverride(null); setFirstDueOverride(null);
    setMonths(selectedPolicy?.max_installments || 120);
    setWithBalloons(false); setBalloonPercent(Number(selectedPolicy?.balloon_limit_pct ?? 0.4) * 100);
    setBalloonCount(4); setError("");
  }

  function changeMonths(value: number) {
    setMonths(value);
    if (maximumBalloons(policy, value) === 0) setWithBalloons(false);
  }

  function documentData(): BrokerProposalDocument {
    if (!formRef.current?.reportValidity() || !lead || !unit || !policy) throw new Error("Selecione lead, lote e preencha as condições.");
    if (!validAmounts || price > 1e9 || !Number.isInteger(months) || months < 1 || months > policy.max_installments || !Number.isInteger(downCount) || downCount < 1 || downCount > maxDownCount || !Number.isInteger(balloonCount) || balloonCount < 0 || firstDue < suggestedFirstDue || plan.length === 0 || plan.some(row => !Number.isFinite(row.amount) || row.amount < 0 || row.amount > 1e12)) throw new Error("Revise valores, percentuais e prazos. A entrada e os balões não podem superar o valor do lote; as mensais devem começar após a entrada.");
    return { customer_name: lead.person_name, project_name: loaded.data.projects.find(row => row.id === unit.project_id)?.name || "", unit_code: unit.unit_code, area: unit.area, sale_price: price, down_payment: down, balloon_total: balloons, monthly_interest_rate: monthlyRate, indexer: policy.indexer, amortization_method: method, payment_plan: plan, conditions_text: conditions };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (submitting.current) return;
    setError("");
    try {
      documentData();
      if (!lead || !unit || !policy) return;
      submitting.current = true; setBusy(true);
      const terms = { sale_price: price, down_payment: down, down_count: downCount, months, monthly_rate: monthlyRate, amortization_method: method, balloon_total: balloons, balloon_count: balloonCount, first_due: firstDue, down_due: downDue, conditions };
      const key = JSON.stringify([lead.id, unit.id, terms]);
      if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
      const result = await getSupabase()!.rpc("submit_broker_proposal", { p_record_id: lead.id, p_unit_id: unit.id, p_request_id: request.current.id, p_terms: terms });
      if (result.error) throw result.error;
      await done(`Proposta ${result.data.number} encaminhada para aprovação. O lote está reservado e vinculado à proposta.`); close();
    } catch (cause) { setError(cause instanceof Error ? cause.message : (cause as { message?: string })?.message || "Não foi possível encaminhar a proposta."); }
    finally { submitting.current = false; setBusy(false); }
  }

  return <div className="modal-backdrop"><form ref={formRef} className={`modal large ${styles.detail} ${styles.proposalModal}`} role="dialog" aria-modal="true" aria-labelledby="broker-proposal-title" onSubmit={submit}>
    <button type="button" className="modal-close" disabled={busy} onClick={close} aria-label="Fechar proposta">×</button>
    <header><small>PROPOSTA E RESERVA</small><h2 id="broker-proposal-title">Monte a proposta com o cliente</h2><p>Escolha as condições. Os juros, a entrada e o fluxo de pagamento são calculados para você.</p></header>
    <div className={styles.proposalLayout}>
      <div className={styles.proposalFields}>
        <fieldset disabled={busy} className={styles.proposalSection}>
          <legend>1. Lead e lote</legend>
          <div className={styles.formGrid}>
            <BrokerLeadSelect required leads={loaded.crm.records.filter(row => row.record_status === "aberta")} value={leadId} onChange={id => {
              const selectedLead = loaded.crm.records.find(row => row.id === id);
              setLeadId(id); changeUnit(!selectedLead?.project_id || selectedLead.project_id === unit?.project_id ? unitId : "", id);
            }} />
            <label>Lote disponível<select required value={unitId} onChange={e => changeUnit(e.target.value)}><option value="">Selecione o lote</option>{loaded.units.filter(row => !lead?.project_id || row.project_id === lead.project_id).map(row => <option key={row.id} value={row.id}>{row.unit_code} · {row.area} m² · {money.format(row.list_price)}</option>)}</select></label>
          </div>
          {unit && <div className={styles.lotSummary}><strong>{unit.unit_code} · {unit.area} m²</strong><span>{money.format(Number(unit.price_per_sqm || unit.list_price / unit.area))}/m²</span><span>Valor de tabela: {money.format(unit.list_price)}</span></div>}
          <label className={styles.proposalLabel}>Valor proposto<CurrencyInput name="sale_price" value={price} onValueChange={setPrice} /></label>
        </fieldset>

        <fieldset disabled={busy || !policy} className={styles.proposalSection}>
          <legend>2. Entrada em percentual</legend>
          <p>O percentual permanece fixo quando você ajusta o valor da proposta.</p>
          <div className={styles.formGrid}>
            <label>Entrada (%)<input required type="number" min={minDownPercent} max={100} step="0.01" value={downPercent} onChange={e => setDownPercent(Number(e.target.value))} /><small>Mínimo: {percentLabel(minDownPercent / 100)}</small></label>
            <label>Parcelas da entrada<select value={downCount} onChange={e => { setDownCount(Number(e.target.value)); setDownDueOverride(null); setFirstDueOverride(null); }}>{Array.from({ length: maxDownCount }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n === 1 ? "À vista" : `${n} vezes`}</option>)}</select><small>{downRate ? `${percentLabel(downRate)} a.m. na entrada` : "Sem juros na entrada"}</small></label>
          </div>
          <div className={styles.calculatedBox}><span>Entrada: <strong data-testid="entry-total">{money.format(down)}</strong></span><span>{downCount} × <strong>{money.format(entryRows[0]?.amount || 0)}</strong>{downRate ? " com juros" : " sem juros"}</span></div>
          <p className={styles.proposalHint}>Entrada parcelada: primeiro vencimento sugerido para o próximo mês.</p>
        </fieldset>

        <fieldset disabled={busy || !policy} className={styles.proposalSection}>
          <legend>3. Parcelamento e amortização</legend>
          <div className={styles.formGrid}>
            <label>Parcelas mensais<input required type="number" min={1} max={policy?.max_installments || 180} step={1} value={months} onChange={e => changeMonths(Number(e.target.value))} /></label>
            <div className={styles.automaticRate}><span>Juros automáticos</span><strong data-testid="monthly-rate">{validTerm ? percentLabel(monthlyRate) : "—"} <small>ao mês</small></strong><span>Definidos pelo prazo e pela política vigente.</span></div>
          </div>
          <div className={styles.termOptions}>{policy && interestTiers(policy).filter(tier => tier.max_installments <= policy.max_installments).map(tier => <button type="button" key={tier.max_installments} aria-pressed={months === tier.max_installments} onClick={() => changeMonths(tier.max_installments)}>{tier.max_installments}x · {percentLabel(tier.monthly_interest_rate)} a.m.</button>)}</div>
          <p className={styles.proposalHint}><strong>Índice de correção monetária: {proposalCorrectionDescription(policy?.indexer)}</strong></p>
          <div className={styles.methodOptions} role="radiogroup" aria-label="Sistema de amortização">
            <label data-selected={method === "price"}><input type="radio" name="amortization_method" value="price" checked={method === "price"} onChange={() => setMethod("price")} /><span><strong>Tabela Price</strong><small>Mensais constantes antes da correção pelo indexador.</small></span></label>
            <label data-selected={method === "sacoc"}><input type="radio" name="amortization_method" value="sacoc" checked={method === "sacoc"} onChange={() => setMethod("sacoc")} /><span><strong>SACOC · Gradiente</strong><small>Mensais crescentes, com juros compostos sobre cada cota.</small></span></label>
          </div>
        </fieldset>

        <fieldset disabled={busy || !policy} className={styles.proposalSection}>
          <legend>4. Balões anuais</legend>
          <label className={styles.balloonToggle}><input type="checkbox" checked={withBalloons} disabled={maxBalloonCount === 0} onChange={e => setWithBalloons(e.target.checked)} />Incluir balões na proposta</label>
          <p>Até {percentLabel(maxBalloonPercent / 100)} do valor do lote no total, em até {Number(policy?.parameters?.annual_balloon_max_count ?? 4)} balões. Esse valor é retirado do saldo das mensais.</p>
          {maxBalloonCount === 0 && <p className={styles.proposalHint}>Disponível para prazos a partir de {policy?.balloon_frequency_months || 12} meses.</p>}
          {withBalloons && <>
            <div className={styles.formGrid}>
              <label>Percentual total em balões (%)<input required type="number" min={0.01} max={maxBalloonPercent} step="0.01" value={balloonPercent} onChange={e => setBalloonPercent(Number(e.target.value))} /></label>
              <label>Quantidade de balões<select value={balloonCount} onChange={e => setBalloonCount(Number(e.target.value))}>{Array.from({ length: maxBalloonCount }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n} {n === 1 ? "balão" : "balões"}</option>)}</select></label>
            </div>
            <div className={styles.calculatedBox}><span>Total em balões: <strong data-testid="balloon-total">{money.format(balloons)}</strong></span><span>{balloonCount} × aproximadamente <strong>{money.format(balloonRows[0]?.amount || 0)}</strong></span></div>
            <ul className={styles.balloonList}>{balloonRows.map((row, i) => <li key={row.installment_number}><span>{i + 1}º balão · {dateLabel(row.due_date)}</span><strong>{money.format(row.amount)}</strong></li>)}</ul>
          </>}
        </fieldset>

        <fieldset disabled={busy || !policy} className={styles.proposalSection}>
          <legend>5. Vencimentos e observações</legend>
          <div className={styles.formGrid}>
            <label>Primeiro vencimento da entrada<input required type="date" min={today()} value={downDue} onChange={e => { setDownDueOverride(e.target.value); setFirstDueOverride(null); }} /></label>
            <label>Primeiro vencimento mensal<input required type="date" min={suggestedFirstDue || today()} value={firstDue} onChange={e => setFirstDueOverride(e.target.value)} /></label>
          </div>
          <p className={styles.proposalHint}>As mensais começam no mês seguinte à última entrada.{Number(policy?.grace_months) > 0 ? ` Carência adicional de ${policy?.grace_months} meses.` : ""}</p>
          {(downDueOverride !== null || firstDueOverride !== null) && <button type="button" onClick={() => { setDownDueOverride(null); setFirstDueOverride(null); }}>Restaurar datas sugeridas</button>}
          <label className={styles.proposalLabel}>Observações para a Diretoria<textarea name="conditions" maxLength={4000} rows={3} placeholder="Informações relevantes para a análise da proposta" value={conditions} onChange={e => setConditions(e.target.value)} /></label>
        </fieldset>
      </div>

      <aside className={styles.proposalSummary} aria-label="Resumo da simulação">
        <small>SIMULAÇÃO EM TEMPO REAL</small><h3>Resumo da proposta</h3>
        <p>{unit ? `${unit.unit_code} · ${unit.area} m²` : "Selecione um lote para simular"}</p>
        <div className={styles.monthlyHighlight}><span>Primeira mensal</span><strong data-testid="first-monthly">{validAmounts && validTerm ? money.format(monthlyRows[0]?.amount || 0) : "—"}</strong><small>{months} mensais · {methodLabels[method]}</small>{method === "sacoc" && <span>Última: {validAmounts && validTerm ? money.format(monthlyRows.at(-1)?.amount || 0) : "—"}</span>}</div>
        <dl><div><dt>Valor do lote</dt><dd>{money.format(price)}</dd></div><div><dt>Entrada · {percentLabel(downPercent / 100)}</dt><dd>{money.format(down)}</dd></div><div><dt>Balões · {withBalloons ? percentLabel(balloonPercent / 100) : "sem balões"}</dt><dd>{money.format(balloons)}</dd></div><div><dt>Saldo das mensais</dt><dd data-testid="monthly-principal">{validAmounts && validTerm ? money.format(principal) : "—"}</dd></div><div><dt>Juros das mensais</dt><dd>{percentLabel(monthlyRate)} a.m.</dd></div><div><dt>Total do fluxo com juros</dt><dd>{validAmounts && validTerm ? money.format(total) : "—"}</dd></div></dl>
        <p className={styles.proposalHint}>Estimativa sem correção futura por {policy?.indexer || "indexador"}. Balões nominais; eventual carência apenas adia vencimentos.</p>
        {!validAmounts && price > 0 && <p className="feedback error" role="alert">Confira os percentuais: entrada e balões não podem superar o valor do lote.</p>}
        {policy && <><hr /><strong>{policy.name}</strong><p className={styles.proposalHint}>Ao encaminhar, o lote fica reservado por {policy.reservation_validity_hours} horas. A proposta depende da aprovação da Diretoria.</p></>}
      </aside>
    </div>

    {policy && validAmounts && validTerm && <details className={styles.paymentSchedule}><summary>Ver cronograma completo de pagamentos ({plan.length} parcelas)</summary><div><table><thead><tr><th>Tipo</th><th>Vencimento</th><th>Valor</th></tr></thead><tbody>{[...plan].sort((a, b) => a.due_date.localeCompare(b.due_date) || a.installment_number - b.installment_number).map(row => <tr key={row.installment_number}><td>{rowLabels[row.installment_type]}</td><td>{dateLabel(row.due_date)}</td><td>{money.format(row.amount)}</td></tr>)}</tbody></table></div></details>}
    {unit && !policy && <p role="alert">Não há política comercial vigente para este atendimento. Solicite a configuração à Diretoria.</p>}
    {error && <p className="feedback error" role="alert">{error}</p>}
    <section className={styles.proposalConference}><h3>Conferir com o cliente</h3><p>O PDF e o envio para conferência não reservam o lote e não representam aprovação.</p><BrokerPdfActions loaded={loaded} leadId={leadId} getDocument={documentData} disabled={busy || !lead || !policy || !validAmounts || !validTerm} /></section>
    <footer className={styles.actions}><button type="button" disabled={busy} onClick={close}>Cancelar</button><button className="primary" disabled={busy || !policy || !lead || !validAmounts || !validTerm}>{busy ? "Encaminhando…" : "Encaminhar proposta e reservar lote"}</button></footer>
  </form></div>;
}
