"use client";
import {FormEvent} from "react";
import {getSupabase} from "@/lib/supabase";
import type {CrmRecord,ErpData} from "../types";
import type {CrmEnterpriseData} from "./types";
import {LeadCommercialFields} from "./lead-commercial-fields";
import {BuyerProfileFields} from "./buyer-profile-fields";
import {BuyerDocuments} from "./buyer-documents";
import {buildLeadPayload} from "./lead-form-payload";
export function LeadModalV52({data,crm,lead,close,done}:{data:ErpData;crm:CrmEnterpriseData;lead:CrmRecord|null;close:()=>void;done:(message:string)=>Promise<void>}){async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();const client=getSupabase();if(!client)return;const{score,payload}=buildLeadPayload(new FormData(e.currentTarget),data,crm,lead);const result=lead?await client.from("crm_records").update(payload).eq("id",lead.id):await client.from("crm_records").insert(payload);if(result.error)throw result.error;await done(lead?"Lead e cadastro do comprador atualizados.":`Lead criado com score ${score}.`);close();}return <div className="modal-backdrop" onMouseDown={close}><form className="modal extra-large crm5-modal" onSubmit={submit} onMouseDown={e=>e.stopPropagation()}><button className="modal-close" type="button" onClick={close}>×</button><header><small>{lead?"EDITAR LEAD / COMPRADOR":"NOVO LEAD"}</small><h2>{lead?.person_name||"Cadastro comercial e contratual"}</h2><p>Atendimento, qualificação, dados civis, endereço e documentação do comprador.</p></header><LeadCommercialFields data={data} crm={crm} lead={lead}/><BuyerProfileFields lead={lead}/><section className="buyer-form-section"><label>Observações<textarea name="notes" rows={4} defaultValue={lead?.notes||""}/></label></section>{lead&&<BuyerDocuments data={data} leadId={lead.id}/>}<footer><button type="button" onClick={close}>Cancelar</button><button className="primary">{lead?"Salvar cadastro completo":"Criar e distribuir lead"}</button></footer></form></div>}
