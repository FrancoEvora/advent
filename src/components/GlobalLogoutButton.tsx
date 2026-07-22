"use client";

import {useEffect,useState} from "react";
import {usePathname} from "next/navigation";
import {getSupabase} from "@/lib/supabase";

const publicPrefixes=["/contrato/","/proposta/","/portal/","/verificar/","/recuperar-senha"];

export function GlobalLogoutButton(){
 const pathname=usePathname();
 const[visible,setVisible]=useState(false);
 const[busy,setBusy]=useState(false);
 const isPublic=publicPrefixes.some(prefix=>pathname.startsWith(prefix));
 useEffect(()=>{if(isPublic){setVisible(false);return}const client=getSupabase();if(!client)return;client.auth.getSession().then(({data})=>setVisible(Boolean(data.session)));const{data}=client.auth.onAuthStateChange((_event,session)=>setVisible(Boolean(session)));return()=>data.subscription.unsubscribe()},[isPublic]);
 async function logout(){const client=getSupabase();if(!client)return;setBusy(true);try{await client.auth.signOut({scope:"local"});sessionStorage.clear();localStorage.removeItem("evora-proposal-unit");location.replace("/")}finally{setBusy(false)}}
 if(!visible||isPublic)return null;
 return <button className="global-logout-button" onClick={logout} disabled={busy} title="Encerrar sessão"><span>↪</span>{busy?"Saindo...":"Sair"}</button>;
}
