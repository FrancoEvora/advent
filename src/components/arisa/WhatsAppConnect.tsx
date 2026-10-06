"use client";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { client } from "./chat-client";
import type { ConnectResponse } from "@/lib/integrations/whatsapp/connect-policy";
import styles from "./whatsapp-connect.module.css";

type Membership = { organization_id: string; organizations: { name: string; trade_name: string | null; active: boolean } | null };
const REGISTER = "https://www.ycloud.com/console/#/entry/register";
const GUIDE = "https://helpdocs.ycloud.com/help-center/whatsapp-accounts-management/create-a-whatsapp-api-account/whatsapp-business-app-coexistence";
const labels: Record<string, string> = { not_started: "Ainda não conectado", checking: "Tentativa anterior pendente", blocked: "Tentativa anterior não concluída", error: "Etapa não concluída", authorized: "Autorização anterior pendente", connected: "Conectado por coexistência", cancelled: "Tentativa anterior cancelada", disconnected: "Desconectado na Meta" };
const events: Record<string, string> = { preflight_started: "Diagnóstico inicial", onboarding_blocked: "Bloqueio da versão anterior", onboarding_started: "Onboarding iniciado", token_received: "Autorização recebida", coexistence_verified: "Coexistência confirmada pela API", onboarding_connected: "Conexão e sincronização solicitadas", onboarding_cancelled: "Tentativa cancelada", onboarding_error: "Etapa não concluída" };

