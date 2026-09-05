"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ErpData, FinancialEntry } from "../types";
import { getOriginalUrl, operationClient, operationError } from "./client";
import { asRecord, FIELD_LABELS, formatDate, formatMoney, OPERATION_LABELS, operationIssue, PAYABLE_FIELDS, stringValue, type BankTransaction, type OperationItem, type PayableField, type PayableValues } from "./types";
import styles from "./operations-center.module.css";

type ReviewProps = {
  item: OperationItem;
  data: ErpData;
  canManage: boolean;
  onClose: () => void;
  onUpdated: () => Promise<void>;
  onOpenEntry?: (id: string) => void;
};

const REQUIRED_FIELDS: PayableField[] = ["contact_id", "project_id", "cost_center_id", "category_id", "amount", "due_date", "issue_date", "document_number", "description"];
const DOCUMENT_TYPES: Record<string, string> = { invoice: "Nota fiscal", boleto: "Boleto", receipt: "Comprovante de pagamento", contract: "Contrato", other: "Documento financeiro" };

function initialValues(item: OperationItem): PayableValues {
  const merged = { ...asRecord(item.extracted), ...asRecord(item.payload), ...asRecord(asRecord(item.payload).resolved_values) };
  return Object.fromEntries(PAYABLE_FIELDS.map((key) => [key, stringValue(merged[key])])) as PayableValues;
}

function getOptions(field: PayableField, data: ErpData) {
  if (field === "contact_id") return data.contacts.filter((row) => row.active && ["fornecedor", "ambos", "colaborador"].includes(row.contact_type));
  if (field === "project_id") return data.projects.filter((row) => row.active);
  if (field === "cost_center_id") return data.costCenters.filter((row) => row.active);
  if (field === "category_id") return data.categories.filter((row) => row.active && row.movement_type !== "entrada");
  if (field === "bank_account_id") return data.bankAccounts.filter((row) => row.active);
  return null;
}

function fieldDisplay(field: PayableField, value: string, data: ErpData): string {
  if (!value) return "Não informado";
  const options = getOptions(field, data);
  if (options) return options.find((option) => option.id === value)?.name || "Cadastro indisponível";
  if (field === "amount") return Number.isFinite(Number(value)) ? formatMoney(Number(value)) : "Valor inválido";
  if (field.endsWith("date")) return formatDate(value);
  return value;
}

function PayableFieldInput({ field, value, data, onChange, disabled }: { field: PayableField; value: string; data: ErpData; onChange: (value: string) => void; disabled: boolean }) {
  const options = getOptions(field, data);
  return <label className={field === "description" ? styles.wideField : styles.field}>
    <span>{FIELD_LABELS[field]}{REQUIRED_FIELDS.includes(field) ? " *" : ""}</span>
    {options ? <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
      <option value="">Selecione</option>
      {value && !options.some((option) => option.id === value) ? <option value={value}>Cadastro indisponível — selecione outro</option> : null}
      {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
    </select> : field === "description" ? <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={3} maxLength={1000} disabled={disabled} /> : <input
      value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}
      type={field === "amount" ? "number" : field.endsWith("date") ? "date" : "text"}
      inputMode={field === "amount" ? "decimal" : undefined} min={field === "amount" ? "0.01" : undefined}
      step={field === "amount" ? "0.01" : undefined} maxLength={field === "document_number" ? 200 : undefined}
    />}
    {options?.length === 0 ? <small>Não há cadastros ativos. Inclua este item nos cadastros da plataforma.</small> : null}
  </label>;
}

