"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { client, errorText } from "./chat-client";
import ArisaMailPanel from "./ArisaMailPanel";
import ArisaWhatsAppPanel from "./ArisaWhatsAppPanel";
import { displayDate, downloadText, workspaceCall, type WorkspacePanel } from "./workspace-client";
import { workspaceLabels, workspacePanels } from "./workspace-navigation";
import styles from "./workspace.module.css";

type Archive = { id: string; title: string; content: string; kind: string; channel: string; source: string; author_type: string; subject_label: string; occurred_at: string; owner_user_id: string | null; payload: Record<string, unknown> };
type Memory = { id: string; source_event_id: string; subject_label: string; kind: string; topic: string; claim: string; evidence: string; confidence: number; status: string; observed_at: string; expires_at: string | null; review_note: string | null; reviewed_at: string | null };
type KnowledgeStatus = { archive: number; memories: number; queue: Record<string, number> };
const kindLabels: Record<string, string> = { fact: "Fato relatado", preference: "Preferência", commitment: "Compromisso", observation: "Percepção · hipótese", analysis: "Análise da IA", message: "Mensagem", file: "Arquivo", action: "Ação", email: "E-mail", log: "Registro de execução", content: "Conteúdo", insight: "Insight", operation: "Operação", review: "Revisão" };

