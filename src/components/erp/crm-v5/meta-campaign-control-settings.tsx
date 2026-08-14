"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ErpData } from "../types";
import type { CrmEnterpriseData } from "./types";
import styles from "./meta-campaign-control-settings.module.css";

type Obj = Record<string, unknown>;
type Permission = { permission: string; status: string };
type Discovery = {
  identity: { id: string; name: string };
  permissions: Permission[];
  ad_accounts: Obj[];
  pages: Obj[];
  phones: Obj[];
  businesses: Obj[];
  warnings: string[];
  api_version?: string;
};
type Connection = {
  id?: string;
  status?: string;
  app_id?: string;
  ad_account_id?: string;
  page_id?: string;
  page_name?: string;
  business_id?: string;
  token_subject_id?: string;
  permissions?: unknown[];
  capabilities?: Obj;
  metadata?: Obj;
  last_verified_at?: string;
  updated_at?: string;
};
type SetupState = {
  marketing_token_configured: boolean;
  connection: Connection | null;
};
type SyncResult = {
  forms?: number;
  fetched?: number;
  queued?: number;
  crm_meta_leads?: number;
  errors?: unknown[];
};

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function id(value: unknown) { return text(value).replace(/^act_/i, "").replace(/\D/g, ""); }
function metadata(connection: Connection | null) { return connection && isObj(connection.metadata) ? connection.metadata : {}; }
function instagramId(page: Obj | undefined) {
  return page && isObj(page.instagram_business_account) ? id(page.instagram_business_account.id) : "";
}
function accountLabel(account: Obj) {
  const accountId = id(account.account_id) || id(account.id);
  return `${text(account.name) || "Sem nome"} · act_${accountId}${text(account.currency) ? ` · ${text(account.currency)}` : ""}`;
}
function pageLabel(page: Obj) { return `${text(page.name) || "Sem nome"} · ${id(page.id)}`; }
function phoneLabel(phone: Obj) { return `${text(phone.verified_name) || "WhatsApp"} · ${text(phone.display_phone_number) || id(phone.id)}`; }

async function sessionToken() {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase indisponível.");
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) throw new Error("Sua sessão expirou. Entre novamente.");
  return data.session.access_token;
}

async function edgeRequest(
  slug: "campaign-control-meta-local" | "enterprise-meta-direct",
  action: string,
  payload?: Obj,
) {
  const accessToken = await sessionToken();
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const apiKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!base || !apiKey) throw new Error("Configuração segura do Supabase indisponível.");
  const response = await fetch(`${base}/functions/v1/${slug}?action=${encodeURIComponent(action)}`, {
    method: payload ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: apiKey,
      Accept: "application/json",
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    cache: "no-store",
  });
  const result = await response.json().catch(() => null) as unknown;
  if (!response.ok || !isObj(result) || result.error) {
    const detail = isObj(result) ? text(result.detail) : "";
    const message = isObj(result) ? text(result.error) : "";
    throw new Error(detail || message || "A operação Meta não foi concluída.");
  }
  return result;
}

