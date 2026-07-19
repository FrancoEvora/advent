"use client";
import { FormEvent, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ApprovalStatus, EntryStatus, EntryType, ErpData, FinancialEntry } from "./types";
import { canWriteFinance, dateAtNoon, downloadCsv, isSettled, money, shortDate, statusLabels } from "./utils";
import { Empty, PanelTitle } from "./views-dashboard";

export function FinanceView({ data, mutate }: { data: ErpData; mutate: (operation: () => Promise<void>, success: string) => Promise<void> }) {
  const [modal, setModal] = useState<FinancialEntry | "new" | null>(null);
  const [query, setQuery] = useState(""); const [type, setType] = useState<"todos" | EntryType>("todos"); const [status, setStatus] = useState<"todos" | EntryStatus>("todos");
  const [center, setCenter] = useState("todos");
  const list = useMemo(() => data.entries.filter((entry) => (type === "todos" || entry.type === type) && (status === "todos" || entry.status === status) && (center === "todos" || entry.cost_center_id === center) && `${entry.description} ${entry.category} ${entry.document_number || ""}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => a.due_date.localeCompare(b.due_date)), [data.entries, type, status, center, query]);

  async function settle(entry: FinancialEntry) {
    const nextStatus: EntryStatus = entry.type === "entrada" ? "recebido" : "pago";
    await mutate(async () => {
      const supabase = getSupabase(); if (!supabase) throw new Error("Supabase indisponível.");
      const { error } = await supabase.from("financial_entries").update({ status: nextStatus, settlement_date: new Date().toISOString().slice(0, 10) }).eq("id", entry.id);
      if (error) throw new Error(error.message);
    }, entry.type === "entrada" ? "Recebimento confirmado." : "Pagamento confirmado.");
  }
  async function remove(entry: FinancialEntry) {
    if (!confirm(`Excluir o lançamento “${entry.description}”?`)) return;
    await mutate(async () => { const supabase = getSupabase(); if (!supabase) throw new Error("Supabase indisponível."); const { error } = await supabase.from("financial_entries").delete().eq("id", entry.id); if (error) throw new Error(error.message); }, "Lançamento excluído.");
  }
  function exportData() { downloadCsv("evora-financeiro.csv", ["Tipo", "Descrição", "Centro de custo", "Categoria", "Valor", "Vencimento", "Status", "Aprovação"], list.map((entry) => [entry.type, entry.description, data.costCenters.find(c => c.id === entry.cost_center_id)?.name, data.categories.find(c => c.id === entry.category_id)?.name || entry.category, entry.amount, entry.due_date, entry.status, entry.approval_status])); }

  return <div className="stack">
    <section className="module-toolbar"><div className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar descrição, documento ou categoria" /></div><div className="toolbar-actions"><button onClick={exportData}>⇩ Exportar</button>{canWriteFinance(data.membership.role) && <button className="primary" onClick={() => setModal("new")}>+ Adicionar lançamento</button>}</div></section>
    <section className="filters"><select value={type} onChange={(e) => setType(e.target.value as typeof type)}><option value="todos">Entradas e saídas</option><option value="saida">Contas a pagar</option><option value="entrada">Contas a receber</option></select><select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="todos">Todos os status</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select value={center} onChange={(e) => setCenter(e.target.value)}><option value="todos">Todos os centros de custo</option>{data.costCenters.filter(c => c.active).map(c => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</select><span>{list.length} registros</span></section>
    <section className="panel finance-table"><div className="table-header"><span>Lançamento</span><span>Classificação</span><span>Vencimento</span><span>Status</span><span>Valor</span><span /></div>{list.map((entry) => <FinanceRow key={entry.id} entry={entry} data={data} onEdit={() => setModal(entry)} onSettle={() => settle(entry)} onRemove={() => remove(entry)} />)}{!list.length && <Empty text="Nenhum lançamento encontrado." />}</section>
    {modal && <EntryModal data={data} entry={modal === "new" ? null : modal} close={() => setModal(null)} mutate={mutate} />}
  </div>;
}

function FinanceRow({ entry, data, onEdit, onSettle, onRemove }: { entry: FinancialEntry; data: ErpData; onEdit: () => void; onSettle: () => void; onRemove: () => void }) {
  const center = data.costCenters.find(c => c.id === entry.cost_center_id); const category = data.categories.find(c => c.id === entry.category_id); const project = data.projects.find(p => p.id === entry.project_id);
  return <article className="finance-row"><div className="finance-main"><i className={entry.type}>{entry.type === "entrada" ? "↓" : "↑"}</i><span><strong>{entry.description}</strong><small>{entry.document_number ? `Doc. ${entry.document_number} · ` : ""}{project?.name || "Corporativo"}</small></span></div><div><strong>{category?.name || entry.category}</strong><small>{center ? `${center.code} · ${center.name}` : "Não classificado"}</small></div><div><strong>{shortDate.format(dateAtNoon(entry.due_date))}</strong><small>{entry.installment_total > 1 ? `${entry.installment_number}/${entry.installment_total}` : "Parcela única"}</small></div><div><span className={`status ${entry.status}`}>{statusLabels[entry.status]}</span><small className={`approval ${entry.approval_status}`}>{entry.approval_status}</small></div><b className={entry.type}>{entry.type === "saida" ? "−" : "+"}{money.format(Number(entry.amount))}</b><div className="row-actions"><button onClick={onEdit} title="Editar">✎</button>{!isSettled(entry) && entry.approval_status === "aprovado" && <button onClick={onSettle} title="Liquidar">✓</button>}<button onClick={onRemove} title="Excluir">×</button></div></article>;
}

function EntryModal({ data, entry, close, mutate }: { data: ErpData; entry: FinancialEntry | null; close: () => void; mutate: (operation: () => Promise<void>, success: string) => Promise<void> }) {
  const [entryType, setEntryType] = useState<EntryType>(entry?.type || "saida"); const [error, setError] = useState("");
  const categories = data.categories.filter(c => c.active && (c.movement_type === entryType || c.movement_type === "ambos"));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); const form = new FormData(event.currentTarget); const amount = Number(form.get("amount"));
    const requiresApproval = data.settings.require_approval && amount >= Number(data.settings.approval_threshold) && !["admin", "diretoria"].includes(data.membership.role);
    const payload = {
      organization_id: data.organization.id, user_id: data.session.user.id, created_by: data.session.user.id, type: entryType,
      description: String(form.get("description")).trim(), category: categories.find(c => c.id === form.get("category_id"))?.name || "Geral",
      category_id: String(form.get("category_id") || "") || null, cost_center_id: String(form.get("cost_center_id") || "") || null,
      bank_account_id: String(form.get("bank_account_id") || "") || null, contact_id: String(form.get("contact_id") || "") || null,
      project_id: String(form.get("project_id") || "") || null, amount, due_date: String(form.get("due_date")), issue_date: String(form.get("issue_date")),
      competence_date: String(form.get("competence_date")), status: (form.get("status") as EntryStatus) || "pendente",
      approval_status: (requiresApproval ? "pendente" : "aprovado") as ApprovalStatus, payment_method: String(form.get("payment_method") || "") || null,
      document_number: String(form.get("document_number") || "") || null, installment_number: Number(form.get("installment_number") || 1),
      installment_total: Number(form.get("installment_total") || 1), recurring: form.get("recurring") === "on", recurrence_rule: String(form.get("recurrence_rule") || "") || null,
      notes: String(form.get("notes") || "") || null,
    };
    try {
      await mutate(async () => {
        const supabase = getSupabase(); if (!supabase) throw new Error("Supabase indisponível.");
        if (entry) { const { error: updateError } = await supabase.from("financial_entries").update(payload).eq("id", entry.id); if (updateError) throw new Error(updateError.message); }
        else {
          const { data: created, error: insertError } = await supabase.from("financial_entries").insert(payload).select().single(); if (insertError) throw new Error(insertError.message);
          if (requiresApproval && created) { const { error: approvalError } = await supabase.from("approval_requests").insert({ organization_id: data.organization.id, entry_id: created.id, requested_by: data.session.user.id, status: "pendente" }); if (approvalError) throw new Error(`Lançamento criado, mas a aprovação falhou: ${approvalError.message}`); }
        }
      }, entry ? "Lançamento atualizado." : requiresApproval ? "Lançamento enviado para aprovação." : "Lançamento salvo com sucesso."); close();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Não foi possível salvar."); }
  }
  const today = new Date().toISOString().slice(0, 10);
  return <div className="modal-backdrop" onMouseDown={close}><form className="modal large" onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}><PanelTitle eyebrow={entry ? "EDITAR MOVIMENTO" : "NOVO MOVIMENTO"} title={entry ? entry.description : "Adicionar lançamento financeiro"} /><button className="modal-close" type="button" onClick={close}>×</button>
    <div className="form-section"><h4>Dados principais</h4><div className="form-grid three"><label>Tipo<select name="type" value={entryType} onChange={(e) => setEntryType(e.target.value as EntryType)}><option value="saida">Conta a pagar</option><option value="entrada">Conta a receber</option></select></label><label>Emissão<input name="issue_date" type="date" defaultValue={entry?.issue_date || today} required /></label><label>Vencimento<input name="due_date" type="date" defaultValue={entry?.due_date || today} required /></label><label className="span-2">Descrição<input name="description" defaultValue={entry?.description || ""} required /></label><label>Valor<input name="amount" type="number" min="0.01" step="0.01" defaultValue={entry?.amount || ""} required /></label><label>Competência<input name="competence_date" type="date" defaultValue={entry?.competence_date || entry?.due_date || today} required /></label><label>Número do documento<input name="document_number" defaultValue={entry?.document_number || ""} /></label><label>Status<select name="status" defaultValue={entry?.status || "pendente"}><option value="rascunho">Rascunho</option><option value="pendente">Pendente</option><option value="pago">Pago</option><option value="recebido">Recebido</option><option value="cancelado">Cancelado</option></select></label></div></div>
    <div className="form-section"><h4>Classificação gerencial</h4><div className="form-grid three"><label>Centro de custo<select name="cost_center_id" defaultValue={entry?.cost_center_id || ""} required><option value="">Selecione</option>{data.costCenters.filter(c => c.active).map(c => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</select></label><label>Categoria financeira<select name="category_id" defaultValue={entry?.category_id || ""} required><option value="">Selecione</option>{categories.map(c => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</select></label><label>Empreendimento<select name="project_id" defaultValue={entry?.project_id || ""}><option value="">Corporativo</option>{data.projects.filter(p => p.active).map(p => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></label><label>Conta financeira<select name="bank_account_id" defaultValue={entry?.bank_account_id || ""}><option value="">A definir</option>{data.bankAccounts.filter(a => a.active).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label>Cliente / fornecedor<select name="contact_id" defaultValue={entry?.contact_id || ""}><option value="">Não informado</option>{data.contacts.filter(c => c.active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Forma de pagamento<select name="payment_method" defaultValue={entry?.payment_method || ""}><option value="">A definir</option><option>PIX</option><option>Boleto</option><option>Transferência</option><option>Cartão</option><option>Dinheiro</option><option>Débito automático</option></select></label></div></div>
    <div className="form-section"><h4>Parcelamento e recorrência</h4><div className="form-grid three"><label>Parcela<input name="installment_number" type="number" min="1" defaultValue={entry?.installment_number || 1} /></label><label>Total de parcelas<input name="installment_total" type="number" min="1" defaultValue={entry?.installment_total || 1} /></label><label className="check"><input name="recurring" type="checkbox" defaultChecked={entry?.recurring} /> Lançamento recorrente</label><label className="span-3">Regra de recorrência<input name="recurrence_rule" placeholder="Ex.: mensal por 12 meses" defaultValue={entry?.recurrence_rule || ""} /></label><label className="span-3">Observações<textarea name="notes" rows={3} defaultValue={entry?.notes || ""} /></label></div></div>
    {error && <div className="feedback error"><strong>Não foi possível salvar.</strong><span>{error}</span></div>}<footer><button type="button" onClick={close}>Cancelar</button><button className="primary">{entry ? "Salvar alterações" : "Salvar lançamento"}</button></footer></form></div>;
}
