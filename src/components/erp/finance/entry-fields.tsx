"use client";

import type { Contact, EntryType, ErpData, FinancialEntry, RevenueCenter } from "../types";
import { CurrencyInput } from "../currency-input";

export function EntryFields({ data, revenueCenters, entry, entryType, setEntryType, amountChanged, dueDate, setDueDate, accountId, setAccountId, contactId, setContactId, contacts, openContact }: {
  data: ErpData;
  revenueCenters: RevenueCenter[];
  entry: FinancialEntry | null;
  entryType: EntryType;
  setEntryType: (type: EntryType) => void;
  amountChanged: (value: number) => void;
  dueDate: string;
  setDueDate: (value: string) => void;
  accountId: string;
  setAccountId: (value: string) => void;
  contactId: string;
  setContactId: (value: string) => void;
  contacts: Contact[];
  openContact: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const categories = data.categories.filter(category => category.active && (category.movement_type === entryType || category.movement_type === "ambos"));
  return <>
    <div className="form-section"><h4>Dados principais</h4><div className="form-grid three"><label>Tipo<select name="type" value={entryType} onChange={(event) => { setEntryType(event.target.value as EntryType); setContactId(""); }}><option value="saida">Conta a pagar</option><option value="entrada">Conta a receber</option></select></label><label>Emissão<input name="issue_date" type="date" defaultValue={entry?.issue_date || today} required /></label><label>Vencimento<input name="due_date" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} required /></label><label className="span-2">Descrição<input name="description" defaultValue={entry?.description || ""} required /></label><label>Valor<CurrencyInput name="amount" defaultValue={entry?.amount || 0} required onValueChange={amountChanged} /></label><label>Competência<input name="competence_date" type="date" defaultValue={entry?.competence_date || entry?.due_date || today} required /></label><label>Número do documento<input name="document_number" defaultValue={entry?.document_number || ""} /></label><label>Status<select name="status" defaultValue={entry?.status || "pendente"}><option value="rascunho">Rascunho</option><option value="pendente">Pendente</option><option value="pago">Pago</option><option value="recebido">Recebido</option><option value="cancelado">Cancelado</option></select></label></div></div>
    <div className="form-section"><h4>Classificação gerencial</h4><div className="form-grid three">
      {entryType === "saida" ? <label>Centro de custo<select name="cost_center_id" defaultValue={entry?.cost_center_id || ""} required><option value="">Selecione</option>{data.costCenters.filter(center => center.active).map(center => <option key={center.id} value={center.id}>{center.code} · {center.name}</option>)}</select></label> : <label>Centro de recebimento<select name="revenue_center_id" defaultValue={entry?.revenue_center_id || ""} required><option value="">Selecione</option>{revenueCenters.filter(center => center.active).map(center => <option key={center.id} value={center.id}>{center.code} · {center.name}</option>)}</select></label>}
      <label>Categoria financeira<select name="category_id" defaultValue={entry?.category_id || ""} required><option value="">Selecione</option>{categories.map(category => <option key={category.id} value={category.id}>{category.code} · {category.name}</option>)}</select></label>
      <label>Empreendimento<select name="project_id" defaultValue={entry?.project_id || ""}><option value="">Corporativo</option>{data.projects.filter(project => project.active).map(project => <option key={project.id} value={project.id}>{project.code} · {project.name}</option>)}</select></label>
      <label>Conta financeira<select name="bank_account_id" value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">Caixa consolidado</option>{data.bankAccounts.filter(account => account.active).map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      <label className="contact-field"><span className="field-label-actions"><span>{entryType === "saida" ? "Fornecedor / credor" : "Cliente / devedor"}</span><button type="button" onClick={openContact}>+ Cadastrar</button></span><select name="contact_id" value={contactId} onChange={(event) => setContactId(event.target.value)}><option value="">Não informado</option>{contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.trade_name || contact.name}</option>)}</select></label>
      <label>Forma de pagamento<select name="payment_method" defaultValue={entry?.payment_method || ""}><option value="">A definir</option><option>PIX</option><option>Boleto</option><option>Transferência</option><option>Cartão</option><option>Dinheiro</option><option>Débito automático</option></select></label>
    </div></div>
    <div className="form-section"><h4>Parcelamento e recorrência</h4><div className="form-grid three"><label>Parcela<input name="installment_number" type="number" min="1" defaultValue={entry?.installment_number || 1} /></label><label>Total de parcelas<input name="installment_total" type="number" min="1" defaultValue={entry?.installment_total || 1} /></label><label className="check"><input name="recurring" type="checkbox" defaultChecked={entry?.recurring} /> Lançamento recorrente</label><label className="span-3">Regra de recorrência<input name="recurrence_rule" placeholder="Ex.: mensal por 12 meses" defaultValue={entry?.recurrence_rule || ""} /></label><label className="span-3">Observações<textarea name="notes" rows={3} defaultValue={entry?.notes || ""} /></label></div></div>
  </>;
}
