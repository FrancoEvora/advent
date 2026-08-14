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
};
type Connection = {
  id?: string;
  status?: string;
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
  token_subject_id: string;
  token_subject_name: string;
  connection: Connection | null;
  routes: Array<Obj>;
};
type SyncResult = {
  formsFound?: number;
  fetched?: number;
  queued?: number;
  duplicates?: number;
  unmapped?: number;
  processing?: unknown;
};

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function id(value: unknown) { return text(value).replace(/^act_/i, "").replace(/\D/g, ""); }
function metadata(connection: Connection | null) { return connection && isObj(connection.metadata) ? connection.metadata : {}; }
function nested(source: Obj, key: string) { return isObj(source[key]) ? source[key] as Obj : {}; }
function instagramId(page: Obj | undefined) {
  return page && isObj(page.instagram_business_account) ? id(page.instagram_business_account.id) : "";
}
function accountLabel(account: Obj) {
  const accountId = id(account.account_id) || id(account.id);
  return `${text(account.name) || "Sem nome"} · act_${accountId}${text(account.currency) ? ` · ${text(account.currency)}` : ""}`;
}
function pageLabel(page: Obj) { return `${text(page.name) || "Sem nome"} · ${id(page.id)}`; }
function phoneLabel(phone: Obj) { return `${text(phone.verified_name) || "WhatsApp"} · ${text(phone.display_phone_number) || id(phone.id)}`; }

async function bearer() {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase indisponível.");
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) throw new Error("Sua sessão expirou. Entre novamente.");
  return `Bearer ${data.session.access_token}`;
}

