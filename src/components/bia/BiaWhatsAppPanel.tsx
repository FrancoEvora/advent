"use client";
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { client, errorText } from '../arisa/chat-client';
import { displayDate } from '../arisa/workspace-client';
import { MessageText } from '../arisa/MessageText';
import { biaDeliveryLabel } from './outbound-display';
import { BiaStartConversation } from './BiaStartConversation';
import styles from '../arisa/workspace.module.css';
type Thread={id:string;peer_phone:string;customer_name:string|null;human_requested:boolean;opted_out_at:string|null;errors:number};
type Inbox={enabled:boolean;verified:boolean;phone:string;threads:Thread[];messages:{id:string;direction:string;content:string;delivery_status:string;occurred_at:string}[]};
export default function BiaWhatsAppPanel({organizationId,userId}:{organizationId:string;userId:string}) {
  const [data,setData]=useState<Inbox|null>(null),[thread,setThread]=useState<string|null>(null),[opening,setOpening]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0),[busy,setBusy]=useState(false);
  const [initialPhone,setInitialPhone]=useState('');
  const refresh=useCallback(()=>setRevision(value=>value+1),[]);
  useEffect(()=>{let live=true;void client().rpc('bia_whatsapp_inbox',{p_organization_id:organizationId,p_thread_id:thread,p_action:'read'}).then(result=>{if(!live)return;if(result.error)setError(errorText(result.error));else{setData(result.data);setError('');}});return()=>{live=false;};},[organizationId,thread,revision]);
  useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden)refresh();},15000);return()=>clearInterval(timer);},[refresh]);
  const active=data?.threads.find(item=>item.id===thread);
  async function control(){setBusy(true);try{const result=await client().rpc('bia_whatsapp_inbox',{p_organization_id:organizationId,p_thread_id:thread,p_action:active?.human_requested?'resume':'pause'});if(result.error)throw result.error;refresh();}catch(error){setError(errorText(error));}finally{setBusy(false);}}
  if(opening)return <BiaStartConversation organizationId={organizationId} userId={userId} initialPhone={initialPhone} onClose={id=>{setOpening(false);if(id)setThread(id);refresh();}}/>;
  return <section aria-label="WhatsApp comercial da Bia"><div className={styles.row}><strong>{data?.enabled&&data.verified?'WhatsApp da Bia ativo':'Verificando canal da Bia…'}</strong><span>{data?.phone}</span><button onClick={()=>{setInitialPhone('');setOpening(true);}} disabled={!data?.enabled}>Iniciar conversa</button><button onClick={refresh}>Atualizar</button><Link href="/bia/gestao">Abrir central de atendimentos</Link></div><p>Peça à Bia no chat para iniciar um contato pelo nome completo do lead ou pelo telefone. A ordem é executada diretamente. As respostas dos clientes aparecem abaixo.</p>{error&&<p role="alert" className={styles.error}>{error}</p>}<label>Atendimento<select value={thread||''} onChange={event=>{setData(value=>value?{...value,messages:[]}:value);setThread(event.target.value||null);}}><option value="">Selecione um contato</option>{data?.threads.map(item=><option key={item.id} value={item.id}>{item.customer_name||'+'+item.peer_phone}{item.errors?' · Requer atenção':''}</option>)}</select></label>{active&&<div className={styles.row}><span>{active.opted_out_at?'Cliente pediu interrupção':active.human_requested?'Atendimento humano':'Atendimento automático da Bia'}</span><button disabled={busy||!!active.opted_out_at} onClick={()=>void control()}>{active.human_requested?'Retomar atendimento automático':'Pausar para atendimento humano'}</button></div>}<div role="log" aria-label="Mensagens do WhatsApp da Bia">{data?.messages.map(message=><article className={styles.card} key={message.id}><strong>{message.direction==='inbound'?'Cliente':'Bia'}</strong><MessageText content={message.content}/><small>{displayDate(message.occurred_at)} · {biaDeliveryLabel[message.delivery_status]||message.delivery_status}</small></article>)}{!data?.threads.length&&<p>Ainda não há atendimentos neste canal.</p>}</div></section>;
}
