"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ErpData } from "../types";
import { ArisaCrmOperations } from "./crm-operations";
import { intakeOperation, ITEM_COLUMNS, operationClient, operationError, processOperation } from "./client";
import { OperationReview } from "./operation-review";
import { asRecord, formatDate, formatMoney, OPERATION_LABELS, operationIssue, stringValue, type InputKind, type JsonRecord, type OperationFilter, type OperationItem, type OperationPolicy } from "./types";
import styles from "./operations-center.module.css";

type Props = {
  data: ErpData;
  can: (key: string) => boolean;
  onRefresh: () => Promise<void>;
  onOpenLead?: (id: string) => void;
  onOpenEntry?: (id: string) => void;
};

type Counts = Record<Exclude<OperationFilter, "all">, number>;
const DEFAULT_COUNTS: Counts = { completed: 0, needs_decision: 0, needs_information: 0, failed: 0, processing: 0 };
const QUEUES = [
  { key: "completed", title: "Trabalho concluído", hint: "Processos finalizados e registrados", symbol: "✓" },
  { key: "needs_decision", title: "Decisões", hint: "Itens que precisam da sua análise", symbol: "◇" },
  { key: "needs_information", title: "Informações faltantes", hint: "Complete apenas o necessário", symbol: "+" },
  { key: "failed", title: "Falhas", hint: "Operações que precisam ser retomadas", symbol: "!" },
] as const;
const FILTER_TITLES: Record<OperationFilter, string> = { all: "Todas as operações", completed: "Trabalho concluído", needs_decision: "Decisões pendentes", needs_information: "Informações faltantes", failed: "Falhas para tratar", processing: "Recebidos e em processamento" };

