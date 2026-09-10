"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { client, errorText } from "./chat-client";
import { displayDate } from "./workspace-client";
import { whatsappDeliveryLabel } from "./whatsapp-display";
import { conversationSearch, mergeMonitorMessages, monitorMessageText, olderMessagesFilter, recoverMonitorGap, type MonitorMessage, type WhatsAppConversation } from "./whatsapp-monitor";
import styles from "./whatsapp-monitor.module.css";

const THREAD_PAGE = 25, MESSAGE_PAGE = 50;
const MESSAGE_FIELDS = "id,thread_id,direction,content,message_type,occurred_at,delivery_status,operation_id,arisa_whatsapp_operations(status,template_name)";
type MessageRow = MonitorMessage & { arisa_whatsapp_operations: { status: string; template_name: string | null } | null };
function messageRows(rows: unknown): MonitorMessage[] {
  return ((rows || []) as MessageRow[]).map(({ arisa_whatsapp_operations: operation, ...message }) => ({ ...message, status: operation?.status, template_name: operation?.template_name }));
}

// Refresh while visible; Safari also refreshes immediately after resuming the page.
function useMonitorRefresh(load: () => Promise<() => void>) {
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null), [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true, working = false;
    const update = async () => {
      if (working || document.visibilityState === "hidden") return;
      working = true;
      try {
        if (!navigator.onLine) throw new Error("Sem conexão. O histórico será atualizado quando a internet voltar.");
        const commit = await load();
        if (alive) { commit(); setUpdatedAt(new Date().toISOString()); setError(""); }
      } catch (failure) { if (alive) setError(errorText(failure)); }
      finally { working = false; if (alive) setLoading(false); }
    };
    void update();
    const timer = window.setInterval(() => void update(), 10000);
    const resume = () => { void update(); };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume); window.addEventListener("online", resume); window.addEventListener("pageshow", resume);
    return () => { alive = false; clearInterval(timer); document.removeEventListener("visibilitychange", resume); window.removeEventListener("focus", resume); window.removeEventListener("online", resume); window.removeEventListener("pageshow", resume); };
  }, [load, revision]);
  return { loading, error, updatedAt, refresh: () => { setLoading(true); setRevision(value => value + 1); } };
}

export default function ArisaWhatsAppConversations({ organizationId }: { organizationId: string }) {
  const [selected, setSelected] = useState<WhatsAppConversation | null>(null);
  const [draft, setDraft] = useState(""), [search, setSearch] = useState(""), [page, setPage] = useState(0);
  const listHeading = useRef<HTMLHeadingElement>(null);
  function find(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setSearch(draft.trim()); setPage(0); }
  function back() { setSelected(null); requestAnimationFrame(() => listHeading.current?.focus()); }
  return <section className={styles.monitor} aria-labelledby="whatsapp-conversations-title">
    <div className={styles.intro}><h3 id="whatsapp-conversations-title">Conversas do WhatsApp</h3><p>Acompanhe o que as pessoas enviam e as respostas da Arisa. Atualização automática a cada 10 segundos enquanto esta tela estiver aberta.</p></div>
    <div className={`${styles.layout} ${selected ? styles.hasConversation : ""}`}>
      <section className={styles.sidebar} aria-labelledby="whatsapp-contact-list">
        <h4 id="whatsapp-contact-list" ref={listHeading} tabIndex={-1}>Contatos e atendimentos</h4>
        <form className={styles.search} onSubmit={find}><label htmlFor="whatsapp-contact-search">Buscar por nome ou número</label><div><input id="whatsapp-contact-search" type="search" value={draft} maxLength={100} onChange={event => setDraft(event.target.value)} placeholder="Nome ou WhatsApp" /><button type="submit">Buscar</button></div></form>
        {search && <button className={styles.clear} onClick={() => { setDraft(""); setSearch(""); setPage(0); }}>Limpar busca</button>}
        <ConversationList key={`${organizationId}:${search}:${page}`} organizationId={organizationId} search={search} page={page} selectedId={selected?.id} onSelect={setSelected} onPage={setPage} />
      </section>
      {selected ? <ConversationHistory key={`${organizationId}:${selected.id}`} organizationId={organizationId} conversation={selected} onBack={back} /> : <div className={styles.empty}>Selecione um contato para acompanhar a conversa.</div>}
    </div>
  </section>;
}