function ExistingPayableLinks({ item, data, canManage, onUpdated, onOpenEntry }: Omit<ReviewProps, "onClose">) {
  const ids = Array.isArray(item.outcome?.duplicate_entry_ids) ? item.outcome.duplicate_entry_ids.filter((id): id is string => typeof id === "string") : [];
  const idKey = ids.join(",");
  const [candidates, setCandidates] = useState<Pick<FinancialEntry, "id" | "description" | "amount" | "due_date" | "document_number" | "contact_id">[]>([]);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    async function loadCandidates() {
      if (!idKey) { if (active) { setCandidates([]); setLoading(false); } return; }
      try {
        const result = await operationClient().from("financial_entries").select("id,description,amount,due_date,document_number,contact_id").eq("organization_id", item.organization_id).in("id", idKey.split(","));
        if (result.error) throw result.error;
        if (active) setCandidates(result.data || []);
      } catch (cause) { if (active) setError(operationError(cause)); }
      finally { if (active) setLoading(false); }
    }
    void loadCandidates();
    return () => { active = false; };
  }, [idKey, item.organization_id]);
  async function link(entryId: string) {
    setLinking(entryId); setError(null);
    try {
      const result = await operationClient().rpc("arisa_link_existing_payable", { p_item_id: item.id, p_entry_id: entryId });
      if (result.error) throw result.error;
      if (result.data?.entry_id !== entryId || result.data?.status !== "completed") throw new Error("O vínculo não foi confirmado. Confira os dados do documento e do lançamento.");
      await onUpdated();
    } catch (cause) { setError(operationError(cause)); }
    finally { setLinking(null); }
  }
  if (!ids.length || item.entry_id) return null;
  return <section className={styles.duplicatePanel} aria-label="Possíveis obrigações já cadastradas"><h4>Confira antes de criar outra obrigação</h4><p>Estas contas têm dados semelhantes. O vínculo exige fornecedor, valor e número do documento correspondentes.</p>
    {loading ? <p role="status">Consultando lançamentos…</p> : candidates.map((entry) => <article key={entry.id} className={styles.duplicateEntry}><div><strong>{entry.description}</strong><p>{data.contacts.find((contact) => contact.id === entry.contact_id)?.name || "Fornecedor cadastrado"} · {formatMoney(Number(entry.amount))} · Vencimento {formatDate(entry.due_date)}</p><small>Documento {entry.document_number || "não informado"}</small></div><div className={styles.inlineActions}>{onOpenEntry ? <button className={styles.textButton} type="button" onClick={() => onOpenEntry(entry.id)}>Abrir lançamento</button> : null}{canManage ? <button type="button" className={styles.secondaryButton} disabled={!!linking} onClick={() => void link(entry.id)}>{linking === entry.id ? "Vinculando…" : "Vincular documento"}</button> : null}</div></article>)}
    {!loading && !candidates.length && !error ? <p>Os lançamentos correspondentes não estão disponíveis para consulta neste perfil.</p> : null}
    {error ? <div className={styles.errorNotice} role="alert">{error}</div> : null}
  </section>;
}