function ContextSelect({ label, value, rows, onChange, required = false, disabled = false }: { label: string; value: string; rows: { id: string; name: string; active: boolean }[]; onChange: (value: string) => void; required?: boolean; disabled?: boolean }) {
  const activeRows = rows.filter((row) => row.active);
  return <label className={styles.field}><span>{label}{required ? " *" : ""}</span><select value={value} onChange={(event) => onChange(event.target.value)} required={required} disabled={disabled || activeRows.length === 0}><option value="">{required ? "Selecione a conta" : "Identificar na revisão"}</option>{activeRows.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select>{required && !activeRows.length ? <small>Cadastre uma conta bancária em Cadastros gerais antes de importar o extrato.</small> : null}</label>;
}

function DocumentIntake({ data, onUpdated }: { data: ErpData; onUpdated: () => Promise<void> }) {
  const [kind, setKind] = useState<InputKind>("payable");
  const [context, setContext] = useState<Record<string, string>>({ bank_account_id: "", project_id: "", cost_center_id: "", category_id: "", contact_id: "" });
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [results, setResults] = useState<{ file: string; message: string; error: boolean }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  function selectFiles(list: FileList | null) {
    setError(null); setResults([]);
    if (!list) return;
    if (list.length > 10) { setFiles([]); if (fileInput.current) fileInput.current.value = ""; setError("Selecione até 10 arquivos por envio."); return; }
    setFiles(Array.from(list));
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!files.length) { setError("Selecione ao menos um documento."); return; }
    if (kind === "bank_statement" && !context.bank_account_id) { setError("Informe a conta bancária a que o extrato pertence."); return; }
    setBusy(true); setError(null); setResults([]);
    const payload = Object.fromEntries(Object.entries(context).filter(([key, value]) => value && (kind === "bank_statement" ? key === "bank_account_id" : key !== "bank_account_id"))) as JsonRecord;
    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        setProgress(`${index + 1} de ${files.length} · ${file.name}`);
        let registered = false;
        try {
          const { item, duplicate } = await intakeOperation(file, kind, data.organization.id, data.session.user.id, payload);
          registered = true;
          if (duplicate) {
            setResults((previous) => [...previous, { file: file.name, message: `Documento já recebido. Registro preservado: ${OPERATION_LABELS[item.status].toLowerCase()}.`, error: false }]);
            continue;
          }
          const result = await processOperation(data.organization.id, item.id);
          const processed = result?.item as OperationItem | undefined;
          setResults((previous) => [...previous, { file: file.name, message: processed?.status ? `Documento recebido. ${OPERATION_LABELS[processed.status]}. Consulte os detalhes na fila abaixo.` : "Documento recebido. Consulte o resultado na fila abaixo.", error: processed?.status === "failed" }]);
        } catch (cause) {
          setResults((previous) => [...previous, { file: file.name, message: `${registered ? "Documento recebido; processamento pendente. " : ""}${operationError(cause)}`, error: true }]);
        }
      }
      setFiles([]);
      if (fileInput.current) fileInput.current.value = "";
    } finally {
      try { await onUpdated(); } catch (cause) { setError(`Os envios foram tratados, mas a atualização da tela falhou: ${operationError(cause)}`); }
      setBusy(false); setProgress("");
    }
  }
  function setHint(key: string, value: string) { setContext((previous) => ({ ...previous, [key]: value })); }
  return <section className={styles.intakePanel} aria-label="Entrada de documentos">
    <div className={styles.sectionHeading}><div><span className={styles.eyebrow}>DELEGUE À ARISA</span><h3>Envie os documentos. A Arisa organiza.</h3><p>Extração de dados, conferência de duplicidades e preparação do financeiro em uma única entrada.</p></div><span className={styles.intakeIcon} aria-hidden="true">↥</span></div>
    <form onSubmit={(event) => void submit(event)}>
      <div className={styles.segmented} aria-label="Tipo de documento"><button className={kind === "payable" ? styles.segmentActive : undefined} type="button" aria-pressed={kind === "payable"} disabled={busy} onClick={() => { setKind("payable"); setFiles([]); setResults([]); if (fileInput.current) fileInput.current.value = ""; }}>Notas, boletos e contratos</button><button className={kind === "bank_statement" ? styles.segmentActive : undefined} type="button" aria-pressed={kind === "bank_statement"} disabled={busy} onClick={() => { setKind("bank_statement"); setFiles([]); setResults([]); if (fileInput.current) fileInput.current.value = ""; }}>Extratos bancários</button></div>
      <div className={styles.intakeGrid}>
        <label className={styles.fileDrop}><span className={styles.uploadGlyph} aria-hidden="true">↑</span><strong>{files.length ? `${files.length} arquivo${files.length > 1 ? "s selecionados" : " selecionado"}` : "Selecionar documentos"}</strong><span>{kind === "payable" ? "PDF, JPG, PNG, WebP ou XML" : "CSV ou OFX"} · até 8 MB por arquivo</span><input ref={fileInput} type="file" multiple accept={kind === "payable" ? ".pdf,.jpg,.jpeg,.png,.webp,.xml" : ".csv,.ofx"} disabled={busy} onChange={(event) => selectFiles(event.target.files)} /><small>Até 10 arquivos por envio</small></label>
        <div className={styles.intakeContext}>
          {kind === "bank_statement" ? <><ContextSelect label="Conta do extrato" value={context.bank_account_id} rows={data.bankAccounts} onChange={(value) => setHint("bank_account_id", value)} required disabled={busy} /><p className={styles.footnote}>Use o arquivo exportado pelo banco, com até 500 movimentações. No CSV, informe data, descrição e valor com sinal ou indicação de débito/crédito.</p></> : <><ContextSelect label="Empreendimento, se já souber" value={context.project_id} rows={data.projects} onChange={(value) => setHint("project_id", value)} disabled={busy} /><details className={styles.contextDetails}><summary>Informar fornecedor e classificação</summary><div className={styles.formGrid}><ContextSelect label="Fornecedor" value={context.contact_id} rows={data.contacts.filter((row) => ["fornecedor", "ambos", "colaborador"].includes(row.contact_type))} onChange={(value) => setHint("contact_id", value)} disabled={busy} /><ContextSelect label="Centro de custo" value={context.cost_center_id} rows={data.costCenters} onChange={(value) => setHint("cost_center_id", value)} disabled={busy} /><ContextSelect label="Categoria" value={context.category_id} rows={data.categories.filter((row) => row.movement_type !== "entrada")} onChange={(value) => setHint("category_id", value)} disabled={busy} /></div></details><p className={styles.footnote}>Informe o que já conhece. A revisão pedirá apenas os dados que faltarem.</p></>}
        </div>
      </div>
      {files.length ? <ul className={styles.selectedFiles}>{files.map((file, index) => <li key={`${file.name}-${index}`}><span>{file.name}</span><small>{(file.size / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} MB</small></li>)}</ul> : null}
      <div className={styles.actionBar}><span className={styles.footnote}>{busy ? progress : "Os originais ficam vinculados ao histórico da operação."}</span><button className={styles.primaryButton} type="submit" disabled={busy || !files.length || (kind === "bank_statement" && !data.bankAccounts.some((row) => row.active))}>{busy ? "Arisa está processando…" : "Enviar e processar"}</button></div>
      {error ? <div className={styles.errorNotice} role="alert">{error}</div> : null}
      {results.length ? <ul className={styles.uploadResults} aria-live="polite">{results.map((result, index) => <li key={`${index}-${result.file}`} data-error={result.error}><strong>{result.file}</strong><span>{result.message}</span></li>)}</ul> : null}
    </form>
  </section>;
}

