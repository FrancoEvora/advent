"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import styles from "./communication-hub.module.css";

type Channel = "whatsapp" | "instagram";
type Obj = Record<string, unknown>;
type Status = { whatsapp: { available: boolean; runtime: Obj | null; error: string | null }; instagram: { available: boolean; account: Obj | null; error: string | null }; originMatches: boolean; appId: string; graphVersion: string; callbackUrl: string | null };
type Signup = { state: string; appId: string; configId: string; graphVersion: string; authorizeUrl: string | null };
type FacebookSdk = { init: (config: Obj) => void; login: (callback: (result: { authResponse?: { code?: string } }) => void, options: Obj) => void };
declare global { interface Window { FB?: FacebookSdk } }
export async function metaConnectionRequest(path: string, organizationId: string, body?: Obj) {
  const client = getSupabase();
  const session = client ? await client.auth.getSession() : null;
  const token = session?.data.session?.access_token;
  if (!token) throw new Error("Entre novamente no Enterprise para gerenciar as conexões.");
  const response = await fetch(`/api/integrations/meta/onboarding${path}${body ? "" : `?organizationId=${encodeURIComponent(organizationId)}`}`, {
    method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify({ ...body, organizationId }) } : {}), cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Não foi possível consultar a conexão.");
  return result;
}

