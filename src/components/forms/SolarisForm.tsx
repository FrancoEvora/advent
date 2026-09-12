"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import { normalizePhone } from "@/lib/forms/solaris";
import styles from "./solaris-form.module.css";

export function SolarisForm() {
  const [page,setPage]=useState(1),[name,setName]=useState(""),[phone,setPhone]=useState(""),[consent,setConsent]=useState(false),[purpose,setPurpose]=useState(""),[budget,setBudget]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[receipt,setReceipt]=useState(""),[website,setWebsite]=useState("");
  const requestId=useRef(""),title=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{requestId.current=crypto.randomUUID()},[]);
  useEffect(()=>{if(page>1)title.current?.focus()},[page]);
  async function next(event:FormEvent) {
    event.preventDefault(); if(busy)return; setError("");
    if(page===1){if(name.trim().length<3)return setError("Informe seu nome para continuar.");if(!normalizePhone(phone))return setError("Informe um WhatsApp válido com DDD.");if(!consent)return setError("Confirme que podemos entrar em contato sobre o Solaris.");setPage(2);return;}
    if(page===2){if(!purpose)return setError("Selecione investir ou morar.");setPage(3);return;}
    if(page!==3)return;
    if(!budget)return setError("Selecione a faixa de investimento.");
    setBusy(true);
    try {
      const attribution=Object.fromEntries(new URLSearchParams(window.location.search));
      if(!requestId.current)requestId.current=crypto.randomUUID();
      const response=await fetch("/api/forms/solaris",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({requestId:requestId.current,name,phone,consent,purpose,budget,website,attribution}),signal:AbortSignal.timeout(20000)});
      const result=await response.json() as {id?:string;error?:string};
      if(!response.ok||result.id!==requestId.current)throw new Error(result.error||"Não foi possível registrar agora. Tente novamente.");
      setReceipt(result.id.slice(0,8).toUpperCase());setPage(4);
    }catch(err){setError(err instanceof Error&&err.name!=="TimeoutError"?err.message:"Não foi possível confirmar agora. Seus dados continuam preenchidos; tente novamente.")}finally{setBusy(false)}
  }
  const titles=["Vamos começar por você.","Investir ou morar?","Qual faixa de investimento?","Obrigado!"];
  return <main className={styles.shell} id="conteudo-principal">
    <div className={styles.wrap}>
      <header className={styles.header}><div className={styles.logo}><Image src="/forms/solaris/marca-original.png" alt="Futura Casa — inteligência imobiliária, marketing e vendas" width={842} height={1052} unoptimized priority/></div><span>Monte Carmelo · MG</span></header>
      <div className={styles.grid}>
        <aside className={styles.property}><span className={styles.eyebrow}>SOLARIS</span><h2>Residencial<br/>Resort.</h2><p>Seu interesse começa aqui.</p><Image src="/forms/solaris/solaris.png" width={255} height={319} alt="Solaris Residencial Resort. Plano Safra 2026, obras em andamento." unoptimized/></aside>
        <section className={styles.panel} aria-label="Cadastro de interesse no Solaris">
          <div className={styles.progressLabel}><span>Solaris Residencial Resort</span><span>{page} de 4</span></div><progress max={4} value={page} aria-label={`Etapa ${page} de 4`}/>
          <form onSubmit={next} noValidate>
            {page===4&&<div className={styles.success} aria-hidden="true">✓</div>}<h1 ref={title} tabIndex={-1}>{titles[page-1]}</h1>
            {page===1&&<><p className={styles.intro}>Deixe seu contato para conhecer os lotes e as condições do Solaris.</p><label className={styles.field}>Nome<input name="name" autoComplete="name" value={name} onChange={e=>setName(e.target.value)} maxLength={120} placeholder="Seu nome" required/></label><label className={styles.field}>WhatsApp com DDD<input name="tel" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={e=>setPhone(e.target.value)} maxLength={22} placeholder="(34) 99999-9999" required/></label><label className={styles.consent}><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/><span>Concordo em receber contato da Futura Casa pelo WhatsApp sobre o Solaris.</span></label><p className={styles.privacy}>Seus dados serão usados para este atendimento. Para corrigir ou excluir seus dados e encerrar o contato, fale com <a href="https://www.instagram.com/redefuturacasa/" target="_blank" rel="noreferrer">@redefuturacasa</a>.</p><div className={styles.trap} aria-hidden="true"><label>Website<input tabIndex={-1} autoComplete="off" value={website} onChange={e=>setWebsite(e.target.value)}/></label></div></>}
            {page===2&&<><p className={styles.intro}>Qual é o seu objetivo com o lote?</p><fieldset className={styles.choices}><legend className={styles.srOnly}>Objetivo com o lote</legend>{[["investir","Investir"],["morar","Morar"]].map(([value,label])=><label className={purpose===value?styles.chosen:styles.choice} key={value}><span>{label}</span><input type="radio" name="purpose" value={value} checked={purpose===value} onChange={()=>setPurpose(value)}/></label>)}</fieldset></>}
            {page===3&&<><p className={styles.intro}>Selecione o valor que considera para investir.</p><fieldset className={styles.choices}><legend className={styles.srOnly}>Faixa de investimento</legend>{[["300_500","Entre R$ 300 mil e R$ 500 mil"],["acima_500","Acima de R$ 500 mil"]].map(([value,label])=><label className={budget===value?styles.chosen:styles.choice} key={value}><span>{label}</span><input type="radio" name="budget" value={value} checked={budget===value} onChange={()=>setBudget(value)}/></label>)}</fieldset></>}
            {page===4&&<div className={styles.confirmation} role="status"><h2>Seu interesse foi registrado.</h2><p>Recebemos seu cadastro com sucesso. A equipe da Futura Casa poderá entrar em contato pelo WhatsApp com informações sobre o Solaris.</p><span>Registro {receipt}</span></div>}
            {error&&<p className={styles.error} role="alert">{error}</p>}{page<4&&<div className={styles.actions}>{page>1&&<button type="button" className={styles.back} disabled={busy} onClick={()=>{setError("");setPage(page-1)}}>‹ Voltar</button>}<button type="submit" className={styles.continue} disabled={busy}>{busy?"Registrando…":page===3?"Registrar meu interesse →":"Continuar →"}</button></div>}
          </form><footer>Futura Casa · Plataforma digital de vendas imobiliárias</footer>
        </section>
      </div>
    </div>
  </main>;
}