function ConversationList({ organizationId, search, page, selectedId, onSelect, onPage }: { organizationId: string; search: string; page: number; selectedId?: string; onSelect: (conversation: WhatsAppConversation) => void; onPage: (page: number) => void }) {
  const [conversations, setConversations] = useState<WhatsAppConversation[]>([]), [hasMore, setHasMore] = useState(false);
  const load = useCallback(async () => {
    let query = client().from("arisa_whatsapp_threads")
      .select("id,phone,contact_name,last_message_at,last_inbound_at,opted_out_at,arisa_whatsapp_messages(id,direction,content,message_type,occurred_at,delivery_status)")
      .eq("organization_id", organizationId).not("last_message_at", "is", null)
      .order("last_message_at", { ascending: false }).order("id", { ascending: false })
      .order("occurred_at", { ascending: false, referencedTable: "arisa_whatsapp_messages" })
      .order("id", { ascending: false, referencedTable: "arisa_whatsapp_messages" })
      .limit(1, { referencedTable: "arisa_whatsapp_messages" }).range(page * THREAD_PAGE, (page + 1) * THREAD_PAGE);
    if (search) { const filter = conversationSearch(search); query = query.ilike(filter.column, filter.pattern); }
    const result = await query;
    if (result.error) throw result.error;
    const rows = (result.data || []) as unknown as WhatsAppConversation[];
    return () => { setConversations(rows.slice(0, THREAD_PAGE)); setHasMore(rows.length > THREAD_PAGE); };
  }, [organizationId, search, page]);
  const state = useMonitorRefresh(load);
  return <>
    <div className={styles.sync}><small>{state.updatedAt ? `Atualizado às ${new Date(state.updatedAt).toLocaleTimeString("pt-BR")}` : "Consultando conversas…"}</small><button onClick={state.refresh} disabled={state.loading} aria-label="Atualizar lista de conversas">↻ Atualizar</button></div>
    {state.error && <p role="alert" className={styles.error}>{state.error}</p>}
    {state.loading && !conversations.length && <p role="status">Carregando atendimentos…</p>}
    {!state.loading && !state.error && !conversations.length && <p>{search ? "Nenhuma conversa encontrada para esta busca." : "Nenhuma conversa registrada nesta página."}</p>}
    <ul className={styles.contacts} aria-label="Conversas do WhatsApp">{conversations.map(conversation => {
      const latest = conversation.arisa_whatsapp_messages[0];
      return <li key={conversation.id}><button aria-current={selectedId === conversation.id ? "true" : undefined} onClick={() => onSelect(conversation)}><span className={styles.contactTop}><strong>{conversation.contact_name || `+${conversation.phone}`}</strong><time dateTime={conversation.last_message_at || undefined}>{conversation.last_message_at ? new Date(conversation.last_message_at).toLocaleDateString("pt-BR") : ""}</time></span>{conversation.contact_name && <small>+{conversation.phone}</small>}<span className={styles.preview}>{latest ? `${latest.direction === "outbound" ? "Arisa: " : ""}${monitorMessageText(latest)}` : "Abrir histórico"}</span></button></li>;
    })}</ul>
    <div className={styles.pages}><button disabled={page === 0 || state.loading} onClick={() => onPage(Math.max(0, page - 1))}>Anterior</button><small>Página {page + 1}</small><button disabled={!hasMore || state.loading} onClick={() => onPage(page + 1)}>Próxima</button></div>
  </>;
}

