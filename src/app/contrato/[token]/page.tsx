"use client";

import {FormEvent,useCallback,useEffect,useState} from "react";
import {useParams} from "next/navigation";
import {getSupabase} from "@/lib/supabase";
import {collectGeolocation,postElectronicEvidence} from "@/lib/e-sign-client";

const money=new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"});
const consentText="Declaro que li, compreendi e assino eletronicamente este contrato, concordando integralmente com seu conteúdo e com o plano de pagamento apresentado.";
function errorText(error:unknown){if(error instanceof Error)return error.message;if(typeof error==="string")return error;try{return JSON.stringify(error)}catch{return "Não foi possível concluir a assinatura do contrato."}}

export default function PublicContractPage(){
 const params=useParams<{token:string}>();
 const[data,setData]=useState<any>(null);
 const[error,setError]=useState("");
 const[busy,setBusy]=useState(false);
 const[signerName,setSignerName]=useState("");
 const[last4,setLast4]=useState("");
 const[terms,setTerms]=useState(false);
 const[geoConsent,setGeoConsent]=useState(false);
 const[certificate,setCertificate]=useState<any>(null);

 const load=useCallback(async()=>{
  const client=getSupabase();
  if(!client)return;
  const result=await client.rpc("crm_get_public_contract",{p_token:params.token});
  if(result.error||!result.data){setError("Contrato inválido, cancelado ou expirado.");return}
  setData(result.data);
  setSignerName((value:string)=>value||result.data.proposal?.customer_name||"");
 },[params.token]);

 useEffect(()=>{load()},[load]);

 async function sign(event:FormEvent){
  event.preventDefault();setBusy(true);setError("");
  try{
   if(last4.length!==4)throw new Error("Informe os quatro últimos dígitos do CPF ou CNPJ.");
   const geolocation=await collectGeolocation(geoConsent);
   const result=await postElectronicEvidence("/api/e-sign/contract",{
    token:params.token,
    signerName,
    documentLast4:last4,
    termsAccepted:terms,
    geolocationConsent:geoConsent,
    geolocation,
    consentText,
   });
   setCertificate(result);await load();
  }catch(err){setError(errorText(err))}
  finally{setBusy(false)}
 }

 if(error&&!data)return <main className="public-proposal-state"><img src="/evora-brand.svg" alt="Évora Urbanismo"/><h1>{error}</h1><p>Solicite uma nova via ao consultor responsável.</p></main>;
 if(!data)return <main className="public-proposal-state"><img src="/evora-brand.svg" alt="Évora Urbanismo"/><p>Carregando contrato...</p></main>;

 const c=data.contract,p=data.proposal,u=data.unit,project=data.project,t=data.template||{},signature=data.signature||{};
 return <main className="public-proposal public-contract">
  <header><img src="/evora-brand.svg" alt="Évora Urbanismo"/><div><small>CONTRATO</small><h1>{c.number}</h1><p>{project.name} · Unidade {u.code}</p></div></header>
  <section className="public-hero"><div><small>COMPRADOR</small><h2>{p.customer_name}</h2><p>{p.customer_profile?.marital_status||"Estado civil não informado"} · {p.customer_profile?.occupation||"Profissão não informada"}</p></div><article><small>VALOR CONTRATADO</small><strong>{money.format(Number(p.sale_price))}</strong><span>Entrada em {p.down_payment_installments_count||1} parcela(s)</span></article></section>
  <section className="public-terms"><article><small>Quadra / lote</small><strong>{u.block} / {u.lot}</strong></article><article><small>Área</small><strong>{u.area} m²</strong></article><article><small>Prazo mensal</small><strong>{p.installments_count} meses</strong></article><article><small>Atualização</small><strong>{(Number(p.monthly_interest_rate)*100).toFixed(3)}% a.m. + {p.indexer}</strong></article><article><small>Empresa</small><strong>{signature.company_signed?"Assinado":"Pendente"}</strong></article><article><small>Comprador</small><strong>{signature.customer_signed?"Assinado":"Pendente"}</strong></article></section>
  <section className="public-notes contract-reading"><h2>{t.title||"Instrumento Particular"}</h2><p>{t.body||"Documento contratual da comercialização imobiliária."}</p>{(t.clauses||[]).map((clause:any,index:number)=><article key={index}><h3>{index+1}. {clause.title}</h3><p>{clause.text}</p></article>)}</section>
  <section className="public-installments"><h2>Plano de pagamento</h2><div><header><span>#</span><span>Tipo</span><span>Vencimento</span><span>Valor</span></header>{(data.installments||[]).map((item:any)=><article key={`${item.type}-${item.number}`}><span>{item.number}</span><span>{item.type}</span><span>{new Date(`${item.due_date}T12:00:00`).toLocaleDateString("pt-BR")}</span><strong>{money.format(Number(item.amount))}</strong></article>)}</div></section>
  <section className="e-sign-panel">
   {!signature.company_signed?<div className="e-sign-waiting"><small>ASSINATURA DA EMPRESA PENDENTE</small><h2>Aguardando emissão formal</h2><p>Solicite ao consultor o envio formal do documento.</p></div>:
   signature.customer_signed?<div className="e-sign-success"><small>ASSINATURA ELETRÔNICA REGISTRADA</small><h2>Contrato assinado pelas partes</h2><p>Os recebíveis foram integrados automaticamente ao fluxo financeiro.</p><dl><div><dt>Empresa</dt><dd>{signature.company_signer} · {new Date(signature.company_signed_at).toLocaleString("pt-BR")}</dd></div><div><dt>Comprador</dt><dd>{signature.customer_signer} · {new Date(signature.customer_signed_at).toLocaleString("pt-BR")}</dd></div><div><dt>Hash do documento</dt><dd>{signature.document_hash}</dd></div></dl></div>:
   <form onSubmit={sign}>
    <small>ASSINATURA ELETRÔNICA DO CONTRATO</small><h2>Assinar contrato</h2>
    <p>A assinatura segue o mesmo fluxo simples do aceite da proposta e registra timestamp, IP, navegador, hash do documento e, somente mediante autorização, localização do dispositivo.</p>
    <div className="company-signature-summary"><strong>Assinado pela Évora Urbanismo</strong><span>{signature.company_signer} · {new Date(signature.company_signed_at).toLocaleString("pt-BR")}</span><code>{signature.document_hash}</code></div>
    <label>Nome completo<input value={signerName} onChange={event=>setSignerName(event.target.value)} required/></label>
    <label>Últimos 4 dígitos do CPF/CNPJ<input value={last4} onChange={event=>setLast4(event.target.value.replace(/\D/g,"").slice(0,4))} inputMode="numeric" maxLength={4} required/></label>
    <label className="e-sign-check discreet-check"><input type="checkbox" checked={terms} onChange={event=>setTerms(event.target.checked)} required/><span>{consentText}</span></label>
    <label className="e-sign-check discreet-check"><input type="checkbox" checked={geoConsent} onChange={event=>setGeoConsent(event.target.checked)}/><span>Autorizo o registro da localização como evidência adicional. A assinatura continua possível sem essa autorização.</span></label>
    {error&&<div className="feedback error">{error}</div>}
    <button className="primary wide" disabled={busy||!terms}>{busy?"Registrando assinatura...":"Assinar contrato"}</button>
   </form>}
   {certificate&&<p className="hint">Assinatura registrada: {certificate.evidence_hash} · {certificate.receivables_created} recebível(is).</p>}
  </section>
  <footer><p>Documento disponibilizado pela plataforma proprietária da Évora Urbanismo.</p><button onClick={()=>window.print()}>Imprimir ou salvar em PDF</button><small>© 2026 Évora Urbanismo</small></footer>
 </main>
}
