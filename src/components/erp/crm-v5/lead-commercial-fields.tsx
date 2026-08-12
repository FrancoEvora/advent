"use client";

import { useState } from "react";
import type { CrmRecord, ErpData } from "../types";
import type { CrmEnterpriseData } from "./types";
import { CurrencyInput } from "./sales/currency-input";

function toLocalDateTime(value:string|null|undefined) {
  if(!value)return "";
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return "";
  const local=new Date(date.getTime()-date.getTimezoneOffset()*60_000);
  return local.toISOString().slice(0,16);
}

export function LeadCommercialFields({data,crm,lead}:{data:ErpData;crm:CrmEnterpriseData;lead:CrmRecord|null}) {
  const defaultPipeline=crm.pipelines.find(i=>i.is_default)?.id||crm.pipelines[0]?.id||"";
  const [pipelineId,setPipelineId]=useState(lead?.pipeline_id||defaultPipeline);
  const [stageId,setStageId]=useState(lead?.stage_id||"");
  const [projectId,setProjectId]=useState(lead?.project_id||"");
  const [campaignId,setCampaignId]=useState(lead?.campaign_id||"");
  const [productId,setProductId]=useState(()=>{
    if(lead?.product_id)return lead.product_id;
    const initialProducts=crm.products.filter(item=>
      item.project_id===lead?.project_id&&item.active
    );
    return initialProducts.length===1?initialProducts[0].id:"";
  });
  const structuredSource=crm.leadSources.find(item=>item.id===lead?.lead_source_id);
  const structuredSourceLocked=Boolean(structuredSource&&!structuredSource.manual_selectable);
  const products=crm.products.filter(item=>
    item.project_id===projectId&&(item.active||item.id===lead?.product_id)
  );
  const campaigns=crm.campaigns.filter(item=>item.project_id===projectId);
  const selectedStage=crm.stages.find(item=>item.id===stageId);
  const isLostStage=Boolean(selectedStage?.is_lost);
  const lossReasons=crm.lossReasons.filter(item=>
    item.active||item.id===lead?.loss_reason_id
  );
  const memberName=(id:string|null|undefined)=>id
    ? data.profiles.find(p=>p.id===id)?.full_name
      ||data.profiles.find(p=>p.id===id)?.email
      ||"Usuário cadastrado"
    : "Não designado";

  function selectProject(nextProjectId:string) {
    setProjectId(nextProjectId);
    const selectedProduct=crm.products.find(item=>item.id===productId);
    const selectedCampaign=crm.campaigns.find(item=>item.id===campaignId);
    if(selectedCampaign?.project_id!==nextProjectId)setCampaignId("");
    if(!nextProjectId){setProductId("");return;}
    if(selectedProduct?.project_id===nextProjectId)return;
    const nextProducts=crm.products.filter(item=>
      item.project_id===nextProjectId&&item.active
    );
    setProductId(nextProducts.length===1?nextProducts[0].id:"");
  }

  function selectPipeline(nextPipelineId:string) {
    setPipelineId(nextPipelineId);
    const selectedStage=crm.stages.find(item=>item.id===stageId);
    if(selectedStage?.pipeline_id===nextPipelineId)return;
    const firstStage=crm.stages
      .filter(item=>item.pipeline_id===nextPipelineId&&item.active)
      .sort((a,b)=>a.position-b.position)[0];
    setStageId(firstStage?.id||"");
  }

  return <section className="buyer-form-section">
    <h3>Dados comerciais</h3>
    <div className="form-grid three">
      <label>Nome completo<input name="person_name" defaultValue={lead?.person_name||""} required/></label>
      <label>Empresa<input name="company_name" defaultValue={lead?.company_name||""}/></label>
      <label>Telefone / WhatsApp<input name="phone" defaultValue={lead?.phone||""}/></label>
      <label>E-mail<input name="email" type="email" defaultValue={lead?.email||""}/></label>
      <label>Empreendimento<select name="project_id" value={projectId} onChange={event=>selectProject(event.target.value)}><option value="">Não definido</option>{data.projects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Produto<select name="product_id" value={productId} onChange={event=>setProductId(event.target.value)} disabled={!projectId}><option value="">{projectId?"Não definido":"Selecione o empreendimento"}</option>{products.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Origem<input name="source" defaultValue={lead?.source||""}/></label>
      <label>Fonte estruturada{structuredSourceLocked?<><input type="hidden" name="lead_source_id" value={structuredSource?.id||""}/><input value={structuredSource?.name||"Integração"} readOnly/></>:<select name="lead_source_id" defaultValue={lead?.lead_source_id||""}><option value="">Não definida</option>{crm.leadSources.filter(item=>(item.active&&item.manual_selectable)||item.id===lead?.lead_source_id).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>}</label>
      <label>Canal{structuredSourceLocked?<><input type="hidden" name="source_channel" value={structuredSource?.channel||lead?.source_channel||""}/><input value={structuredSource?.channel||lead?.source_channel||"Integração"} readOnly/></>:<select name="source_channel" defaultValue={lead?.source_channel||"whatsapp"}>{lead?.source_channel&&!['whatsapp','instagram','facebook','site','telefone','evento','indicação'].includes(lead.source_channel)&&<option value={lead.source_channel}>{lead.source_channel}</option>}<option>whatsapp</option><option>instagram</option><option>facebook</option><option>site</option><option>telefone</option><option>evento</option><option>indicação</option></select>}</label>
      <label>Campanha<select name="campaign_id" value={campaignId} onChange={event=>setCampaignId(event.target.value)} disabled={!projectId}><option value="">Sem campanha</option>{campaigns.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Pipeline<select name="pipeline_id" value={pipelineId} onChange={event=>selectPipeline(event.target.value)}>{crm.pipelines.filter(item=>item.active||item.id===lead?.pipeline_id).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Etapa<select name="stage_id" value={stageId} onChange={event=>setStageId(event.target.value)}><option value="">Etapa inicial</option>{crm.stages.filter(item=>item.pipeline_id===pipelineId&&(item.active||item.id===lead?.stage_id)).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Motivo da perda<select name="loss_reason_id" defaultValue={lead?.loss_reason_id||""} disabled={!isLostStage} required={isLostStage}><option value="">Selecione o motivo</option>{lossReasons.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <div className="crm5-assignment-readonly"><small>SDR responsável</small><strong>{memberName(lead?.sdr_user_id)}</strong><span>Designação formal na Mesa SDR</span></div>
      <div className="crm5-assignment-readonly"><small>Corretor</small><strong>{memberName(lead?.broker_user_id)}</strong><span>Designação formal na Mesa SDR</span></div>
      <label>Temperatura<select name="temperature" defaultValue={lead?.temperature||"morno"}><option value="frio">Frio</option><option value="morno">Morno</option><option value="quente">Quente</option></select></label>
      <label>Prioridade<select name="priority" defaultValue={lead?.priority||"normal"}><option value="baixa">Baixa</option><option value="normal">Normal</option><option value="alta">Alta</option><option value="urgente">Urgente</option></select></label>
      <label>Valor potencial<CurrencyInput name="estimated_value" defaultValue={lead?.estimated_value||0}/></label>
      <label>Orçamento mínimo<CurrencyInput name="budget_min" defaultValue={lead?.budget_min||0}/></label>
      <label>Orçamento máximo<CurrencyInput name="budget_max" defaultValue={lead?.budget_max||0}/></label>
      <label>Capacidade de parcela<CurrencyInput name="payment_capacity" defaultValue={lead?.payment_capacity||0}/></label>
      <label>Área mínima<input name="preferred_area_min" type="number" step="0.01" defaultValue={lead?.preferred_area_min||0}/></label>
      <label>Área máxima<input name="preferred_area_max" type="number" step="0.01" defaultValue={lead?.preferred_area_max||0}/></label>
      <label>Cidade de interesse<input name="preferred_city" defaultValue={lead?.preferred_city||""}/></label>
      <label>Fechamento estimado<input name="expected_close_date" type="date" defaultValue={lead?.expected_close_date||""}/></label>
      <label>Próxima ação<input name="next_action_at" type="datetime-local" defaultValue={toLocalDateTime(lead?.next_action_at)}/></label>
      <label>Tags<input name="tags" defaultValue={lead?.tags?.join(", ")||""}/></label>
      <label>UTM source<input name="utm_source" defaultValue={lead?.utm_source||""}/></label>
      <label>UTM medium<input name="utm_medium" defaultValue={lead?.utm_medium||""}/></label>
      <label>UTM campaign<input name="utm_campaign" defaultValue={lead?.utm_campaign||""}/></label>
      <label className="checkbox-line"><input name="financing_interest" type="checkbox" defaultChecked={lead?.financing_interest}/><span>Interesse em financiamento</span></label>
    </div>
  </section>;
}
