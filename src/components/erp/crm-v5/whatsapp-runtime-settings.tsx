"use client";

import { useEffect, useMemo, useState } from "react";

import type { ErpData } from "../types";

interface RuntimeStatus {
  enabled: boolean;
  mode: "supervised" | "autonomous_replies";
  waba_id: string | null;
  phone_number_id: string | null;
  graph_api_version: string | null;
  display_phone_number: string | null;
  access_token_configured: boolean;
  app_secret_configured: boolean;
  verify_token_configured: boolean;
  ready: boolean;
}

const emptyStatus: RuntimeStatus = {
  enabled: false,
  mode: "supervised",
  waba_id: null,
  phone_number_id: null,
  graph_api_version: null,
  display_phone_number: null,
  access_token_configured: false,
  app_secret_configured: false,
  verify_token_configured: false,
  ready: false,
};

export function WhatsAppRuntimeSettings({ data, canManage }: { data: ErpData; canManage: boolean }) {
  const [status, setStatus] = useState<RuntimeStatus>(emptyStatus);
  const [wabaId, setWabaId] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [graphApiVersion, setGraphApiVersion] = useState("v23.0");
  const [displayPhone, setDisplayPhone] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const callbackUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/api/integrations/whatsapp/webhook?organizationId=${data.organization.id}`;
  }, [data.organization.id]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const response = await fetch(`/api/integrations/whatsapp/runtime?organizationId=${encodeURIComponent(data.organization.id)}`, {
        headers: { Authorization: `Bearer ${data.session.access_token}` },
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = await response.json() as { runtime?: RuntimeStatus };
      if (cancelled || !payload.runtime) return;
      setStatus(payload.runtime);
      setWabaId(payload.runtime.waba_id || "");
      setPhoneNumberId(payload.runtime.phone_number_id || "");
      setGraphApiVersion(payload.runtime.graph_api_version || "v23.0");
      setDisplayPhone(payload.runtime.display_phone_number || "");
    }
    if (canManage && data.session.access_token) void load();
    return () => { cancelled = true; };
  }, [canManage, data.organization.id, data.session.access_token]);

  async function save(nextEnabled = status.enabled) {
    if (!canManage || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/integrations/whatsapp/runtime", {
        method: "PUT",
        headers: { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: data.organization.id,
          wabaId,
          phoneNumberId,
          graphApiVersion,
          displayPhoneNumber: displayPhone,
          accessToken: accessToken || null,
          appSecret: appSecret || null,
          verifyToken: verifyToken || null,
          enabled: nextEnabled,
          mode: "supervised",
        }),
      });
      const payload = await response.json() as { runtime?: RuntimeStatus; error?: string };
      if (!response.ok || !payload.runtime) throw new Error(payload.error || "WHATSAPP_CONFIG_FAILED");
      setStatus(payload.runtime);
      setAccessToken("");
      setAppSecret("");
      setVerifyToken("");
      setNotice(payload.runtime.enabled ? "WhatsApp Cloud ativo em modo supervisionado." : "Configuração salva. O canal permanece desativado.");
    } catch (error) {
      setNotice(error instanceof Error && error.message === "WHATSAPP_CONFIG_FAILED" ? "Não foi possível salvar a configuração." : "Revise os identificadores e as credenciais informadas.");
    } finally {
      setBusy(false);
    }
  }

  return <section className="crm5-panel" id="whatsapp-cloud-setup">
    <header><div><small>WHATSAPP CLOUD API</small><h3>Atendimento bidirecional supervisionado</h3><p>Recebe mensagens pelo webhook oficial da Meta, registra a conversa no CRM e permite enviar respostas aprovadas pela Bia e pelo Supervisor.</p></div></header>
    <div className="crm5-policy-grid">
      <article><strong>{status.ready ? "Pronto" : "Pendente"}</strong><span>Runtime WhatsApp</span></article>
      <article><strong>{status.enabled ? "Ativo" : "Desativado"}</strong><span>Canal bidirecional</span></article>
      <article><strong>{status.access_token_configured ? "Protegido" : "Ausente"}</strong><span>Access token no Vault</span></article>
      <article><strong>Supervisionado</strong><span>Modo inicial obrigatório</span></article>
    </div>
    <div className="form-grid two" style={{ marginTop: 18 }}>
      <label>WABA ID<input disabled={!canManage || busy} value={wabaId} onChange={(event) => setWabaId(event.target.value)} inputMode="numeric" placeholder="ID da conta WhatsApp Business" /></label>
      <label>Phone Number ID<input disabled={!canManage || busy} value={phoneNumberId} onChange={(event) => setPhoneNumberId(event.target.value)} inputMode="numeric" placeholder="ID do número na Meta" /></label>
      <label>Versão da Graph API<input disabled={!canManage || busy} value={graphApiVersion} onChange={(event) => setGraphApiVersion(event.target.value)} placeholder="v23.0" /></label>
      <label>Número exibido<input disabled={!canManage || busy} value={displayPhone} onChange={(event) => setDisplayPhone(event.target.value)} placeholder="+55 ..." /></label>
      <label>Access token<input disabled={!canManage || busy} value={accessToken} onChange={(event) => setAccessToken(event.target.value)} type="password" autoComplete="new-password" placeholder={status.access_token_configured ? "Configurado — deixe em branco para manter" : "Token permanente/sistema"} /></label>
      <label>App secret<input disabled={!canManage || busy} value={appSecret} onChange={(event) => setAppSecret(event.target.value)} type="password" autoComplete="new-password" placeholder={status.app_secret_configured ? "Configurado — deixe em branco para manter" : "App secret da Meta"} /></label>
      <label className="span-2">Verify token<input disabled={!canManage || busy} value={verifyToken} onChange={(event) => setVerifyToken(event.target.value)} type="password" autoComplete="new-password" placeholder={status.verify_token_configured ? "Configurado — deixe em branco para manter" : "Crie um token longo e aleatório"} /></label>
      <label className="span-2">Callback URL<input readOnly value={callbackUrl} onFocus={(event) => event.currentTarget.select()} /></label>
    </div>
    <p style={{ marginTop: 12 }}><small>Os três segredos são armazenados no Supabase Vault e nunca retornam para esta tela. Cadastre a Callback URL acima no webhook do app Meta e assine a WABA para o campo de mensagens.</small></p>
    {notice ? <button className="notice" type="button" onClick={() => setNotice("")}>{notice}</button> : null}
    <footer style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
      <button type="button" disabled={!canManage || busy} onClick={() => void save(false)}>Salvar sem ativar</button>
      <button className="primary" type="button" disabled={!canManage || busy || !wabaId || !phoneNumberId || !graphApiVersion} onClick={() => void save(!status.enabled)}>{status.enabled ? "Desativar WhatsApp Cloud" : "Salvar e ativar supervisionado"}</button>
    </footer>
  </section>;
}
