"use client";

import {useState} from "react";
import {getSupabase} from "@/lib/supabase";
import type {ErpData} from "../../types";
import {canAdmin} from "../../utils";
import type {SalesContract,SalesData} from "./types";
import {brl,escapeHtml,openPrintDocument,statusLabel} from "./utils";
import {createContractShare,logContractSend} from "./contract-share";
import {ContractCancelModal} from "./contract-cancel-modal";

export function ContractsViewV56({data,sales,reload}:{data:ErpData;sales:SalesData;reload:()=>Promise<void>}){
 const[cancel,setCancel]=useState<SalesContract|null>(null),[message,setMessage]=useState("");
 const role=String(data.membership.role||"").toLowerCase(),canDecide=canAdmin(data.membership.role)||["diretoria","diretor"].includes(role);

 function printContract(contract:SalesContract){
  const proposal=sales.proposals.find(item=>item.id===contract.proposal_id),unit=sales.units.find(item=>item.id===contract.unit_id),project=data.projects.find(item=>item.id===contract.project_id),template=sales.templates.find(item=>item.template_key===contract.template_key)||sales.templates[0],installments=sales.installments.filter(item=>item.proposal_id===contract.proposal_id),events=(sales.signatureEvents||[]).filter(event=>event.entity_type==="contract"&&event.entity_id===contract.id);
  if(!proposal||!unit||!project)return;
  const profile=proposal.customer_profile||{},clauses=(template?.clauses||[]).map((clause,index)=>`<h3>${index+1}. ${escapeHtml(clause.title)}</h3><p>${escapeHtml(clause.text)}</p>`).join(""),buyer=`${escapeHtml(proposal.customer_name)}, ${escapeHtml(String(profile.nationality||""))}, ${escapeHtml(String(profile.marital_status||""))}, ${escapeHtml(String(profile.occupation||""))}, CPF/CNPJ ${escapeHtml(proposal.customer_document||"")}, residente em ${escapeHtml(String(profile.street||""))}, ${escapeHtml(String(profile.address_number||""))}, ${escapeHtml(String(profile.city||""))}/${escapeHtml(String(profile.state||""))}.`;
  const certificate=events.length?`<div style="page-break-before:always"><h1>Certificado de evidências eletrônicas</h1><p>Este anexo integra o contrato ${escapeHtml(contract.contract_number)}.</p>${events.map((event,index)=>`<h2>Evento ${index+1} — ${escapeHtml(event.signer_role)}</h2><table><tr><th>Signatário</th><td>${escapeHtml(event.signer_name)}</td><th>Timestamp</th><td>${new Date(event.created_at).toLocaleString("pt-BR")}</td></tr><tr><th>Hash do documento</th><td colspan="3"><code>${escapeHtml(event.document_hash||"")}</code></td></tr><tr><th>Hash da evidência</th><td colspan="3"><code>${escapeHtml(event.evidence_hash||"")}</code></td></tr><tr><th>IP</th><td>${escapeHtml(event.ip_address||"Não disponível")}</td><th>Fuso</th><td>${escapeHtml(event.timezone||"Não disponível")}</td></tr><tr><th>Geolocalização</th><td colspan="3">${event.geolocation?.latitude!=null?`${event.geolocation.latitude}, ${event.geolocation.longitude} · precisão ${event.geolocation.accuracy||"—"} m`:"Não autorizada ou indisponível"}</td></tr><tr><th>Navegador</th><td colspan="3">${escapeHtml(event.user_agent||"Não disponível")}</td></tr></table>`).join("")}</div>`:"";
  const body=`<header><img src="${location.origin}/evora-brand.svg" style="width:260px"><h1>${escapeHtml(template?.title||"Instrumento Particular")}</h1><p class="muted">Contrato ${escapeHtml(contract.contract_number)} · Proposta ${escapeHtml(proposal.proposal_number)}</p></header><h2>Comprador</h2><p>${buyer}</p><h2>Quadro resumo</h2><table><tr><th>Empreendimento</th><td>${escapeHtml(project.name)}</td><th>Unidade</th><td>${escapeHtml(unit.unit_code)}</td></tr><tr><th>Quadra / lote</th><td>${escapeHtml(unit.block_code)} / ${escapeHtml(unit.lot_number)}</td><th>Área</th><td>${unit.area} m²</td></tr><tr><th>Preço</th><td class="total">${brl.format(Number(proposal.sale_price))}</td><th>Entrada</th><td>${proposal.down_payment_installments_count||1}x · ${brl.format(Number(proposal.down_payment))}</td></tr></table><p>${escapeHtml((template?.body||"").replaceAll("{{UNIDADE}}",unit.unit_code).replaceAll("{{EMPREENDIMENTO}}",project.name))}</p>${clauses}<h2>Plano de pagamento</h2><table><tr><th>#</th><th>Tipo</th><th>Vencimento</th><th>Valor</th></tr>${installments.map(item=>`<tr><td>${item.installment_number}</td><td>${item.installment_type}</td><td>${new Date(`${item.due_date}T12:00:00`).toLocaleDateString("pt-BR")}</td><td>${brl.format(Number(item.amount))}</td></tr>`).join("")}</table><p class="muted">Autenticidade verificável pela plataforma Évora Gestão.</p><div class="signature"><div>Évora Urbanismo</div><div>${escapeHtml(proposal.customer_name)}</div></div>${certificate}`;
  openPrintDocument(`Contrato ${contract.contract_number}`,body);
 }

 async function share(contract:SalesContract,channel:"email"|"whatsapp"|"link"){
  const proposal=sales.proposals.find(item=>item.id===contract.proposal_id);if(!proposal)return;
  const url=await createContractShare(data,sales,contract);
  if(channel==="link"){await logContractSend(data,contract,"link","",url);await navigator.clipboard.writeText(url);alert("Contrato aceito pela empresa e link copiado.")}
  else if(channel==="whatsapp"){const phone=(proposal.customer_phone||"").replace(/\D/g,"");await logContractSend(data,contract,"whatsapp",phone,url);window.open(`https://wa.me/${phone}?text=${encodeURIComponent(`Olá, ${proposal.customer_name}. Acesse e aceite o contrato ${contract.contract_number}: ${url}`)}`,"_blank")}
  else{await logContractSend(data,contract,"email",proposal.customer_email||"",url);location.href=`mailto:${proposal.customer_email||""}?subject=${encodeURIComponent(`Contrato ${contract.contract_number} — Évora Urbanismo`)}&body=${encodeURIComponent(`Olá, ${proposal.customer_name}.\n\nAcesse, confira e aceite eletronicamente: ${url}`)}`}
  await reload();
 }

 async function cancelUnsigned(contract:SalesContract){
  const reason=prompt("Informe o motivo do cancelamento do contrato ainda não aceito pelo comprador:");if(!reason)return;
  if(!confirm(`Confirma o cancelamento do contrato ${contract.contract_number}? O link será desativado e a unidade poderá voltar ao estoque.`))return;
  const client=getSupabase();if(!client)return;
  const result=await client.rpc("crm_cancel_unsigned_contract",{p_contract_id:contract.id,p_reason:reason});
  if(result.error){setMessage(result.error.message);return}
  await reload();
 }

 return <div className="crm5-stack">
  {message&&<button className="notice" onClick={()=>setMessage("")}>{message}</button>}
  <section className="crm5-section-header"><div><small>ACEITE ELETRÔNICO E RECEBÍVEIS</small><h2>Contratos</h2><p>Envio, aceite auditável, cancelamento prévio e integração automática ao financeiro.</p></div></section>
  <section className="contract-list">{sales.contracts.map(contract=>{const proposal=sales.proposals.find(item=>item.id===contract.proposal_id),unit=sales.units.find(item=>item.id===contract.unit_id),emitted=sales.installments.filter(item=>item.proposal_id===contract.proposal_id&&item.financial_entry_id).length,companyAccepted=!!(contract as any).company_signed_at,customerAccepted=!!(contract as any).customer_signed_at,signatureStatus=(contract as any).signature_status||"pendente_empresa",canCancelUnsigned=canDecide&&!customerAccepted&&contract.status!=="cancelado";return <article key={contract.id}><header><div><small>{contract.contract_number}</small><h3>{proposal?.customer_name||"Cliente"}</h3><span>{data.projects.find(item=>item.id===contract.project_id)?.name} · {unit?.unit_code}</span></div><i data-status={contract.status}>{statusLabel[contract.status]||contract.status}</i></header><div className="contract-stats"><span><small>Valor</small>{brl.format(Number(proposal?.sale_price||0))}</span><span><small>Empresa</small>{companyAccepted?"Aceito":"Pendente"}</span><span><small>Comprador</small>{customerAccepted?"Aceito":"Pendente"}</span><span><small>Recebíveis</small>{emitted}</span></div><div className="signature-flow-status" data-status={signatureStatus}><strong>{signatureStatus==="concluida"?"Aceite bilateral concluído":signatureStatus==="pendente_cliente"?"Aguardando aceite do comprador":"Aguardando envio e aceite da empresa"}</strong>{(contract as any).document_hash&&<code>{(contract as any).document_hash}</code>}</div>{contract.cancellation_reason&&<div className="feedback error">Cancelado: {contract.cancellation_reason}</div>}<footer><button onClick={()=>printContract(contract)}>Gerar contrato / PDF</button>{contract.status!=="cancelado"&&<><button onClick={()=>share(contract,"link")}>Aceitar pela empresa e copiar link</button><button onClick={()=>share(contract,"whatsapp")}>WhatsApp</button><button onClick={()=>share(contract,"email")}>E-mail</button></>}{canCancelUnsigned&&<button className="danger-button" onClick={()=>cancelUnsigned(contract)}>Cancelar antes do aceite</button>}{customerAccepted&&contract.status==="assinado"&&canAdmin(data.membership.role)&&<button className="danger-button" onClick={()=>setCancel(contract)}>Distrato / cancelamento jurídico</button>}</footer></article>})}{!sales.contracts.length&&<div className="crm5-empty"><strong>Nenhum contrato gerado</strong><p>O contrato será criado automaticamente quando o cliente aceitar a proposta.</p></div>}</section>
  {cancel&&<ContractCancelModal data={data} sales={sales} contract={cancel} close={()=>setCancel(null)} reload={reload}/>}</div>;
}