export default function WhatsAppConnect() {
  const [session, setSession] = useState<Session | null>(null), [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [memberships, setMemberships] = useState<Membership[]>([]), [organization, setOrganization] = useState("");
  const [snapshot, setSnapshot] = useState<ConnectResponse | null>(null), [revision, setRevision] = useState(0);
  const activeUser = useRef<string | null>(null), userId = session?.user.id;
  useEffect(() => {
    let alive = true;
    const auth = client().auth;
    const apply = (value: Session | null) => {
      if (!alive) return;
      if (activeUser.current !== (value?.user.id || null)) {
        activeUser.current = value?.user.id || null;
        setOrganization(""); setMemberships([]); setSnapshot(null); setError(""); setBusy(false);
      }
      setSession(value); setLoading(false);
    };
    void auth.getSession().then(({ data }) => apply(data.session));
    const { data } = auth.onAuthStateChange((_event, value) => apply(value));
    return () => { alive = false; data.subscription.unsubscribe(); };
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
        if (controller.signal.aborted || activeUser.current !== userId) return;
        setBusy(true); setError("");
        if (!data.session || data.session.user.id !== userId) throw new Error("Entre novamente para continuar.");
        const response = await fetch(`/api/arisa/whatsapp-connect?organizationId=${organization}`, { headers: { authorization: `Bearer ${data.session.access_token}` }, cache: "no-store", signal: controller.signal });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.message || "Não foi possível consultar a conexão.");
        if (!controller.signal.aborted && activeUser.current === userId) setSnapshot(result);
      } catch (failure) {
        if (!controller.signal.aborted && activeUser.current === userId) setError(failure instanceof Error ? failure.message : "Consulta indisponível.");
      } finally { if (!controller.signal.aborted && activeUser.current === userId) setBusy(false); }
    })();
    return () => controller.abort();
  }, [organization, userId, revision]);
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); const form = new FormData(event.currentTarget);
    try { const result = await client().auth.signInWithPassword({ email: String(form.get("email")), password: String(form.get("password")) }); if (result.error) throw new Error("Não foi possível entrar. Confira seu e-mail e sua senha."); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Não foi possível entrar."); } finally { setBusy(false); }
  }
  const c = snapshot?.connection;
  return <main className={styles.page}><div className={styles.shell}>
    <header className={styles.header}><Link href="/arisa" className={styles.brand}><Image src="/arisa-profile.webp" alt="Arisa" width={44} height={44} /><span><strong>Arisa</strong><small>ÉVORA URBANISMO</small></span></Link><Link href="/arisa">Voltar à Arisa ↗</Link></header>
    <section className={styles.hero}><span className={styles.eyebrow}>WHATSAPP BUSINESS · COEXISTENCE</span><h1>Preparar seu WhatsApp<br />para o Franco</h1><p>Prepare a conexão do seu WhatsApp Business pela YCloud, usando o cadastro oficial da Meta para manter o aplicativo no iPhone.</p><div className={styles.safety}><span aria-hidden="true">◇</span><span>Etapa atual: criar a conta gratuita do provedor, antes de vincular o número.</span></div></section>
    <div className={styles.grid}>
      <section className={styles.card} aria-labelledby="connection-title"><div className={styles.cardHeading}><span className={styles.step}>01</span><div><small>SEU SEGUNDO CANAL</small><h2 id="connection-title">Preparação pela YCloud</h2></div><span className={styles.badge}>Antes da conexão</span></div>
        <p>O fluxo direto do aplicativo Arisa depende de uma permissão avançada que a Meta não disponibilizou para o uso próprio informado. A preparação seguirá pelo provedor YCloud.</p>
        <ol className={styles.steps}>
          <li><strong>Crie sua conta no plano Free.</strong><span>Cadastre seu e-mail, defina a senha e conclua a verificação de segurança no site da YCloud. O plano não exige cartão nem mensalidade; mensagens pela API têm cobrança separada.</span></li>
          <li><strong>Localize a opção de coexistência.</strong><span>No painel, acesse Create channels → WhatsApp Business APP Coexistence → WhatsApp Business App Number.</span></li>
          <li><strong>Pare antes de confirmar o vínculo.</strong><span>Não escaneie o QR de conexão nem autorize a vinculação no iPhone nesta etapa. A integração com a Arisa e a elegibilidade do número ainda precisam ser verificadas.</span></li>
        </ol>
        <a className={styles.providerLink} href={REGISTER} target="_blank" rel="noopener noreferrer">Criar conta gratuita na YCloud ↗</a>
        <div className={styles.actions}><a href="https://www.ycloud.com/console/" target="_blank" rel="noopener noreferrer">Já tenho conta: abrir painel YCloud ↗</a><a href={GUIDE} target="_blank" rel="noopener noreferrer">Ver o guia de coexistência ↗</a></div>
        <p className={styles.hint}>Os links abrem a YCloud em outra aba. Abrir o cadastro não envia seu número, contatos ou histórico e não altera o estado da conexão nesta página. Digite a senha apenas no site do provedor.</p>
        <div className={styles.warning}><strong>A confirmação no telefone já pode vincular sua conta</strong><p>A coexistência mantém o WhatsApp Business principal. A Meta pode desconectar dispositivos vinculados e algumas funções podem mudar. Se não houver a opção de conectar o WhatsApp Business existente, encerre o cadastro.</p><p>A YCloud poderá processar os dados do canal após sua autorização de conexão. A preparação desta página não inicia sincronização de histórico.</p><a href="https://www.ycloud.com/terms-service" target="_blank" rel="noopener noreferrer">Termos da YCloud ↗</a>{" · "}<a href="https://www.ycloud.com/privacy-policy" target="_blank" rel="noopener noreferrer">Privacidade da YCloud ↗</a></div>
      </section>
      <section className={styles.card} aria-labelledby="diagnostic-title"><div className={styles.cardHeading}><span className={styles.step}>02</span><div><small>ACESSO E ACOMPANHAMENTO</small><h2 id="diagnostic-title">Estado na Arisa</h2></div></div>
        <p>O cadastro externo não é confirmado automaticamente aqui. A conexão via YCloud e a recepção de seus eventos pela Arisa ainda não foram configuradas.</p>
        {loading ? <p role="status">Verificando sua sessão…</p> : !session ? <><p>Entre com sua conta administrativa da Évora para consultar os canais existentes.</p><form className={styles.form} onSubmit={signIn}><label>E-mail<input name="email" type="email" autoComplete="username" required /></label><label>Senha<input name="password" type="password" autoComplete="current-password" required /></label><button className={styles.secondary} disabled={busy}>{busy ? "Entrando…" : "Entrar na Évora"}</button></form></> : <>
          {memberships.length > 1 && <label className={styles.select}>Organização<select disabled={busy} value={organization} onChange={e => { setOrganization(e.target.value); setSnapshot(null); }}>{memberships.map(m => <option key={m.organization_id} value={m.organization_id}>{m.organizations?.trade_name || m.organizations?.name}</option>)}<option value="">Selecione</option></select></label>}
          {c?.onboarding_status === "connected" && <p className={styles.notice}>Há uma conexão anterior confirmada pela API da Meta para {c.phone_number_masked}. Este registro não confirma uma conexão pela YCloud.</p>}
          <dl className={styles.facts}>
            <div><dt>Canal próprio da Arisa</dt><dd>{!snapshot ? "Aguardando consulta" : snapshot.primary.configured ? snapshot.primary.enabled ? "Configurado · habilitado" : "Configurado · pausado" : "Configuração incompleta"}</dd></div>
            <div><dt>Último registro do canal pessoal</dt><dd>{!snapshot ? "Aguardando consulta" : labels[c?.onboarding_status || "not_started"] || "Aguardando revisão"}</dd></div>
            <div><dt>Integração YCloud → Arisa</dt><dd>Pendente de configuração</dd></div>
            <div><dt>Elegibilidade via YCloud</dt><dd>Ainda não verificada</dd></div>
            <div><dt>Respostas automáticas pessoais</dt><dd>Desativadas</dd></div>
            <div><dt>Sincronização de contatos</dt><dd>{c?.operations.contacts === "done" ? "Solicitada anteriormente à Meta" : c?.operations.contacts ? "Requer conferência" : "Ainda não solicitada"}</dd></div>
            <div><dt>Histórico</dt><dd>{c?.history_shared === false ? "Compartilhamento recusado na Meta" : c?.sync_progress != null ? `${c.sync_progress}% recebido` : c?.operations.history === "done" ? "Solicitado anteriormente à Meta" : "Ainda não solicitado"}</dd></div>
          </dl>
          <button className={styles.secondary} disabled={busy || !organization} onClick={() => setRevision(value => value + 1)}>{busy ? "Consultando…" : "Atualizar estado"}</button>
          {snapshot && <details className={styles.details}><summary>Diagnóstico e auditoria anteriores</summary><p><code>franco_personal</code> · Integração direta Meta</p><p>App: {snapshot.configuration.appId || "pendente"}<br />Configuração: {snapshot.configuration.configId || "pendente"}</p><p>WABA: {c?.waba_id || "a confirmar"}<br />Phone Number ID: {c?.phone_number_id || "a confirmar"}</p>{c?.token_expires_at && <p>Autorização válida até {new Date(c.token_expires_at).toLocaleDateString("pt-BR")}.</p>}<ul>{snapshot.audit.map(a => <li key={a.id}>{new Date(a.created_at).toLocaleString("pt-BR")} · {events[a.event] || "Estado atualizado"}</li>)}</ul></details>}
          <button className={styles.textButton} disabled={busy} onClick={() => void client().auth.signOut({ scope: "local" })}>Sair desta conta</button>
        </>}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </section>
    </div>
    <footer className={styles.footer}><span>Arisa · Évora Urbanismo</span><Link href="/privacidade">Privacidade</Link><span>Preparação · confirmação do número ainda pendente</span></footer>
  </div></main>;
}
