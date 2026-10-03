"use client";
import Image from "next/image";
import Link from "next/link";
import Script from "next/script";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { client } from "./chat-client";
import { coexistenceLoginOptions, CONNECT_POLICY, parseMetaEvent, type ConnectResponse, type MetaFinish, type OnboardingSession } from "@/lib/integrations/whatsapp/connect-policy";
import styles from "./whatsapp-connect.module.css";
type Membership = { organization_id: string; organizations: { name: string; trade_name: string | null; active: boolean } | null };
type Facebook = { init: (options: Record<string, unknown>) => void; login: (callback: (response: { authResponse?: { code?: string } }) => void, options: ReturnType<typeof coexistenceLoginOptions>) => void };
type Attempt = { session: OnboardingSession; organization: string; user: string; finish?: MetaFinish; exchanged?: boolean; finalizing?: boolean; exchanging?: boolean; cancelling?: boolean };
const labels: Record<string, string> = { not_started: "Pronto para iniciar", checking: "Aguardando a Meta", blocked: "Pronto para nova tentativa", error: "Etapa não concluída", authorized: "Autorizado · finalização pendente", connected: "Conectado por coexistência", cancelled: "Tentativa cancelada", disconnected: "Desconectado na Meta" };
const events: Record<string, string> = { preflight_started: "Diagnóstico inicial", onboarding_blocked: "Bloqueio da versão anterior", onboarding_started: "Onboarding iniciado", token_received: "Autorização recebida", coexistence_verified: "Coexistência confirmada pela API", onboarding_connected: "Conexão e sincronização solicitadas", onboarding_cancelled: "Tentativa cancelada", onboarding_error: "Etapa não concluída" };
export default function WhatsAppConnect() {
  const [session, setSession] = useState<Session | null>(null), [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [memberships, setMemberships] = useState<Membership[]>([]), [organization, setOrganization] = useState("");
  const [snapshot, setSnapshot] = useState<ConnectResponse | null>(null), [sdk, setSdk] = useState<"loading" | "loaded" | "error">("loading");
  const [prepared, setPrepared] = useState(false), [canResume, setCanResume] = useState(false);
  const [authorizationReceived, setAuthorizationReceived] = useState(false);
  const [awaitingMeta, setAwaitingMeta] = useState(false);
  const activeUser = useRef<string | null>(null), attempt = useRef<Attempt | null>(null), listener = useRef<((event: MessageEvent) => void) | null>(null);
  const userId = session?.user.id;
  const storageKey = (user: string, org: string) => `arisa.coexistence.${user}.${org}`;
  const persist = (value: Attempt) => { try { sessionStorage.setItem(storageKey(value.user, value.organization), JSON.stringify({ ...value, finalizing: false, exchanging: false, cancelling: false })); } catch { /* Storage may be disabled. */ } };
  const forget = (value: Attempt | null) => { if (value) { try { sessionStorage.removeItem(storageKey(value.user, value.organization)); } catch { /* No storage. */ } } };
  const cleanupListener = () => { if (listener.current) window.removeEventListener("message", listener.current); listener.current = null; };
  useEffect(() => {
    let alive = true;
    const auth = client().auth;
    const applySession = (value: Session | null) => {
      if (!alive) return;
      if (activeUser.current !== (value?.user.id || null)) {
        activeUser.current = value?.user.id || null; cleanupListener(); attempt.current = null;
        setOrganization(""); setMemberships([]); setSnapshot(null); setNotice(""); setError(""); setPrepared(false); setBusy(false); setAuthorizationReceived(false); setAwaitingMeta(false);
      }
      setSession(value); setLoading(false);
    };
    void auth.getSession().then(({ data }) => applySession(data.session));
    const { data } = auth.onAuthStateChange((_event, value) => applySession(value));
    return () => { alive = false; data.subscription.unsubscribe(); cleanupListener(); };
  }, []);
  useEffect(() => {
    let alive = true; if (!userId) return;
    void client().from("organization_members").select("organization_id,organizations(name,trade_name,active)").eq("user_id", userId).eq("active", true).eq("role", "admin").then(({ data, error }) => {
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
        if (!data.session) throw new Error("Entre novamente para continuar.");
        const response = await fetch(`/api/arisa/whatsapp-connect?organizationId=${organization}`, { headers: { authorization: `Bearer ${data.session.access_token}` }, cache: "no-store", signal: controller.signal });
        const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.message || "Não foi possível consultar a conexão.");
        if (controller.signal.aborted) return;
        setSnapshot(result);
        try {
          const saved = JSON.parse(sessionStorage.getItem(storageKey(userId, organization)) || "null") as Attempt | null;
          if (saved && saved.user === userId && saved.organization === organization && Date.parse(saved.session.expiresAt) > Date.now()) {
            attempt.current = saved; setPrepared(!saved.exchanged); setCanResume(Boolean(saved.exchanged && saved.finish)); setAuthorizationReceived(Boolean(saved.exchanged));
            if (saved.exchanged) setNotice("A autorização foi recebida. Retome a finalização desta tentativa.");
          }
        } catch { /* Ignore an unavailable or expired browser session. */ }
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Não foi possível consultar a conexão."); }
    })();
    return () => controller.abort();
  }, [organization, userId]);
  const appId = snapshot?.configuration.appId;
  useEffect(() => {
    if (sdk !== "loaded" || !appId) return;
    (window as Window & { FB?: Facebook }).FB?.init({ appId, version: CONNECT_POLICY.graphVersion, autoLogAppEvents: false, xfbml: false });
  }, [sdk, appId]);
  useEffect(() => {
    if (!appId || sdk !== "loading") return;
    const timer = setTimeout(() => setSdk(current => current === "loading" ? "error" : current), 15000);
    return () => clearTimeout(timer);
  }, [appId, sdk]);
  async function api(path: string, body?: Record<string, unknown>, expectedUser = userId) {
    const { data } = await client().auth.getSession();
    if (!data.session || data.session.user.id !== expectedUser || activeUser.current !== expectedUser) throw new Error("Entre novamente para continuar.");
    const response = await fetch(path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${data.session.access_token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), cache: "no-store", signal: AbortSignal.timeout(120000) });
    const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.message || "Não foi possível concluir esta etapa.");
    if (activeUser.current !== expectedUser) throw new Error("A sessão foi alterada.");
    return result;
  }
  const callbackBody = (a: Attempt) => ({ organizationId: a.organization, sessionId: a.session.sessionId, nonce: a.session.nonce });
  async function refresh() {
    setError(""); try { setSnapshot(await api(`/api/arisa/whatsapp-connect?organizationId=${organization}`)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Consulta indisponível."); }
  }
  async function finish(a: Attempt) {
    if (!a.exchanged || !a.finish || a.finalizing || attempt.current !== a || activeUser.current !== a.user) return;
    a.finalizing = true; setBusy(true); setNotice("Confirmando a coexistência e preparando a recepção de mensagens…");
    try {
      const result = await api("/api/arisa/whatsapp-connect/callback", { ...callbackBody(a), action: "finalize", ...a.finish }, a.user);
      setSnapshot(result); setCanResume(false); setPrepared(false); cleanupListener(); forget(a); attempt.current = null;
      setNotice("Coexistência confirmada. A recepção está preparada e a sincronização foi solicitada. As respostas automáticas continuam desativadas.");
    } catch (failure) {
      if (activeUser.current === a.user) { setError(failure instanceof Error ? failure.message : "Não foi possível finalizar."); setCanResume(true); persist(a); }
    } finally { a.finalizing = false; if (activeUser.current === a.user) setBusy(false); }
  }
  async function prepare() {
    if (!userId) return; setBusy(true); setError(""); setNotice(""); cleanupListener();
    try {
      const result = await api("/api/arisa/whatsapp-connect", { organizationId: organization });
      const a: Attempt = { session: result, organization, user: userId }; attempt.current = a; persist(a); setPrepared(true); setCanResume(false); setAuthorizationReceived(false);
      setNotice("Tudo preparado. Clique em Continuar na Meta para abrir a janela oficial.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Não foi possível preparar."); }
    finally { setBusy(false); }
  }
  function launch() {
    const a = attempt.current, fb = (window as Window & { FB?: Facebook }).FB;
    if (!a || !fb || sdk !== "loaded" || a.exchanging || a.exchanged || a.finalizing || a.cancelling) return;
    if (Date.parse(a.session.expiresAt) <= Date.now()) { setPrepared(false); setError("A tentativa expirou. Prepare uma nova conexão."); return; }
    setError(""); setBusy(true); setAwaitingMeta(true); setNotice("Continue na janela da Meta. Se ela não abrir, encerre esta tentativa e abra esta página no Chrome, Edge ou Safari com pop-ups permitidos. Na Meta, selecione o WhatsApp Business que já está no seu iPhone.");
    cleanupListener();
    listener.current = (event: MessageEvent) => {
      if (attempt.current !== a || activeUser.current !== a.user || a.cancelling) return;
      const parsed = parseMetaEvent(event.origin, event.data); if (!parsed) return;
      if (parsed.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING") { a.finish = parsed; persist(a); void finish(a); }
      else if (parsed.event === "ERROR") { setError("A Meta informou que esta etapa não foi concluída. Confira a mensagem na janela oficial."); if (!a.exchanging && !a.finalizing) setBusy(false); }
      else if (!a.exchanged && !a.exchanging) { setNotice("A janela informou cancelamento. Aguarde o retorno do login ou encerre esta tentativa abaixo."); setBusy(false); }
    };
    window.addEventListener("message", listener.current);
    // Synchronous call from the actual user click prevents popup blocking.
    try { fb.login(response => {
      if (attempt.current !== a || activeUser.current !== a.user || a.cancelling || a.exchanging || a.exchanged) return;
      setAwaitingMeta(false);
      const code = response.authResponse?.code;
      if (!code) { setBusy(false); setNotice("A autorização não foi recebida. Você pode continuar na Meta ou encerrar esta tentativa."); return; }
      setNotice("Autorização recebida. Validando com a Meta…");
      a.exchanging = true;
      // Codes expire quickly: exchange immediately, independently of postMessage order.
      void api("/api/arisa/whatsapp-connect/callback", { ...callbackBody(a), action: "exchange", code }, a.user).then(() => {
        a.exchanging = false; a.exchanged = true; persist(a); setCanResume(Boolean(a.finish)); setAuthorizationReceived(true);
        if (a.finish) void finish(a); else { setBusy(false); setNotice("Autorização recebida. Conclua a tela de coexistência na Meta para finalizar."); }
      }).catch(failure => { a.exchanging = false; if (activeUser.current === a.user) { setError(failure instanceof Error ? failure.message : "Falha na autorização."); setBusy(false); } });
    }, coexistenceLoginOptions(a.session.configId)); } catch { setAwaitingMeta(false); setBusy(false); setError("Não foi possível abrir o login da Meta. Permita pop-ups para este site."); }
  }
  async function cancel() {
    const a = attempt.current; if (!a || a.exchanged || a.finalizing || a.exchanging || a.cancelling) return;
    a.cancelling = true; setAwaitingMeta(false); setBusy(true); setError("");
    try { setSnapshot(await api("/api/arisa/whatsapp-connect/callback", { ...callbackBody(a), action: "cancel" }, a.user)); cleanupListener(); forget(a); attempt.current = null; setPrepared(false); setNotice("Tentativa encerrada nesta página. Nenhum pedido de migração ou registro foi feito pelo sistema."); }
    catch (failure) { a.cancelling = false; setError(failure instanceof Error ? failure.message : "Não foi possível encerrar."); }
    finally { setBusy(false); }
  }
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); const form = new FormData(event.currentTarget);
    try { const result = await client().auth.signInWithPassword({ email: String(form.get("email")), password: String(form.get("password")) }); if (result.error) throw new Error("Não foi possível entrar. Confira seu e-mail e sua senha."); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Não foi possível entrar."); } finally { setBusy(false); }
  }
  const c = snapshot?.connection, connected = c?.onboarding_status === "connected", ready = snapshot?.configuration.ready && sdk === "loaded";
  return <main className={styles.page}><div className={styles.shell}>
    <header className={styles.header}><Link href="/arisa" className={styles.brand}><Image src="/arisa-profile.webp" alt="Arisa" width={44} height={44} /><span><strong>Arisa</strong><small>ÉVORA URBANISMO</small></span></Link><Link href="/arisa">Voltar à Arisa ↗</Link></header>
    <section className={styles.hero}><span className={styles.eyebrow}>WHATSAPP BUSINESS · COEXISTENCE</span><h1>Conectar WhatsApp<br />ao Franco</h1><p>Conecte seu WhatsApp Business à infraestrutura da Arisa pelo fluxo oficial da Meta, mantendo o aplicativo no iPhone.</p><div className={styles.safety}><span aria-hidden="true">◇</span><span>Esta conexão usa coexistência. A confirmação do número acontece na Meta e no seu WhatsApp Business.</span></div></section>
    <div className={styles.grid}>
      <section className={styles.card} aria-labelledby="connection-title"><div className={styles.cardHeading}><span className={styles.step}>01</span><div><small>SEU SEGUNDO CANAL</small><h2 id="connection-title">WhatsApp pessoal</h2></div><span className={styles.badge}>{connected ? "Conectado" : "Conexão oficial"}</span></div>
        <p>A Meta verifica os requisitos e solicita sua autorização durante o cadastro. Ao concluir, seu número é conectado por coexistência.</p>
        <div className={styles.warning}><strong>Continue usando o WhatsApp Business no iPhone</strong><p>A coexistência mantém o aplicativo principal. A Meta pode desconectar dispositivos vinculados; você poderá vinculá-los novamente. Algumas funções do aplicativo podem mudar.</p><p>Na janela da Meta, selecione a conexão do WhatsApp Business existente. Se essa opção não estiver disponível, encerre a tentativa.</p><a href={CONNECT_POLICY.documentation} target="_blank" rel="noopener noreferrer">Como funciona a coexistência ↗</a></div>
        {connected ? <p className={styles.notice}>Seu canal {c?.phone_number_masked} foi confirmado pela API da Meta.</p> : canResume ? <button className={styles.primary} disabled={busy} onClick={() => { const a = attempt.current; if (a) void finish(a); }}>{busy ? "Finalizando…" : "Retomar finalização"}</button> : prepared ? <button className={styles.primary} disabled={busy || !ready} onClick={launch}>{busy ? "Aguardando a Meta…" : "Continuar na Meta"}</button> : <button className={styles.primary} disabled={busy || !ready || !organization} onClick={() => void prepare()}>{busy ? "Preparando…" : "Conectar WhatsApp"}</button>}
        <p className={styles.hint}>{!session ? "Entre com sua conta da Évora para conectar." : !snapshot ? "Consultando a configuração…" : !snapshot.configuration.ready ? "A configuração do aplicativo Meta está pendente." : sdk !== "loaded" ? sdk === "error" ? "O SDK da Meta não carregou. Recarregue a página e verifique bloqueadores do navegador." : "Carregando o SDK oficial da Meta…" : "Você confirma a conta, o número e as permissões na Meta. Respostas automáticas permanecem desativadas."}</p>
        {prepared && !authorizationReceived && <button className={styles.textButton} disabled={busy && !awaitingMeta} onClick={() => void cancel()}>Encerrar tentativa nesta página</button>}
        <dl className={styles.facts}><div><dt>Estado da conexão</dt><dd>{labels[c?.onboarding_status || "not_started"] || "Aguardando revisão"}</dd></div><div><dt>Coexistência</dt><dd>{c?.coexistence_status === "verified" ? "Confirmada pela API da Meta" : "A verificar na Meta"}</dd></div><div><dt>Respostas automáticas</dt><dd>Desativadas</dd></div></dl>
      </section>
      <section className={styles.card} aria-labelledby="diagnostic-title"><div className={styles.cardHeading}><span className={styles.step}>02</span><div><small>ACESSO E ACOMPANHAMENTO</small><h2 id="diagnostic-title">Sua conexão</h2></div></div>
        {loading ? <p role="status">Verificando sua sessão…</p> : !session ? <><p>Entre com sua conta administrativa da Évora.</p><form className={styles.form} onSubmit={signIn}><label>E-mail<input name="email" type="email" autoComplete="username" required /></label><label>Senha<input name="password" type="password" autoComplete="current-password" required /></label><button className={styles.secondary} disabled={busy}>{busy ? "Entrando…" : "Entrar na Évora"}</button></form></> : <>
          {memberships.length > 1 && <label className={styles.select}>Organização<select disabled={busy || prepared} value={organization} onChange={e => { setOrganization(e.target.value); setSnapshot(null); attempt.current = null; setCanResume(false); }}>{memberships.map(m => <option key={m.organization_id} value={m.organization_id}>{m.organizations?.trade_name || m.organizations?.name}</option>)}<option value="">Selecione</option></select></label>}
          <dl className={styles.facts}><div><dt>Canal próprio da Arisa</dt><dd>{!snapshot ? "Consultando…" : snapshot.primary.configured ? snapshot.primary.enabled ? "Configurado · habilitado" : "Configurado · pausado" : "Configuração incompleta"}</dd></div><div><dt>Aplicativo Meta</dt><dd>{snapshot?.configuration.ready ? "Configurado para coexistência" : "Aguardando configuração"}</dd></div><div><dt>Sincronização de contatos</dt><dd>{c?.operations.contacts === "done" ? "Solicitada à Meta" : c?.operations.contacts ? "Requer conferência" : "Ainda não solicitada"}</dd></div><div><dt>Histórico</dt><dd>{c?.history_shared === false ? "Compartilhamento recusado na Meta" : c?.sync_progress != null ? `${c.sync_progress}% recebido` : c?.operations.history === "done" ? "Solicitado · aguardando a Meta" : "Ainda não solicitado"}</dd></div></dl>
          <button className={styles.secondary} disabled={busy || !organization} onClick={() => void refresh()}>Atualizar estado</button>
          {snapshot && <details className={styles.details}><summary>Diagnóstico e auditoria</summary><p><code>franco_personal</code> · Embedded Signup v4 · Graph API v26.0</p><p>App: {snapshot.configuration.appId || "pendente"}<br />Configuração: {snapshot.configuration.configId || "pendente"}</p><p>WABA: {c?.waba_id || "a confirmar"}<br />Phone Number ID: {c?.phone_number_id || "a confirmar"}</p>{c?.token_expires_at && <p>Autorização válida até {new Date(c.token_expires_at).toLocaleDateString("pt-BR")}.</p>}<ul>{snapshot.audit.map(a => <li key={a.id}>{new Date(a.created_at).toLocaleString("pt-BR")} · {events[a.event] || "Estado atualizado"}</li>)}</ul></details>}
          <button className={styles.textButton} disabled={busy} onClick={() => { forget(attempt.current); void client().auth.signOut({ scope: "local" }); }}>Sair desta conta</button>
        </>}
        {notice && <p className={styles.notice} role="status">{notice}</p>}{error && <p className={styles.error} role="alert">{error}</p>}
      </section>
    </div>
    {appId && <Script id="arisa-meta-sdk" src="https://connect.facebook.net/pt_BR/sdk.js" strategy="afterInteractive" onReady={() => setSdk(typeof (window as Window & { FB?: Facebook }).FB?.login === "function" ? "loaded" : "error")} onError={() => setSdk("error")} />}
    <footer className={styles.footer}><span>Arisa · Évora Urbanismo</span><Link href="/privacidade">Privacidade</Link><span>Conexão por coexistência · confirmação na Meta</span></footer>
  </div></main>;
}
