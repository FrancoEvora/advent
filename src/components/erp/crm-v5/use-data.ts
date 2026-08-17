"use client";

import { useCallback, useEffect, useState } from "react";
import type { ErpData } from "../types";
import type { CrmEnterpriseData } from "./types";
import { loadCrmCore } from "./load-core";
import { loadCrmMarketing } from "./load-marketing";
import { loadCrmAdmin } from "./load-admin";

const empty:CrmEnterpriseData={records:[],actions:[],pipelines:[],stages:[],teams:[],teamMembers:[],products:[],leadSources:[],lossReasons:[],campaigns:[],folders:[],assets:[],automations:[],alerts:[],assignments:[],templates:[],integrations:[],metaLeadRoutes:[],metaLeadStatus:null,metaLeadStatusError:null,goals:[]};
export function useCrmV5(data:ErpData){
  const [crm,setCrm]=useState<CrmEnterpriseData>(empty); const [loading,setLoading]=useState(true); const [error,setError]=useState("");
  const reload=useCallback(async()=>{setLoading(true);setError("");try{const [core,marketing,admin]=await Promise.all([loadCrmCore(data.organization.id),loadCrmMarketing(data.organization.id),loadCrmAdmin(data.organization.id)]);setCrm({...core,...marketing,...admin});}catch(e){setError(e instanceof Error?e.message:"Não foi possível carregar o CRM.");}finally{setLoading(false);}},[data.organization.id]);
  const markRecordArchived=useCallback((recordId:string)=>{const archivedAt=new Date().toISOString();setCrm(current=>({...current,records:current.records.map(record=>record.id===recordId?{...record,record_status:"arquivada",next_action_at:null,sla_due_at:null,stagnation_at:null,updated_at:archivedAt}:record)}));},[]);
  useEffect(()=>{let active=true;queueMicrotask(()=>{if(active)void reload()});return()=>{active=false}},[reload]);
  return{crm,loading,error,reload,markRecordArchived};
}
