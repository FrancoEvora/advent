"use client";

import { useCallback, useEffect, useState } from "react";
import type { ErpData } from "../types";
import type { CrmEnterpriseData } from "./types";
import { loadCrmCore } from "./load-core";
import { loadCrmMarketing } from "./load-marketing";
import { loadCrmAdmin } from "./load-admin";
import {useAutoRefresh} from "@/lib/use-auto-refresh";

const empty:CrmEnterpriseData={records:[],actions:[],pipelines:[],stages:[],teams:[],teamMembers:[],campaigns:[],folders:[],assets:[],automations:[],alerts:[],templates:[],integrations:[],goals:[]};
export function useCrmV5(data:ErpData){
  const [crm,setCrm]=useState<CrmEnterpriseData>(empty); const [loading,setLoading]=useState(true); const [error,setError]=useState("");
  const reload=useCallback(async()=>{setLoading(true);setError("");try{const [core,marketing,admin]=await Promise.all([loadCrmCore(data.organization.id),loadCrmMarketing(data.organization.id),loadCrmAdmin(data.organization.id)]);setCrm({...core,...marketing,...admin});}catch(e){setError(e instanceof Error?e.message:"Não foi possível carregar o CRM.");}finally{setLoading(false);}},[data.organization.id]);
  useEffect(()=>{reload();},[reload]);
  useAutoRefresh(reload);
  return{crm,loading,error,reload};
}
