"use client";
import {FormEvent,useState} from "react";
import {getSupabase} from "@/lib/supabase";
import type {CrmRecord,ErpData} from "../types";
import type {CrmEnterpriseData} from "./types";
import {LeadCommercialFields} from "./lead-commercial-fields";
import {BuyerProfileFields} from "./buyer-profile-fields";
import {BuyerDocuments} from "./buyer-documents";
import {buildLeadPayload} from "./lead-form-payload";
import {LeadConversationHistory} from "./lead-conversation-history";
import {LeadCommercialDossier} from "./lead-commercial-dossier";
import {LeadInstagramFields,buildInstagramPayload} from "./lead-instagram-fields";
import styles from "./lead-modal-v52.module.css";

export function LeadModalV52({data,crm,lead,close,done}:{data:ErpData;crm:CrmEnterpriseData;lead:CrmRecord|null;close:()=>void;done:(message:string)=>Promise<void>}) {
  const archived=lead?.record_status==="arquivada";
  const [error,setError]=useState("");
  const [saving,setSaving]=useState(false);
  async function submit(e:FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if(archived||saving)return;
    const client=getSupabase();
    if(!client)return;
    setError("");setSaving(true);
    try {
      const form=new FormData(e.currentTarget);
      const {score,payload}=buildLeadPayload(form,data,crm,lead);
      const changes={...payload,...buildInstagramPayload(form,lead)};
      const result=lead?await client.from("crm_records").update(changes).eq("id",lead.id):await client.from("crm_records").insert(changes);
      if(result.error)throw new Error(result.error.message);
      await done(lead?"Lead e cadastro do comprador atualizados.":`Lead criado com score ${score}. Designe o atendimento na Mesa SDR.`);
      close();
    } catch(cause) {
      setError(cause instanceof Error?cause.message:"Não foi possível salvar. Revise os dados e tente novamente.");
    } finally {setSaving(false);}
  }
  return <div className="modal-backdrop" onMouseDown={()=>{if(!saving)close();}}>
    <form className="modal extra-large crm5-modal" onSubmit={submit} onMouseDown={e=>e.stopPropagation()} aria-busy={saving}>
      <button className="modal-close" type="button" onClick={close} disabled={saving}>×</button>
      <header><small>{archived?"LEAD ARQUIVADO":lead?"DOSSIÊ DO LEAD / COMPRADOR":"NOVO LEAD"}</small><h2>{lead?.person_name||"Cadastro comercial e contratual"}</h2><p>{archived?"Consulta somente leitura. Todo o histórico comercial permanece preservado no ERP.":lead?"Visão única do relacionamento: atendimento da Bia, visitas, propostas, atividades e cadastro do comprador.":"Atendimento, qualificação, dados civis, endereço e documentação do comprador."}</p></header>
      {archived&&<div className={styles.archivedNotice} role="status"><strong>Cadastro arquivado e protegido contra alterações</strong><span>Para evitar reativação ou edição acidental, somente a consulta do cadastro, dos documentos e das conversas está disponível.</span></div>}
      {lead&&<LeadCommercialDossier lead={lead}/>}
      {lead&&<LeadConversationHistory organizationId={data.organization.id} crmRecordId={lead.id} accessToken={data.session.access_token} leadName={lead.person_name}/>}
      <fieldset className={styles.editableFields} disabled={archived||saving}>
        <LeadCommercialFields data={data} crm={crm} lead={lead}/>
        <LeadInstagramFields key={lead?.id||"new"} lead={lead}/>
        <BuyerProfileFields lead={lead}/>
        <section className="buyer-form-section"><label>Observações<textarea name="notes" rows={4} defaultValue={lead?.notes||""}/></label></section>
      </fieldset>
      {lead&&<BuyerDocuments data={data} leadId={lead.id} readOnly={archived}/>}
      {error&&<p role="alert" style={{color:"#9f2525",padding:"12px 20px"}}>{error}</p>}
      <footer><button type="button" onClick={close} disabled={saving}>{archived?"Fechar":"Cancelar"}</button>{!archived&&<button className="primary" disabled={saving}>{saving?"Salvando…":lead?"Salvar cadastro completo":"Criar lead"}</button>}</footer>
    </form>
  </div>;
}