function PayableReview({ item, data, canManage, onUpdated, onOpenEntry }: Omit<ReviewProps, "onClose">) {
  const [values, setValues] = useState<PayableValues>(() => initialValues(item));
  const [attentionFields] = useState<PayableField[]>(() => {
    const initial = initialValues(item);
    const missing = REQUIRED_FIELDS.filter((field) => !initial[field]?.trim() || (field === "amount" && !(Number(initial.amount) > 0)) || (getOptions(field, data) && !getOptions(field, data)?.some((row) => row.id === initial[field])));
    const dates: PayableField[] = initial.due_date && initial.issue_date && initial.due_date < initial.issue_date ? ["due_date", "issue_date"] : [];
    const supplier: PayableField[] = item.issues?.some((issue) => /CPF.CNPJ.*diverge|emitente.*própria/i.test(issue)) ? ["contact_id", "supplier_document"] : [];
    return [...new Set([...missing, ...dates, ...supplier])];
  });
  const [editAll, setEditAll] = useState(false);
  const [busy, setBusy] = useState<"save" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const extracted = asRecord(item.extracted);
  const isReceipt = extracted.document_type === "receipt";
  const createsPayable = ["invoice", "boleto"].includes(stringValue(extracted.document_type));
  const editable = canManage && ["needs_information", "needs_decision"].includes(item.status);
  const missing = REQUIRED_FIELDS.filter((field) => !values[field]?.trim() || (field === "amount" && !(Number(values.amount) > 0)) || (getOptions(field, data) && !getOptions(field, data)?.some((row) => row.id === values[field])));
  const dateConflict = !!values.due_date && !!values.issue_date && values.due_date < values.issue_date;
  const fieldsToEdit = editAll ? PAYABLE_FIELDS : attentionFields;
  const evidence = asRecord(extracted.source_evidence);
  const warnings = Array.isArray(extracted.warnings) ? extracted.warnings.filter((warning): warning is string => typeof warning === "string") : [];

  async function save(create: boolean) {
    if (create && (missing.length || !createsPayable || dateConflict)) {
      setError(!createsPayable ? "Somente nota fiscal ou boleto pode originar uma nova obrigação." : "Complete e confira as informações obrigatórias antes de cadastrar a obrigação.");
      return;
    }
    setBusy(create ? "create" : "save"); setError(null); setNotice(null);
    try {
      const payload = Object.fromEntries(PAYABLE_FIELDS.map((field) => [field, field === "amount" ? values[field] ? Number(values[field]) : null : values[field] || null]));
      const result = await operationClient().rpc("arisa_resolve_payable", { p_item_id: item.id, p_values: payload, p_create: create });
      if (result.error) throw result.error;
      if (result.data?.error) throw new Error(result.data.error);
      const updated = asRecord(result.data);
      if (updated.id !== item.id) throw new Error("A operação não retornou confirmação. Atualize a fila antes de tentar novamente.");
      if (create && !(updated.status === "completed" && updated.entry_id)) {
        const pending = Array.isArray(updated.issues) ? updated.issues.filter((issue): issue is string => typeof issue === "string").join(" ") : "";
        setError(pending || "A obrigação não foi cadastrada. Confira as pendências e possíveis duplicidades.");
      } else setNotice(create ? "Obrigação cadastrada. A aprovação financeira continua na fila de aprovações." : "Informações salvas.");
      await onUpdated();
    } catch (cause) { setError(operationError(cause)); }
    finally { setBusy(null); }
  }

  return <div className={styles.reviewBody}>
    {isReceipt ? <div className={styles.infoNotice}>Este documento é um comprovante de pagamento. Ele deve ser conferido com uma obrigação existente e com o extrato bancário; não gera uma nova conta a pagar.</div> : null}
    {!isReceipt && !createsPayable ? <div className={styles.infoNotice}>Este documento não é uma nota fiscal ou um boleto. Para criar uma obrigação, envie o documento de cobrança correspondente.</div> : null}
    <div className={styles.factGrid}>
      {PAYABLE_FIELDS.filter((field) => field !== "bank_account_id" || values[field]).map((field) => <div key={field}>
        <span>{FIELD_LABELS[field]}</span><strong className={!values[field] ? styles.missingValue : undefined}>{fieldDisplay(field, values[field], data)}</strong>
      </div>)}
    </div>
    {Object.entries(evidence).some(([, value]) => stringValue(value)) ? <details className={styles.evidence}>
      <summary>Evidências extraídas do documento</summary>
      <dl>{Object.entries(evidence).filter(([, value]) => stringValue(value)).map(([key, value]) => <div key={key}><dt>{FIELD_LABELS[key as PayableField] || (key === "supplier_document" ? "Documento do fornecedor" : key)}</dt><dd>{stringValue(value)}</dd></div>)}</dl>
      <p>Confira os trechos com o documento original antes de corrigir dados.</p>
    </details> : null}
    {warnings.filter((warning) => warning !== "RECEIPT_DOES_NOT_CREATE_PAYABLE").length > 0 ? <div className={styles.infoNotice}><strong>Pontos para conferência</strong><ul>{warnings.filter((warning) => warning !== "RECEIPT_DOES_NOT_CREATE_PAYABLE").map((warning, index) => <li key={`${index}-${warning}`}>{operationIssue(warning)}</li>)}</ul></div> : null}
    <ExistingPayableLinks item={item} data={data} canManage={editable} onUpdated={onUpdated} onOpenEntry={onOpenEntry} />
    {editable ? <form onSubmit={(event) => { event.preventDefault(); void save(false); }}>
      <div className={styles.sectionHeading}><div><h4>{attentionFields.length ? "Complete e confira as pendências" : "Informações para revisão"}</h4><p>{attentionFields.length ? "Os demais dados já foram aproveitados do documento e do contexto informado." : "Confira os valores, a classificação e os pontos de atenção antes de cadastrar."}</p></div><button className={styles.textButton} type="button" onClick={() => setEditAll((value) => !value)} disabled={!!busy}>{editAll ? "Mostrar apenas pendências" : "Corrigir dados"}</button></div>
      {fieldsToEdit.length ? <div className={styles.formGrid}>{fieldsToEdit.map((field) => <PayableFieldInput key={field} field={field} value={values[field]} data={data} disabled={!!busy} onChange={(value) => setValues((previous) => ({ ...previous, [field]: value }))} />)}</div> : null}
      <div className={styles.actionBar}>
        <button className={styles.secondaryButton} type="submit" disabled={!!busy}>{busy === "save" ? "Salvando…" : "Salvar informações"}</button>
        {createsPayable ? <button className={styles.primaryButton} type="button" disabled={!!busy || missing.length > 0 || dateConflict} onClick={() => void save(true)}>{busy === "create" ? "Cadastrando…" : "Cadastrar obrigação"}</button> : null}
      </div>
      {createsPayable ? <p className={styles.footnote}>O cadastro fica pendente de aprovação. Esta ação não executa pagamento.</p> : null}
    </form> : null}
    {item.entry_id ? <div className={styles.successNotice}><div><strong>Obrigação vinculada ao financeiro</strong><p>O andamento da aprovação e do pagamento está no lançamento.</p></div>{onOpenEntry ? <button type="button" className={styles.secondaryButton} onClick={() => onOpenEntry(item.entry_id!)}>Abrir lançamento</button> : null}</div> : null}
    {error ? <div className={styles.errorNotice} role="alert">{error}</div> : null}
    {notice ? <div className={styles.successNotice} role="status">{notice}</div> : null}
  </div>;
}

