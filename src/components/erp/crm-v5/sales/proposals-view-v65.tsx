"use client";

import {useState} from "react";
import {getSupabase} from "@/lib/supabase";
import type {ErpData} from "../../types";
import {canAdmin} from "../../utils";
import type {SalesData,SalesProposal} from "./types";
import {brl,statusLabel} from "./utils";
import {ProposalsViewV56} from "./proposals-view-v56";

function canDecide(role:string){const normalized=String(role||"").toLowerCase();return canAdmin(role)||["diretoria","diretor"].includes(normalized)}

export function ProposalsViewV65({data,sales,reload}:{data:ErpData;sales:SalesData;reload:()=>Promise<void>}){
 const[busyId,setBusyId]=useState<string|null>(null);
 const eligible=sales.proposals.filter(proposal=>!proposal.accepted_at&&!['aceita','contratada','rejeitada','cancelada'].includes(proposal.status));

 async function decide(proposal:SalesProposal,action:"rejeitada"|"cancelada"){
  const label=action==="rejeitada"?"rejeição":"cancelamento";
  const reason=prompt(`Informe o motivo da ${label} da proposta ${proposal.proposal_number}:`);
  if(!reason?.trim())return;
  if(!confirm(`${action==="rejeitada"?"Rejeitar":"Cancelar"} a proposta ${proposal.proposal_number}? O link público será desativado e a unidade poderá ser liberada.`))return;
  setBusyId(proposal.id);
  try{
   const supabase=getSupabase();if(!supabase)throw new Error("Supabase indisponível.");
   const result=await supabase.rpc("crm_decide_unaccepted_proposal",{p_proposal_id:proposal.id,p_action:action,p_reason:reason.trim()});
   if(result.error)throw result.error;
   await reload();
  }catch(error){alert(error instanceof Error?error.message:String(error))}
  finally{setBusyId(null)}
 }

 return <div className="crm-governance-stack">
  <ProposalsViewV56 data={data} sales={sales} reload={reload}/>
  {canDecide(data.membership.role)&&<section className="commercial-governance-panel">
   <header><div><small>GOVERNANÇA COMERCIAL</small><h2>Rejeição e cancelamento de propostas</h2><p>Disponível somente antes do aceite eletrônico do cliente.</p></div><span>{eligible.length} elegível(is)</span></header>
   <div className="commercial-governance-list">{eligible.map(proposal=>{const unit=sales.units.find(item=>item.id===proposal.unit_id);return <article key={proposal.id}>
    <div><small>{proposal.proposal_number}</small><strong>{proposal.customer_name}</strong><span>{data.projects.find(project=>project.id===proposal.project_id)?.name} · {unit?.unit_code||"Unidade"}</span></div>
    <div><small>Status atual</small><b>{statusLabel[proposal.status]||proposal.status}</b><span>{brl.format(Number(proposal.sale_price||0))}</span></div>
    <footer><button disabled={busyId===proposal.id} onClick={()=>decide(proposal,"rejeitada")}>Rejeitar proposta</button><button className="danger-button" disabled={busyId===proposal.id} onClick={()=>decide(proposal,"cancelada")}>Cancelar proposta</button></footer>
   </article>})}{!eligible.length&&<p className="empty-state">Nenhuma proposta pendente de aceite está elegível para rejeição ou cancelamento.</p>}</div>
  </section>}
 </div>;
}
