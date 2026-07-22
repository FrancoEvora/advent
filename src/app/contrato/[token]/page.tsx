"use client";

import {FormEvent,useCallback,useEffect,useState} from "react";
import {useParams} from "next/navigation";
import {getSupabase} from "@/lib/supabase";
import {collectGeolocation,postElectronicEvidence} from "@/lib/e-sign-client";

const money=new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"});
const consentText="Declaro que li, compreendi e assino eletronicamente este contrato, concordando integralmente com seu conteúdo e com o plano de pagamento apresentado.";

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
 const[challengeId,setChallengeId]=useState("");
 const[otpCode,setOtpCode]=useState("");
 const[phoneMasked,setPhoneMasked]=useState("");
 const[simulation,setSimulation]=useState(false);
 const[simulationCode,setSimulationCode]=useState("");
 const[simulationMessage,setSimulationMessage]=useState("");

 const load=useCallback(async()=>{
  const client=getSupabase();
  if(!client)return;
  const[contractResult,modeResult]=await Promise.all([
   client.rpc("crm_get_public_contract",{p_token:params.token}),
   client.rpc("get_public_signature_otp_mode",{p_token:params.token,p_entity_type:"contract"}),
  ]);
  if(contractResult.error||!contractResult.data){setError("Contrato inválido, cancelado ou expirado.");return}
  setData(contractResult.data);
  setSignerName((value:string)=>value||contractResult.data.proposal?.customer_name||"");
  if(!modeResult.error)setSimulation(Boolean(modeResult.data?.simulation));
 },[params.token]);

 useEffect(()=>{load()},[load]);

 async function requestOtp(){
  setBusy(true);setError("");setSimulationMessage("");setOtpCode("");
  try{
   if(simulation){
    const client=getSupabase();
    if(!client)throw new Error("Supabase indisponível.");
    const result=await client.rpc("issue_public_test_signature_otp",{p_token:params.token,p_entity_type:"contract"});
    if(result.error||!result.data)throw new Error(result.error?.message||"Não foi possível gerar o código de teste.");
    setChallengeId(String(result.data.id));
    setPhoneMasked(String(result.data.phone_masked||"telefone cadastrado"));
    setSimulationCode(String(result.data.simulationCode||"260726"));
    setSimulationMessage("Código gerado somente para simulação. Digite-o manualmente no campo abaixo.");
    return;
   }
   const response=await fetch("/api/e-sign/otp/request",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:params.token,entityType:"contract"})});
   const result=await response.json();
   if(!response.ok)throw new Error(result.error||"Não foi possível enviar o código.");
   setChallengeId(String(result.challengeId));
   setPhoneMasked(String(result.phoneMasked||""));
  }catch(err){setError(err instanceof Error?err.message:"Não foi possível gerar o código.")}
  finally{setBusy(false)}
 }

 async function sign(event:FormEvent){
  event.preventDefault();setBusy(true);setError("");
  try{
   if(last4.length!==4)throw new Error("Informe os quatro últimos dígitos do CPF ou CNPJ.");
   if(!challengeId||otpCode.length!==6)throw new Error("Gere e digite o código de confirmação.");
   const geolocation=await collectGeolocation(geoConsent);
   const result=await postElectronicEvidence("/api/e-sign/contract",{token:params.token,signerName,documentLast4:last4,termsAccepted:terms,geolocationConsent:geoConsent,geolocation,consentText,otpChallengeId:challengeId,otpCode});
   setCertificate(result);await load();
  }catch(err){setError(err instanceof Error?err.message:"Não foi possível assinar o contrato")}
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
   signature.customer_signed?<div className="e-sign-success"><small>ASSINATURA ELETRÔNICA CONCLUÍDA</small><h2>Contrato assinado pelas partes</h2><p>Os recebíveis foram integrados automaticamente ao fluxo financeiro.</p><dl><div><dt>Empresa</dt><dd>{signature.company_signer} · {new Date(signature.company_signed_at).toLocaleString("pt-BR")}</dd></div><div><dt>Comprador</dt><dd>{signature.customer_signer} · {new Date(signature.customer_signed_at).toLocaleString("pt-BR")}</dd></div><div><dt>Hash do documento</dt><dd>{signature.document_hash}</dd></div></dl></div>:
   <form onSubmit={sign}>
    {simulation&&<div className="otp-simulation-warning"><b>MODO DE TESTE ATIVO</b><span>Nenhuma mensagem real será enviada. Gere o código e digite-o no campo de confirmação.</span></div>}
    <small>ASSINATURA DO COMPRADOR</small><h2>Confirmar e assinar</h2>
    <p>{simulation?"Para este teste, a plataforma gera um código visível na própria página. Digite o código manualmente para simular o recebimento.":"A confirmação usa um código de seis dígitos enviado ao WhatsApp cadastrado."}</p>
    <div className="company-signature-summary"><strong>Assinado pela Évora Urbanismo</strong><span>{signature.company_signer} · {new Date(signature.company_signed_at).toLocaleString("pt-BR")}</span><code>{signature.document_hash}</code></div>
    <label>Nome completo<input value={signerName} onChange={event=>setSignerName(event.target.value)} required/></label>
    <label>Últimos 4 dígitos do CPF/CNPJ<input value={last4} onChange={event=>setLast4(event.target.value.replace(/\D/g,"").slice(0,4))} inputMode="numeric" maxLength={4} required/></label>
    <div className="otp-box">
     <button type="button" onClick={requestOtp} disabled={busy}>{challengeId?(simulation?"Gerar novo código de teste":"Reenviar código"):(simulation?"Gerar código de teste":"Enviar código pelo WhatsApp")}</button>
     {simulation&&challengeId&&<article className="whatsapp-simulation"><header><b>SIMULAÇÃO DE MENSAGEM</b><time>{new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}</time></header><p>Código de confirmação da assinatura:</p><strong>{simulationCode}</strong><small>{simulationMessage}</small></article>}
     {challengeId&&<label>Digite o código {simulation?"de teste":`enviado para ${phoneMasked}`}<input value={otpCode} onChange={event=>setOtpCode(event.target.value.replace(/\D/g,"").slice(0,6))} inputMode="numeric" maxLength={6} placeholder="Digite os 6 dígitos" autoComplete="one-time-code" required/></label>}
    </div>
    <label className="e-sign-check discreet-check"><input type="checkbox" checked={terms} onChange={event=>setTerms(event.target.checked)} required/><span>{consentText}</span></label>
    <label className="e-sign-check discreet-check"><input type="checkbox" checked={geoConsent} onChange={event=>setGeoConsent(event.target.checked)}/><span>Autorizo o registro da localização como evidência adicional.</span></label>
    {error&&<div className="feedback error">{error}</div>}
    <button className="primary wide" disabled={busy||!terms||!challengeId||otpCode.length!==6}>{busy?"Validando e assinando...":simulation?"Validar código de teste e assinar":"Confirmar código e assinar"}</button>
   </form>}
   {certificate&&<p className="hint">Evidência registrada: {certificate.evidence_hash} · {certificate.receivables_created} recebível(is).</p>}
  </section>
  <footer><p>Documento disponibilizado pela plataforma proprietária da Évora Urbanismo.</p><button onClick={()=>window.print()}>Imprimir ou salvar em PDF</button><small>© 2026 Évora Urbanismo</small></footer>
 </main>
}
