"use client";
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { client, errorText, UUID } from '../arisa/chat-client';
import { displayDate } from '../arisa/workspace-client';
import { MessageText } from '../arisa/MessageText';
import { getActivityRelatedLink } from '../erp/activities/activity-links';
import { biaDeliveryLabel, biaOutboundError } from './outbound-display';
import { BiaStartConversation } from './BiaStartConversation';
import styles from '../arisa/workspace.module.css';
import monitor from './monitor.module.css';

type Thread = { id: string; peer_phone: string; customer_name: string | null; human_requested: boolean; opted_out_at: string | null; crm_record_id: string | null; last_activity_at?: string; last_message?: string; delivery_status?: string };
type Inbox = { enabled: boolean; verified: boolean; phone: string; threads: Thread[]; selected: Thread | null; total: number; message_total: number; updated_at: string; messages: { id: string; direction: string; content: string; delivery_status: string; error_code: string | null; occurred_at: string }[] };
const mode = (item: Thread) => item.opted_out_at ? 'Cliente pediu interrupção' : item.human_requested ? 'Atendimento humano' : 'Bia automática';

export default function BiaWhatsAppPanel({ organizationId, userId }: { organizationId: string; userId: string }) {
  const [snapshot, setSnapshot] = useState<{ organizationId: string; inbox: Inbox } | null>(null);
  const [thread, setThread] = useState<string | null>(() => { const id = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('atendimento'); return id && UUID.test(id) ? id : null; });
  const [opening, setOpening] = useState(false), [error, setError] = useState(''), [revision, setRevision] = useState(0), [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [filter, setFilter] = useState('all'), [offset, setOffset] = useState(0), [messageOffset, setMessageOffset] = useState(0);
  const data = snapshot?.organizationId === organizationId ? snapshot.inbox : null;
  const active = data?.selected?.id === thread ? data.selected : null;
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    let live = true;
    async function read() {
      try {
        const result = await client().rpc('bia_whatsapp_monitor', { p_organization_id: organizationId, p_thread_id: thread, p_search: search, p_filter: filter, p_offset: offset, p_message_offset: messageOffset });
        if (result.error) throw result.error;
        if (live) { setSnapshot({ organizationId, inbox: result.data }); setError(''); }
      } catch (failure) { if (live) setError(errorText(failure)); }
    }
    void read();
    return () => { live = false; };
  }, [organizationId, thread, search, filter, offset, messageOffset, revision]);

  useEffect(() => {
    const visibleRefresh = () => { if (!document.hidden) refresh(); };
    const timer = setInterval(visibleRefresh, 15000);
    window.addEventListener('focus', visibleRefresh);
    window.addEventListener('pageshow', visibleRefresh);
    document.addEventListener('visibilitychange', visibleRefresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', visibleRefresh); window.removeEventListener('pageshow', visibleRefresh); document.removeEventListener('visibilitychange', visibleRefresh); };
  }, [refresh]);

  function selectThread(id: string | null) {
    setThread(id); setMessageOffset(0);
    setSnapshot(value => value ? { ...value, inbox: { ...value.inbox, selected: null, messages: [] } } : value);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('atendimento', id); else url.searchParams.delete('atendimento');
    window.history.replaceState(null, '', url);
  }
  function applySearch(event: FormEvent) { event.preventDefault(); setSearch(query.trim()); setOffset(0); selectThread(null); refresh(); }
  async function control() {
    if (!active) return;
    setBusy(true);
    try {
      const result = await client().rpc('bia_whatsapp_inbox', { p_organization_id: organizationId, p_thread_id: active.id, p_action: active.human_requested ? 'resume' : 'pause' });
      if (result.error) throw result.error;
      refresh();
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  }
  if (opening) return <BiaStartConversation organizationId={organizationId} userId={userId} initialPhone="" onClose={id => { setOpening(false); if (id) selectThread(id); refresh(); }} />;

  return <section aria-label="Conversas da Bia">
    <div className={styles.row}><strong>{data ? data.enabled && data.verified ? 'WhatsApp da Bia ativo' : 'WhatsApp da Bia em preparação' : 'Carregando atendimentos…'}</strong><span>{data?.phone}</span><button onClick={() => setOpening(true)} disabled={!data?.enabled || !data.verified}>Iniciar conversa</button><button onClick={refresh}>Atualizar</button></div>
    <p>Acompanhe aqui as conversas da Bia com os clientes no WhatsApp. O mesmo histórico fica disponível no iPhone e no computador.</p>
    {data && <p className={styles.meta}>Atualizado em {displayDate(data.updated_at)} · Atualização a cada 15 segundos enquanto este menu está aberto e ao voltar ao aplicativo.</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <form onSubmit={applySearch} className={styles.row}><label className={styles.grow}>Buscar contato<input type="search" maxLength={120} value={query} onChange={event => setQuery(event.target.value)} placeholder="Nome ou telefone" /></label><label>Atendimento<select value={filter} onChange={event => { setFilter(event.target.value); setOffset(0); selectThread(null); }}><option value="all">Todos</option><option value="automatic">Bia automática</option><option value="human">Atendimento humano</option><option value="opted_out">Interrompidos pelo cliente</option></select></label><button type="submit">Buscar</button></form>
    {data && <p>{data.total} {data.total === 1 ? 'conversa encontrada' : 'conversas encontradas'}</p>}
    <div className={monitor.grid}><div><nav className={monitor.contacts} aria-label="Lista de conversas da Bia">{data?.threads.map(item => <button className={monitor.contact} key={item.id} aria-current={thread === item.id ? 'true' : undefined} onClick={() => selectThread(item.id)}><strong>{item.customer_name || '+' + item.peer_phone}</strong><small>{mode(item)}{item.last_activity_at && ' · ' + displayDate(item.last_activity_at)}</small><span>{item.last_message || 'Nenhuma mensagem registrada'}</span>{item.delivery_status && <small>{biaDeliveryLabel[item.delivery_status] || (item.delivery_status === 'received' ? 'Recebida' : item.delivery_status)}</small>}</button>)}{data && !data.threads.length && <p>Nenhuma conversa encontrada.</p>}</nav>
      {data && data.total > 25 && <div className={styles.row}><button disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 25))}>Contatos anteriores</button><small>Página {Math.floor(offset / 25) + 1} de {Math.ceil(data.total / 25)}</small><button disabled={offset + 25 >= data.total} onClick={() => setOffset(value => value + 25)}>Mais contatos</button></div>}</div>
      <section className={monitor.history} aria-label="Histórico do atendimento selecionado">{active ? <><h3>{active.customer_name || '+' + active.peer_phone}</h3><p>+{active.peer_phone} · {mode(active)}</p><div className={styles.row}><button disabled={busy || !!active.opted_out_at} onClick={() => void control()}>{active.human_requested ? 'Retomar atendimento automático' : 'Pausar para atendimento humano'}</button>{active.crm_record_id && <Link href={getActivityRelatedLink('crm_records', active.crm_record_id)?.href || '/?view=crm'}>Cadastro no CRM</Link>}</div>
        <div className={styles.row}><small>{data?.message_total} mensagens no histórico</small>{!!data && data.message_total > 50 && <><button disabled={messageOffset + 50 >= data.message_total} onClick={() => setMessageOffset(value => value + 50)}>Mensagens mais antigas</button><button disabled={messageOffset === 0} onClick={() => setMessageOffset(value => Math.max(0, value - 50))}>Mensagens mais recentes</button></>}</div>
        <div role="log" aria-label="Mensagens do WhatsApp da Bia">{data?.messages.map(message => <article className={styles.card} key={message.id}><strong>{message.direction === 'inbound' ? 'Cliente' : 'Bia'}</strong><MessageText content={message.content} /><small>{displayDate(message.occurred_at)} · {message.direction === 'inbound' ? 'Recebida' : biaDeliveryLabel[message.delivery_status] || message.delivery_status}</small>{message.error_code && <p className={styles.error}>{biaOutboundError(message.error_code)}</p>}</article>)}{!data?.messages.length && <p>Ainda não há mensagens neste atendimento.</p>}</div></> : <p>{thread ? 'Carregando histórico…' : 'Selecione um contato para acompanhar a conversa.'}</p>}</section></div>
  </section>;
}
