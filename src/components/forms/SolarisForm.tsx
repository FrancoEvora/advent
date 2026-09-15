"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import { normalizePhone } from "@/lib/forms/solaris";
import styles from "./solaris-form.module.css";

const benefits = [
  ["01", "Lotes disponíveis", "Conheça as opções do Solaris e encontre uma que faça sentido para o seu objetivo."],
  ["02", "Condições comerciais", "Receba informações sobre valores e possibilidades de pagamento, conforme a disponibilidade."],
  ["03", "Atendimento pelo WhatsApp", "Tire suas dúvidas com a equipe da Futura Casa antes de dar o próximo passo."],
];

export function SolarisForm() {
  const [page, setPage] = useState(1);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState("");
  const [website, setWebsite] = useState("");
  const requestId = useRef("");
  const title = useRef<HTMLHeadingElement>(null);
  const submitting = useRef(false);

  useEffect(() => { requestId.current = crypto.randomUUID(); }, []);
  useEffect(() => { if (page > 1) title.current?.focus(); }, [page]);

  async function next(event: FormEvent) {
    event.preventDefault();
    if (busy || submitting.current) return;
    setError("");
    if (page === 1) {
      if (name.trim().length < 3) return setError("Informe seu nome para continuar.");
      if (!normalizePhone(phone)) return setError("Informe um WhatsApp válido com DDD.");
      // The existing notice and affirmative authorization are preserved.
      setConsent(true);
      setPage(2);
      return;
    }
    if (page !== 2) return;
    if (!purpose) return setError("Selecione investir ou morar.");
    submitting.current = true;
    setBusy(true);
    try {
      // Anchor links keep the original campaign URL and its attribution intact.
      const attribution = Object.fromEntries(new URLSearchParams(window.location.search));
      if (!requestId.current) requestId.current = crypto.randomUUID();
      const response = await fetch("/api/forms/solaris", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: requestId.current, name, phone, consent, purpose, website, attribution }),
        signal: AbortSignal.timeout(20000),
      });
      const result = await response.json() as { id?: string; error?: string };
      if (!response.ok || result.id !== requestId.current) {
        throw new Error(result.error || "Não foi possível registrar agora. Tente novamente.");
      }
      // A click, a step transition or an HTTP 200 without the receipt is not a lead.
      setReceipt(result.id.slice(0, 8).toUpperCase());
      setPage(3);
    } catch (err) {
      setError(err instanceof Error && err.name !== "TimeoutError"
        ? err.message
        : "Não foi possível confirmar agora. Seus dados continuam preenchidos; tente novamente.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const titles = ["Receba lotes e condições.", "Investir ou morar?", "Obrigado!"];

  return (
    <main className={styles.shell} id="conteudo-principal">
      <a className={styles.skip} href="#formulario">Ir para o formulário</a>
      <div className={styles.wrap}>
        <header className={styles.header}>
          <svg className={styles.logo} viewBox="54 7 188 120" role="img" aria-label="Futura Casa — inteligência imobiliária, marketing e vendas">
            <image href="/forms/solaris/marca-original.png" width="842" height="1052" />
          </svg>
          <span>Monte Carmelo · MG</span>
          <a className={styles.headerCta} href="#formulario">Quero conhecer <span aria-hidden="true">↗</span></a>
        </header>

        <div className={styles.grid}>
          <section className={styles.property} aria-labelledby="solaris-titulo">
            <p className={styles.eyebrow}>SOLARIS · RESIDENCIAL RESORT</p>
            <h1 id="solaris-titulo">Seu próximo capítulo <em>começa com um lugar.</em></h1>
            <p className={styles.location}>Lotes em Monte Carmelo (MG) para morar ou investir.</p>
            <p className={styles.heroDescription}>Conheça o Solaris e receba as opções de lotes e condições comerciais pelo WhatsApp. Informação para escolher com mais clareza, no seu tempo.</p>
            <div className={styles.campaignTags}><span>Plano Safra 2026</span><span>Obras em andamento</span></div>
            <a className={styles.heroCta} href="#formulario">Quero receber lotes e condições <span aria-hidden="true">→</span></a>
            <p className={styles.ctaNote}>Primeiro você conhece. Depois, decide.</p>
            <div className={styles.heroTrust}>
              <span className={styles.trustMark} aria-hidden="true">FC</span>
              <p><strong>Atendimento Futura Casa</strong><span>Uma conversa sobre o que faz sentido para você.</span></p>
            </div>
          </section>

          <section className={styles.panel} id="formulario" aria-label="Cadastro de interesse no Solaris">
            <div className={styles.progressLabel}><span>Seu interesse no Solaris</span><span>{page} de 3</span></div>
            <progress max={3} value={page} aria-label={`Etapa ${page} de 3`} />
            <form onSubmit={next} noValidate aria-busy={busy}>
              {page === 3 && <div className={styles.success} aria-hidden="true">✓</div>}
              <h2 className={styles.formTitle} ref={title} tabIndex={-1}>{titles[page - 1]}</h2>
              {page === 1 && <>
                <p className={styles.intro}>Informe seu nome e WhatsApp. No próximo passo, diga se busca um lote para investir ou morar.</p>
                <label className={styles.field}>Nome<input name="name" autoComplete="name" value={name} onChange={e => setName(e.target.value)} maxLength={120} placeholder="Seu nome" required /></label>
                <label className={styles.field}>WhatsApp com DDD<input name="tel" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} maxLength={22} placeholder="(34) 99999-9999" required /></label>
                <p className={styles.privacy} id="solaris-consent-notice">Ao clicar em Continuar, você autoriza a Futura Casa a usar seu nome e WhatsApp para entrar em contato sobre o Solaris. Seus dados serão usados para este atendimento. Para corrigir ou excluir seus dados e encerrar o contato, fale com <a href="https://www.instagram.com/redefuturacasa/" target="_blank" rel="noreferrer">@redefuturacasa</a>.</p>
                <div className={styles.trap} aria-hidden="true"><label>Website<input tabIndex={-1} autoComplete="off" value={website} onChange={e => setWebsite(e.target.value)} /></label></div>
              </>}
              {page === 2 && <>
                <p className={styles.intro}>Qual é o seu objetivo com o lote? Essa resposta ajuda a equipe a orientar o atendimento.</p>
                <fieldset className={styles.choices}>
                  <legend className={styles.srOnly}>Objetivo com o lote</legend>
                  {[["investir", "Investir"], ["morar", "Morar"]].map(([value, label]) => (
                    <label className={purpose === value ? styles.chosen : styles.choice} key={value}>
                      <span>{label}</span><input type="radio" name="purpose" value={value} checked={purpose === value} onChange={() => setPurpose(value)} />
                    </label>
                  ))}
                </fieldset>
              </>}
              {page === 3 && <div className={styles.confirmation} role="status">
                <h3>Seu interesse foi registrado.</h3>
                <p>Recebemos seu cadastro com sucesso. A equipe da Futura Casa poderá entrar em contato pelo WhatsApp com informações sobre o Solaris.</p>
                <span>Registro {receipt}</span>
              </div>}
              {error && <p className={styles.error} role="alert">{error}</p>}
              {page < 3 && <div className={styles.actions}>
                {page > 1 && <button type="button" className={styles.back} disabled={busy} onClick={() => { setError(""); setPage(page - 1); }}>‹ Voltar</button>}
                <button type="submit" className={styles.continue} disabled={busy} aria-describedby={page === 1 ? "solaris-consent-notice" : undefined}>
                  {busy ? "Registrando…" : page === 2 ? "Registrar meu interesse →" : "Continuar →"}
                </button>
              </div>}
            </form>
            <footer>Seus dados são usados para o atendimento sobre o Solaris.</footer>
          </section>
        </div>

        <section className={styles.benefits} aria-labelledby="beneficios-titulo">
          <div className={styles.sectionHead}><p className={styles.eyebrow}>O QUE VOCÊ VAI RECEBER</p><h2 id="beneficios-titulo">Antes de escolher um lote,<br />conheça as possibilidades.</h2></div>
          <div className={styles.benefitGrid}>{benefits.map(([number, heading, description]) => (
            <article className={styles.benefit} key={number}><span>{number}</span><h3>{heading}</h3><p>{description}</p></article>
          ))}</div>
        </section>

        <section className={styles.campaign} aria-labelledby="campanha-titulo">
          <figure className={styles.campaignVisual}>
            <Image src="/forms/solaris/solaris.png" width={255} height={319} alt="Campanha Solaris Residencial Resort: Plano Safra 2026, com atendimento Futura Casa." unoptimized loading="lazy" />
            <figcaption>Conheça a campanha Solaris.</figcaption>
          </figure>
          <div className={styles.campaignCopy}>
            <p className={styles.eyebrow}>PLANO SAFRA 2026</p>
            <h2 id="campanha-titulo">Do seu interesse<br />à sua próxima escolha.</h2>
            <p>Condições pensadas para o produtor rural, em parceria com a JVF Group. Converse com a Futura Casa para conhecer as opções do Solaris Residencial Resort.</p>
            <p className={styles.availability}>Valores, disponibilidade dos lotes, prazos e condições de pagamento devem ser confirmados com a equipe no atendimento.</p>
            <a className={styles.textCta} href="#formulario">Quero conhecer as condições <span aria-hidden="true">→</span></a>
          </div>
        </section>

        <section className={styles.faq} aria-labelledby="duvidas-titulo">
          <div className={styles.sectionHead}><p className={styles.eyebrow}>ANTES DE COMEÇAR</p><h2 id="duvidas-titulo">Sua próxima conversa,<br />sem dúvidas sobre o caminho.</h2></div>
          <div className={styles.faqList}>
            <details><summary>O que acontece depois do cadastro?</summary><p>Após o registro, a equipe da Futura Casa poderá entrar em contato pelo WhatsApp informado para apresentar lotes disponíveis e condições comerciais do Solaris.</p></details>
            <details><summary>Posso conhecer as opções para morar ou investir?</summary><p>Sim. No formulário, você indica seu objetivo para orientar a conversa. O cadastro não representa reserva de lote nem contratação.</p></details>
            <details><summary>Onde fica o Solaris?</summary><p>O Solaris Residencial Resort fica em Monte Carmelo, Minas Gerais. No atendimento, você pode solicitar informações de localização e orientações para conhecer o empreendimento.</p></details>
            <details><summary>Preciso informar renda ou faixa de investimento?</summary><p>Não. Pedimos apenas nome, WhatsApp e se seu objetivo é investir ou morar. As demais informações podem ser tratadas durante o atendimento.</p></details>
          </div>
        </section>

        <section className={styles.finalCta} aria-labelledby="proximo-passo-titulo">
          <div><p className={styles.eyebrow}>O PRÓXIMO PASSO É SEU</p><h2 id="proximo-passo-titulo">Conheça o Solaris.<br />Decida com informação.</h2></div>
          <a className={styles.heroCta} href="#formulario">Receber lotes e condições <span aria-hidden="true">→</span></a>
        </section>
        <footer className={styles.siteFooter}><span>Futura Casa · Solaris Residencial Resort</span><span>Monte Carmelo · Minas Gerais</span></footer>
      </div>
    </main>
  );
}