function StatementReview({ item, data, canManage, onUpdated, onOpenEntry }: Omit<ReviewProps, "onClose">) {
  const [rows, setRows] = useState<BankTransaction[]>([]);
  const [page, setPage] = useState(0);
  const [counts, setCounts] = useState({ total: 0, matched: 0, unmatched: 0, ambiguous: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState(stringValue(item.payload?.bank_account_id));
  const requestId = useRef(0);
  const loadRows = useCallback(async () => {
    const request = ++requestId.current;
    try {
      const client = operationClient();
      const base = () => client.from("arisa_bank_transactions").select("*", { count: "exact", head: true }).eq("organization_id", item.organization_id).eq("item_id", item.id);
      const results = await Promise.all([
        client.from("arisa_bank_transactions").select("id,organization_id,item_id,bank_account_id,line_number,external_id,transaction_date,amount,description,document_number,status,matched_entry_id,candidate_count,match_reason", { count: "exact" }).eq("organization_id", item.organization_id).eq("item_id", item.id).order("line_number").range(page * 25, page * 25 + 24),
        base().eq("status", "matched"), base().eq("status", "unmatched"), base().eq("status", "ambiguous"),
      ]);
      const failure = results.find((result) => result.error)?.error;
      if (failure) throw failure;
      if (request !== requestId.current) return;
      setError(null);
      setRows((results[0].data || []) as BankTransaction[]);
      setCounts({ total: results[0].count || 0, matched: results[1].count || 0, unmatched: results[2].count || 0, ambiguous: results[3].count || 0 });
    } catch (cause) { if (request === requestId.current) setError(operationError(cause)); }
    finally { if (request === requestId.current) setLoading(false); }
  }, [item.id, item.organization_id, page]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void loadRows(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadRows]);
  async function reconcile() {
    setBusy(true); setError(null);
    try {
      const result = await operationClient().rpc("arisa_reconcile_statement", { p_item_id: item.id });
      if (result.error) throw result.error;
      if (result.data?.error) throw new Error(result.data.error);
      await Promise.all([loadRows(), onUpdated()]);
    } catch (cause) { setError(operationError(cause)); }
    finally { setBusy(false); }
  }
  async function saveAccount(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      if (!selectedAccount) throw new Error("Selecione a conta bancária do extrato.");
      const result = await operationClient().rpc("arisa_set_statement_account", { p_item_id: item.id, p_bank_account_id: selectedAccount });
      if (result.error) throw result.error;
      if (result.data?.id !== item.id) throw new Error("A atualização da conta não foi confirmada. Atualize a fila e confira o extrato.");
      await Promise.all([loadRows(), onUpdated()]);
    } catch (cause) { setError(operationError(cause)); }
    finally { setBusy(false); }
  }
  const accountId = stringValue(item.payload?.bank_account_id);
  const account = data.bankAccounts.find((row) => row.id === accountId);
  return <div className={styles.reviewBody}>
    <div className={styles.sectionHeading}><div><h4>{account?.name || "Movimentações do extrato"}</h4><p>A conciliação procura correspondências com os lançamentos existentes. Não altera pagamentos ou saldos.</p></div>{canManage && counts.total > 0 ? <button className={styles.secondaryButton} type="button" disabled={busy || loading || item.status === "processing"} onClick={() => void reconcile()}>{busy ? "Conferindo…" : "Conferir correspondências"}</button> : null}</div>
    {canManage && !data.bankAccounts.some((row) => row.active) ? <div className={styles.infoNotice}>Cadastre uma conta bancária em Cadastros gerais antes de importar ou conferir o extrato.</div> : null}
    {canManage && !loading && counts.total === 0 && ["needs_information", "needs_decision"].includes(item.status) ? <form className={styles.policyFields} onSubmit={(event) => void saveAccount(event)}><label className={styles.field}><span>Conta do extrato</span><select value={selectedAccount} onChange={(event) => setSelectedAccount(event.target.value)} disabled={busy} required><option value="">Selecione a conta</option>{data.bankAccounts.filter((row) => row.active).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><button type="submit" className={styles.secondaryButton} disabled={busy || !selectedAccount}>{busy ? "Conferindo…" : "Salvar conta e conferir"}</button></form> : null}
    {!loading && !error ? <div className={styles.bankCounts}><span><strong>{counts.total}</strong> movimentações</span><span><strong>{counts.matched}</strong> correspondências</span><span><strong>{counts.unmatched}</strong> sem correspondência</span><span><strong>{counts.ambiguous}</strong> ambíguas</span></div> : null}
    {error ? <div className={styles.errorNotice} role="alert">{error}<button className={styles.textButton} type="button" onClick={() => void loadRows()}>Tentar novamente</button></div> : null}
    {loading ? <p className={styles.emptyState} role="status">Carregando movimentações…</p> : rows.length ? <div className={styles.tableScroll}><table className={styles.bankTable}>
      <thead><tr><th>Data</th><th>Movimentação</th><th>Valor</th><th>Conferência</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id}><td>{formatDate(row.transaction_date)}</td><td><strong>{row.description || "Sem descrição"}</strong>{row.document_number ? <small>Documento {row.document_number}</small> : null}</td><td className={Number(row.amount) < 0 ? styles.debit : styles.credit}>{formatMoney(Number(row.amount))}</td><td><span className={styles.statusBadge} data-status={row.status === "matched" ? "completed" : row.status === "ambiguous" ? "needs_decision" : "needs_information"}>{row.status === "matched" ? "Correspondência identificada" : row.status === "ambiguous" ? `${row.candidate_count} candidatos — conferir` : "Sem correspondência"}</span>{row.match_reason ? <small>{row.match_reason}</small> : null}{row.matched_entry_id && onOpenEntry ? <button type="button" className={styles.textButton} onClick={() => onOpenEntry(row.matched_entry_id!)}>Abrir lançamento</button> : null}</td></tr>)}</tbody>
    </table></div> : !error ? <p className={styles.emptyState}>As movimentações aparecerão após o processamento do extrato.</p> : null}
    {counts.total > 25 ? <div className={styles.pagination}><button type="button" className={styles.secondaryButton} disabled={page === 0 || loading} onClick={() => { setLoading(true); setPage((value) => value - 1); }}>Anterior</button><span>Página {page + 1} de {Math.ceil(counts.total / 25)}</span><button type="button" className={styles.secondaryButton} disabled={(page + 1) * 25 >= counts.total || loading} onClick={() => { setLoading(true); setPage((value) => value + 1); }}>Próxima</button></div> : null}
  </div>;
}