function ConversationHistory({ organizationId, conversation, onBack }: { organizationId: string; conversation: WhatsAppConversation; onBack: () => void }) {
  const [messages, setMessages] = useState<MonitorMessage[]>([]), [hasOlder, setHasOlder] = useState(false), [olderBusy, setOlderBusy] = useState(false), [olderError, setOlderError] = useState("");
  const [newMessages, setNewMessages] = useState(0);
  const pane = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null), pinned = useRef(true), alive = useRef(true), known = useRef(new Set<string>()), initialized = useRef(false);
  const restoreHeight = useRef<number | null>(null), oldest = useRef<MonitorMessage | null>(null), newest = useRef<MonitorMessage | null>(null), loadingOlder = useRef(false);
  useEffect(() => { alive.current = true; heading.current?.focus(); return () => { alive.current = false; }; }, []);
  const load = useCallback(async () => {
    const result = await client().from("arisa_whatsapp_messages").select(MESSAGE_FIELDS).eq("organization_id", organizationId).eq("thread_id", conversation.id)
      .order("occurred_at", { ascending: false }).order("id", { ascending: false }).limit(MESSAGE_PAGE + 1);
    if (result.error) throw result.error;
    const rows = messageRows(result.data), recent = rows.slice(0, MESSAGE_PAGE);
    const recovered = await recoverMonitorGap(newest.current, recent, async cursor => {
      if (!alive.current) return [];
      const gap = await client().from("arisa_whatsapp_messages").select(MESSAGE_FIELDS).eq("organization_id", organizationId).eq("thread_id", conversation.id)
        .or(olderMessagesFilter(cursor)).order("occurred_at", { ascending: false }).order("id", { ascending: false }).limit(MESSAGE_PAGE);
      if (gap.error) throw gap.error;
      return messageRows(gap.data);
    });
    return () => {
      const added = recovered.filter(row => !known.current.has(row.id)).length;
      if (initialized.current && !pinned.current && added) setNewMessages(value => value + added);
      for (const row of recovered) known.current.add(row.id);
      if (!initialized.current) { setHasOlder(rows.length > MESSAGE_PAGE); oldest.current = recent.at(-1) || null; }
      newest.current = recent[0] || newest.current;
      initialized.current = true;
      setMessages(previous => mergeMonitorMessages(previous, recovered));
    };
  }, [organizationId, conversation.id]);
  const state = useMonitorRefresh(load);
  useLayoutEffect(() => {
    const element = pane.current; if (!element) return;
    if (restoreHeight.current !== null) { element.scrollTop += element.scrollHeight - restoreHeight.current; restoreHeight.current = null; }
    else if (pinned.current) element.scrollTop = element.scrollHeight;
  }, [messages]);
  async function loadOlder() {
    const cursor = oldest.current;
    if (!cursor || loadingOlder.current) return;
    loadingOlder.current = true; setOlderBusy(true); setOlderError(""); pinned.current = false;
    try {
      const result = await client().from("arisa_whatsapp_messages").select(MESSAGE_FIELDS).eq("organization_id", organizationId).eq("thread_id", conversation.id)
        .or(olderMessagesFilter(cursor)).order("occurred_at", { ascending: false }).order("id", { ascending: false }).limit(MESSAGE_PAGE + 1);
      if (result.error) throw result.error;
      if (!alive.current) return;
      const rows = messageRows(result.data), older = rows.slice(0, MESSAGE_PAGE);
      restoreHeight.current = pane.current?.scrollHeight ?? null;
      for (const row of older) known.current.add(row.id);
      oldest.current = older.at(-1) || cursor; setHasOlder(rows.length > MESSAGE_PAGE);
      setMessages(previous => mergeMonitorMessages(previous, older));
    } catch (failure) { if (alive.current) setOlderError(errorText(failure)); }
    finally { loadingOlder.current = false; if (alive.current) setOlderBusy(false); }
  }
  function latest() { pinned.current = true; setNewMessages(0); pane.current?.scrollTo({ top: pane.current.scrollHeight, behavior: "smooth" }); }
  return <section className={styles.conversation} aria-labelledby="whatsapp-selected-contact">
    <header className={styles.conversationHeader}><button className={styles.back} onClick={onBack}>← Contatos</button><div><h4 ref={heading} tabIndex={-1} id="whatsapp-selected-contact">{conversation.contact_name || `+${conversation.phone}`}</h4><small>+{conversation.phone}</small></div><button onClick={state.refresh} disabled={state.loading} aria-label="Atualizar conversa selecionada">↻</button></header>
    <div className={styles.historyStatus}><small>{state.updatedAt ? `Histórico atualizado em ${displayDate(state.updatedAt)}` : "Carregando histórico…"}</small>{conversation.opted_out_at && <small>Este contato pediu para não receber mensagens.</small>}</div>
    {state.error && <p role="alert" className={styles.error}>{state.error}</p>}
    <div ref={pane} className={styles.messages} role="region" aria-label={`Histórico com ${conversation.contact_name || conversation.phone}`} tabIndex={0} onScroll={() => { const element = pane.current; if (!element) return; pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; if (pinned.current) setNewMessages(0); }}>
      {hasOlder && <button className={styles.older} disabled={olderBusy} onClick={() => void loadOlder()}>{olderBusy ? "Carregando…" : "Carregar mensagens anteriores"}</button>}
      {olderError && <p role="alert" className={styles.error}>{olderError}</p>}
      {state.loading && !messages.length && <p role="status">Carregando mensagens…</p>}
      {!state.loading && !state.error && !messages.length && <p>Nenhuma mensagem registrada nesta conversa.</p>}
      {messages.map(message => <article key={message.id} className={`${styles.message} ${message.direction === "outbound" ? styles.outbound : styles.inbound}`}><strong>{message.direction === "outbound" ? "Arisa" : conversation.contact_name || "Contato"}</strong><p>{monitorMessageText(message)}</p><div className={styles.messageMeta}><time dateTime={message.occurred_at}>{displayDate(message.occurred_at)}</time><span>{whatsappDeliveryLabel(message)}</span></div>{message.template_name && <small>Modelo: {message.template_name}</small>}</article>)}
    </div>
    {newMessages > 0 && <button className={styles.newMessages} onClick={latest} aria-live="polite">{newMessages} nova(s) mensagem(ns) · Ir para o fim ↓</button>}
    <footer className={styles.footer}>Histórico do canal da Arisa · Acesso administrativo.</footer>
  </section>;
}
