"use client";
import {useState} from "react";
import type {ErpData} from "../types";
import {FinanceView as FinanceEntriesView} from "./finance-view";
import {DreView} from "./dre-view";
export function FinanceViewV60({data,mutate}:{data:ErpData;mutate:(operation:()=>Promise<void>,success:string)=>Promise<void>}){const[tab,setTab]=useState<"entries"|"dre">("entries");return <div className="finance-v60"><nav className="finance-module-tabs"><button className={tab==="entries"?"active":""} onClick={()=>setTab("entries")}>Contas a pagar e receber</button><button className={tab==="dre"?"active":""} onClick={()=>setTab("dre")}>DRE gerencial</button></nav>{tab==="entries"?<FinanceEntriesView data={data} mutate={mutate}/>:<DreView data={data}/>}</div>}
