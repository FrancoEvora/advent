"use client";

import Image from "next/image";
import Link from "next/link";
import Script from "next/script";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { client } from "./chat-client";
import { CONNECT_POLICY, type ConnectResponse } from "@/lib/integrations/whatsapp/connect-policy";
import styles from "./whatsapp-connect.module.css";

type Membership = { organization_id: string; organizations: { name: string; trade_name: string | null; active: boolean } | null };
type SDK = "idle" | "loading" | "loaded" | "error";
const labels: Record<string, string> = { not_started: "Não iniciado", checking: "Verificando pré-requisitos", blocked: "Aguardando definição do fluxo seguro", error: "Erro no diagnóstico" };

export default function WhatsAppConnect() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [memberships, setMemberships] = useState<Membership[]>([]), [organization, setOrganization] = useState("");
  const [snapshot, setSnapshot] = useState<ConnectResponse | null>(null), [sdk, setSdk] = useState<SDK>("idle");
  const [notice, setNotice] = useState("");
  const pendingRequest = useRef<string | null>(null);
  const activeUser = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    const auth = client().auth;
    const applySession = (value: Session | null) => {
      if (!alive) return;
      if (activeUser.current !== (value?.user.id || null)) {
        activeUser.current = value?.user.id || null;
        setOrganization(""); setMemberships([]); setSnapshot(null); setSdk("idle"); setNotice(""); setError("");
        pendingRequest.current = null;
      }
      setSession(value); setLoading(false);
    };
    void auth.getSession().then(({ data }) => applySession(data.session));
    const { data } = auth.onAuthStateChange((_event, value) => applySession(value));
    return () => { alive = false; data.subscription.unsubscribe(); };
  }, []);
  const userId = session?.user.id;
  useEffect(() => {
    let alive = true;
    if (!userId) return;
    void client().from("organization_members").select("organization_id,organizations(name,trade_name,active)")
      .eq("user_id", userId).eq("active", true).eq("role", "admin").then(({ data, error }) => {
        if (!alive) return;
        const items = (data as unknown as Membership[] || []).filter(m => m.organizations?.active);
        setMemberships(items); setOrganization(items.length === 1 ? items[0].organization_id : "");
        if (error || !items.length) setError("Este acesso exige um administrador ativo da organização.");
      });
    return () => { alive = false; };
  }, [userId]);

  useEffect(() => {
    if (!organization || !userId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const { data } = await client().auth.getSession();
        if (!data.session) throw new Error("Entre novamente para consultar o diagnóstico.");
        const response = await fetch(`/api/arisa/whatsapp-connect?organizationId=${encodeURIComponent(organization)}`, {
          headers: { authorization: `Bearer ${data.session.access_token}` }, cache: "no-store", signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.message || "O diagnóstico está indisponível.");
        if (!controller.signal.aborted) setSnapshot(result);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "O diagnóstico está indisponível.");
      }
    })();
    return () => controller.abort();
  }, [organization, userId]);

  useEffect(() => {
    if (sdk !== "loading") return;
    const timer = setTimeout(() => setSdk(current => current === "loading" ? "error" : current), 15000);
    return () => clearTimeout(timer);
  }, [sdk]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await client().auth.signInWithPassword({ email: String(form.get("email")), password: String(form.get("password")) });
      if (result.error) throw new Error("Não foi possível entrar. Confira seu e-mail e sua senha.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Não foi possível entrar."); }
    finally { setBusy(false); }
  }
  async function preflight() {
    if (busy || !organization) return;
    setBusy(true); setError(""); setNotice("");
    pendingRequest.current ??= crypto.randomUUID();
    try {
      const { data } = await client().auth.getSession();
      if (!data.session) throw new Error("Entre novamente para continuar.");
      const response = await fetch("/api/arisa/whatsapp-connect", {
        method: "POST", headers: { authorization: `Bearer ${data.session.access_token}`, "content-type": "application/json" },
        body: JSON.stringify({ organizationId: organization, requestId: pendingRequest.current }),
        signal: AbortSignal.timeout(20000),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || "Não foi possível concluir o diagnóstico.");
      if (activeUser.current !== userId) return;
      setSnapshot(result); pendingRequest.current = null;
      setNotice("Diagnóstico registrado. Elegibilidade ainda não verificada pela Meta. O onboarding permanece bloqueado para preservar seu número.");
    } catch (failure) { if (activeUser.current === userId) setError(failure instanceof Error ? failure.message : "Não foi possível concluir o diagnóstico."); }
    finally { setBusy(false); }
  }
  function sdkReady() {
    const facebook = (window as Window & { FB?: { init?: unknown; login?: unknown } }).FB;
    setSdk(typeof facebook?.init === "function" && typeof facebook?.login === "function" ? "loaded" : "error");
  }
  const signedIn = Boolean(userId && organization);
  return <main className={styles.page}>
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href="/arisa" className={styles.brand}><Image src="/arisa-profile.webp" alt="Arisa" width={44} height={44} /><span><strong>Arisa</strong><small>ÉVORA URBANISMO</small></span></Link>
        <Link href="/arisa">Voltar à Arisa <span aria-hidden="true">↗</span></Link>
      </header>
      <section className={styles.hero}>
        <span className={styles.eyebrow}>WHATSAPP BUSINESS · COEXISTENCE</span>
        <h1>Conectar WhatsApp<br />ao Franco</h1>
        <p>Esta conexão permite que a Arisa receba e gerencie mensagens com sua autorização, mantendo seu WhatsApp Business funcionando normalmente no iPhone.</p>
        <div className={styles.safety}><span aria-hidden="true">◇</span><span>Esta etapa não deve desconectar nem substituir o WhatsApp Business do seu iPhone.</span></div>
      </section>
      <div className={styles.grid}>
        <section className={styles.card} aria-labelledby="connection-title">
          <div className={styles.cardHeading}><span className={styles.step}>01</span><div><small>SEU SEGUNDO CANAL</small><h2 id="connection-title">WhatsApp pessoal</h2></div><span className={styles.badge}>Não conectado</span></div>
          <p>A preparação está disponível. A verificação do número pela Meta está bloqueada nesta versão.</p>
          <div className={styles.warning}>
            <strong>O fluxo da Meta também conecta a conta</strong>
            <p>Concluir o Embedded Signup já pode vincular seu WhatsApp à plataforma. A Meta não documenta uma parada automática para apenas verificar a elegibilidade, sem alterar a conta.</p>
            <p>Por isso, o botão abaixo permanece indisponível. Nenhuma autorização de conexão será solicitada nesta página.</p>
            <a href={CONNECT_POLICY.documentation} target="_blank" rel="noopener noreferrer">Ler a documentação oficial ↗</a>
          </div>
          <button className={styles.primary} disabled aria-describedby="eligibility-help">Verificar elegibilidade</button>
          <p id="eligibility-help" className={styles.hint}>Bloqueado para proteger seu número. Não significa que ele seja inelegível.</p>
          <dl className={styles.facts}><div><dt>Elegibilidade</dt><dd>Não verificada</dd></div><div><dt>Conexão com a Meta</dt><dd>Não iniciada</dd></div><div><dt>Respostas automáticas</dt><dd>Desativadas neste canal</dd></div></dl>
        </section>
        <section className={styles.card} aria-labelledby="diagnostic-title">
          <div className={styles.cardHeading}><span className={styles.step}>02</span><div><small>PREPARAÇÃO SEGURA</small><h2 id="diagnostic-title">Diagnóstico técnico</h2></div></div>
          {loading ? <p role="status">Verificando sua sessão…</p> : !session ? <>
            <p>Entre com sua conta administrativa da Évora para consultar e registrar o diagnóstico.</p>
            <form className={styles.form} onSubmit={signIn}><label>E-mail<input name="email" type="email" autoComplete="username" required /></label><label>Senha<input name="password" type="password" autoComplete="current-password" required /></label><button className={styles.secondary} disabled={busy}>{busy ? "Entrando…" : "Entrar na Évora"}</button></form>
          </> : <>
            {memberships.length > 1 && <label className={styles.select}>Organização<select disabled={busy} value={organization} onChange={e => { setOrganization(e.target.value); setSnapshot(null); pendingRequest.current = null; setError(""); setNotice(""); }}>{memberships.map(m => <option key={m.organization_id} value={m.organization_id}>{m.organizations?.trade_name || m.organizations?.name}</option>)}<option value="">Selecione</option></select></label>}
            {signedIn && <>
              <dl className={styles.facts}>
                <div><dt>Canal próprio da Arisa</dt><dd>{!snapshot ? "Aguardando consulta" : snapshot.primary.configured ? snapshot.primary.enabled ? "Configurado · habilitado" : "Configurado · pausado" : "Configuração incompleta"}</dd></div>
                <div><dt>Preparação do segundo canal</dt><dd>{labels[snapshot?.connection?.onboarding_status || "not_started"] || "Aguardando revisão"}</dd></div>
                <div><dt>Configuração do app Meta</dt><dd>{!snapshot ? "Aguardando consulta" : snapshot.configuration.appIdPresent && snapshot.configuration.configIdPresent ? "Identificadores presentes · revisão pendente" : "Identificadores de onboarding pendentes"}</dd></div>
              </dl>
              <div className={styles.actions}><button className={styles.secondary} disabled={busy} onClick={() => void preflight()}>{busy ? "Verificando pré-requisitos…" : "Executar diagnóstico seguro"}</button></div>
              <p className={styles.hint}>O diagnóstico não pede seu número nem inicia o login da Meta. O teste do SDK carrega apenas o script oficial do Facebook.</p>
              {snapshot && <details className={styles.details}><summary>Informações técnicas e auditoria</summary><p><code>franco_personal</code> · Embedded Signup v4 · Graph API v26.0</p><p>O canal atual usa sua configuração existente. Este diagnóstico não substitui suas credenciais ou webhook.</p><p><code>is_on_biz_app</code> e <code>platform_type</code>: não consultados. Esses campos confirmam coexistência já estabelecida, não elegibilidade prévia.</p><ul>{snapshot.audit.map(a => <li key={a.id}>{new Date(a.created_at).toLocaleString("pt-BR")} · {a.event === "preflight_started" ? "Diagnóstico iniciado" : "Onboarding bloqueado por segurança"}</li>)}</ul>{!snapshot.audit.length && <p>Nenhuma tentativa registrada.</p>}</details>}
            </>}
            <button className={styles.textButton} onClick={() => { setSnapshot(null); setOrganization(""); setMemberships([]); setSdk("idle"); setNotice(""); setError(""); pendingRequest.current = null; void client().auth.signOut({ scope: "local" }); }}>Sair desta conta</button>
          </>}
          <dl className={styles.facts}><div><dt>SDK oficial</dt><dd role="status">{({ idle: "Não testado", loading: "Carregando…", loaded: "Script carregado · login não iniciado", error: "Não foi possível carregar" })[sdk]}</dd></div></dl>
          <button className={styles.textButton} disabled={sdk !== "idle"} onClick={() => setSdk("loading")}>Testar carregamento do SDK</button>
          <p className={styles.hint}>Este teste público baixa apenas o script oficial do Facebook. Não inicia login nem conecta uma conta.</p>
          {sdk === "error" && <p role="status">O carregamento pode ter sido bloqueado pelo navegador. Recarregue a página para testar novamente.</p>}
          {sdk !== "idle" && <Script id="arisa-meta-sdk-diagnostic" src="https://connect.facebook.net/pt_BR/sdk.js" strategy="afterInteractive" onReady={sdkReady} onError={() => setSdk("error")} />}
          {notice && <p className={styles.notice} role="status">{notice}</p>}
          {error && <p className={styles.error} role="alert">{error}</p>}
        </section>
      </div>
      <footer className={styles.footer}><span>Arisa · Évora Urbanismo</span><Link href="/privacidade">Privacidade</Link><span>Preparação · conexão ainda não autorizada</span></footer>
    </div>
  </main>;
}
