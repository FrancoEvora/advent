"use client";

import {useCallback,useEffect,useState} from "react";
import {getSupabase} from "@/lib/supabase";
import {useAutoRefresh} from "@/lib/use-auto-refresh";

type Notification={id:string;title:string;message:string;notification_type:string;read_at:string|null;created_at:string};

export function ActivityNotificationBell({organizationId,userId}:{organizationId:string;userId:string}){
 const[items,setItems]=useState<Notification[]>([]),[open,setOpen]=useState(false);
 const load=useCallback(async()=>{
  const supabase=getSupabase();if(!supabase)return;
  await supabase.rpc("run_my_automations",{p_organization_id:organizationId});
  const result=await supabase.from("activity_notifications").select("id,title,message,notification_type,read_at,created_at").eq("organization_id",organizationId).eq("recipient_user_id",userId).order("created_at",{ascending:false}).limit(12);
  if(!result.error)setItems((result.data||[]) as Notification[]);
 },[organizationId,userId]);
 useEffect(()=>{queueMicrotask(()=>{void load()});const supabase=getSupabase();if(!supabase)return;const channel=supabase.channel(`activity-notifications-${userId}`).on("postgres_changes",{event:"INSERT",schema:"public",table:"activity_notifications",filter:`recipient_user_id=eq.${userId}`},()=>{void load()}).subscribe();return()=>{void supabase.removeChannel(channel)}},[load,userId]);
 useAutoRefresh(load);
 const unread=items.filter(item=>!item.read_at).length;
 async function markAllRead(){const supabase=getSupabase();if(!supabase)return;await supabase.from("activity_notifications").update({read_at:new Date().toISOString()}).eq("organization_id",organizationId).eq("recipient_user_id",userId).is("read_at",null);await load()}
 return <div className="notification-bell">
  <button type="button" className="notification-bell-button" onClick={()=>setOpen(value=>!value)} aria-label={`Notificações${unread?`: ${unread} não lidas`:""}`} aria-expanded={open}>♢{unread>0&&<b>{unread>99?"99+":unread}</b>}</button>
  {open&&<aside className="notification-popover"><header><div><strong>Notificações</strong><small>Atualizadas automaticamente</small></div>{unread>0&&<button onClick={markAllRead}>Marcar lidas</button>}</header><div>{items.slice(0,8).map(item=><article key={item.id} className={item.read_at?"read":"unread"}><i data-type={item.notification_type}>●</i><span><strong>{item.title}</strong><small>{item.message}</small><time>{new Date(item.created_at).toLocaleString("pt-BR")}</time></span></article>)}{!items.length&&<p>Nenhuma notificação.</p>}</div><a href="/agenda">Abrir central e agenda</a></aside>}
 </div>;
}