export function MetaCampaignControlSettings({
  data,
  crm,
  reload,
  canManage,
}: {
  data: ErpData;
  crm: CrmEnterpriseData;
  reload: () => Promise<void>;
  canManage: boolean;
}) {
  const [apiVersion, setApiVersion] = useState("v25.0");
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [adAccountId, setAdAccountId] = useState("");
  const [adAccountName, setAdAccountName] = useState("");
  const [pageId, setPageId] = useState("");
  const [instagramActorId, setInstagramActorId] = useState("");
  const [whatsappPhoneId, setWhatsappPhoneId] = useState("");
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [whatsappDisplayName, setWhatsappDisplayName] = useState("");
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [busy, setBusy] = useState<"load" | "connect" | "save" | "sync" | null>("load");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const connection = setup?.connection || null;
  const connectionMeta = useMemo(() => metadata(connection), [connection]);

  function applyConnection(saved: Connection | null) {
    if (!saved) return;
    const meta = metadata(saved);
    if (text(meta.api_version)) setApiVersion(text(meta.api_version));
    if (saved.ad_account_id) setAdAccountId(id(saved.ad_account_id));
    if (text(meta.ad_account_name)) setAdAccountName(text(meta.ad_account_name));
    if (saved.page_id) setPageId(id(saved.page_id));
    if (text(meta.instagram_actor_id)) setInstagramActorId(id(meta.instagram_actor_id));
    if (text(meta.whatsapp_phone_number_id)) setWhatsappPhoneId(id(meta.whatsapp_phone_number_id));
    if (text(meta.whatsapp_number)) setWhatsappNumber(text(meta.whatsapp_number).replace(/\D/g, ""));
    if (text(meta.whatsapp_display_name)) setWhatsappDisplayName(text(meta.whatsapp_display_name));
  }

  function applyDiscovery(next: Discovery, saved = connection) {
    setDiscovery(next);
    const savedMeta = metadata(saved);
    const savedAd = id(saved?.ad_account_id);
    const savedPage = id(saved?.page_id);
    const savedPhone = id(savedMeta.whatsapp_phone_number_id);

    const account = next.ad_accounts.find((candidate) => (id(candidate.account_id) || id(candidate.id)) === savedAd)
      || (next.ad_accounts.length === 1 ? next.ad_accounts[0] : undefined);
    if (account) {
      setAdAccountId(id(account.account_id) || id(account.id));
      setAdAccountName(text(account.name));
    }
    const page = next.pages.find((candidate) => id(candidate.id) === savedPage)
      || (next.pages.length === 1 ? next.pages[0] : undefined);
    if (page) {
      setPageId(id(page.id));
      setInstagramActorId(instagramId(page));
    }
    const phone = next.phones.find((candidate) => id(candidate.id) === savedPhone)
      || (next.phones.length === 1 ? next.phones[0] : undefined);
    if (phone) {
      setWhatsappPhoneId(id(phone.id));
      setWhatsappNumber(text(phone.display_phone_number).replace(/\D/g, ""));
      setWhatsappDisplayName(`${text(phone.verified_name)} ${text(phone.display_phone_number)}`.trim());
    }
  }

  async function discover(api = apiVersion, token = accessToken, secret = appSecret, saved = connection) {
    const result = await edgeRequest("campaign-control-meta-local", "discover", {
      api_version: api,
      access_token: token,
      app_secret: secret,
    });
    const next: Discovery = {
      identity: isObj(result.identity) ? { id: id(result.identity.id), name: text(result.identity.name) } : { id: "", name: "" },
      permissions: Array.isArray(result.permissions) ? result.permissions.filter(isObj).map((row) => ({ permission: text(row.permission), status: text(row.status) })) : [],
      ad_accounts: Array.isArray(result.ad_accounts) ? result.ad_accounts.filter(isObj) : [],
      pages: Array.isArray(result.pages) ? result.pages.filter(isObj) : [],
      phones: Array.isArray(result.phones) ? result.phones.filter(isObj) : [],
      businesses: Array.isArray(result.businesses) ? result.businesses.filter(isObj) : [],
      warnings: Array.isArray(result.warnings) ? result.warnings.filter((value): value is string => typeof value === "string") : [],
      api_version: text(result.api_version) || api,
    };
    applyDiscovery(next, saved);
    return next;
  }

  async function load(autoDiscover = true) {
    setBusy("load"); setError(""); setNotice("");
    try {
      const result = await edgeRequest("campaign-control-meta-local", "status");
      const saved = isObj(result.connection) ? result.connection as Connection : null;
      const next: SetupState = {
        marketing_token_configured: result.token_configured === true,
        connection: saved,
      };
      setSetup(next);
      applyConnection(saved);
      const api = text(result.api_version) || text(metadata(saved).api_version) || "v25.0";
      setApiVersion(api);
      if (autoDiscover && next.marketing_token_configured) {
        await discover(api, "", "", saved);
        setNotice("Credencial protegida e ativos carregados pelo mesmo conector do Campaign Control.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar a configuração Meta.");
    } finally { setBusy(null); }
  }

  useEffect(() => { void load(true); }, []);

  async function connect() {
    setBusy("connect"); setError(""); setNotice("");
    try {
      const next = await discover();
      setNotice(`${next.ad_accounts.length} conta(s), ${next.pages.length} Página(s), ${next.businesses.length} Business(es) e ${next.phones.length} WhatsApp(s) encontrados.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha na conexão com a Meta.");
    } finally { setBusy(null); }
  }

  async function syncLeads() {
    setBusy("sync"); setError("");
    try {
      const result = await edgeRequest("enterprise-meta-direct", "sync", {});
      const sync: SyncResult = {
        forms: Number(result.forms || 0),
        fetched: Number(result.fetched || 0),
        queued: Number(result.queued || 0),
        crm_meta_leads: Number(result.crm_meta_leads || 0),
        errors: Array.isArray(result.errors) ? result.errors : [],
      };
      setSyncResult(sync);
      setNotice(`Sincronização concluída: ${sync.fetched || 0} lead(s) lido(s) e ${sync.crm_meta_leads || 0} registro(s) Meta no CRM.`);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "A sincronização de leads falhou.");
      throw cause;
    } finally { setBusy(null); }
  }

  async function save() {
    setBusy("save"); setError(""); setNotice(""); setSyncResult(null);
    try {
      const result = await edgeRequest("campaign-control-meta-local", "save", {
        api_version: apiVersion,
        access_token: accessToken,
        app_secret: appSecret,
        ad_account_id: adAccountId,
        ad_account_name: adAccountName,
        page_id: pageId,
        page_name: text(discovery?.pages.find((page) => id(page.id) === pageId)?.name) || connection?.page_name || "",
        instagram_actor_id: instagramActorId,
        whatsapp_number: whatsappNumber,
        whatsapp_phone_number_id: whatsappPhoneId,
        whatsapp_display_name: whatsappDisplayName,
      });
      const saved = isObj(result.connection) ? result.connection as Connection : connection;
      setSetup({ marketing_token_configured: true, connection: saved });
      applyConnection(saved);
      setAccessToken(""); setAppSecret("");
      setNotice("Conexão validada e salva pelo mesmo conector do Campaign Control. Sincronizando formulários e leads…");
      try {
        await syncLeads();
      } catch {
        // syncLeads já mostra o erro sem desfazer a conexão salva.
      }
      await load(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível validar e salvar a conexão.");
    } finally { setBusy(null); }
  }

  async function toggleRoute(route: Obj) {
    if (!canManage) return;
    const supabase = getSupabase(); if (!supabase) return;
    const routeId = text(route.id); if (!routeId) return;
    setBusy("save"); setError("");
    try {
      const result = await supabase.from("crm_meta_lead_routes").update({ active: route.active !== true, updated_at: new Date().toISOString() }).eq("organization_id", data.organization.id).eq("id", routeId);
      if (result.error) throw result.error;
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível alterar a rota."); }
    finally { setBusy(null); }
  }

  const selectedAccount = discovery?.ad_accounts.find((candidate) => (id(candidate.account_id) || id(candidate.id)) === adAccountId);
  const selectedPage = discovery?.pages.find((candidate) => id(candidate.id) === pageId);
  const selectedPhone = discovery?.phones.find((candidate) => id(candidate.id) === whatsappPhoneId);
  const permissions = discovery?.permissions || [];
  const connected = connection?.status === "CONNECTED" && Boolean(connection?.page_id) && Boolean(connection?.ad_account_id) && Boolean(setup?.marketing_token_configured);
  const routeList = crm.metaLeadRoutes as unknown as Obj[];

  return <section id="meta-campaign-control-setup" className={`crm5-panel ${styles.panel}`}>
    <div className={styles.hero}>
      <div><small>META · CONECTOR COMPARTILHADO COM O ÉVORA CAMPAIGN CONTROL</small><h3>Meta Leads — Facebook e Instagram</h3><p>Não existe um segundo processo de conexão: o Enterprise chama o próprio conector local-compatible do Campaign Control e usa a mesma credencial protegida no Vault.</p></div>
      <span className={`${styles.statusPill} ${connected ? styles.connected : ""}`}>{connected ? "CONECTADO" : setup?.marketing_token_configured ? "CONFIGURAÇÃO PENDENTE" : "NÃO CONFIGURADO"}</span>
    </div>

    {error && <div className={styles.error}>{error}</div>}
    {notice && <div className={styles.notice}>{notice}</div>}

    <div className={styles.grid}>
      <article className={styles.card}>
        <div className={styles.step}><span className={styles.stepNumber}>1</span><div><small>CONEXÃO</small><h4>Conectar e descobrir os ativos</h4><p>Mesmo fluxo da versão local: versão da Graph API, App Secret opcional e Access Token.</p></div></div>
        <div className={styles.fieldGrid}>
          <div className={styles.field}><label>Versão da API</label><input value={apiVersion} onChange={(event) => setApiVersion(event.target.value)} placeholder="v25.0" /></div>
          <div className={styles.field}><label>App Secret <span className={styles.hint}>(opcional)</span></label><input type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} autoComplete="off" placeholder="Deixe vazio quando não for exigido" /></div>
        </div>
        <div className={styles.field}><label>Access Token</label><input type="password" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} autoComplete="off" placeholder={setup?.marketing_token_configured ? "Credencial protegida salva — deixe vazio para reutilizar" : "Cole o Access Token da Meta"} /></div>
        <div className={styles.actions}><button className={styles.primary} disabled={!canManage || busy !== null && busy !== "load"} onClick={connect}>{busy === "connect" ? "Conectando…" : "Conectar à Meta"}</button>{setup?.marketing_token_configured && <button className={styles.secondary} disabled={busy !== null} onClick={() => load(true)}>Recarregar ativos salvos</button>}<span className={`${styles.inlineStatus} ${discovery ? styles.ok : ""}`}>{discovery ? `Conectado como ${discovery.identity.name || discovery.identity.id || "usuário Meta"}` : busy === "load" ? "Carregando…" : ""}</span></div>
        {discovery && <div className={styles.assetStats}><article><strong>{discovery.ad_accounts.length}</strong><span>contas de anúncios</span></article><article><strong>{discovery.pages.length}</strong><span>Páginas</span></article><article><strong>{discovery.businesses.length}</strong><span>Businesses</span></article><article><strong>{discovery.phones.length}</strong><span>WhatsApps</span></article></div>}
      </article>

      <article className={styles.card}>
        <div className={styles.step}><span className={styles.stepNumber}>2</span><div><small>OPERAÇÃO</small><h4>Escolher a operação</h4><p>Os ativos são os mesmos devolvidos ao Campaign Control. IDs manuais continuam disponíveis como fallback.</p></div></div>
        <div className={styles.field}><label>Conta de anúncios</label><select value={adAccountId} onChange={(event) => { const value = event.target.value; setAdAccountId(value); const found = discovery?.ad_accounts.find((item) => (id(item.account_id) || id(item.id)) === value); setAdAccountName(found ? text(found.name) : ""); }}><option value="">{discovery ? "Selecione" : "Conecte para listar"}</option>{discovery?.ad_accounts.map((account) => { const value = id(account.account_id) || id(account.id); return <option key={value} value={value}>{accountLabel(account)}</option>; })}</select></div>
        <div className={styles.fieldGrid}><div className={styles.field}><label>ID da conta</label><input value={adAccountId} onChange={(event) => setAdAccountId(id(event.target.value))} /></div><div className={styles.field}><label>Nome da conta</label><input value={adAccountName || text(selectedAccount?.name) || text(connectionMeta.ad_account_name)} readOnly /></div></div>
        <div className={styles.field}><label>Página da operação</label><select value={pageId} onChange={(event) => { const value = event.target.value; setPageId(value); const found = discovery?.pages.find((item) => id(item.id) === value); setInstagramActorId(instagramId(found)); }}><option value="">{discovery ? "Selecione" : "Conecte para listar"}</option>{discovery?.pages.map((page) => { const value = id(page.id); return <option key={value} value={value}>{pageLabel(page)}</option>; })}</select></div>
        <div className={styles.fieldGrid}><div className={styles.field}><label>ID da Página</label><input value={pageId} onChange={(event) => setPageId(id(event.target.value))} /></div><div className={styles.field}><label>Instagram Business ID</label><input value={instagramActorId || instagramId(selectedPage) || id(connectionMeta.instagram_actor_id)} onChange={(event) => setInstagramActorId(id(event.target.value))} placeholder="Preenchido automaticamente" /></div></div>
        <div className={styles.field}><label>WhatsApp Business</label><select value={whatsappPhoneId} onChange={(event) => { const value = event.target.value; setWhatsappPhoneId(value); const found = discovery?.phones.find((item) => id(item.id) === value); if (found) { setWhatsappNumber(text(found.display_phone_number).replace(/\D/g, "")); setWhatsappDisplayName(`${text(found.verified_name)} ${text(found.display_phone_number)}`.trim()); } }}><option value="">Selecione ou informe manualmente</option>{discovery?.phones.map((phone) => { const value = id(phone.id); return <option key={value} value={value}>{phoneLabel(phone)}</option>; })}</select></div>
        <div className={styles.fieldGrid}><div className={styles.field}><label>WhatsApp com DDI e DDD</label><input value={whatsappNumber} onChange={(event) => setWhatsappNumber(event.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="5534XXXXXXXXX" /></div><div className={styles.field}><label>Phone Number ID <span className={styles.hint}>(recomendado)</span></label><input value={whatsappPhoneId} onChange={(event) => setWhatsappPhoneId(id(event.target.value))} /></div></div>
      </article>

      <article className={`${styles.card} ${styles.full}`}>
        <div className={styles.step}><span className={styles.stepNumber}>3</span><div><small>VALIDAÇÃO</small><h4>Validar e salvar a ativação</h4><p>Conta e Página são validadas na Graph API, a credencial fica no mesmo Vault e o Page Access Token é derivado pelo mesmo conector usado pelo Campaign Control.</p></div></div>
        <div className={styles.actions}><button className={styles.primary} disabled={!canManage || busy !== null || !adAccountId || !pageId || whatsappNumber.length < 10} onClick={save}>{busy === "save" ? "Validando e salvando…" : "Validar e salvar"}</button><button className={styles.secondary} disabled={busy !== null || !connected} onClick={syncLeads}>{busy === "sync" ? "Sincronizando…" : "Sincronizar leads agora"}</button></div>
        <div className={styles.summary}><div className={styles.summaryRow}><span>Conta</span><strong>{adAccountName || text(selectedAccount?.name) || text(connectionMeta.ad_account_name) || adAccountId || "—"}</strong></div><div className={styles.summaryRow}><span>Página</span><strong>{text(selectedPage?.name) || connection?.page_name || pageId || "—"}</strong></div><div className={styles.summaryRow}><span>WhatsApp</span><strong>{whatsappDisplayName || text(selectedPhone?.verified_name) || text(connectionMeta.whatsapp_display_name) || whatsappNumber || "—"}</strong></div><div className={styles.summaryRow}><span>Credencial</span><strong>{setup?.marketing_token_configured ? "Protegida no Vault compartilhado com o Campaign Control" : "Ainda não salva"}</strong></div></div>
      </article>
    </div>

    {discovery && <article className={styles.card}>
      <div><span className={styles.miniTitle}>TOKEN RECONHECIDO</span><div className={styles.identity}><strong>{discovery.identity.name || "Usuário Meta"}</strong><span>ID {discovery.identity.id || "—"}</span></div></div>
      <div><span className={styles.miniTitle}>PERMISSÕES</span><div className={styles.permissionGrid}>{permissions.map((permission) => <div className={styles.permission} key={permission.permission}><b>{permission.permission}</b><i className={permission.status === "granted" ? styles.ok : ""}>{permission.status === "granted" ? "OK" : permission.status}</i></div>)}</div></div>
      {discovery.warnings.length > 0 && <div className={styles.notice}>{discovery.warnings.join(" · ")}</div>}
    </article>}

    <article className={styles.card}>
      <div className={styles.step}><span className={styles.stepNumber}>4</span><div><small>LEAD ADS → CRM</small><h4>Rotas comerciais</h4><p>Depois da conexão, o Enterprise usa os formulários da Página para criar/atualizar as rotas e inserir os leads diretamente no CRM.</p></div></div>
      {routeList.length > 0 ? <div className={styles.forms}>{routeList.filter((route) => !pageId || id(route.page_id) === pageId).map((route) => <article key={text(route.id)}><div><strong>{text(route.name) || `Formulário ${text(route.form_id)}`}</strong><small>Form {text(route.form_id)} · {route.active === true ? "recebimento ativo" : "recebimento pausado"}</small></div>{canManage && <button className={styles.secondary} disabled={busy !== null} onClick={() => toggleRoute(route)}>{route.active === true ? "Pausar" : "Ativar"}</button>}</article>)}</div> : <p className={styles.routeInfo}>As rotas serão criadas quando os formulários forem sincronizados.</p>}
      {syncResult && <div className={styles.syncResult}><article><strong>{Number(syncResult.forms || 0)}</strong><span>formulários</span></article><article><strong>{Number(syncResult.fetched || 0)}</strong><span>leads lidos</span></article><article><strong>{Number(syncResult.queued || 0)}</strong><span>novos na fila</span></article><article><strong>{Number(syncResult.crm_meta_leads || 0)}</strong><span>leads Meta no CRM</span></article><article><strong>{Array.isArray(syncResult.errors) ? syncResult.errors.length : 0}</strong><span>exceções</span></article></div>}
    </article>
  </section>;
}