export default function ArisaWorkspace({ organizationId, userId, initialPanel: tab, onPanelChange: setTab, onClose }: { organizationId: string; userId: string; initialPanel: WorkspacePanel; onPanelChange: (panel: WorkspacePanel) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const knowledgePanel = tab === "archive" || tab === "memory";
  const [status, setStatus] = useState<KnowledgeStatus | null>(null), [archives, setArchives] = useState<Archive[]>([]), [total, setTotal] = useState(0), [memories, setMemories] = useState<Memory[]>([]);
  const [query, setQuery] = useState(""), [search, setSearch] = useState(""), [kind, setKind] = useState(""), [offset, setOffset] = useState(0), [memoryPage, setMemoryPage] = useState(0);
  const [selected, setSelected] = useState<Archive | null>(null), [revision, setRevision] = useState(0);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  useEffect(() => {
    if (!knowledgePanel) return;
    let alive = true;
    void client().rpc("arisa_knowledge_status", { p_organization_id: organizationId }).then(result => { if (alive) { if (result.error) setError(errorText(result.error)); else setStatus(result.data); } });
    return () => { alive = false; };
  }, [organizationId, revision, knowledgePanel]);
  useEffect(() => {
    if (tab !== "archive" && tab !== "memory") return;
    let alive = true;
    const load = async () => {
      if (tab === "archive") {
        const result = await client().rpc("arisa_archive_search", { p_organization_id: organizationId, p_query: search, p_kind: kind || null, p_limit: 20, p_offset: offset });
        if (result.error) throw result.error;
        if (alive) { setArchives(result.data.rows); setTotal(result.data.total); }
      } else {
        const result = await client().from("arisa_memories").select("id,source_event_id,subject_label,kind,topic,claim,evidence,confidence,status,observed_at,expires_at,review_note,reviewed_at").eq("organization_id", organizationId).order("observed_at", { ascending: false }).order("id", { ascending: false }).range(memoryPage * 20, memoryPage * 20 + 19);
        if (result.error) throw result.error;
        if (alive) setMemories(result.data || []);
      }
    };
    void load().catch(error => { if (alive) setError(errorText(error)); });
    return () => { alive = false; };
  }, [tab, organizationId, search, kind, offset, memoryPage, revision]);
  const showSource = useCallback(async (id: string) => {
    try { const result = await client().from("arisa_archive").select("*").eq("organization_id", organizationId).eq("id", id).single(); if (result.error) throw result.error; setSelected(result.data); setTab("archive"); }
    catch (error) { setError(errorText(error)); }
  }, [organizationId, setTab]);
  async function process() {
    setBusy(true); setError(""); setNotice("");
    try { await workspaceCall("arisa-background", { organizationId }); setRevision(n => n + 1); setNotice("Ciclo concluído. O restante da fila continuará automaticamente."); }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  function archiveCard(row: Archive) {
    return <article className={styles.card} key={row.id}><div className={styles.meta}>{kindLabels[row.kind] || row.kind} · {row.channel} · {row.author_type} · {row.owner_user_id ? "Sua conversa privada" : "Organização"}</div><h3>{row.title}</h3><small>{row.subject_label} · {displayDate(row.occurred_at)}</small><pre className={styles.content}>{row.content || "Consulte os detalhes deste registro."}</pre><div className={styles.row}><button onClick={() => downloadText(`${row.title}.txt`, row.content)}>Baixar conteúdo</button><button onClick={() => downloadText(`${row.id}.json`, JSON.stringify(row, null, 2))}>Exportar registro</button></div><details><summary>Origem e detalhes</summary><small>{row.source} · {row.id}</small><pre className={styles.content}>{JSON.stringify(row.payload, null, 2)}</pre></details></article>;
  }
  return <dialog ref={dialog} className={styles.dialog} onCancel={onClose} aria-labelledby="arisa-workspace-title"><header className={styles.header}><div><small>ARISA · ÉVORA URBANISMO</small><h2 id="arisa-workspace-title">Canais e conhecimento</h2></div><button onClick={onClose} aria-label="Fechar e voltar à conversa">✕</button></header><nav className={styles.tabs} aria-label="Áreas da Arisa">{workspacePanels.map(key => <button key={key} aria-current={tab === key ? "page" : undefined} onClick={() => { setTab(key); setError(""); setNotice(""); }}>{workspaceLabels[key]}</button>)}</nav><div className={styles.body}>
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
    {tab === "email" || tab === "agenda" ? <ArisaMailPanel key={tab} organizationId={organizationId} userId={userId} section={tab} /> : tab === "whatsapp" ? <ArisaWhatsAppPanel organizationId={organizationId} /> : <>
      <div className={styles.stats}><span><strong>{status?.archive ?? "—"}</strong> registros no arquivo</span><span><strong>{status?.memories ?? "—"}</strong> memórias ativas</span><span><strong>{(status?.queue.pending || 0) + (status?.queue.processing || 0)}</strong> na fila de aprendizado</span></div>
      {tab === "archive" ? <><p>Mensagens, documentos, conteúdos e resultados das ações, com origem e versões preservadas.</p><form className={styles.row} onSubmit={event => { event.preventDefault(); setSearch(query); setOffset(0); setSelected(null); }}><label className={styles.grow}>Buscar no arquivo<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Pessoa, assunto ou conteúdo" /></label><label>Tipo<select value={kind} onChange={e => { setKind(e.target.value); setOffset(0); }}>{["", "message", "email", "content", "file", "action", "insight", "operation", "log", "review"].map(key => <option key={key} value={key}>{kindLabels[key] || "Todos"}</option>)}</select></label><button type="submit">Buscar</button></form>{selected && <section><div className={styles.row}><strong>Evidência selecionada</strong><button onClick={() => setSelected(null)}>Fechar evidência</button></div>{archiveCard(selected)}</section>}{archives.map(archiveCard)}{!archives.length && <p>Nenhum registro encontrado.</p>}<div className={styles.row}><button disabled={offset === 0} onClick={() => setOffset(n => Math.max(0, n - 20))}>Anteriores</button><small>{total} registros · Página {offset / 20 + 1}</small><button disabled={offset + 20 >= total} onClick={() => setOffset(n => n + 20)}>Próximos</button></div></> : <>
        <p>A Arisa consulta estes aprendizados em novas conversas. Percepções profissionais são hipóteses revisáveis; a evidência original permanece disponível.</p><div className={styles.row}><button disabled={busy} onClick={() => void process()}>{busy ? "Processando…" : "Processar memória agora"}</button><small>Atualização automática a cada 5 minutos.</small></div>{Boolean(status?.queue.failed) && <p role="status">{status?.queue.failed} registros precisam de revisão técnica. O conteúdo original está preservado.</p>}
        {memories.map(memory => <MemoryCard key={memory.id} memory={memory} onSource={showSource} onSaved={() => setRevision(n => n + 1)} />)}{!memories.length && <p>Os aprendizados aparecerão aqui conforme a fila for processada.</p>}<div className={styles.row}><button disabled={memoryPage === 0} onClick={() => setMemoryPage(n => n - 1)}>Anteriores</button><small>Página {memoryPage + 1}</small><button disabled={memories.length < 20} onClick={() => setMemoryPage(n => n + 1)}>Próximos</button></div>
      </>}
    </>}
  </div></dialog>;
}

function MemoryCard({ memory, onSource, onSaved }: { memory: Memory; onSource: (id: string) => Promise<void>; onSaved: () => void }) {
  const [now] = useState(() => Date.now());
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget); setBusy(true); setError("");
    try {
      const result = await client().rpc("arisa_memory_review", { p_memory_id: memory.id, p_status: String(values.get("status")), p_note: String(values.get("note")), p_correction: String(values.get("claim")) });
      if (result.error) throw result.error; setEditing(false); onSaved();
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  const expired = Boolean(memory.expires_at && Date.parse(memory.expires_at) <= now);
  return <article className={styles.card}><div className={styles.meta}>{kindLabels[memory.kind]} · {memory.status === "rejected" ? "Invalidada" : expired ? "Expirada" : "Ativa"}</div><h3>{memory.subject_label}</h3><p>{memory.claim}</p><blockquote>{memory.evidence}</blockquote><small>Confiança estimada: {Math.round(memory.confidence * 100)}% · Origem: {displayDate(memory.observed_at)}{memory.expires_at && ` · Validade: ${displayDate(memory.expires_at)}`}</small>{memory.review_note && <p>Revisão: {memory.review_note} · {displayDate(memory.reviewed_at)}</p>}<div className={styles.row}><button onClick={() => void onSource(memory.source_event_id)}>Ver evidência</button><button onClick={() => setEditing(value => !value)}>Revisar aprendizado</button></div>{editing && <form onSubmit={save}><label>Texto do aprendizado<textarea name="claim" defaultValue={memory.claim} minLength={3} maxLength={1200} required rows={3} /></label><label>Decisão<select name="status" defaultValue={memory.status === "rejected" ? "rejected" : "active"}><option value="active">Manter / corrigir</option><option value="rejected">Invalidar e deixar de utilizar</option></select></label><label>Justificativa<textarea name="note" minLength={3} maxLength={1200} required rows={2} /></label><button disabled={busy}>Salvar revisão</button></form>}{error && <p role="alert" className={styles.error}>{error}</p>}</article>;
}
