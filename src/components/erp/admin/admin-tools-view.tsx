"use client";
import {useState} from "react";
import type {ErpData} from "../types";
import {BackupCenter} from "./backup-center";
import {DataMigrationCenterV2 as DataMigrationCenter} from "./data-migration-center-v2";
import {DatabaseResetCenter} from "./database-reset-center";
export function AdminToolsView({data,reload}:{data:ErpData;reload:()=>Promise<void>}){const[tab,setTab]=useState<"backup"|"migracao"|"limpeza">("backup");return <div className="admin-tools"><section className="admin-heading"><div><small>GOVERNANÇA E TRANSIÇÃO</small><h1>Administração da plataforma</h1><p>Backup, migração de dados, validação e reinicialização segura.</p></div></section><nav className="admin-tabs"><button className={tab==="backup"?"active":""} onClick={()=>setTab("backup")}>Backup e recuperação</button><button className={tab==="migracao"?"active":""} onClick={()=>setTab("migracao")}>Migração de dados</button><button className={tab==="limpeza"?"active":""} onClick={()=>setTab("limpeza")}>Limpeza da base</button></nav>{tab==="backup"?<BackupCenter data={data}/>:tab==="migracao"?<DataMigrationCenter data={data} reload={reload}/>:<DatabaseResetCenter data={data} onDone={reload}/>}</div>}
