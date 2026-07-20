"use client";
import {useState} from "react";
import type {ErpData} from "../types";
import {DataMigrationCenter} from "./data-migration-center";
import {DatabaseResetCenter} from "./database-reset-center";

export function AdminToolsView({data,reload}:{data:ErpData;reload:()=>Promise<void>}){const[tab,setTab]=useState<"migracao"|"limpeza">("migracao");return <div className="admin-tools"><section className="admin-heading"><div><small>GOVERNANÇA E TRANSIÇÃO</small><h1>Administração da plataforma</h1><p>Migração de dados, modelos de planilha, validação e reinicialização segura.</p></div></section><nav className="admin-tabs"><button className={tab==="migracao"?"active":""} onClick={()=>setTab("migracao")}>Migração de dados</button><button className={tab==="limpeza"?"active":""} onClick={()=>setTab("limpeza")}>Limpeza da base</button></nav>{tab==="migracao"?<DataMigrationCenter data={data} reload={reload}/>:<DatabaseResetCenter data={data} onDone={reload}/>}</div>}
