"use client";

import {useEffect,useState} from "react";
import {usePathname} from "next/navigation";
import {getSupabase} from "@/lib/supabase";

const publicPrefixes=["/cliente/","/parceiro","/contrato/","/proposta/","/portal/","/verificar/","/recuperar-senha","/atendimento/","/arisa"];

export function GlobalLogoutButton(){
 const pathname=usePathname();
 const[visible,setVisible]=useState(false);
 const[busy,setBusy]=useState(false);
 const isPublic=publicPrefixes.some(prefix=>pathname.startsWith(prefix));
 useEffect(()=>{
  if(isPublic)return;
  const client=getSupabase();
  if(!client)return;
  let active=true;
  void client.auth.getSession().then(({data})=>{if(active)setVisible(Boolean(data.session))});
  const{data}=client.auth.onAuthStateChange((_event,session)=>{if(active)setVisible(Boolean(session))});
  return()=>{active=false;data.subscription.unsubscribe()};
 },[isPublic]);
 async function logout(){const client=getSupabase();if(!client)return;setBusy(true);try{await client.auth.signOut({scope:"local"});sessionStorage.clear();localStorage.removeItem("evora-proposal-unit");location.replace("/")}finally{setBusy(false)}}
 if(isPublic||!visible)return null;
 return <button className="global-logout-button" onClick={logout} disabled={busy} title="Encerrar sessão" aria-label="Encerrar sessão"><span aria-hidden="true">↪</span>{busy?"Saindo...":"Sair"}</button>;
}