export function OperationReview(props: ReviewProps) {
  const { item, onClose } = props;
  const [originalBusy, setOriginalBusy] = useState(false);
  const [originalError, setOriginalError] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [dismissReason, setDismissReason] = useState("");
  const [dismissBusy, setDismissBusy] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  async function dismiss(event: React.FormEvent) {
    event.preventDefault(); setDismissBusy(true); setDismissError(null);
    try {
      const result = await operationClient().rpc("arisa_dismiss_operation", { p_item_id: item.id, p_reason: dismissReason.trim() });
      if (result.error) throw result.error;
      if (result.data?.status !== "dismissed") throw new Error("O descarte não foi confirmado. Atualize a fila para conferir.");
      await props.onUpdated();
    } catch (cause) { setDismissError(operationError(cause)); }
    finally { setDismissBusy(false); }
  }
  async function openOriginal() {
    const target = window.open("about:blank", "_blank");
    if (target) target.opener = null;
    setOriginalBusy(true); setOriginalError(null); setFallbackUrl(null);
    try {
      const url = await getOriginalUrl(item);
      if (target) target.location.replace(url); else setFallbackUrl(url);
    } catch (cause) { target?.close(); setOriginalError(operationError(cause)); }
    finally { setOriginalBusy(false); }
  }
  return <section className={styles.reviewPanel} aria-label={`Revisão de ${item.file_name}`}>
    <header className={styles.reviewHeader}><div><span className={styles.eyebrow}>{item.input_kind === "bank_statement" ? "EXTRATO BANCÁRIO" : DOCUMENT_TYPES[stringValue(item.extracted?.document_type)] || "DOCUMENTO FINANCEIRO"}</span><h3>{item.file_name}</h3><p>Recebido em {formatDate(item.created_at, true)} · <span className={styles.statusBadge} data-status={item.status}>{OPERATION_LABELS[item.status]}</span></p></div><div className={styles.inlineActions}><button className={styles.secondaryButton} type="button" disabled={originalBusy} onClick={() => void openOriginal()}>{originalBusy ? "Abrindo…" : "Abrir original ↗"}</button><button className={styles.iconButton} type="button" aria-label="Fechar revisão" onClick={onClose}>×</button></div></header>
    {originalError ? <div className={styles.errorNotice} role="alert">{originalError}</div> : null}
    {fallbackUrl ? <a className={styles.textButton} href={fallbackUrl} target="_blank" rel="noopener noreferrer">Abrir documento original ↗</a> : null}
    {item.error_message ? <div className={styles.errorNotice}><strong>Processamento interrompido</strong><p>{item.error_message}</p></div> : null}
    {item.issues?.length ? <div className={styles.issueList}><strong>O que precisa de atenção</strong><ul>{item.issues.map((issue, index) => <li key={`${index}-${issue}`}>{operationIssue(issue)}</li>)}</ul></div> : null}
    {item.input_kind === "bank_statement" ? <StatementReview {...props} /> : <PayableReview {...props} />}
    {props.canManage && !["processing", "completed", "dismissed"].includes(item.status) && !item.entry_id ? <details className={styles.dismissPanel}><summary>Este documento não precisa ser tratado?</summary><form onSubmit={(event) => void dismiss(event)}><label className={styles.wideField}><span>Motivo do descarte</span><textarea required minLength={5} maxLength={1000} rows={2} value={dismissReason} onChange={(event) => setDismissReason(event.target.value)} disabled={dismissBusy} /></label><p className={styles.footnote}>O documento e o motivo permanecem no histórico. Esta ação retira o item das filas de pendências.</p><div className={styles.actionBar}><button type="submit" className={styles.secondaryButton} disabled={dismissBusy || dismissReason.trim().length < 5}>{dismissBusy ? "Registrando…" : "Descartar com justificativa"}</button></div>{dismissError ? <div className={styles.errorNotice} role="alert">{dismissError}</div> : null}</form></details> : null}
    {item.status === "dismissed" && item.outcome?.dismiss_reason ? <div className={styles.infoNotice}><strong>Motivo do descarte</strong><p>{stringValue(item.outcome.dismiss_reason)}</p></div> : null}
  </section>;
}
