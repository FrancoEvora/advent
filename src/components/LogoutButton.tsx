"use client";

import {useState} from "react";
import {getSupabase} from "@/lib/supabase";

export function LogoutButton({compact=false}:{compact?:boolean}){
 const[busy,setBusy]=useState(false);
 async function logout(){
  if(busy)return;
  setBusy(true);
  const supabase=getSupabase();
  if(supabase)await supabase.auth.signOut({scope:"local"});
  location.replace("/");
 }
 return <button type="button" className={`logout-button ${compact?"compact":""}`} onClick={logout} disabled={busy} title="Encerrar esta sessão">{busy?"Saindo...":"Sair"}</button>;
}
