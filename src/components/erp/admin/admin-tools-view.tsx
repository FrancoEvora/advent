"use client";
import {useEffect,useState} from "react";
import type {ErpData} from "../types";
import {BackupCenter} from "./backup-center";
import {DataMigrationCenterV2 as DataMigrationCenter} from "./data-migration-center-v2";
import {DatabaseResetGuard} from "./database-reset-guard";

type Tab="backup"|"migracao"|"limpeza";
export function AdminToolsView({data,reload,canBackup=true,canPlatform=true}:{data:ErpData;reload:()=>Promise<void>;canBackup?:boolean;canPlatform?:boolean}){
 const first:Tab=canBackup?"backup":"migracao";
 const[tab,setTab]=useState<Tab>(first);
 useEffect(()=>{if(tab==="backup"&&!canBackup)setTab("migracao");if((tab==="migracao"||tab==="limpeza")&&!canPlatform)setTab("backup")},[tab,canBackup,canPlatform]);
 return <div className="admin-tools"><section className="admin-heading"><div><small>GOVERNANÇA E TRANSIÇÃO</small><h1>Administração da plataforma</h1><p>Backup, migração de dados, validação e reinicialização segura.</p></div></section><nav className="admin-tabs">{canBackup&&<button className={tab==="backup"?"active":""} onClick={()=>setTab("backup")}>Backup e recuperação</button>}{canPlatform&&<button className={tab==="migracao"?"active":""} onClick={()=>setTab("migracao")}>Migração de dados</button>}{canPlatform&&<button className={tab==="limpeza"?"active":""} onClick={()=>setTab("limpeza")}>Limpeza da base</button>}</nav>{tab==="backup"&&canBackup?<BackupCenter data={data}/>:tab==="migracao"&&canPlatform?<DataMigrationCenter data={data} reload={reload}/>:tab==="limpeza"&&canPlatform?<DatabaseResetGuard data={data} onDone={reload}/>:<div className="feedback error">Seu perfil não possui autorização para esta área.</div>}</div>
}
