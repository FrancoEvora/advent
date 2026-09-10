"use client";
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { client } from '../arisa/chat-client';
import { AssistantHeader } from '../assistants/AssistantHeader';
import { MessageText } from '../arisa/MessageText';
import { getActivityRelatedLink } from '../erp/activities/activity-links';
import { BiaStartConversation } from './BiaStartConversation';
import { biaDeliveryLabel, biaOutboundError } from './outbound-display';

type Thread = { id: string; peer_phone: string; customer_name: string | null; human_requested: boolean; opted_out_at: string | null; errors: number; crm_record_id: string | null };
type Message = { id: string; content: string; direction: string; delivery_status: string | null; error_code?: string | null; occurred_at: string };
type Inbox = { enabled: boolean; verified: boolean; phone: string | null; threads: Thread[]; messages: Message[] };
type Membership = { organization_id: string; organizations: { name: string; active: boolean } | null };
export default function BiaInbox() {
  const [session, setSession] = useState<Session | null>(null), [ready, setReady] = useState(false);
  const [memberships, setMemberships] = useState<Membership[]>([]), [org, setOrg] = useState('');
  const [threadId, setThreadId] = useState<string | null>(null), [data, setData] = useState<Inbox | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [initialPhone, setInitialPhone] = useState('');
  const requestNumber = useRef(0);
  const invalidate = useCallback(() => { requestNumber.current++; }, []);
  useEffect(() => {
    const db = client(); let alive = true;
    const query = new URLSearchParams(window.location.search);
    const openingTimer = setTimeout(() => { if (query.get('iniciar') === '1') { setStartOpen(true); setInitialPhone((query.get('telefone') || '').slice(0,30)); } }, 0);
    void db.auth.getSession().then(({data}) => { if(alive){setSession(data.session);setReady(true);} });
    const { data: subscription } = db.auth.onAuthStateChange((_event,value) => { if(alive){setSession(value);setReady(true);if(!value){requestNumber.current++;setOrg('');setMemberships([]);setData(null);setThreadId(null);}} });
    document.documentElement.classList.add('public-agent-active'); document.body.classList.add('public-agent-active');
    return () => { alive=false; clearTimeout(openingTimer); invalidate();subscription.subscription.unsubscribe();document.documentElement.classList.remove('public-agent-active');document.body.classList.remove('public-agent-active'); };
  }, [invalidate]);
  const userId = session?.user.id;
  useEffect(() => {
    if(!userId)return;let alive=true;
    void client().from('organization_members').select('organization_id,organizations(name,active)').eq('user_id',userId).eq('active',true).eq('role','admin').then(({data,error}) => {
      if(!alive)return;
      if(error){setError('Não foi possível consultar suas permissões.');return;}
      const rows=(data as unknown as Membership[]||[]).filter(row=>row.organizations?.active);setMemberships(rows);setOrg(rows.length===1?rows[0].organization_id:'');
      if(!rows.length)setError('Esta área está disponível aos administradores ativos da organização.');
    });return()=>{alive=false;};
  },[userId]);
  const load = useCallback(async (action='read') => {
    if(!org)return;const current=++requestNumber.current;
    try {
      const result=await client().rpc('bia_whatsapp_inbox',{p_organization_id:org,p_thread_id:threadId,p_action:action});
      if(current!==requestNumber.current)return;
      if(result.error){setError('Não foi possível carregar o atendimento da Bia.');return;}
      setData(result.data as Inbox);setError('');
    } catch { if(current===requestNumber.current)setError('Não foi possível conectar ao atendimento da Bia.'); }
  },[org,threadId]);
  useEffect(()=>{const initial=setTimeout(()=>void load(),0);const timer=setInterval(()=>void load(),15000);return()=>{clearTimeout(initial);clearInterval(timer);invalidate();};},[load,invalidate]);
  async function signIn(event: FormEvent<HTMLFormElement>){
    event.preventDefault();setBusy(true);setError('');const form=new FormData(event.currentTarget);
    try {const {error}=await client().auth.signInWithPassword({email:String(form.get('email')),password:String(form.get('password'))});if(error)setError('Confira seu e-mail e sua senha.');}
    catch {setError('Não foi possível entrar agora.');} finally {setBusy(false);}
  }
  async function control(action:string){setBusy(true);try{await load(action);}finally{setBusy(false);}}
  const active=data?.threads.find(t=>t.id===threadId);
  return <main id="conteudo-principal" className="public-agent-page bia-whatsapp arisa-chat bia-commercial"><div className="public-agent-shell"><section className="public-agent-chat-card">
    <AssistantHeader name="Bia" subtitle="Central de vendas e atendimento" organization="Futura Casa · Évora Urbanismo" avatar="/vitoria/vitoria-avatar.webp" />
    {!ready ? <p role="status">Verificando acesso…</p> : !session ? <div className="public-agent-messages arisa-login"><p>Acompanhe os atendimentos comerciais da Bia com sua conta da plataforma.</p><form onSubmit={signIn}><label>E-mail<input type="email" name="email" autoComplete="username" required /></label><label>Senha<input type="password" name="password" autoComplete="current-password" required /></label><button disabled={busy}>{busy?'Entrando…':'Entrar na central da Bia'}</button></form><Link href="/">Abrir plataforma</Link></div> : !org ? <div className="arisa-login"><label>Organização<select value={org} onChange={e=>{requestNumber.current++;setData(null);setThreadId(null);setOrg(e.target.value);}}><option value="">Selecione</option>{memberships.map(m=><option key={m.organization_id} value={m.organization_id}>{m.organizations?.name}</option>)}</select></label><button onClick={()=>void client().auth.signOut()}>Trocar de conta</button></div> : <>
      <div className="bia-inbox-toolbar"><strong>{data?.enabled&&data.verified?'WhatsApp ativo':'WhatsApp em preparação'}</strong><span>{data?.phone}</span><Link href="/bia" target="_blank">Conversar com a Bia</Link><Link href="/?view=crm">Abrir CRM</Link><button disabled={busy} onClick={()=>void control('read')}>Atualizar</button></div>
      {startOpen ? <BiaStartConversation key={`${userId}:${org}`} organizationId={org} userId={userId!} initialPhone={initialPhone} onClose={id=>{setStartOpen(false);setInitialPhone('');if(id)setThreadId(id);void load();}} /> : <><div className="bia-inbox-toolbar"><button disabled={!data?.enabled||!data?.verified} onClick={()=>setStartOpen(true)}>Iniciar conversa</button></div>
      <div className="bia-inbox-grid"><nav className="bia-inbox-list" aria-label="Atendimentos da Bia">{!data?.threads.length&&<p>As conversas da Bia no WhatsApp aparecerão aqui.</p>}{data?.threads.map(t=><button key={t.id} aria-current={threadId===t.id} onClick={()=>{requestNumber.current++;setData(old=>old?{...old,messages:[]}:old);setThreadId(t.id);}}><strong>{t.customer_name||`+${t.peer_phone}`}</strong><small>{t.opted_out_at?'Cliente pediu interrupção':t.human_requested?'Atendimento com a equipe':'Atendimento com a Bia'}{t.errors>0?' · Requer atenção':''}</small></button>)}</nav>
      <section className="bia-inbox-thread" aria-label="Conversa selecionada">{active&&<div className="bia-inbox-toolbar"><span>{active.customer_name||`+${active.peer_phone}`}</span><button disabled={busy||Boolean(active.opted_out_at)} onClick={()=>void control(active.human_requested?'resume':'pause')}>{active.human_requested?'Retomar a Bia nas próximas mensagens':'Pausar para atendimento humano'}</button>{active.crm_record_id&&<Link href={getActivityRelatedLink("crm_records",active.crm_record_id)?.href||"/?view=crm"}>Cadastro no CRM</Link>}</div>}
        <div className="public-agent-messages" role="log" aria-label="Mensagens do atendimento">{!active&&<p>Selecione um atendimento para consultar o histórico.</p>}{data?.messages.map(m=><article key={m.id} className={`public-agent-message ${m.direction==='inbound'?'user':'assistant'}`}><div className="public-agent-message-content"><MessageText content={m.content}/><div className="public-agent-message-meta"><time dateTime={m.occurred_at}>{new Date(m.occurred_at).toLocaleString('pt-BR')}</time>{m.delivery_status&&<span>{biaDeliveryLabel[m.delivery_status]||m.delivery_status}</span>}</div>{m.error_code&&<small>{biaOutboundError(m.error_code)}</small>}</div></article>)}</div>
      </section></div></>}
    </>}{error&&<p className="public-agent-alert" role="alert">{error}</p>}
    <footer className="arisa-login-footer"><Link href="/">Plataforma Évora</Link> · <Link href="/arisa">Arisa</Link>{session&&<> · <button onClick={()=>void client().auth.signOut()}>Sair</button></>}</footer>
  </section></div></main>;
}
