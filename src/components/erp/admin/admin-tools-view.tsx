"use client";
import {useEffect,useState} from "react";
import {getSupabase} from "@/lib/supabase";
import type {ErpData} from "../types";
import {BackupCenter} from "./backup-center";
import {DataMigrationCenterV2 as DataMigrationCenter} from "./data-migration-center-v2";
import {DatabaseResetGuard} from "./database-reset-guard";

type Tab="backup"|"migracao"|"limpeza";
export function AdminToolsView({data,reload}:{data:ErpData;reload:()=>Promise<void>}){
 const[tab,setTab]=useState<Tab>("backup"),[access,setAccess]=useState({backup:data.membership.role==="admin",platform:data.membership.role==="admin"}),[ready,setReady]=useState(data.membership.role==="admin");
 useEffect(()=>{const load=async()=>{if(data.membership.role==="admin"){setReady(true);return}const own=data.membership.permissions||{};const s=getSupabase();if(!s){setReady(true);return}const r=await s.from("role_permissions").select("permission_key,allowed").eq("organization_id",data.organization.id).eq("role",data.membership.role).in("permission_key",["backup.manage","platform.manage"]);const inherited=Object.fromEntries((r.data||[]).map(x=>[x.permission_key,x.allowed]));setAccess({backup:Object.prototype.hasOwnProperty.call(own,"backup.manage")?own["backup.manage"]===true:inherited["backup.manage"]===true,platform:Object.prototype.hasOwnProperty.call(own,"platform.manage")?own["platform.manage"]===true:inherited["platform.manage"]===true});setReady(true)};load()},[data]);
 useEffect(()=>{if(ready&&tab==="backup"&&!access.backup)setTab("migracao");if(ready&&(tab==="migracao"||tab==="limpeza")&&!access.platform)setTab("backup")},[ready,tab,access]);
 if(!ready)return <div className="feedback">Verificando autorizações...</div>;
 return <div className="admin-tools"><section className="admin-heading"><div><small>GOVERNANÇA E TRANSIÇÃO</small><h1>Administração da plataforma</h1><p>Backup, migração de dados, validação e reinicialização segura.</p></div></section><nav className="admin-tabs">{access.backup&&<button className={tab==="backup"?"active":""} onClick={()=>setTab("backup")}>Backup e recuperação</button>}{access.platform&&<button className={tab==="migracao"?"active":""} onClick={()=>setTab("migracao")}>Migração de dados</button>}{access.platform&&<button className={tab==="limpeza"?"active":""} onClick={()=>setTab("limpeza")}>Limpeza da base</button>}</nav>{tab==="backup"&&access.backup?<BackupCenter data={data}/>:tab==="migracao"&&access.platform?<DataMigrationCenter data={data} reload={reload}/>:tab==="limpeza"&&access.platform?<DatabaseResetGuard data={data} onDone={reload}/>:<div className="feedback error">Seu perfil não possui autorização para esta área.</div>}</div>
}
