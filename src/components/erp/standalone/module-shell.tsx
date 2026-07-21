"use client";
import {useEffect,useState} from "react";
import type {Session} from "@supabase/supabase-js";
import {getSupabase} from "@/lib/supabase";
import type {Membership,Organization,Profile,Project} from "../types";

type Context={session:Session;organization:Organization;membership:Membership;profile:Profile|null;projects:Project[];members:Membership[];profiles:Profile[]};
export function ModuleShell({title,eyebrow,children}:{title:string;eyebrow:string;children:(context:Context)=>React.ReactNode}){
 const[ctx,setCtx]=useState<Context|null>(null),[error,setError]=useState("");
 useEffect(()=>{(async()=>{const s=getSupabase();if(!s){setError("Supabase indisponível.");return}const{data:{session}}=await s.auth.getSession();if(!session){location.href="/";return}const{data:membership,error:me}=await s.from("organization_members").select("*").eq("user_id",session.user.id).eq("active",true).limit(1).maybeSingle();if(me||!membership){setError(me?.message||"Usuário sem organização ativa.");return}const orgId=membership.organization_id;const[org,profile,projects,members,profiles]=await Promise.all([s.from("organizations").select("*").eq("id",orgId).single(),s.from("profiles").select("*").eq("id",session.user.id).maybeSingle(),s.from("projects").select("*").eq("organization_id",orgId).order("name"),s.from("organization_members").select("*").eq("organization_id",orgId).eq("active",true),s.from("profiles").select("*")]);const failed=[org,projects,members].find(x=>x.error);if(failed?.error){setError(failed.error.message);return}setCtx({session,organization:org.data,membership,profile:profile.data,projects:projects.data||[],members:members.data||[],profiles:profiles.data||[]})})()},[]);
 if(error)return <div className="standalone-error"><img src="/evora-brand.svg" alt="Évora Urbanismo"/><h1>Não foi possível abrir o módulo</h1><p>{error}</p><a href="/">Voltar à plataforma</a></div>;
 if(!ctx)return <div className="splash"><img src="/evora-brand.svg" alt="Évora Urbanismo"/><div className="spinner"/><p>Preparando módulo...</p></div>;
 return <div className="standalone-module"><header><div><small>{eyebrow}</small><h1>{title}</h1><p>{ctx.organization.trade_name||ctx.organization.name}</p></div><a href="/">Voltar ao ERP</a></header><main>{children(ctx)}</main></div>;
}
