"use client";
import {FormEvent} from "react";
import {getSupabase} from "@/lib/supabase";
import type {CrmRecord,ErpData} from "../types";
import {BuyerProfileFields} from "./buyer-profile-fields";
import {BuyerDocuments} from "./buyer-documents";
import {buyerPayload} from "./buyer-profile";
export function BuyerProfileModal({data,lead,close,done}:{data:ErpData;lead:CrmRecord;close:()=>void;done:(message:string)=>Promise<void>}){async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();const client=getSupabase();if(!client)return;const result=await client.from("crm_records").update({...buyerPayload(new FormData(e.currentTarget)),updated_at:new Date().toISOString()}).eq("id",lead.id);if(result.error)throw result.error;await done("Cadastro do comprador atualizado.");close();}return <div className="modal-backdrop" onMouseDown={close}><form className="modal extra-large crm5-modal" onSubmit={submit} onMouseDown={e=>e.stopPropagation()}><button className="modal-close" type="button" onClick={close}>×</button><header><small>CADASTRO DO COMPRADOR</small><h2>{lead.person_name}</h2><p>Dados civis, endereço, cônjuge e documentação para proposta e contrato.</p></header><BuyerProfileFields lead={lead}/><BuyerDocuments data={data} leadId={lead.id}/><footer><button type="button" onClick={close}>Cancelar</button><button className="primary">Salvar cadastro contratual</button></footer></form></div>}
