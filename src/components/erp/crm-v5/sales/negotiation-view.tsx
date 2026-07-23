"use client";

import {FormEvent,useMemo,useState} from "react";
import {getSupabase} from "@/lib/supabase";
import type {ErpData} from "../../types";
import type {NegotiationPolicy,SalesData} from "./types";
import {brl,buildPlan,proposalCompliance} from "./utils";
import {CurrencyInput} from "./currency-input";

const today=()=>new Date().toISOString().slice(0,10);

function policyState(policy:NegotiationPolicy){
  const current=today();
  if(!policy.active)return "Inativa";
  if(policy.valid_from&&policy.valid_from>current)return "Programada";
  if(policy.valid_until&&policy.valid_until<current)return "Encerrada";
  return "Vigente";
}

export function NegotiationView({data,sales,reload}:{data:ErpData;sales:SalesData;reload:()=>Promise<void>}){
  const[project,setProject]=useState(data.projects[0]?.id||"");
  const[selectedPolicyId,setSelectedPolicyId]=useState("");
  const[unitId,setUnitId]=useState("");
  const[edit,setEdit]=useState<NegotiationPolicy|null|"new">(null);
  const[message,setMessage]=useState("");
  const[assigning,setAssigning]=useState("");
  const projectPolicies=useMemo(()=>sales.policies.filter(item=>item.project_id===project),[sales.policies,project]);
  const campaigns=useMemo(()=>sales.campaigns.filter(item=>item.project_id===project),[sales.campaigns,project]);
  const policy=projectPolicies.find(item=>item.id===selectedPolicyId)||projectPolicies.find(item=>item.is_default&&item.active)||projectPolicies[0];
  const units=sales.units.filter(item=>item.project_id===project&&item.status==="disponivel");
  const unit=units.find(item=>item.id===unitId);
  const[values,setValues]=useState({salePrice:0,downPayment:0,downPaymentInstallments:1,installments:120,balloonTotal:0,balloonCount:8,firstDueDate:today(),downFirstDueDate:today()});

  function changeProject(value:string){setProject(value);setUnitId("");setSelectedPolicyId("");}
  function selectUnit(id:string){
    setUnitId(id);
    const selected=units.find(item=>item.id===id);
    if(selected)setValues(current=>({...current,salePrice:Number(selected.list_price),downPayment:Number(selected.list_price)*(policy?.min_down_payment_pct||.2),downPaymentInstallments:1,installments:policy?.max_installments||120}));
  }
  async function assignPolicy(campaignId:string,policyId:string){
    const client=getSupabase();
    if(!client)return;
    setAssigning(campaignId);setMessage("");
    const result=await client.from("crm_campaigns").update({negotiation_policy_id:policyId||null,updated_at:new Date().toISOString()}).eq("id",campaignId).eq("organization_id",data.organization.id);
    if(result.error)setMessage(result.error.message);
    else{setMessage("Política da campanha atualizada.");await reload();}
    setAssigning("");
  }

  const plan=unit?buildPlan({salePrice:values.salePrice,downPayment:values.downPayment,downPaymentInstallments:values.downPaymentInstallments,downPaymentFirstDueDate:values.downFirstDueDate,downPaymentFrequencyDays:Number(policy?.down_payment_frequency_days||30),downPaymentRate:Number(policy?.down_payment_interest_rate||0),installments:values.installments,monthlyRate:Number(policy?.monthly_interest_rate||0),graceMonths:Number(policy?.grace_months||0),balloonTotal:values.balloonTotal,balloonCount:values.balloonCount,balloonFrequency:Number(policy?.balloon_frequency_months||12),firstDueDate:values.firstDueDate}):[];
  const compliance=unit?proposalCompliance(unit,policy,{salePrice:values.salePrice,downPayment:values.downPayment,downPaymentInstallments:values.downPaymentInstallments,installments:values.installments,balloonTotal:values.balloonTotal}):{requiresApproval:false,reasons:[]};
  const monthly=plan.find(item=>item.installment_type==="mensal")?.amount||0;
  const downInstallment=plan.find(item=>item.installment_type==="entrada")?.amount||0;

  return <div className="crm5-stack policy-management">
    {message&&<button className="notice" onClick={()=>setMessage("")}>{message}<span>×</span></button>}
    <section className="crm5-section-header policy-header">
      <div><small>GOVERNANÇA COMERCIAL</small><h2>Políticas comerciais e alçadas</h2><p>Crie regras distintas e determine qual delas será aplicada em cada campanha.</p></div>
      <div className="toolbar-actions policy-toolbar">
        <select aria-label="Empreendimento" value={project} onChange={event=>changeProject(event.target.value)}>{data.projects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <button onClick={()=>setEdit("new")}>+ Nova política</button>
        <button className="primary" disabled={!policy} onClick={()=>policy&&setEdit(policy)}>Editar política</button>
      </div>
    </section>

    <section className="commercial-policy-workspace">
      <aside className="policy-selector" aria-label="Políticas comerciais do empreendimento">
        <header><div><small>POLÍTICAS CADASTRADAS</small><strong>{projectPolicies.length}</strong></div><p>A política padrão é usada quando a campanha não possui uma regra própria.</p></header>
        <div>{projectPolicies.map(item=><button key={item.id} className={policy?.id===item.id?"active":""} onClick={()=>setSelectedPolicyId(item.id)}>
          <span><strong>{item.name}</strong><small>{item.description||"Sem descrição"}</small></span>
          <i data-state={policyState(item).toLowerCase()}>{item.is_default?"Padrão":policyState(item)}</i>
        </button>)}</div>
        {!projectPolicies.length&&<div className="crm5-empty"><strong>Nenhuma política</strong><p>Cadastre a primeira política comercial deste empreendimento.</p><button className="primary" onClick={()=>setEdit("new")}>Criar política</button></div>}
      </aside>

      <div className="policy-detail">
        {policy?<>
          <header><div><small>POLÍTICA SELECIONADA</small><h3>{policy.name}</h3><p>{policy.description||"Condições comerciais, limites e alçadas desta política."}</p></div><span data-state={policyState(policy).toLowerCase()}>{policyState(policy)}</span></header>
          <section className="negotiation-policy-grid">
            <article><small>Entrada mínima</small><strong>{(policy.min_down_payment_pct*100).toFixed(1)}%</strong></article>
            <article><small>Entrada parcelada</small><strong>{policy.allow_down_payment_installments?`até ${policy.max_down_payment_installments}x`:"Não"}</strong></article>
            <article><small>Desconto máximo</small><strong>{(policy.max_discount_pct*100).toFixed(1)}%</strong></article>
            <article><small>Alçada administrativa</small><strong>{(policy.admin_approval_discount_pct*100).toFixed(1)}%</strong></article>
            <article><small>Prazo máximo</small><strong>{policy.max_installments} meses</strong></article>
            <article><small>Parcela mínima</small><strong>{brl.format(Number(policy.min_installment||0))}</strong></article>
            <article><small>Juros mensais</small><strong>{(policy.monthly_interest_rate*100).toFixed(3)}%</strong></article>
            <article><small>Indexador</small><strong>{policy.indexer}</strong></article>
            <article><small>Balões</small><strong>até {(policy.balloon_limit_pct*100).toFixed(0)}%</strong></article>
            <article><small>Reserva</small><strong>{policy.reservation_validity_hours} h</strong></article>
          </section>
        </>:<div className="crm5-empty"><strong>Selecione ou crie uma política</strong><p>As condições selecionadas também alimentam o simulador.</p></div>}
      </div>
    </section>

    <section className="campaign-policy-assignment">
      <header><div><small>ATRIBUIÇÃO POR CAMPANHA</small><h3>Campanhas comerciais</h3><p>Cada proposta originada de uma campanha congela a política vigente no momento da submissão.</p></div><span>{campaigns.length} campanha{campaigns.length===1?"":"s"}</span></header>
      <div>{campaigns.map(campaign=><article key={campaign.id}>
        <div><strong>{campaign.name}</strong><small>{campaign.channel||campaign.campaign_type} · {campaign.status}</small></div>
        <label>Política aplicável<select value={campaign.negotiation_policy_id||""} disabled={assigning===campaign.id} onChange={event=>assignPolicy(campaign.id,event.target.value)}><option value="">Usar política padrão</option>{projectPolicies.filter(item=>item.active).map(item=><option key={item.id} value={item.id}>{item.name}{item.is_default?" · padrão":""}</option>)}</select></label>
      </article>)}</div>
      {!campaigns.length&&<div className="crm5-empty"><strong>Nenhuma campanha vinculada</strong><p>Cadastre uma campanha comercial com este empreendimento para atribuir uma política específica.</p></div>}
    </section>

    <section className="negotiation-simulator">
      <header><div><small>SIMULADOR</small><h3>Condição comercial</h3><p>{policy?`Aplicando ${policy.name}`:"Cadastre uma política para simular"}</p></div><select value={unitId} onChange={event=>selectUnit(event.target.value)} disabled={!policy}><option value="">Selecione uma unidade disponível</option>{units.map(item=><option key={item.id} value={item.id}>{item.unit_code} · {item.area} m² · {brl.format(Number(item.list_price))}</option>)}</select></header>
      {unit&&policy?<><div className="form-grid four"><label>Preço de venda<CurrencyInput value={values.salePrice} onValueChange={salePrice=>setValues(current=>({...current,salePrice}))}/></label><label>Entrada total<CurrencyInput value={values.downPayment} onValueChange={downPayment=>setValues(current=>({...current,downPayment}))}/></label><label>Parcelas da entrada<input type="number" min="1" max={policy.max_down_payment_installments||12} value={values.downPaymentInstallments} onChange={event=>setValues(current=>({...current,downPaymentInstallments:Number(event.target.value)}))}/></label><label>1º vencimento da entrada<input type="date" value={values.downFirstDueDate} onChange={event=>setValues(current=>({...current,downFirstDueDate:event.target.value}))}/></label><label>Parcelas mensais<input type="number" value={values.installments} onChange={event=>setValues(current=>({...current,installments:Number(event.target.value)}))}/></label><label>Primeiro vencimento<input type="date" value={values.firstDueDate} onChange={event=>setValues(current=>({...current,firstDueDate:event.target.value}))}/></label><label>Total em balões<CurrencyInput value={values.balloonTotal} onValueChange={balloonTotal=>setValues(current=>({...current,balloonTotal}))}/></label><label>Quantidade de balões<input type="number" value={values.balloonCount} onChange={event=>setValues(current=>({...current,balloonCount:Number(event.target.value)}))}/></label></div><div className="negotiation-result"><article><small>Preço de tabela</small><strong>{brl.format(Number(unit.list_price))}</strong></article><article><small>Preço proposto</small><strong>{brl.format(values.salePrice)}</strong></article><article><small>Entrada parcelada</small><strong>{values.downPaymentInstallments}x de {brl.format(downInstallment)}</strong></article><article><small>Parcela mensal</small><strong>{brl.format(monthly)}</strong></article><article className={compliance.requiresApproval?"risk":"ok"}><small>Governança</small><strong>{compliance.requiresApproval?"Exige aprovação":"Dentro da política"}</strong></article></div>{compliance.reasons.length>0&&<div className="feedback error"><strong>Motivos para aprovação:</strong> {compliance.reasons.join(" · ")}</div>}<details className="payment-plan-preview"><summary>Ver plano de pagamento ({plan.length} lançamentos)</summary><div>{plan.map(item=><span key={`${item.installment_type}-${item.installment_number}`}><b>{item.installment_number}</b>{item.installment_type}<time>{new Date(`${item.due_date}T12:00:00`).toLocaleDateString("pt-BR")}</time><strong>{brl.format(item.amount)}</strong></span>)}</div></details></>:<div className="crm5-empty"><strong>Selecione uma unidade</strong><p>O simulador utilizará a política comercial selecionada.</p></div>}
    </section>
    {edit&&<PolicyModal data={data} projectId={project} policy={edit==="new"?null:edit} close={()=>setEdit(null)} reload={reload}/>}
  </div>;
}

function PolicyModal({data,projectId,policy,close,reload}:{data:ErpData;projectId:string;policy:NegotiationPolicy|null;close:()=>void;reload:()=>Promise<void>}){
  const[error,setError]=useState("");
  const[saving,setSaving]=useState(false);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setSaving(true);setError("");
    const form=new FormData(event.currentTarget);const client=getSupabase();
    if(!client){setError("Supabase indisponível.");setSaving(false);return;}
    const pct=(name:string)=>Number(form.get(name)||0)/100;
    const active=form.get("active")==="on";
    const payload={organization_id:data.organization.id,project_id:projectId,name:String(form.get("name")),description:String(form.get("description")||"")||null,active,is_default:active&&form.get("is_default")==="on",valid_from:String(form.get("valid_from")||"")||null,valid_until:String(form.get("valid_until")||"")||null,min_down_payment_pct:pct("min_down"),max_discount_pct:pct("max_discount"),admin_approval_discount_pct:pct("admin_discount"),max_installments:Number(form.get("max_installments")),min_installment:Number(form.get("min_installment")||0),monthly_interest_rate:pct("monthly_rate"),indexer:String(form.get("indexer")),grace_months:Number(form.get("grace_months")||0),balloon_limit_pct:pct("balloon_limit"),balloon_frequency_months:Number(form.get("balloon_frequency")||12),proposal_validity_days:Number(form.get("proposal_validity")||5),reservation_validity_hours:Number(form.get("reservation_validity")||24),allow_down_payment_installments:form.get("allow_down_installments")==="on",max_down_payment_installments:Number(form.get("max_down_installments")||1),down_payment_first_due_days:Number(form.get("down_first_due_days")||0),down_payment_frequency_days:Number(form.get("down_frequency_days")||30),down_payment_interest_rate:pct("down_interest_rate"),require_admin_below_min_price:true,allow_custom_schedule:true,updated_by:data.session.user.id,updated_at:new Date().toISOString(),...(!policy?{created_by:data.session.user.id}:{})};
    const result=policy?await client.from("crm_negotiation_parameters").update(payload).eq("id",policy.id):await client.from("crm_negotiation_parameters").insert(payload);
    if(result.error){setError(result.error.message);setSaving(false);return;}
    await reload();close();
  }
  return <div className="modal-backdrop" onMouseDown={close}><form className="modal large crm5-modal" onSubmit={submit} onMouseDown={event=>event.stopPropagation()}><button type="button" className="modal-close" onClick={close}>×</button><header><small>POLÍTICA COMERCIAL</small><h2>{policy?.name||"Nova política comercial"}</h2><p>Defina vigência, limites e alçadas. Propostas já submetidas não serão alteradas.</p></header>{error&&<div className="feedback error">{error}</div>}<div className="form-grid three"><label className="span-2">Nome<input name="name" defaultValue={policy?.name||"Política comercial"} required/></label><label>Entrada mínima (%)<input name="min_down" type="number" min="0" max="100" step="0.01" defaultValue={(policy?.min_down_payment_pct||.2)*100}/></label><label className="span-3">Descrição<textarea name="description" rows={2} defaultValue={policy?.description||""}/></label><label>Início da vigência<input name="valid_from" type="date" defaultValue={policy?.valid_from||""}/></label><label>Fim da vigência<input name="valid_until" type="date" defaultValue={policy?.valid_until||""}/></label><label className="checkbox-line"><input name="active" type="checkbox" defaultChecked={policy?.active??true}/><span>Política ativa</span></label><label className="checkbox-line"><input name="is_default" type="checkbox" defaultChecked={policy?.is_default??!policy}/><span>Usar como política padrão</span></label><label className="checkbox-line span-2"><input name="allow_down_installments" type="checkbox" defaultChecked={policy?.allow_down_payment_installments}/><span>Permitir parcelamento da entrada</span></label><label>Máximo de parcelas da entrada<input name="max_down_installments" type="number" min="1" defaultValue={policy?.max_down_payment_installments||1}/></label><label>1º vencimento da entrada (dias)<input name="down_first_due_days" type="number" min="0" defaultValue={policy?.down_payment_first_due_days||0}/></label><label>Frequência da entrada (dias)<input name="down_frequency_days" type="number" min="1" defaultValue={policy?.down_payment_frequency_days||30}/></label><label>Juros da entrada (%)<input name="down_interest_rate" type="number" step="0.001" defaultValue={(policy?.down_payment_interest_rate||0)*100}/></label><label>Desconto máximo (%)<input name="max_discount" type="number" step="0.01" defaultValue={(policy?.max_discount_pct||.05)*100}/></label><label>Alçada administrativa (%)<input name="admin_discount" type="number" step="0.01" defaultValue={(policy?.admin_approval_discount_pct||.03)*100}/></label><label>Prazo máximo<input name="max_installments" type="number" defaultValue={policy?.max_installments||120}/></label><label>Parcela mínima<CurrencyInput name="min_installment" defaultValue={policy?.min_installment||0}/></label><label>Juros mensais (%)<input name="monthly_rate" type="number" step="0.001" defaultValue={(policy?.monthly_interest_rate||.005)*100}/></label><label>Indexador<input name="indexer" defaultValue={policy?.indexer||"IPCA"}/></label><label>Carência (meses)<input name="grace_months" type="number" defaultValue={policy?.grace_months||0}/></label><label>Limite de balões (%)<input name="balloon_limit" type="number" step="0.01" defaultValue={(policy?.balloon_limit_pct||.4)*100}/></label><label>Frequência dos balões<input name="balloon_frequency" type="number" defaultValue={policy?.balloon_frequency_months||12}/></label><label>Validade da proposta (dias)<input name="proposal_validity" type="number" defaultValue={policy?.proposal_validity_days||5}/></label><label>Validade da reserva (horas)<input name="reservation_validity" type="number" defaultValue={policy?.reservation_validity_hours||24}/></label></div><footer><button type="button" onClick={close}>Cancelar</button><button className="primary" disabled={saving}>{saving?"Salvando…":"Salvar política"}</button></footer></form></div>;
}