function OperationPolicyPanel({ policy, canEdit, onUpdated }: { policy: OperationPolicy; canEdit: boolean; onUpdated: () => Promise<void> }) {
  const [enabled, setEnabled] = useState(policy.auto_register_complete_documents);
  const [limit, setLimit] = useState(String(policy.max_auto_amount));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setError(null); setNotice(null);
    const amount = Number(limit);
    if (!Number.isFinite(amount) || amount <= 0) { setError("Informe um limite válido maior que zero."); return; }
    setBusy(true);
    try {
      const result = await operationClient().rpc("arisa_set_operation_policy", { p_organization_id: policy.organization_id, p_enabled: enabled, p_max_amount: amount });
      if (result.error) throw result.error;
      if (result.data?.error) throw new Error(result.data.error);
      setNotice("Regra de autonomia salva."); await onUpdated();
    } catch (cause) { setError(operationError(cause)); }
    finally { setBusy(false); }
  }
  return <details className={styles.policyPanel}><summary><div><span className={styles.eyebrow}>AUTONOMIA FINANCEIRA</span><strong>{policy.auto_register_complete_documents ? `Cadastro automático até ${formatMoney(Number(policy.max_auto_amount))}` : "Cadastro após sua revisão"}</strong></div><span>Configurar</span></summary><form onSubmit={(event) => void save(event)}>
    <p>Documentos completos e sem divergências podem ser cadastrados automaticamente dentro do limite definido. O pagamento continua sujeito à aprovação financeira.</p>
    <label className={styles.checkbox}><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={!canEdit || busy} /><span>Permitir cadastro automático de documentos completos</span></label>
    <div className={styles.policyFields}><label className={styles.field}><span>Limite por documento (R$)</span><input type="number" inputMode="decimal" min="0.01" step="0.01" required value={limit} disabled={!canEdit || busy} onChange={(event) => setLimit(event.target.value)} /></label>{canEdit ? <button className={styles.secondaryButton} type="submit" disabled={busy}>{busy ? "Salvando…" : "Salvar regra"}</button> : <p className={styles.footnote}>A alteração desta regra exige alçada de aprovação financeira ou administração.</p>}</div>
    {error ? <div className={styles.errorNotice} role="alert">{error}</div> : null}{notice ? <div className={styles.successNotice} role="status">{notice}</div> : null}
  </form></details>;
}