async function requestJson(method: "GET" | "POST" | "PUT", url: string, payload?: Obj) {
  const authorization = await bearer();
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: authorization,
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    cache: "no-store",
    credentials: "same-origin",
  });
  const result = await response.json().catch(() => null) as unknown;
  if (!response.ok || !isObj(result) || result.ok !== true) {
    const message = isObj(result) && typeof result.error === "string" ? result.error : "A operação não foi concluída.";
    throw new Error(message);
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
  const [forms, setForms] = useState<Obj[]>([]);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [busy, setBusy] = useState<"load" | "connect" | "save" | "sync" | null>("load");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const connection = setup?.connection || null;
  const connectionMeta = useMemo(() => metadata(connection), [connection]);
  const currentWhatsapp = useMemo(() => nested(connectionMeta, "whatsapp"), [connectionMeta]);
  const currentPage = useMemo(() => nested(connectionMeta, "page"), [connectionMeta]);
  const currentAccount = useMemo(() => nested(connectionMeta, "ad_account"), [connectionMeta]);

  function applyConnection(next: SetupState) {
    const saved = next.connection;
    const meta = metadata(saved);
    const whatsapp = nested(meta, "whatsapp");
    const account = nested(meta, "ad_account");
    const page = nested(meta, "page");
    const savedForms = Array.isArray(meta.forms) ? meta.forms.filter(isObj) : [];
    if (text(meta.api_version)) setApiVersion(text(meta.api_version));
    if (saved?.ad_account_id) setAdAccountId(id(saved.ad_account_id));
    if (text(account.name)) setAdAccountName(text(account.name));
    if (saved?.page_id) setPageId(id(saved.page_id));
    if (isObj(page.instagram_business_account)) setInstagramActorId(id(page.instagram_business_account.id));
    if (text(meta.instagram_actor_id)) setInstagramActorId(id(meta.instagram_actor_id));
    if (text(whatsapp.phone_number_id)) setWhatsappPhoneId(id(whatsapp.phone_number_id));
    if (text(whatsapp.number)) setWhatsappNumber(id(whatsapp.number));
    if (text(whatsapp.display_name)) setWhatsappDisplayName(text(whatsapp.display_name));
    if (savedForms.length) setForms(savedForms);
  }

  function applyDiscovery(next: Discovery, saved?: Connection | null) {
    setDiscovery(next);
    const savedMeta = metadata(saved || connection);
    const savedWhatsapp = nested(savedMeta, "whatsapp");
    const savedAd = id(saved?.ad_account_id || connection?.ad_account_id);
    const savedPage = id(saved?.page_id || connection?.page_id);
    const savedPhone = id(savedWhatsapp.phone_number_id);

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

  async function connectWith(api = apiVersion, token = accessToken, secret = appSecret, saved?: Connection | null) {
    const result = await requestJson("POST", "/api/integrations/meta/campaign-control", {
      organizationId: data.organization.id,
      api_version: api,
      access_token: token,
      app_secret: secret,
    });
    const next = isObj(result.discovery) ? result.discovery as unknown as Discovery : null;
    if (!next) throw new Error("A Meta não devolveu os ativos da operação.");
    applyDiscovery(next, saved);
    return next;
  }

  async function load(autoDiscover = true) {
    setBusy("load"); setError(""); setNotice("");
    try {
      const result = await requestJson("GET", `/api/integrations/meta/campaign-control?organizationId=${encodeURIComponent(data.organization.id)}`);
      const next: SetupState = {
        marketing_token_configured: result.marketing_token_configured === true,
        token_subject_id: text(result.token_subject_id),
        token_subject_name: text(result.token_subject_name),
        connection: isObj(result.connection) ? result.connection as Connection : null,
        routes: Array.isArray(result.routes) ? result.routes.filter(isObj) : [],
      };
      setSetup(next);
      applyConnection(next);
      if (autoDiscover && next.marketing_token_configured) {
        const meta = metadata(next.connection);
        const api = text(meta.api_version) || "v25.0";
        setApiVersion(api);
        await connectWith(api, "", "", next.connection);
        setNotice("Credencial protegida reutilizada automaticamente, como no Campaign Control.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar a configuração Meta.");
    } finally { setBusy(null); }
  }

  useEffect(() => { void load(true); }, []); // carregamento único do módulo

  async function connect() {
    setBusy("connect"); setError(""); setNotice("");
    try {
      const next = await connectWith();
      setNotice(`${next.ad_accounts.length} conta(s), ${next.pages.length} Página(s) e ${next.phones.length} número(s) de WhatsApp encontrados.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha na conexão com a Meta.");
    } finally { setBusy(null); }
  }

  async function syncLeads(targetPageId = pageId) {
    if (!targetPageId) throw new Error("Selecione a Página antes de sincronizar leads.");
    setBusy("sync"); setError("");
    try {
      const authorization = await bearer();
      const response = await fetch("/api/integrations/meta/leads/sync", {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: data.organization.id, pageId: targetPageId }),
        cache: "no-store",
        credentials: "same-origin",
      });
      const result = await response.json().catch(() => null) as unknown;
      if (!response.ok || !isObj(result) || result.ok !== true) {
        throw new Error(isObj(result) && typeof result.error === "string" ? result.error : "A sincronização de leads falhou.");
      }
      setSyncResult(result as SyncResult);
      setNotice(`Sincronização concluída: ${Number(result.fetched || 0)} lead(s) lido(s) da Meta.`);
      await reload();
      await load(false);
    } finally { setBusy(null); }
  }

  async function save() {
    setBusy("save"); setError(""); setNotice(""); setSyncResult(null);
    try {
      const result = await requestJson("PUT", "/api/integrations/meta/campaign-control", {
        organizationId: data.organization.id,
        api_version: apiVersion,
        access_token: accessToken,
        app_secret: appSecret,
        ad_account_id: adAccountId,
        ad_account_name: adAccountName,
        page_id: pageId,
        instagram_actor_id: instagramActorId,
        whatsapp_number: whatsappNumber,
        whatsapp_phone_number_id: whatsappPhoneId,
        whatsapp_display_name: whatsappDisplayName,
      });
      setAccessToken(""); setAppSecret("");
      if (Array.isArray(result.forms)) setForms(result.forms.filter(isObj));
      if (isObj(result.discovery)) applyDiscovery(result.discovery as unknown as Discovery, isObj(result.connection) ? result.connection as Connection : null);
      setNotice(`Ativação validada e salva.${Number(result.routes_activated || 0) > 0 ? ` ${Number(result.routes_activated)} rota(s) do CRM ativada(s).` : ""}`);
      await load(false);
      try { await syncLeads(pageId); } catch (syncError) {
        setError(`A conexão foi salva, mas os leads ainda não sincronizaram: ${syncError instanceof Error ? syncError.message : "falha desconhecida"}`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível validar e salvar a conexão.");
    } finally { if (busy !== "sync") setBusy(null); }
  }

  async function toggleRoute(route: Obj) {
    if (!canManage) return;
    const supabase = getSupabase(); if (!supabase) return;
    const routeId = text(route.id); if (!routeId) return;
    setBusy("save"); setError("");
    try {
      const result = await supabase.from("crm_meta_lead_routes").update({ active: route.active !== true, updated_at: new Date().toISOString() }).eq("organization_id", data.organization.id).eq("id", routeId);
      if (result.error) throw result.error;
      await reload(); await load(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível alterar a rota."); }
    finally { setBusy(null); }
  }

  const selectedAccount = discovery?.ad_accounts.find((candidate) => (id(candidate.account_id) || id(candidate.id)) === adAccountId);
  const selectedPage = discovery?.pages.find((candidate) => id(candidate.id) === pageId);
  const selectedPhone = discovery?.phones.find((candidate) => id(candidate.id) === whatsappPhoneId);
  const permissions = discovery?.permissions || [];
  const connected = connection?.status === "CONNECTED" && Boolean(connection?.page_id) && Boolean(connection?.ad_account_id) && Boolean(setup?.marketing_token_configured);
  const routeList = setup?.routes || crm.metaLeadRoutes as unknown as Obj[];

  return <section id="meta-campaign-control-setup" className={`crm5-panel ${styles.panel}`}>
    <div className={styles.hero}>
      <div><small>META · MESMO CONECTOR DO ÉVORA CAMPAIGN CONTROL</small><h3>Meta Leads — Facebook e Instagram</h3><p>O Enterprise usa a mesma credencial protegida, a mesma descoberta de ativos e a mesma validação do Campaign Control. Depois da conexão, os formulários e leads entram no CRM.</p></div>
      <span className={`${styles.statusPill} ${connected ? styles.connected : ""}`}>{connected ? "CONECTADO" : setup?.marketing_token_configured ? "CONFIGURAÇÃO PENDENTE" : "NÃO CONFIGURADO"}</span>
    </div>

    {error && <div className={styles.error}>{error}</div>}
    {notice && <div className={styles.notice}>{notice}</div>}

    <div className={styles.grid}>
      <article className={styles.card}>
        <div className={styles.step}><span className={styles.stepNumber}>1</span><div><small>CONEXÃO</small><h4>Conectar e descobrir os ativos</h4><p>Mesmo fluxo da versão local: versão da Graph API, App Secret opcional e token de acesso.</p></div></div>
        <div className={styles.fieldGrid}>
          <div className={styles.field}><label>Versão da API</label><input value={apiVersion} onChange={(event) => setApiVersion(event.target.value)} placeholder="v25.0" /></div>
          <div className={styles.field}><label>App Secret <span className={styles.hint}>(opcional)</span></label><input type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} autoComplete="off" placeholder="Deixe vazio quando não for exigido" /></div>
        </div>
        <div className={styles.field}><label>Token de acesso</label><input type="password" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} autoComplete="off" placeholder={setup?.marketing_token_configured ? "Credencial protegida salva — deixe vazio para reutilizar" : "Cole o Access Token da Meta"} /></div>
        <div className={styles.actions}><button className={styles.primary} disabled={!canManage || busy !== null && busy !== "load"} onClick={connect}>{busy === "connect" ? "Conectando…" : "Conectar à Meta"}</button>{setup?.marketing_token_configured && <button className={styles.secondary} disabled={busy !== null} onClick={() => load(true)}>Recarregar salvos</button>}<span className={`${styles.inlineStatus} ${discovery ? styles.ok : ""}`}>{discovery ? `Conectado como ${discovery.identity.name || discovery.identity.id || "usuário Meta"}` : busy === "load" ? "Carregando…" : ""}</span></div>
        {discovery && <div className={styles.assetStats}><article><strong>{discovery.ad_accounts.length}</strong><span>contas de anúncios</span></article><article><strong>{discovery.pages.length}</strong><span>Páginas</span></article><article><strong>{discovery.businesses.length}</strong><span>Businesses</span></article><article><strong>{discovery.phones.length}</strong><span>WhatsApps</span></article></div>}
      </article>

      <article className={styles.card}>
        <div className={styles.step}><span className={styles.stepNumber}>2</span><div><small>OPERAÇÃO</small><h4>Escolher a operação</h4><p>Os campos são preenchidos pela descoberta. Também é possível informar os IDs manualmente.</p></div></div>
        <div className={styles.field}><label>Conta de anúncios</label><select value={adAccountId} onChange={(event) => { const value = event.target.value; setAdAccountId(value); const found = discovery?.ad_accounts.find((item) => (id(item.account_id) || id(item.id)) === value); setAdAccountName(found ? text(found.name) : ""); }}><option value="">{discovery ? "Selecione" : "Conecte para listar"}</option>{discovery?.ad_accounts.map((account) => { const value = id(account.account_id) || id(account.id); return <option key={value} value={value}>{accountLabel(account)}</option>; })}</select></div>
        <div className={styles.fieldGrid}><div className={styles.field}><label>ID da conta</label><input value={adAccountId} onChange={(event) => setAdAccountId(id(event.target.value))} /></div><div className={styles.field}><label>Nome da conta</label><input value={adAccountName || text(selectedAccount?.name) || text(currentAccount.name)} readOnly /></div></div>
        <div className={styles.field}><label>Página da operação</label><select value={pageId} onChange={(event) => { const value = event.target.value; setPageId(value); const found = discovery?.pages.find((item) => id(item.id) === value); setInstagramActorId(instagramId(found)); }}><option value="">{discovery ? "Selecione" : "Conecte para listar"}</option>{discovery?.pages.map((page) => { const value = id(page.id); return <option key={value} value={value}>{pageLabel(page)}</option>; })}</select></div>
        <div className={styles.fieldGrid}><div className={styles.field}><label>ID da Página</label><input value={pageId} onChange={(event) => setPageId(id(event.target.value))} /></div><div className={styles.field}><label>Instagram Business ID</label><input value={instagramActorId || instagramId(selectedPage) || instagramId(currentPage)} onChange={(event) => setInstagramActorId(id(event.target.value))} placeholder="Preenchido automaticamente" /></div></div>
        <div className={styles.field}><label>WhatsApp Business encontrado</label><select value={whatsappPhoneId} onChange={(event) => { const value = event.target.value; setWhatsappPhoneId(value); const found = discovery?.phones.find((item) => id(item.id) === value); if (found) { setWhatsappNumber(text(found.display_phone_number).replace(/\D/g, "")); setWhatsappDisplayName(`${text(found.verified_name)} ${text(found.display_phone_number)}`.trim()); } }}><option value="">Selecione ou informe manualmente</option>{discovery?.phones.map((phone) => { const value = id(phone.id); return <option key={value} value={value}>{phoneLabel(phone)}</option>; })}</select></div>
        <div className={styles.fieldGrid}><div className={styles.field}><label>WhatsApp com DDI e DDD</label><input value={whatsappNumber || text(currentWhatsapp.number)} onChange={(event) => setWhatsappNumber(event.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="5534XXXXXXXXX" /></div><div className={styles.field}><label>Phone Number ID <span className={styles.hint}>(recomendado)</span></label><input value={whatsappPhoneId || id(currentWhatsapp.phone_number_id)} onChange={(event) => setWhatsappPhoneId(id(event.target.value))} /></div></div>
      </article>

      <article className={`${styles.card} ${styles.full}`}>
        <div className={styles.step}><span className={styles.stepNumber}>3</span><div><small>VALIDAÇÃO</small><h4>Validar e salvar a ativação</h4><p>O Enterprise valida a conta, a Página e o WhatsApp na Meta, deriva o Page Access Token e salva tudo no mesmo Vault utilizado pelo Campaign Control.</p></div></div>
        <div className={styles.actions}><button className={styles.primary} disabled={!canManage || busy !== null || !adAccountId || !pageId || whatsappNumber.length < 10} onClick={save}>{busy === "save" ? "Validando e salvando…" : "Validar e salvar"}</button><button className={styles.secondary} disabled={busy !== null || !pageId} onClick={() => syncLeads()}>{busy === "sync" ? "Sincronizando…" : "Sincronizar leads agora"}</button></div>
        <div className={styles.summary}><div className={styles.summaryRow}><span>Conta</span><strong>{adAccountName || text(selectedAccount?.name) || text(currentAccount.name) || adAccountId || "—"}</strong></div><div className={styles.summaryRow}><span>Página</span><strong>{text(selectedPage?.name) || connection?.page_name || text(currentPage.name) || pageId || "—"}</strong></div><div className={styles.summaryRow}><span>WhatsApp</span><strong>{whatsappDisplayName || text(selectedPhone?.verified_name) || text(currentWhatsapp.display_name) || whatsappNumber || "—"}</strong></div><div className={styles.summaryRow}><span>Credencial</span><strong>{setup?.marketing_token_configured ? `Protegida no Vault${setup.token_subject_name ? ` · ${setup.token_subject_name}` : ""}` : "Ainda não salva"}</strong></div></div>
      </article>
    </div>

    {discovery && <article className={styles.card}>
      <div><span className={styles.miniTitle}>TOKEN RECONHECIDO</span><div className={styles.identity}><strong>{discovery.identity.name || setup?.token_subject_name || "Usuário Meta"}</strong><span>ID {discovery.identity.id || setup?.token_subject_id || "—"}</span></div></div>
      <div><span className={styles.miniTitle}>PERMISSÕES</span><div className={styles.permissionGrid}>{permissions.map((permission) => <div className={styles.permission} key={permission.permission}><b>{permission.permission}</b><i className={permission.status === "granted" ? styles.ok : ""}>{permission.status === "granted" ? "OK" : permission.status}</i></div>)}</div></div>
      {discovery.warnings.length > 0 && <div className={styles.notice}>{discovery.warnings.join(" · ")}</div>}
    </article>}

    <article className={styles.card}>
      <div className={styles.step}><span className={styles.stepNumber}>4</span><div><small>LEAD ADS → CRM</small><h4>Formulários e rotas comerciais</h4><p>Depois da conexão, os formulários da Página são lidos e os leads entram no CRM pelas rotas abaixo.</p></div></div>
      <div className={styles.forms}>{forms.length ? forms.map((form) => { const formId = id(form.id); const route = routeList.find((candidate) => id(candidate.form_id) === formId && id(candidate.page_id) === pageId); return <article key={formId}><div><strong>{text(form.name) || `Formulário ${formId}`}</strong><small>ID {formId} · {text(form.status) || "status não informado"}</small></div><span className={`${styles.routeBadge} ${route?.active === true ? styles.active : ""}`}>{route ? route.active === true ? "ROTA ATIVA" : "ROTA INATIVA" : "SEM ROTA"}</span></article>; }) : <p className={styles.routeInfo}>Os formulários aparecerão aqui após validar e salvar a Página.</p>}</div>
      {routeList.length > 0 && <div className={styles.forms}>{routeList.filter((route) => !pageId || id(route.page_id) === pageId).map((route) => <article key={text(route.id)}><div><strong>{text(route.name) || `Rota ${text(route.form_id)}`}</strong><small>Form {text(route.form_id)} · {route.active === true ? "recebimento automático ativo" : "recebimento pausado"}</small></div>{canManage && <button className={styles.secondary} disabled={busy !== null} onClick={() => toggleRoute(route)}>{route.active === true ? "Pausar" : "Ativar"}</button>}</article>)}</div>}
      {syncResult && <div className={styles.syncResult}><article><strong>{Number(syncResult.formsFound || 0)}</strong><span>formulários</span></article><article><strong>{Number(syncResult.fetched || 0)}</strong><span>leads lidos</span></article><article><strong>{Number(syncResult.queued || 0)}</strong><span>novos na fila</span></article><article><strong>{Number(syncResult.duplicates || 0)}</strong><span>já existentes</span></article><article><strong>{Number(syncResult.unmapped || 0)}</strong><span>sem rota</span></article></div>}
    </article>
  </section>;
}