export function MetaConnectionPanel({ organizationId, canManage }: { organizationId: string; canManage: boolean }) {
  const [status, setStatus] = useState<Status | null>(null), [signup, setSignup] = useState<Signup | null>(null);
  const [busy, setBusy] = useState(false), [sdkReady, setSdkReady] = useState(false), [step, setStep] = useState(0);
  const [notice, setNotice] = useState(""), [error, setError] = useState("");
  const pending = useRef<{ signup: Signup; code?: string; wabaId?: string; phoneNumberId?: string; sent: boolean } | null>(null);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    if (!canManage) return;
    try { const next = await metaConnectionRequest("", organizationId) as Status; if (mounted.current) setStatus(next); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Não foi possível consultar os canais."); }
  }, [organizationId, canManage]);
  useEffect(() => { mounted.current = true; queueMicrotask(() => { if (mounted.current) void refresh(); }); return () => { mounted.current = false; pending.current = null; }; }, [refresh]);

  const complete = useCallback(async () => {
    const p = pending.current;
    if (!p || p.sent || !p.code || !p.wabaId || !p.phoneNumberId) return;
    p.sent = true; setStep(2);
    try {
      const result = await metaConnectionRequest("/complete", organizationId, { state: p.signup.state, code: p.code, wabaId: p.wabaId, phoneNumberId: p.phoneNumberId });
      if (mounted.current) { setNotice(result.message); setStep(3); await refresh(); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Não foi possível concluir a conexão."); }
    finally { pending.current = null; if (mounted.current) { setBusy(false); setSignup(null); } }
  }, [organizationId, refresh]);
  useEffect(() => {
    function receive(event: MessageEvent) {
      if (!["https://www.facebook.com", "https://web.facebook.com"].includes(event.origin) || !pending.current) return;
      let payload: Obj;
      try { payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data; } catch { return; }
      if (!payload || payload.type !== "WA_EMBEDDED_SIGNUP") return;
      if (typeof payload.event === "string" && payload.event.startsWith("FINISH")) {
        const data = payload.data as Obj | undefined;
        if (typeof data?.waba_id !== "string" || typeof data?.phone_number_id !== "string") return;
        pending.current.wabaId = data.waba_id; pending.current.phoneNumberId = data.phone_number_id; void complete();
      } else if (payload.event === "CANCEL" || payload.event === "ERROR") {
        pending.current = null; setBusy(false); setSignup(null); setError("A ativação não foi concluída na Meta. Você pode iniciar novamente.");
      }
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [complete]);
  async function prepare(channel: Channel) {
    setBusy(true); setError(""); setNotice(""); setStep(0);
    try {
      const next = await metaConnectionRequest("", organizationId, { channel }) as Signup;
      if (channel === "instagram" && next.authorizeUrl) {
        sessionStorage.setItem("evora_meta_callback_org", organizationId);
        window.location.assign(next.authorizeUrl); return;
      }
      setSignup(next); setStep(1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível iniciar a autorização."); }
    finally { setBusy(false); }
  }
  function authorizeWhatsApp() {
    if (!signup || !window.FB || busy) return;
    setBusy(true); setError("");
    pending.current = { signup, sent: false };
    window.FB.init({ appId: signup.appId, version: signup.graphVersion, cookie: false, xfbml: false });
    window.FB.login(result => {
      if (!pending.current) return;
      if (!result.authResponse?.code) { pending.current = null; setBusy(false); setSignup(null); setError("A autorização foi cancelada ou não foi concedida."); return; }
      pending.current.code = result.authResponse.code; void complete();
    }, { config_id: signup.configId, response_type: "code", override_default_response_type: true, extras: { setup: {}, sessionInfoVersion: "3" } });
  }
  const wa = status?.whatsapp.runtime;
  const ig = status?.instagram.account;
  return <section className={styles.stack} aria-label="Conexões oficiais Meta" id="enterprise-meta-connect">
    {status?.whatsapp.available && <Script src="https://connect.facebook.net/pt_BR/sdk.js" strategy="afterInteractive" onReady={() => setSdkReady(true)} onError={() => setError("Não foi possível carregar a janela de autorização da Meta. Verifique bloqueadores de conteúdo.")} />}
    <div className={styles.cards}>
      <article className={styles.card}><small className={styles.eyebrow}>CANAL OFICIAL</small><h3>WhatsApp Business</h3>
        <span className={styles.badge}>{wa?.access_token_configured ? "Credencial cadastrada" : "Aguardando conexão"}</span>
        <p>{String(wa?.display_phone_number || "Conecte o número empresarial pela janela oficial da Meta.")}</p>
        <p>Arisa: gestão administrativa. Bia: relacionamento comercial da Futura Casa. A conexão mantém as ativações e permissões atuais.</p>
        <div className={styles.row}><button className="primary" disabled={!canManage || busy || !status?.whatsapp.available || !status.originMatches} onClick={() => void prepare("whatsapp")}>{wa?.access_token_configured ? "Renovar autorização" : "Conectar WhatsApp"}</button><a href="/arisa?painel=whatsapp">Canal da Arisa</a></div>
        {status?.whatsapp.error && <p className={styles.pending}>{status.whatsapp.error}</p>}
        {canManage && status && !status.whatsapp.available && <p className={styles.pending}>Ativação guiada aguardando a configuração do aplicativo Meta pela equipe técnica.</p>}
      </article>
      <article className={styles.card}><small className={styles.eyebrow}>PERFIL PROFISSIONAL</small><h3>Instagram</h3>
        <span className={styles.badge}>{ig?.authorized ? "Perfil autorizado" : ig?.username ? "Renovar autorização" : "Aguardando autorização"}</span>
        <p>{ig?.username ? `@${ig.username}` : "Autorize o perfil profissional da empresa com seu login do Instagram."}</p>
        <p>A autorização do perfil é a primeira etapa. O Direct permanece pendente de recebimento e encaminhamento; nenhuma assistente é ativada por esta conexão.</p>
        <div className={styles.row}><button className="primary" disabled={!canManage || busy || !status?.instagram.available || !status.originMatches} onClick={() => void prepare("instagram")}>{ig?.username ? "Renovar Instagram" : "Conectar Instagram"}</button></div>
        {typeof ig?.expires_at === "string" && <p>Autorização válida até {new Date(ig.expires_at).toLocaleDateString("pt-BR")}.</p>}
        {status?.instagram.error && <p className={styles.pending}>{status.instagram.error}</p>}
        {canManage && status && !status.instagram.available && <p className={styles.pending}>A equipe técnica precisa concluir a preparação do Instagram para liberar a autorização.</p>}
      </article>
    </div>
    {!canManage && <p className={styles.notice}>Solicite a conexão dos canais a um administrador com permissão de integrações.</p>}
    {status && !status.originMatches && <p className={styles.notice}>A autorização de contas será feita no endereço oficial cadastrado para o Enterprise. O ambiente de revisão preserva os canais ativos.</p>}
    {signup && <article className={styles.card}><h3>Conectar WhatsApp</h3><ol className={styles.steps}>{["Preparar", "Autorizar na Meta", "Verificar e salvar", "Revisar canal"].map((text, i) => <li key={text} aria-current={step === i ? "step" : undefined}>{i + 1}. {text}</li>)}</ol><p>Na janela da Meta, escolha a empresa e o número. Se houver um número cadastrado, selecione o mesmo para preservar a operação.</p><div className={styles.row}><button className="primary" disabled={busy || !sdkReady} onClick={authorizeWhatsApp}>{busy ? "Aguardando a Meta…" : sdkReady ? "Autorizar na Meta" : "Carregando autorização…"}</button><button disabled={step === 2} onClick={() => { pending.current = null; setSignup(null); setBusy(false); }}>Cancelar</button></div></article>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}{error && <p role="alert" className={styles.error}>{error}</p>}
    {canManage && <div className={styles.row}><button disabled={busy} onClick={() => void refresh()}>Atualizar situação dos canais</button></div>}
  </section>;
}
