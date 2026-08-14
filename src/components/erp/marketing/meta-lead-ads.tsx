"use client";

import {FormEvent,useEffect,useState} from "react";
import {getSupabase} from "@/lib/supabase";
import {ModuleShell} from "../standalone/module-shell";
import type {MetaCredentialStatus} from "@/lib/integrations/meta/credential-contract";

function stateLabel(v?:{configured:boolean}|null){return v?.configured?"Configurado":"Pendente"}

export function MetaLeadAdsStandalone(){
 return <ModuleShell eyebrow="META · AQUISIÇÃO E CRM" title="Meta Lead Ads">{context=><MetaLeadAds context={context}/>}</ModuleShell>;
}

function MetaLeadAds({context}:{context:any}){
 const[status,setStatus]=useState<MetaCredentialStatus|null>(null);
 const[busy,setBusy]=useState(false),[notice,setNotice]=useState("");
 const[pageId,setPageId]=useState("");
 async function auth(){const s=getSupabase();if(!s)throw new Error("Supabase indisponível.");const {data}=await s.auth.getSession();if(!data.session)throw new Error("Sessão expirada.");return data.session.access_token}
 async function load(){try{setBusy(true);const token=await auth();const r=await fetch(`/api/integrations/meta/credentials?organizationId=${encodeURIComponent(context.organization.id)}`,{headers:{Authorization:`Bearer ${token}`},cache:"no-store"});const j=await r.json();if(!r.ok)throw new Error(j.error||"Falha ao consultar integração Meta.");setStatus(j.status);if(!pageId&&j.status?.pages?.[0]?.pageId)setPageId(j.status.pages[0].pageId)}catch(e:any){setNotice(e.message)}finally{setBusy(false)}}
 useEffect(()=>{load()},[]);
 async function save(e:FormEvent<HTMLFormElement>){e.preventDefault();const f=new FormData(e.currentTarget);try{setBusy(true);setNotice("");const token=await auth();const body={organizationId:context.organization.id,pageId:String(f.get("pageId")||"").trim(),appSecret:String(f.get("appSecret")||"").trim()||null,verifyToken:String(f.get("verifyToken")||"").trim()||null,accessToken:String(f.get("accessToken")||"").trim()||null};const r=await fetch("/api/integrations/meta/credentials",{method:"PUT",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error||"Não foi possível salvar a conexão Meta.");setStatus(j.status);setNotice("Conexão Meta salva no Enterprise.");(e.currentTarget.elements.namedItem("accessToken") as HTMLInputElement).value="";(e.currentTarget.elements.namedItem("appSecret") as HTMLInputElement).value="";(e.currentTarget.elements.namedItem("verifyToken") as HTMLInputElement).value=""}catch(e:any){setNotice(e.message)}finally{setBusy(false)}}
 const connected=Boolean(status?.ready?.signatureValidation&&status?.ready?.graphPages);
 return <div className="marketing-v60"><section className="marketing-hero"><div><small>CONEXÃO NATIVA DO ENTERPRISE</small><h2>Meta Lead Ads → CRM</h2><p>Credenciais persistidas no backend, webhook assinado, deduplicação e entrada direta no CRM. O token nunca é salvo no navegador.</p></div><span className={`badge ${connected?"green":"amber"}`}>{connected?"CONECTADO":"CONFIGURAR"}</span></section>
 {notice&&<button className="notice" onClick={()=>setNotice("")}>{notice}</button>}
 <section className="marketing-command-grid"><article className="marketing-panel"><header><div><small>STATUS</small><h3>Integração Meta</h3></div><button onClick={load} disabled={busy}>Atualizar</button></header><div className="marketing-line"><span><strong>App Secret</strong><small>Validação da assinatura do webhook</small></span><i>{stateLabel(status?.appSecret)}</i></div><div className="marketing-line"><span><strong>Verify Token</strong><small>Verificação inicial do webhook</small></span><i>{stateLabel(status?.verifyToken)}</i></div><div className="marketing-line"><span><strong>Páginas Meta</strong><small>{status?.pages?.map(p=>p.pageId).join(", ")||"Nenhuma página registrada"}</small></span><i>{status?.ready?.graphPages||0}</i></div><div className="marketing-line"><span><strong>Webhook</strong><small>/api/integrations/meta/leads</small></span><i>{status?.ready?.webhookVerification?"PRONTO":"PENDENTE"}</i></div></article>
 <article className="marketing-panel"><header><div><small>CONFIGURAÇÃO</small><h3>Credenciais da operação</h3></div></header><form onSubmit={save} className="settings-form-v3"><label>ID da Página Meta<input name="pageId" value={pageId} onChange={e=>setPageId(e.target.value)} inputMode="numeric" required placeholder="658734250657699"/></label><label>Access Token<input name="accessToken" type="password" autoComplete="off" placeholder={status?.pages?.some(p=>p.pageId===pageId&&p.accessToken.configured)?"Já armazenado — deixe vazio para manter":"Token da Página / Lead Ads"}/></label><label>App Secret<input name="appSecret" type="password" autoComplete="off" placeholder={status?.appSecret.configured?"Já armazenado — deixe vazio para manter":"App Secret"}/></label><label>Verify Token<input name="verifyToken" type="password" autoComplete="off" placeholder={status?.verifyToken.configured?"Já armazenado — deixe vazio para manter":"Verify Token"}/></label><button className="primary" disabled={busy}>{busy?"Processando…":"Validar e salvar"}</button></form></article></section>
 <section className="marketing-panel" style={{marginTop:16}}><header><div><small>FLUXO OFICIAL</small><h3>Entrada direta no CRM</h3></div></header><p>Meta Lead Ads → webhook do Enterprise → fila idempotente → normalização → contato/oportunidade no CRM. O Campaign Control passa a consumir a atribuição comercial do Enterprise, sem manter uma segunda base oficial de leads.</p></section></div>
}
