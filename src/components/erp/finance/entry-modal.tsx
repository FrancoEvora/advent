"use client";

import { FormEvent, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ApprovalStatus, EntryStatus, EntryType, ErpData, FinancialEntry, RevenueCenter } from "../types";
import { analyzePaymentRisk } from "../analytics";
import { dateAtNoon, daysUntil, money, shortDate } from "../utils";
import { PanelTitle } from "../views-dashboard";
import { EntryFields } from "./entry-fields";
import { QuickContactModal } from "./quick-contact-modal";

export function EntryModal({ data, revenueCenters, entry, close, mutate }: { data: ErpData; revenueCenters: RevenueCenter[]; entry: FinancialEntry | null; close: () => void; mutate: (operation: () => Promise<void>, success: string) => Promise<void> }) {
  const [entryType, setEntryType] = useState<EntryType>(entry?.type || "saida");
  const [amount, setAmount] = useState(Number(entry?.amount || 0));
  const [dueDate, setDueDate] = useState(entry?.due_date || new Date().toISOString().slice(0, 10));
  const [accountId, setAccountId] = useState(entry?.bank_account_id || "");
  const [contactId, setContactId] = useState(entry?.contact_id || "");
  const [quickContact, setQuickContact] = useState(false);
  const [error, setError] = useState("");
  const contactTypes = entryType === "saida" ? ["fornecedor", "ambos", "colaborador"] : ["cliente", "ambos", "corretor"];
  const contacts = data.contacts.filter(contact => contact.active && contactTypes.includes(contact.contact_type));
  const risk = useMemo(() => entryType === "saida" ? analyzePaymentRisk(data, { amount, dueDate, accountId: accountId || null, excludeEntryId: entry?.id }) : null, [data, entryType, amount, dueDate, accountId, entry?.id]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const categories = data.categories.filter(category => category.active && (category.movement_type === entryType || category.movement_type === "ambos"));
    const thresholdApproval = Boolean(data.settings.require_approval) && amount >= Number(data.settings.approval_threshold) && !["admin", "diretoria"].includes(data.membership.role);
    const cashApproval = Boolean(risk?.risky && (data.settings.require_cash_risk_approval ?? true));
    const requiresApproval = thresholdApproval || cashApproval;
    const payload = {
      organization_id: data.organization.id,
      user_id: data.session.user.id,
      created_by: data.session.user.id,
      type: entryType,
      description: String(form.get("description")).trim(),
      category: categories.find(category => category.id === form.get("category_id"))?.name || "Geral",
      category_id: String(form.get("category_id") || "") || null,
      cost_center_id: entryType === "saida" ? String(form.get("cost_center_id") || "") || null : null,
      revenue_center_id: entryType === "entrada" ? String(form.get("revenue_center_id") || "") || null : null,
      bank_account_id: accountId || null,
      contact_id: contactId || null,
      project_id: String(form.get("project_id") || "") || null,
      amount,
      due_date: dueDate,
      issue_date: String(form.get("issue_date")),
      competence_date: String(form.get("competence_date")),
      status: (form.get("status") as EntryStatus) || "pendente",
      approval_status: (requiresApproval ? "pendente" : "aprovado") as ApprovalStatus,
      payment_method: String(form.get("payment_method") || "") || null,
      document_number: String(form.get("document_number") || "") || null,
      installment_number: Number(form.get("installment_number") || 1),
      installment_total: Number(form.get("installment_total") || 1),
      recurring: form.get("recurring") === "on",
      recurrence_rule: String(form.get("recurrence_rule") || "") || null,
      notes: String(form.get("notes") || "") || null,
      cash_risk: Boolean(risk?.risky),
      cash_risk_level: risk?.level || "baixo",
      projected_balance: risk?.projectedBalance ?? null,
      recommended_due_date: risk?.recommendedDate ?? null,
      risk_reason: risk?.risky ? risk.reason : null,
      treatment_status: daysUntil(dueDate) < 0 ? "recomendado" : "nao_aplicavel",
    };

    await mutate(async () => {
      const supabase = getSupabase(); if (!supabase) throw new Error("Supabase indisponível.");
      let entryId = entry?.id;
      if (entry) {
        const { error: updateError } = await supabase.from("financial_entries").update(payload).eq("id", entry.id);
        if (updateError) throw new Error(updateError.message);
      } else {
        const { data: created, error: insertError } = await supabase.from("financial_entries").insert(payload).select().single();
        if (insertError) throw new Error(insertError.message);
        entryId = created.id;
      }
      if (requiresApproval && entryId) {
        const { data: existing } = await supabase.from("approval_requests").select("id").eq("entry_id", entryId).eq("status", "pendente").maybeSingle();
        if (!existing) {
          const reason = cashApproval ? "Pagamento com risco de caixa negativo" : "Valor acima da alçada configurada";
          const { error: approvalError } = await supabase.from("approval_requests").insert({ organization_id: data.organization.id, entry_id: entryId, requested_by: data.session.user.id, status: "pendente", reason, recommended_due_date: risk?.recommendedDate || null, risk_snapshot: risk ? { level: risk.level, projected_balance: risk.projectedBalance, reason: risk.reason } : null });
          if (approvalError) throw new Error(approvalError.message);
        }
      }
    }, entry ? "Lançamento atualizado." : requiresApproval ? "Lançamento enviado para aprovação." : "Lançamento salvo com sucesso.");
    close();
  }

  return <>
    <div className="modal-backdrop" onMouseDown={close}><form className="modal large" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}><PanelTitle eyebrow={entry ? "EDITAR MOVIMENTO" : "NOVO MOVIMENTO"} title={entry ? entry.description : "Adicionar lançamento financeiro"} /><button className="modal-close" type="button" onClick={close}>×</button>
      <EntryFields data={data} revenueCenters={revenueCenters} entry={entry} entryType={entryType} setEntryType={setEntryType} amountChanged={setAmount} dueDate={dueDate} setDueDate={setDueDate} accountId={accountId} setAccountId={setAccountId} contactId={contactId} setContactId={setContactId} contacts={contacts} openContact={() => setQuickContact(true)} />
      {risk?.risky && <div className={`cash-risk-alert ${risk.level}`}><div><b>!</b><span><strong>Risco de caixa {risk.level}</strong><small>Saldo projetado após o pagamento: {money.format(risk.projectedBalance)}</small></span></div><p>{risk.reason}</p>{risk.recommendedDate && <button type="button" onClick={() => setDueDate(risk.recommendedDate!)}>Usar data recomendada: {shortDate.format(dateAtNoon(risk.recommendedDate))}</button>}<em>Este pagamento será encaminhado para aprovação administrativa.</em></div>}
      {error && <div className="feedback error"><strong>Não foi possível salvar.</strong><span>{error}</span></div>}
      <footer><button type="button" onClick={close}>Cancelar</button><button className="primary">{entry ? "Salvar alterações" : "Salvar lançamento"}</button></footer>
    </form></div>
    {quickContact && <QuickContactModal entryType={entryType} data={data} mutate={mutate} close={() => setQuickContact(false)} onCreated={setContactId} />}
  </>;
}
