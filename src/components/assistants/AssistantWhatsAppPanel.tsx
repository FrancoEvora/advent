"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { client, errorText, UUID } from '../arisa/chat-client';
import { displayDate } from '../arisa/workspace-client';
import { MessageText } from '../arisa/MessageText';
import { getActivityRelatedLink } from '../erp/activities/activity-links';
import { channelDetails, deliveryLabel, outboundError, type WhatsAppInbox, type WhatsAppThread } from './whatsapp-panel-client';
import { AssistantStartConversation } from './AssistantStartConversation';
import styles from '../arisa/workspace.module.css';
import monitor from './whatsapp-panel.module.css';

export default function AssistantWhatsAppPanel({ organizationId, userId, assistant }: { organizationId: string; userId: string; assistant: "arisa" | "bia" }) {
  const channel = channelDetails(assistant);
  const mode = (item: WhatsAppThread) => item.opted_out_at ? "Contato pediu interrupção" : item.human_requested ? "Atendimento humano" : `${channel.name} automática`;
  const [snapshot, setSnapshot] = useState<{ organizationId: string; assistant: string; inbox: WhatsAppInbox } | null>(null);
  const [thread, setThread] = useState<string | null>(() => { const id = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('atendimento'); return id && UUID.test(id) ? id : null; });
  const [opening, setOpening] = useState(false), [error, setError] = useState(''), [revision, setRevision] = useState(0), [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [filter, setFilter] = useState('all'), [offset, setOffset] = useState(0), [messageOffset, setMessageOffset] = useState(0);
  const data = snapshot?.organizationId === organizationId && snapshot.assistant === assistant ? snapshot.inbox : null;
  const active = data?.selected?.id === thread ? data.selected : null;
  const pane = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const scrollState = useRef({thread:null as string | null,page:0,pinned:true});
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  useLayoutEffect(() => {
    const element = pane.current;
    if (!element || !active) return;
    const changed = scrollState.current.thread !== active.id;
    if (changed || scrollState.current.page !== messageOffset) {
      element.scrollTop = messageOffset === 0 ? element.scrollHeight : 0;
      scrollState.current = {thread:active.id,page:messageOffset,pinned:messageOffset === 0};
      if (changed) heading.current?.focus({preventScroll:true});
    } else if (scrollState.current.pinned && messageOffset === 0) element.scrollTop = element.scrollHeight;
  }, [active, data?.messages, messageOffset]);

  useEffect(() => {
    let live = true;
    async function read() {
      try {
        const result = await client().rpc(channel.monitor, { p_organization_id: organizationId, p_thread_id: thread, p_search: search, p_filter: filter, p_offset: offset, p_message_offset: messageOffset });
        if (result.error) throw result.error;
        if (live) { setSnapshot({ organizationId, assistant, inbox: result.data }); setError(''); }
      } catch (failure) { if (live) setError(errorText(failure)); }
    }
    void read();
    return () => { live = false; };
  }, [organizationId, assistant, channel.monitor, thread, search, filter, offset, messageOffset, revision]);

  useEffect(() => {
    const visibleRefresh = () => { if (!document.hidden) refresh(); };
    const timer = setInterval(visibleRefresh, 15000);
    window.addEventListener('focus', visibleRefresh);
    window.addEventListener('pageshow', visibleRefresh);
    window.addEventListener('online', visibleRefresh);
    document.addEventListener('visibilitychange', visibleRefresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', visibleRefresh); window.removeEventListener('pageshow', visibleRefresh); window.removeEventListener('online', visibleRefresh); document.removeEventListener('visibilitychange', visibleRefresh); };
  }, [refresh]);

  function selectThread(id: string | null) {
    if (id === thread) return;
    scrollState.current = {thread:null,page:0,pinned:true};
    setThread(id); setMessageOffset(0);
    setSnapshot(value => value ? { ...value, inbox: { ...value.inbox, selected: null, messages: [] } } : value);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('atendimento', id); else url.searchParams.delete('atendimento');
    window.history.replaceState(null, '', url);
  }
  function latest() {
    scrollState.current.pinned = true;
    if (messageOffset) setMessageOffset(0);
    else pane.current?.scrollTo({top:pane.current.scrollHeight,behavior:'smooth'});
  }
  function applySearch(event: FormEvent) { event.preventDefault(); setSearch(query.trim()); setOffset(0); selectThread(null); refresh(); }
  async function control() {
    if (!active) return;
    setBusy(true);
    try {
      const result = await client().rpc(channel.control, { p_organization_id: organizationId, p_thread_id: active.id, p_action: active.human_requested ? 'resume' : 'pause' });
      if (result.error) throw result.error;
      refresh();
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  }
  if (opening) return <div className={monitor.start}><AssistantStartConversation assistant={assistant} organizationId={organizationId} userId={userId} initialPhone="" onClose={id => { setOpening(false); if (id) selectThread(id); refresh(); }} /></div>;

  return <section className={monitor.panel} aria-label={`Conversas da ${channel.name}`}>
    <div className={monitor.toolbar}><div><strong>{data ? data.enabled && data.verified ? `WhatsApp da ${channel.name} ativo` : `WhatsApp da ${channel.name} em preparação` : 'Carregando atendimentos…'}</strong><small>{data?.phone}</small></div><button onClick={() => setOpening(true)} disabled={!data?.enabled || !data.verified}>Iniciar conversa</button><button onClick={refresh} aria-label="Atualizar atendimentos">↻</button></div>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <div className={`${monitor.grid} ${thread ? monitor.hasThread : ''}`}><aside className={monitor.sidebar}>
      <form onSubmit={applySearch} className={monitor.search}><label>Buscar contato<input type="search" maxLength={120} value={query} onChange={event => setQuery(event.target.value)} placeholder="Nome ou telefone" /></label><label>Atendimento<select value={filter} onChange={event => { setFilter(event.target.value); setOffset(0); selectThread(null); }}><option value="all">Todos</option><option value="automatic">{channel.name} automática</option><option value="human">Atendimento humano</option><option value="opted_out">Interrompidos pelo contato</option></select></label><button type="submit">Buscar</button></form>
      {data && <p className={monitor.count}>{data.total} {data.total === 1 ? 'conversa encontrada' : 'conversas encontradas'}</p>}
      <nav className={monitor.contacts} aria-label={`Lista de conversas da ${channel.name}`}>{data?.threads.map(item => <button className={monitor.contact} key={item.id} aria-current={thread === item.id ? 'true' : undefined} onClick={() => selectThread(item.id)}><strong>{item.customer_name || '+' + item.peer_phone}</strong><small>{mode(item)}{item.last_activity_at && ' · ' + displayDate(item.last_activity_at)}</small><span>{item.last_message || 'Nenhuma mensagem registrada'}</span>{item.delivery_status && <small>{deliveryLabel[item.delivery_status] || (item.delivery_status === 'received' ? 'Recebida' : item.delivery_status)}</small>}</button>)}{data && !data.threads.length && <p>Nenhuma conversa encontrada.</p>}</nav>
      {data && data.total > 25 && <div className={styles.row}><button disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 25))}>Contatos anteriores</button><small>Página {Math.floor(offset / 25) + 1} de {Math.ceil(data.total / 25)}</small><button disabled={offset + 25 >= data.total} onClick={() => setOffset(value => value + 25)}>Mais contatos</button></div>}
    </aside>
      <section className={monitor.history} aria-label="Histórico do atendimento selecionado">{thread ? <>
        <header className={monitor.historyHeader}><button onClick={() => selectThread(null)}>← Conversas</button><div><h3 ref={heading} tabIndex={-1}>{active?.customer_name || (active ? '+' + active.peer_phone : 'Abrindo atendimento…')}</h3>{active && <small>+{active.peer_phone} · {mode(active)}</small>}</div></header>
        {active && <><details className={monitor.actions}><summary>Opções de atendimento</summary><div className={styles.row}><button disabled={busy || !!active.opted_out_at} onClick={() => void control()}>{active.human_requested ? 'Retomar atendimento automático' : 'Pausar para atendimento humano'}</button>{active.crm_record_id && <Link href={getActivityRelatedLink('crm_records', active.crm_record_id)?.href || '/?view=crm'}>Cadastro no CRM</Link>}</div></details>
          <div className={monitor.historyStatus}><small>{data?.message_total} mensagens · {data && displayDate(data.updated_at)}</small><button onClick={latest}>Últimas mensagens ↓</button></div></>}
        <div ref={pane} className={monitor.messages} role="log" aria-label={`Mensagens do WhatsApp da ${channel.name}`} tabIndex={0} onScroll={() => { const element = pane.current; if (element) scrollState.current.pinned = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
          {!active ? <p role="status">{error ? 'Não foi possível carregar o histórico. Use Atualizar para tentar novamente.' : 'Carregando histórico…'}</p> : <>{data?.messages.map(message => <article className={`${monitor.message} ${message.direction === 'inbound' ? monitor.inbound : monitor.outbound}`} key={message.id}><strong>{message.direction === 'inbound' ? active.customer_name || 'Contato' : channel.name}</strong><MessageText content={message.content || "Mensagem sem conteúdo de texto."} /><small>{displayDate(message.occurred_at)} · {message.direction === 'inbound' ? 'Recebida' : deliveryLabel[message.delivery_status] || message.delivery_status}</small>{message.error_code && <p className={styles.error}>{outboundError(assistant, message.error_code)}</p>}</article>)}{!data?.messages.length && <p>Ainda não há mensagens neste atendimento.</p>}</>}
        </div>
        {active && data && data.message_total > 50 && <div className={monitor.pages}><button disabled={messageOffset + 50 >= data.message_total} onClick={() => setMessageOffset(value => value + 50)}>Mensagens mais antigas</button><small>Página {Math.floor(messageOffset / 50) + 1} de {Math.ceil(data.message_total / 50)}</small><button disabled={messageOffset === 0} onClick={() => setMessageOffset(value => Math.max(0, value - 50))}>Mensagens mais recentes</button></div>}
      </> : <p className={monitor.empty}>Selecione um contato para abrir o histórico completo.</p>}</section></div>
  </section>;
}
