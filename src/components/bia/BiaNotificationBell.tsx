"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "../arisa/notifications.module.css";
import { toolJson, type BiaTool } from "./customer-tools-client";
type Notice={id:string;conversationId:string;title:string;message:string;read_at:string|null;created_at:string};
export default function BiaNotificationBell({tool,enabled,busy,revision,onConversation}:{tool:BiaTool;enabled:boolean;busy:boolean;revision:number;onConversation:(id:string)=>void}) {
  const [items,setItems]=useState<Notice[]>([]),[unread,setUnread]=useState(0),[open,setOpen]=useState(false),[error,setError]=useState(''),[saving,setSaving]=useState(false);
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),request=useRef(0),mounted=useRef(false);
  const refresh=useCallback(async()=>{
    if(!enabled)return;
    const sequence=++request.current;
    try{const data=await toolJson<{items:Notice[];unread_count:number}>(tool,'notices');if(mounted.current&&sequence===request.current){setItems(data.items);setUnread(data.unread_count);setError('');}}
    catch{if(mounted.current&&sequence===request.current)setError('Não foi possível atualizar os avisos. Tente novamente.');}
  },[tool,enabled]);
  useEffect(()=>{
    mounted.current=true;const sync=()=>{if(!document.hidden)void refresh();};sync();
    const timer=window.setInterval(sync,30000);window.addEventListener('focus',sync);document.addEventListener('visibilitychange',sync);
    const invalidate=()=>{request.current++;};
    return()=>{mounted.current=false;invalidate();clearInterval(timer);window.removeEventListener('focus',sync);document.removeEventListener('visibilitychange',sync);};
  },[refresh,revision]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!root.current?.contains(event.target))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(false);trigger.current?.focus();}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[open]);
  async function markRead(ids:string[]) {setSaving(true);try{await toolJson(tool,'notices_read',{ids});await refresh();}catch{setError('Não foi possível marcar o aviso como lido.');}finally{if(mounted.current)setSaving(false);}}
  return <div ref={root} className={styles.root}>
    <button ref={trigger} type="button" className="arisa-icon-button" disabled={!enabled} aria-label={`Avisos da Bia${unread?`, ${unread} não lidos`:''}`} aria-expanded={open} aria-controls="bia-notifications" onClick={()=>{setOpen(value=>!value);void refresh();}}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
      {unread>0&&<span className={styles.badge} aria-hidden="true">{unread>99?'99+':unread}</span>}
    </button>
    {open&&<section id="bia-notifications" className={styles.panel} aria-label="Avisos da Bia">
      <div className={styles.heading}><strong>Novidades para você</strong><button type="button" onClick={()=>setOpen(false)} aria-label="Fechar avisos">×</button></div>
      <p>Respostas, simulações, materiais e atualizações do seu atendimento.</p>
      {error&&<p role="alert">{error} <button type="button" onClick={()=>void refresh()}>Atualizar</button></p>}
      {items.some(item=>!item.read_at)&&<button type="button" disabled={saving} onClick={()=>void markRead(items.filter(item=>!item.read_at).map(item=>item.id))}>Marcar os avisos exibidos como lidos</button>}
      <div className={styles.list}>{items.map(item=><article key={item.id} className={item.read_at?styles.read:styles.unread}>
        <strong>{item.title}</strong><p>{item.message}</p><time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'})}</time>
        <button type="button" disabled={busy} onClick={()=>{setOpen(false);onConversation(item.conversationId);}}>Abrir conversa</button>
        {!item.read_at&&<button type="button" disabled={saving} onClick={()=>void markRead([item.id])}>Marcar como lido</button>}
      </article>)}{!items.length&&!error&&<p>Nenhum aviso registrado para você.</p>}</div>
    </section>}
  </div>;
}
