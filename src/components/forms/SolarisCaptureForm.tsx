"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { normalizePhone, normalizeInstagram, SOLARIS_INSTAGRAM_CONSENT_TEXT } from "@/lib/forms/solaris";
import styles from "./solaris-form.module.css";
import social from "./solaris-instagram.module.css";

/** Uses the existing Solaris ingestion API; never writes a partial lead. */
export function SolarisCaptureForm({ onRegistered }: { onRegistered?: () => void }) {
  const [page, setPage] = useState(1);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [instagram, setInstagram] = useState("");
  const [instagramConsent, setInstagramConsent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState("");
  const [website, setWebsite] = useState("");
  const requestId = useRef("");
  const title = useRef<HTMLHeadingElement>(null);
  const submitting = useRef(false);
  const instagramUsername = normalizeInstagram(instagram);

  useEffect(() => { requestId.current = crypto.randomUUID(); }, []);
  useEffect(() => { if (page > 1) title.current?.focus(); }, [page]);

  async function next(event: FormEvent) {
    event.preventDefault();
    if (busy || submitting.current) return;
    setError("");
    if (page === 1) {
      if (name.trim().length < 3) return setError("Informe seu nome para continuar.");
      if (!normalizePhone(phone)) return setError("Informe um WhatsApp válido com DDD.");
      setConsent(true);
      setPage(2);
      return;
    }
    if (page !== 2) return;
    if (!purpose) return setError("Selecione investir ou morar.");
    if (instagram.trim() && !instagramUsername) return setError("Confira seu Instagram: informe o @ ou o link do perfil, não de uma publicação. Você também pode deixar o campo em branco.");
    submitting.current = true;
    setBusy(true);
    try {
      const attribution = Object.fromEntries(new URLSearchParams(window.location.search));
      if (!requestId.current) requestId.current = crypto.randomUUID();
      const response = await fetch("/api/forms/solaris", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: requestId.current, name, phone, consent, purpose, website, attribution, instagram: instagramUsername, instagramConsent: !!instagramUsername && instagramConsent }),
        signal: AbortSignal.timeout(20000),
      });
      const result = await response.json() as { id?: string; error?: string };
      if (!response.ok || result.id !== requestId.current) {
        throw new Error(result.error || "Não foi possível registrar agora. Tente novamente.");
      }
      setReceipt(result.id.slice(0, 8).toUpperCase());
      setPage(3);
      onRegistered?.();
    } catch (err) {
      setError(err instanceof Error && err.name !== "TimeoutError"
        ? err.message
        : "Não foi possível confirmar agora. Seus dados continuam preenchidos; tente novamente.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <section className={styles.panel} id="formulario" aria-label="Cadastro de interesse no Solaris">
      <div className={styles.formTop}><span>ATENDIMENTO FUTURA CASA</span><span>{page < 3 ? `${page} de 2` : "CONCLUÍDO"}</span></div>
      <progress max={2} value={Math.min(page, 2)} aria-label={page < 3 ? `Etapa ${page} de 2` : "Cadastro registrado"} />
      <form onSubmit={next} noValidate aria-busy={busy}>
        {page === 3 && <div className={styles.successMark} aria-hidden="true">✓</div>}
        <h2 className={styles.formTitle} ref={title} tabIndex={-1}>{page === 1 ? "Seu lugar no Solaris." : page === 2 ? "Morar ou investir?" : "Um novo começo."}</h2>
        {page === 1 && <>
          <p className={styles.formIntro}>Receba pelo WhatsApp os lotes disponíveis e as condições comerciais.</p>
          <label className={styles.field}>Seu nome<input name="name" autoComplete="name" value={name} onChange={e => setName(e.target.value)} maxLength={120} placeholder="Como podemos chamar você?" required aria-describedby={error ? "solaris-form-error" : undefined} /></label>
          <label className={styles.field}>WhatsApp com DDD<input name="tel" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} maxLength={22} placeholder="(34) 99999-9999" required aria-describedby={error ? "solaris-form-error" : undefined} /></label>
          <p className={styles.consentNotice} id="solaris-consent-notice">Ao clicar em Continuar, você autoriza a Futura Casa a usar seu nome e WhatsApp para entrar em contato sobre o Solaris. Seus dados serão usados para este atendimento. Para corrigir ou excluir seus dados e encerrar o contato, fale com <a href="https://www.instagram.com/redefuturacasa/" target="_blank" rel="noreferrer">@redefuturacasa</a>.</p>
          <div className={styles.trap} aria-hidden="true"><label>Website<input tabIndex={-1} autoComplete="off" value={website} onChange={e => setWebsite(e.target.value)} /></label></div>
        </>}
        {page === 2 && <>
          <p className={styles.formIntro}>Conte seu objetivo. Compartilhar o Instagram é opcional.</p>
          <fieldset className={styles.choices}><legend>Qual é o seu objetivo com o lote?</legend>
            {[["morar", "Quero morar"], ["investir", "Quero investir"]].map(([value, label]) => (
              <label className={purpose === value ? styles.chosen : styles.choice} key={value}><span>{label}</span><input type="radio" name="purpose" value={value} checked={purpose === value} onChange={() => setPurpose(value)} /></label>
            ))}
          </fieldset>
          <div className={social.section}>
            <label className={styles.field} htmlFor="solaris-instagram">Instagram <span className={social.optional}>(opcional)</span>
              <input id="solaris-instagram" name="instagram" value={instagram} onChange={e => { setInstagram(e.target.value); setInstagramConsent(false); }} maxLength={200} placeholder="@seuperfil ou link do Instagram" autoCapitalize="none" autoComplete="off" spellCheck={false} aria-describedby={`solaris-instagram-help${error ? " solaris-form-error" : ""}`} />
            </label>
            <p id="solaris-instagram-help" className={social.help}>O perfil será registrado junto ao seu cadastro. Você pode continuar sem informar.</p>
            {instagramUsername && <a className={social.profile} href={`https://www.instagram.com/${instagramUsername}/`} target="_blank" rel="noopener noreferrer">Conferir o perfil informado: @{instagramUsername} ↗</a>}
            {instagram.trim() && <label className={social.consent}><input type="checkbox" name="instagramConsent" checked={instagramConsent} onChange={e => setInstagramConsent(e.target.checked)} /><span>{SOLARIS_INSTAGRAM_CONSENT_TEXT}</span></label>}
            {instagram.trim() && <p className={social.help}>Esta autorização é opcional e não conecta sua conta nem libera acesso a conteúdo privado. Para retirá-la, fale com <a href="https://www.instagram.com/redefuturacasa/" target="_blank" rel="noopener noreferrer">@redefuturacasa</a>.</p>}
          </div>
        </>}
        {page === 3 && <div className={styles.confirmation} role="status"><h3>Seu interesse foi registrado.</h3><p>A equipe da Futura Casa poderá entrar em contato pelo WhatsApp informado para apresentar as opções do Solaris.</p><span>Registro {receipt}</span></div>}
        {error && <p className={styles.formError} id="solaris-form-error" role="alert">{error}</p>}
        {page < 3 && <div className={styles.actions}>
          {page > 1 && <button type="button" className={styles.back} disabled={busy} onClick={() => { setError(""); setPage(page - 1); }}>← Voltar</button>}
          <button type="submit" className={styles.submit} disabled={busy} aria-describedby={page === 1 ? "solaris-consent-notice" : undefined}>{busy ? "Registrando…" : page === 2 ? "Receber lotes e condições →" : "Continuar →"}</button>
        </div>}
      </form>
      <p className={styles.formFooter}><span aria-hidden="true">◇</span> Conhecer é o primeiro passo. O cadastro não é uma reserva.</p>
      <noscript><p>Ative o JavaScript para enviar o formulário. O conteúdo do empreendimento permanece disponível.</p></noscript>
    </section>
  );
}