function FinancialOperations({ data, can, onRefresh, onOpenEntry }: Props) {
  const [items, setItems] = useState<OperationItem[]>([]);
  const [counts, setCounts] = useState<Counts>(DEFAULT_COUNTS);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<OperationFilter>("all");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<OperationItem | null>(null);
  const [policy, setPolicy] = useState<OperationPolicy | null>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);
  const canManage = can("financial.manage") && can("documents.manage");
  const canEditPolicy = can("financial.approve") || can("settings.manage");
  const organizationId = data.organization.id;

  const load = useCallback(async () => {
    const request = ++requestId.current;
    try {
      const client = operationClient();
      let rowsQuery = client.from("arisa_operation_items").select(ITEM_COLUMNS, { count: "exact" }).eq("organization_id", organizationId);
      if (filter === "processing") rowsQuery = rowsQuery.in("status", ["received", "processing"]);
      else if (filter !== "all") rowsQuery = rowsQuery.eq("status", filter);
      const countQuery = (key: Exclude<OperationFilter, "all">) => {
        const query = client.from("arisa_operation_items").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);
        return key === "processing" ? query.in("status", ["received", "processing"]) : query.eq("status", key);
      };
      const keys = Object.keys(DEFAULT_COUNTS) as (keyof Counts)[];
      const results = await Promise.all([
        rowsQuery.order("created_at", { ascending: false }).range(page * 20, page * 20 + 19),
        client.from("arisa_operation_policies").select("organization_id,auto_register_complete_documents,max_auto_amount").eq("organization_id", organizationId).maybeSingle(),
        ...keys.map(countQuery),
      ]);
      const failure = results.find((result) => result.error)?.error;
      if (failure) throw failure;
      if (request !== requestId.current) return;
      setError(null);
      setItems((results[0].data || []) as unknown as OperationItem[]);
      setTotal(results[0].count || 0);
      setPolicy((results[1].data as unknown as OperationPolicy | null) || { organization_id: organizationId, auto_register_complete_documents: false, max_auto_amount: 5000 });
      setCounts(Object.fromEntries(keys.map((key, index) => [key, results[index + 2].count || 0])) as Counts);
      setLoaded(true);
    } catch (cause) { if (request === requestId.current) setError(operationError(cause)); }
    finally { if (request === requestId.current) setLoading(false); }
  }, [organizationId, filter, page]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  async function refresh() {
    setLoading(true);
    const actions: Promise<unknown>[] = [load(), onRefresh()];
    if (selected) actions.push((async () => {
      const result = await operationClient().from("arisa_operation_items").select(ITEM_COLUMNS).eq("organization_id", organizationId).eq("id", selected.id).maybeSingle();
      if (result.error) throw result.error;
      setSelected(result.data as OperationItem | null);
    })());
    const results = await Promise.allSettled(actions);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }
  async function process(item: OperationItem) {
    setProcessingId(item.id); setActionError(null);
    try { await processOperation(organizationId, item.id); }
    catch (cause) { setActionError(operationError(cause)); }
    finally {
      try { await refresh(); } catch (cause) { setActionError(operationError(cause)); }
      setProcessingId(null);
    }
  }
  function applyFilter(next: OperationFilter) { if (next === filter && page === 0) return; setLoading(true); setFilter(next); setPage(0); }
  function openReview(item: OperationItem) { setSelected(item); requestAnimationFrame(() => reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })); }
  return <div className={styles.financeContent}>
    <div className={styles.sectionHeading}><div><h3>Documentos financeiros</h3><p>Acompanhe o trabalho executado e intervenha nas exceções.</p></div><button type="button" className={styles.secondaryButton} disabled={loading} onClick={() => { setLoading(true); void load(); }}>{loading ? "Atualizando…" : "Atualizar fila"}</button></div>
    <div className={styles.queueGrid}>{QUEUES.map((queue) => <button key={queue.key} type="button" className={styles.queueCard} data-status={queue.key} data-active={filter === queue.key} aria-pressed={filter === queue.key} onClick={() => applyFilter(filter === queue.key ? "all" : queue.key)}><span className={styles.queueIcon} aria-hidden="true">{queue.symbol}</span><strong className={styles.queueNumber}>{loaded ? counts[queue.key].toLocaleString("pt-BR") : "—"}</strong><span className={styles.queueTitle}>{queue.title}</span><small>{queue.hint}</small></button>)}</div>
    <div className={styles.processingStrip}><span><i aria-hidden="true" /><strong>{loaded ? counts.processing : "—"}</strong> recebido{counts.processing !== 1 ? "s" : ""} ou em processamento</span><button type="button" className={styles.textButton} onClick={() => applyFilter(filter === "processing" ? "all" : "processing")}>{filter === "processing" ? "Ver todas as operações" : "Acompanhar →"}</button></div>
    {error ? <div className={styles.errorNotice} role="alert"><strong>Não foi possível atualizar a fila.</strong><p>{error}</p>{loaded ? <small>Os dados exibidos são da última consulta concluída.</small> : null}</div> : null}
    {canManage ? <DocumentIntake data={data} onUpdated={refresh} /> : <div className={styles.infoNotice}>Seu perfil pode acompanhar as operações. O envio e o tratamento de documentos exigem permissão de gestão financeira e documental.</div>}
    {policy ? <OperationPolicyPanel key={`${policy.auto_register_complete_documents}-${policy.max_auto_amount}`} policy={policy} canEdit={canEditPolicy} onUpdated={load} /> : null}
    <div ref={reviewRef} className={styles.reviewAnchor}>{selected ? <OperationReview key={`${selected.id}-${selected.updated_at}`} item={selected} data={data} canManage={canManage} onClose={() => setSelected(null)} onUpdated={refresh} onOpenEntry={onOpenEntry} /> : null}</div>
    <section className={styles.workList} aria-label="Fila financeira"><div className={styles.sectionHeading}><div><h3>{FILTER_TITLES[filter]}</h3><p>{loaded ? `${total.toLocaleString("pt-BR")} registro${total !== 1 ? "s" : ""}` : "Consultando registros…"}</p></div><label className={styles.filterLabel}><span>Exibir</span><select value={filter} onChange={(event) => applyFilter(event.target.value as OperationFilter)}>{Object.entries(FILTER_TITLES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
      {actionError ? <div className={styles.errorNotice} role="alert">{actionError}</div> : null}
      {loading && !loaded ? <div className={styles.emptyState} role="status">Carregando operações…</div> : items.length ? <div className={styles.operationRows}>{items.map((item) => {
        const amount = Number(asRecord(item.payload?.resolved_values).amount ?? item.extracted?.amount);
        const canProcess = canManage && ["received", "failed", "processing"].includes(item.status);
        return <article className={styles.operationRow} key={item.id} data-selected={selected?.id === item.id}><div className={styles.documentGlyph} aria-hidden="true">{item.input_kind === "bank_statement" ? "↔" : "▤"}</div><div className={styles.operationCopy}><button type="button" className={styles.rowTitle} onClick={() => openReview(item)}>{item.file_name}</button><p>{item.input_kind === "bank_statement" ? "Extrato bancário" : "Documento financeiro"} · {formatDate(item.created_at, true)}</p>{item.status === "failed" ? <small className={styles.failureText}>{item.error_message || "Abra o documento para conferir a falha e retomar o processamento."}</small> : item.issues?.length ? <small>{operationIssue(item.issues[0])}{item.issues.length > 1 ? ` · +${item.issues.length - 1} ponto${item.issues.length > 2 ? "s" : ""}` : ""}</small> : item.outcome?.summary ? <small>{stringValue(item.outcome.summary)}</small> : null}</div><div className={styles.rowStatus}><span className={styles.statusBadge} data-status={item.status}>{OPERATION_LABELS[item.status]}</span>{item.input_kind === "payable" && Number.isFinite(amount) && amount > 0 ? <strong>{formatMoney(amount)}</strong> : null}</div><div className={styles.rowActions}>{canProcess ? <button type="button" className={styles.secondaryButton} disabled={!!processingId} onClick={() => void process(item)}>{processingId === item.id ? "Processando…" : item.status === "failed" ? "Tentar novamente" : item.status === "processing" ? "Verificar execução" : "Processar"}</button> : null}<button type="button" className={styles.textButton} onClick={() => openReview(item)}>{item.status === "needs_information" ? "Completar →" : item.status === "needs_decision" ? "Revisar →" : "Ver detalhes →"}</button></div></article>;
      })}</div> : !error ? <div className={styles.emptyState}><span className={styles.emptyGlyph} aria-hidden="true">✓</span><h4>{filter === "all" ? "A fila está pronta para receber trabalho" : "Nenhum item nesta fila"}</h4><p>{filter === "all" ? "Envie os primeiros documentos para iniciar a operação financeira da Arisa." : "Os documentos aparecerão aqui conforme o resultado do processamento."}</p></div> : null}
      {total > 20 ? <div className={styles.pagination}><button className={styles.secondaryButton} type="button" disabled={page === 0 || loading} onClick={() => { setLoading(true); setPage((value) => value - 1); }}>Anterior</button><span>Página {page + 1} de {Math.ceil(total / 20)}</span><button className={styles.secondaryButton} type="button" disabled={(page + 1) * 20 >= total || loading} onClick={() => { setLoading(true); setPage((value) => value + 1); }}>Próxima</button></div> : null}
    </section>
  </div>;
}

export function ArisaOperationsCenter(props: Props) {
  const financialVisible = props.can("financial.view") && props.can("documents.view");
  const crmVisible = props.can("crm.view");
  const [requestedTab, setRequestedTab] = useState<"financial" | "crm">(financialVisible ? "financial" : "crm");
  const tab = requestedTab === "financial" && financialVisible ? "financial" : crmVisible ? "crm" : "financial";
  return <section className={styles.center} aria-label="Arisa Operações">
    <header className={styles.hero}><div><span className={styles.heroEyebrow}><span aria-hidden="true">✦</span> SUA OPERAÇÃO, EM MOVIMENTO</span><h2>Arisa Operações</h2><p>Documentos tratados. CRM acompanhado.<br />Sua atenção nas decisões que precisam de você.</p></div><div className={styles.heroNote}><span className={styles.heroOrbit} aria-hidden="true">✦</span><strong>Do documento à ação.</strong><span>Execução acompanhada,<br />com histórico e evidências.</span></div></header>
    {financialVisible || crmVisible ? <><nav className={styles.tabs} aria-label="Áreas operacionais">{financialVisible ? <button type="button" aria-current={tab === "financial" ? "page" : undefined} className={tab === "financial" ? styles.tabActive : undefined} onClick={() => setRequestedTab("financial")}>Financeiro <span>Documentos e conciliação</span></button> : null}{crmVisible ? <button type="button" aria-current={tab === "crm" ? "page" : undefined} className={tab === "crm" ? styles.tabActive : undefined} onClick={() => setRequestedTab("crm")}>CRM <span>Rotinas e oportunidades</span></button> : null}</nav>{tab === "financial" ? <FinancialOperations {...props} /> : <ArisaCrmOperations data={props.data} can={props.can} onRefresh={props.onRefresh} onOpenLead={props.onOpenLead} />}</> : <div className={styles.infoNotice}>Seu perfil não possui acesso às operações financeiras ou ao CRM.</div>}
  </section>;
}
