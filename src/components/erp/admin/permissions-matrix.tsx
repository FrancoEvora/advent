"use client";
import {useEffect,useMemo,useState} from "react";
import {getSupabase} from "@/lib/supabase";
import type {ErpData,Role} from "../types";
import {roleLabels} from "../utils";

type PermissionMap=Record<string,Record<string,boolean>|boolean>;
const modules=[
 {id:"dashboard",label:"Visão executiva",actions:["view"]},
 {id:"crm",label:"CRM",actions:["view","create","edit","approve","export","automations"]},
 {id:"post_sale",label:"Pós-venda",actions:["view","create","edit","approve","export"]},
 {id:"finance",label:"Financeiro",actions:["view","create","edit","approve","delete","export"]},
 {id:"procurement",label:"Compras",actions:["view","create","edit","approve"]},
 {id:"hr",label:"RH",actions:["view","create","edit","approve","export"]},
 {id:"documents",label:"Documentos",actions:["view","upload","delete"]},
 {id:"projects",label:"Empreendimentos",actions:["view","edit"]},
 {id:"admin",label:"Administração",actions:["users","reports","audit","backup","reset"]}
];
const actionLabels:Record<string,string>={view:"Ver",create:"Criar",edit:"Editar",approve:"Aprovar",delete:"Excluir",export:"Exportar",automations:"Automações",upload:"Anexar",users:"Usuários",reports:"Relatórios",audit:"Auditoria",backup:"Backup",reset:"Limpeza"};
export function PermissionsMatrix({data}:{data:ErpData}){
 const roles=Object.keys(roleLabels) as Role[];const[selected,setSelected]=useState<Role>("diretoria"),[matrix,setMatrix]=useState<PermissionMap>({}),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const isAdmin=selected==="admin";
 useEffect(()=>{(async()=>{const s=getSupabase();if(!s)return;const r=await s.from("role_access_profiles").select("permissions").eq("organization_id",data.organization.id).eq("role",selected).maybeSingle();setMatrix((r.data?.permissions||{}) as PermissionMap)})()},[selected,data.organization.id]);
 const checked=(m:string,a:string)=>isAdmin||Boolean((matrix[m] as Record<string,boolean>|undefined)?.[a]);
 function toggle(m:string,a:string){if(isAdmin)return;setMatrix(prev=>({...prev,[m]:{...((prev[m] as Record<string,boolean>)||{}),[a]:!checked(m,a)}}))}
 async function save(){setBusy(true);setMessage("");const s=getSupabase();if(!s)return;const r=await s.from("role_access_profiles").upsert({organization_id:data.organization.id,role:selected,permissions:isAdmin?{all:true}:matrix,updated_by:data.session.user.id,updated_at:new Date().toISOString()},{onConflict:"organization_id,role"});setBusy(false);setMessage(r.error?r.error.message:"Permissões atualizadas com sucesso.")}
 const enabled=useMemo(()=>modules.reduce((n,m)=>n+m.actions.filter(a=>checked(m.id,a)).length,0),[matrix,selected]);
 return <section className="panel permissions-matrix"><header className="panel-title"><div><small>PERMISSÕES POR PERFIL</small><h3>Matriz de acessos e alçadas</h3><p>Defina exatamente o que cada função pode visualizar e executar.</p></div><div className="permissions-summary"><strong>{enabled}</strong><span>permissões ativas</span></div></header><div className="permissions-toolbar"><label>Perfil<select value={selected} onChange={e=>setSelected(e.target.value as Role)}>{roles.map(r=><option key={r} value={r}>{roleLabels[r]}</option>)}</select></label>{isAdmin&&<div className="feedback">O administrador mantém acesso total e não pode ser restringido.</div>}</div><div className="permissions-table"><header><span>Módulo</span><span>Permissões</span></header>{modules.map(m=><article key={m.id}><strong>{m.label}</strong><div>{m.actions.map(a=><label key={a} className={checked(m.id,a)?"active":""}><input type="checkbox" checked={checked(m.id,a)} disabled={isAdmin} onChange={()=>toggle(m.id,a)}/><span>{actionLabels[a]}</span></label>)}</div></article>)}</div><footer><button className="primary" disabled={busy||isAdmin} onClick={save}>{busy?"Salvando...":"Salvar permissões"}</button>{message&&<span className="feedback">{message}</span>}</footer></section>