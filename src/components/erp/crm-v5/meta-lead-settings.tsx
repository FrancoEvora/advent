"use client";

import { FormEvent, useMemo, useState, useSyncExternalStore } from "react";
import { getSupabase } from "@/lib/supabase";
import type { MetaCredentialStatus } from "@/lib/integrations/meta/credential-contract";
import type { ErpData } from "../types";
import { EmptyState, Status } from "./shared";
import type {
  CrmEnterpriseData,
  CrmMetaAssignmentRole,
  CrmMetaAssignmentStrategy,
  CrmMetaLeadRoute,
} from "./types";
import { MetaCredentialSettings } from "./meta-credential-settings";
import styles from "./meta-lead-settings.module.css";

type RouteDraft = {
  id: string;
  name: string;
  pageId: string;
  formId: string;
  providerAccountId: string;
  projectId: string;
  productId: string;
  leadSourceId: string;
  pipelineId: string;
  initialStageId: string;
  teamId: string;
  fallbackOwnerUserId: string;
  assignmentStrategy: CrmMetaAssignmentStrategy;
  assignmentRole: CrmMetaAssignmentRole;
  firstContactSlaMinutes: number;
  defaultCountryCallingCode: string;
  active: boolean;
};

const META_WEBHOOK_PATH = "/api/integrations/meta/leads";
const SOLARIS_META_PAGE_ID = "1296933085661158";
const commercialRoles = new Set(["admin", "diretoria", "comercial", "gestor_crm", "sdr", "corretor"]);
const sdrTeamTypes = new Set(["sdr", "pre_vendas", "pre-vendas"]);
const brokerTeamTypes = new Set(["corretor", "corretores", "vendas", "comercial"]);
const subscribeToOrigin = () => () => undefined;
const getBrowserOrigin = () => window.location.origin;
const getServerOrigin = () => "";

function freshDraft(data: ErpData, crm: CrmEnterpriseData): RouteDraft {
  const project = data.projects.find((item) => item.active && (item.code === "SOL" || item.name.toLocaleLowerCase("pt-BR").includes("solaris")))
    || data.projects.find((item) => item.active);
  const product = crm.products.find((item) => item.active && item.project_id === project?.id && item.code === "LOTES_RESIDENCIAIS")
    || crm.products.find((item) => item.active && item.project_id === project?.id);
  const source = crm.leadSources.find((item) => item.active && item.code === "META_INSTANT_FORM" && item.provider === "meta" && item.channel === "meta_lead_ads" && !item.manual_selectable)
    || crm.leadSources.find((item) => item.active && item.provider === "meta" && item.channel === "meta_lead_ads" && !item.manual_selectable);
  const pipeline = crm.pipelines.find((item) => item.active && item.is_default)
    || crm.pipelines.find((item) => item.active);
  const stage = crm.stages.find((item) => item.active && !item.is_won && !item.is_lost && item.pipeline_id === pipeline?.id && item.code === "novo")
    || crm.stages.find((item) => item.active && !item.is_won && !item.is_lost && item.pipeline_id === pipeline?.id);
  return {
    id: "",
    name: project ? `${project.name} · Formulário Meta` : "Formulário Instantâneo Meta",
    // O Page ID e publico e foi confirmado para o piloto Solaris. A rota
    // continua sempre como rascunho ate receber Form ID, owner e credenciais.
    pageId: project?.code === "SOL" || project?.name.toLocaleLowerCase("pt-BR").includes("solaris")
      ? SOLARIS_META_PAGE_ID
      : "",
    formId: "",
    providerAccountId: "",
    projectId: project?.id || "",
    productId: product?.id || "",
    leadSourceId: source?.id || "",
    pipelineId: pipeline?.id || "",
    initialStageId: stage?.id || "",
    teamId: "",
    fallbackOwnerUserId: "",
    assignmentStrategy: "round_robin",
    assignmentRole: "sdr",
    firstContactSlaMinutes: stage?.sla_hours ? Math.max(1, Number(stage.sla_hours) * 60) : 60,
    defaultCountryCallingCode: "55",
    active: false,
  };
}

function editDraft(route: CrmMetaLeadRoute): RouteDraft {
  return {
    id: route.id,
    name: route.name,
    pageId: route.page_id,
    formId: route.form_id || "",
    providerAccountId: route.provider_account_id || "",
    projectId: route.project_id,
    productId: route.product_id,
    leadSourceId: route.lead_source_id,
    pipelineId: route.pipeline_id,
    initialStageId: route.initial_stage_id,
    teamId: route.team_id || "",
    fallbackOwnerUserId: route.fallback_owner_user_id || "",
    assignmentStrategy: route.assignment_strategy,
    assignmentRole: route.assignment_role,
    firstContactSlaMinutes: route.first_contact_sla_minutes,
    defaultCountryCallingCode: route.default_country_calling_code,
    active: route.active,
  };
}

function countMetric(source: Record<string, number | string | null> | undefined, ...keys: string[]) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

function timeMetric(source: Record<string, string | null> | undefined, ...keys: string[]) {
  for (const key of keys) if (source?.[key]) return source[key];
  return null;
}

function profileLabel(userId: string, data: ErpData) {
  const profile = data.profiles.find((item) => item.id === userId);
  return profile?.full_name || profile?.email || userId;
}

export function MetaLeadSettings({
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
  const [draft, setDraft] = useState<RouteDraft>(() => freshDraft(data, crm));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [credentialStatus, setCredentialStatus] = useState<MetaCredentialStatus | null>(null);
  const callbackOrigin = useSyncExternalStore(subscribeToOrigin, getBrowserOrigin, getServerOrigin);
  const callbackUrl = `${callbackOrigin}${META_WEBHOOK_PATH}`;

  const products = useMemo(
    () => crm.products.filter((item) => item.active && item.project_id === draft.projectId),
    [crm.products, draft.projectId],
  );
  const stages = useMemo(
    () => crm.stages.filter((item) => item.active && !item.is_won && !item.is_lost && item.pipeline_id === draft.pipelineId),
    [crm.stages, draft.pipelineId],
  );
  const metaSources = useMemo(
    () => crm.leadSources.filter((item) => item.active && item.provider === "meta" && item.channel === "meta_lead_ads" && !item.manual_selectable),
    [crm.leadSources],
  );
  const activeMembers = useMemo(
    () => data.members.filter((item) => item.active && commercialRoles.has(item.role)),
    [data.members],
  );
  const compatibleTeams = useMemo(() => {
    const acceptedTypes = draft.assignmentRole === "sdr" ? sdrTeamTypes : brokerTeamTypes;
    return crm.teams.filter((item) => item.active && acceptedTypes.has(item.team_type.toLocaleLowerCase("pt-BR")));
  }, [crm.teams, draft.assignmentRole]);
  const selectedTeamMemberCount = useMemo(() => {
    if (!draft.teamId) return 0;
    const activeUsers = new Set(activeMembers.map((item) => item.user_id));
    return crm.teamMembers.filter((item) => item.active && item.team_id === draft.teamId && activeUsers.has(item.user_id)).length;
  }, [activeMembers, crm.teamMembers, draft.teamId]);

  const baseBlockers = [
    !draft.name.trim() && "Informe um nome para a rota.",
    !/^\d+$/.test(draft.pageId.trim()) && "Informe o ID numérico da Página Meta.",
    !/^\d+$/.test(draft.formId.trim()) && "Informe o ID numérico do Formulário Instantâneo.",
    !draft.projectId && "Selecione o empreendimento.",
    !draft.productId && "Selecione o produto.",
    !draft.leadSourceId && "Selecione a origem do lead.",
    !draft.pipelineId && "Selecione o funil.",
    !draft.initialStageId && "Selecione a etapa inicial.",
    draft.assignmentStrategy !== "fallback_only" && !draft.teamId && "Selecione uma equipe para a estratégia de distribuição.",
    (!Number.isInteger(draft.firstContactSlaMinutes) || draft.firstContactSlaMinutes < 5) && "O SLA deve ser de pelo menos 5 minutos.",
    !/^[1-9]\d{0,2}$/.test(draft.defaultCountryCallingCode.trim()) && "Informe um código de país válido.",
  ].filter(Boolean) as string[];
  const activationBlockers = [
    !credentialStatus && "Confirme o estado das credenciais Meta no cofre.",
    credentialStatus && !credentialStatus.appSecret.configured && "Cadastre o App Secret da Meta.",
    credentialStatus && !credentialStatus.verifyToken.configured && "Cadastre o token de verificação do webhook.",
    credentialStatus && !credentialStatus.pages.find((item) => item.pageId === draft.pageId)?.accessToken.configured && "Cadastre o token de acesso desta Página Meta.",
    !draft.fallbackOwnerUserId && "Defina o responsável de contingência para nunca deixar o lead sem dono.",
    draft.assignmentStrategy !== "fallback_only" && Boolean(draft.teamId) && selectedTeamMemberCount === 0 && "A equipe selecionada ainda não possui membro ativo.",
  ].filter(Boolean) as string[];
  const blockers = [...baseBlockers, ...(draft.active ? activationBlockers : [])];

  const status = crm.metaLeadStatus;
  const activeRoutes = countMetric(status?.routes, "active", "active_routes") || crm.metaLeadRoutes.filter((item) => item.active).length;
  const pendingEvents = countMetric(status?.events, "pending", "queued", "received")
    + countMetric(status?.events, "retry")
    + countMetric(status?.events, "unmapped");
  const processedEvents = countMetric(status?.events, "processed", "completed");
  const deadLetterEvents = countMetric(status?.events, "dead_letter", "failed");
  const failedEvents = deadLetterEvents
    + countMetric(status?.events, "blocked")
    + countMetric(status?.events, "processed_attribution_incomplete", "attribution_incomplete");
  const lastEventAt = timeMetric(status?.timestamps, "last_received_at", "last_event_at", "latest_event_at");

  function startNew() {
    setDraft(freshDraft(data, crm));
    setFeedback("");
    setError("");
  }

  function selectProject(projectId: string) {
    const product = crm.products.find((item) => item.active && item.project_id === projectId);
    setDraft((current) => ({ ...current, projectId, productId: product?.id || "" }));
  }

  function selectPipeline(pipelineId: string) {
    const stage = crm.stages.find((item) => item.active && !item.is_won && !item.is_lost && item.pipeline_id === pipelineId && item.code === "novo")
      || crm.stages.find((item) => item.active && !item.is_won && !item.is_lost && item.pipeline_id === pipelineId);
    setDraft((current) => ({ ...current, pipelineId, initialStageId: stage?.id || "" }));
  }

  async function saveRoute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback("");
    setError("");
    if (!canManage) {
      setError("Seu perfil não pode alterar integrações comerciais.");
      return;
    }
    if (blockers.length) {
      setError(blockers[0]);
      return;
    }
    const client = getSupabase();
    if (!client) {
      setError("Supabase indisponível.");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        organization_id: data.organization.id,
        name: draft.name.trim(),
        page_id: draft.pageId.trim(),
        form_id: draft.formId.trim() || null,
        provider_account_id: draft.providerAccountId.trim() || null,
        project_id: draft.projectId,
        product_id: draft.productId,
        lead_source_id: draft.leadSourceId,
        pipeline_id: draft.pipelineId,
        initial_stage_id: draft.initialStageId,
        team_id: draft.assignmentStrategy === "fallback_only" ? null : draft.teamId || null,
        fallback_owner_user_id: draft.fallbackOwnerUserId || null,
        assignment_strategy: draft.assignmentStrategy,
        assignment_role: draft.assignmentRole,
        first_contact_sla_minutes: draft.firstContactSlaMinutes,
        default_country_calling_code: draft.defaultCountryCallingCode.trim(),
        active: draft.active,
        updated_by: data.session.user.id,
      };
      const result = draft.id
        ? await client.from("crm_meta_lead_routes").update(payload).eq("organization_id", data.organization.id).eq("id", draft.id)
        : await client.from("crm_meta_lead_routes").insert({ ...payload, created_by: data.session.user.id });
      if (result.error) throw result.error;
      await reload();
      setDraft(freshDraft(data, crm));
      setFeedback(draft.id ? "Rota Meta atualizada." : "Rota Meta criada.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível salvar a rota Meta.");
    } finally {
      setBusy(false);
    }
  }

  async function copyCallback() {
    try {
      await navigator.clipboard.writeText(callbackUrl);
      setFeedback("URL de callback copiada.");
      setError("");
    } catch {
      setError("Não foi possível copiar automaticamente. Selecione a URL e copie manualmente.");
    }
  }

  async function requeueFailures() {
    if (!canManage || deadLetterEvents === 0) return;
    const client = getSupabase();
    if (!client) {
      setError("Supabase indisponível.");
      return;
    }
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      const result = await client.rpc("requeue_meta_lead_failures", {
        p_organization_id: data.organization.id,
      });
      if (result.error) throw result.error;
      const total = typeof result.data === "number" ? result.data : Number(result.data || 0);
      await reload();
      setFeedback(total > 0
        ? `${total} evento(s) reenviado(s) para processamento.`
        : "Nenhum evento elegível para reprocessamento.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível reprocessar as falhas Meta.");
    } finally {
      setBusy(false);
    }
  }

  return <section id="meta-lead-integration" className={`crm5-panel ${styles.panel}`}>
    <header className={styles.header}>
      <div><small>META LEAD ADS · ENTRADA CANÔNICA</small><h3>Rotas de Formulário Instantâneo</h3></div>
      <Status tone={activeRoutes > 0 ? "success" : "warning"}>{activeRoutes > 0 ? `${activeRoutes} ativa${activeRoutes === 1 ? "" : "s"}` : "homologação"}</Status>
    </header>

    <div className={styles.securityNote}>
      <strong>Credenciais protegidas no servidor</strong>
      <span>App Secret, token de verificação e tokens de Página são enviados ao servidor e armazenados no Vault. O CRM recebe apenas o estado “configurado” e nunca recupera o valor.</span>
    </div>

    <div className={styles.callback}>
      <label>URL de callback para o aplicativo Meta<input value={callbackUrl} readOnly aria-label="URL de callback Meta" /></label>
      <button type="button" onClick={copyCallback}>Copiar URL</button>
    </div>

    <MetaCredentialSettings
      organizationId={data.organization.id}
      pageId={draft.pageId}
      canManage={canManage}
      onStatusChange={setCredentialStatus}
      reloadRoutes={reload}
    />

    <div className={styles.metrics}>
      <article><small>ROTAS ATIVAS</small><strong>{activeRoutes}</strong><span>Page/Form em produção</span></article>
      <article><small>AGUARDANDO</small><strong>{pendingEvents}</strong><span>Recebidos, retry ou sem rota</span></article>
      <article><small>PROCESSADOS</small><strong>{processedEvents}</strong><span>Inseridos no CRM</span></article>
      <article><small>EXCEÇÕES</small><strong>{failedEvents}</strong><span>Bloqueios, dead-letter ou atribuição parcial</span></article>
    </div>
    <p className={styles.lastEvent}>{lastEventAt ? `Último evento recebido em ${new Date(lastEventAt).toLocaleString("pt-BR")}.` : "Nenhum evento Meta recebido neste ambiente."}</p>
    {crm.metaLeadStatusError && <div className="feedback">{crm.metaLeadStatusError}</div>}

    <div className={styles.routesHeader}>
      <div><small>MAPEAMENTOS</small><h4>Page/Form → oportunidade no Évora</h4></div>
      {canManage && <div className={styles.routeActions}>
        {deadLetterEvents > 0 && <button type="button" disabled={busy} onClick={requeueFailures}>Reprocessar falhas</button>}
        <button type="button" disabled={busy} onClick={startNew}>+ Nova rota</button>
      </div>}
    </div>
    {crm.metaLeadRoutes.length === 0
      ? <EmptyState title="Nenhuma rota Meta cadastrada" text="Cadastre a Page e o formulário do piloto Solaris. A rota permanece inativa até existir responsável de contingência." />
      : <div className={styles.routeList}>{crm.metaLeadRoutes.map((route) => {
        const project = data.projects.find((item) => item.id === route.project_id);
        const product = crm.products.find((item) => item.id === route.product_id);
        const team = crm.teams.find((item) => item.id === route.team_id);
        const fallback = route.fallback_owner_user_id ? profileLabel(route.fallback_owner_user_id, data) : "não definido";
        return <article key={route.id}>
          <div><strong>{route.name}</strong><span>Page {route.page_id} · Form {route.form_id}</span></div>
          <div><small>DESTINO</small><span>{project?.name || "Empreendimento"} · {product?.name || "Produto"}</span></div>
          <div><small>DISTRIBUIÇÃO</small><span>{team?.name || "Somente contingência"} · {fallback}</span></div>
          <Status tone={route.active ? "success" : "neutral"}>{route.active ? "ativa" : "rascunho"}</Status>
          {canManage && <button type="button" onClick={() => { setDraft(editDraft(route)); setFeedback(""); setError(""); }}>Editar</button>}
        </article>;
      })}</div>}

    {canManage ? <form className={styles.form} onSubmit={saveRoute}>
      <header><div><small>{draft.id ? "EDITAR ROTA" : "NOVA ROTA"}</small><h4>{draft.id ? draft.name : "Piloto Solaris Residencial"}</h4></div>{draft.id && <button type="button" onClick={startNew}>Cancelar edição</button>}</header>
      <div className={styles.formGrid}>
        <label className={styles.span2}>Nome da rota<input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} required /></label>
        <label>ID da Página Meta<input value={draft.pageId} onChange={(event) => setDraft((current) => ({ ...current, pageId: event.target.value }))} inputMode="numeric" pattern="[0-9]+" placeholder="Ex.: 1234567890" required /></label>
        <label>ID do Formulário<input value={draft.formId} onChange={(event) => setDraft((current) => ({ ...current, formId: event.target.value }))} inputMode="numeric" pattern="[0-9]+" placeholder="Ex.: 9876543210" required /></label>
        <label>Conta de anúncios (opcional)<input value={draft.providerAccountId} onChange={(event) => setDraft((current) => ({ ...current, providerAccountId: event.target.value.replace(/^act_/i, "").replace(/\D/g, "") }))} inputMode="numeric" pattern="[0-9]*" maxLength={64} placeholder="Ex.: 1234567890" /><small>Use o ID numérico; o prefixo act_ é removido automaticamente.</small></label>
        <label>Empreendimento<select value={draft.projectId} onChange={(event) => selectProject(event.target.value)} required><option value="">Selecione</option>{data.projects.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Produto<select value={draft.productId} onChange={(event) => setDraft((current) => ({ ...current, productId: event.target.value }))} required><option value="">Selecione</option>{products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Origem<select value={draft.leadSourceId} onChange={(event) => setDraft((current) => ({ ...current, leadSourceId: event.target.value }))} required><option value="">Selecione</option>{metaSources.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Funil<select value={draft.pipelineId} onChange={(event) => selectPipeline(event.target.value)} required><option value="">Selecione</option>{crm.pipelines.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Etapa inicial<select value={draft.initialStageId} onChange={(event) => setDraft((current) => ({ ...current, initialStageId: event.target.value }))} required><option value="">Selecione</option>{stages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Estratégia<select value={draft.assignmentStrategy} onChange={(event) => setDraft((current) => ({ ...current, assignmentStrategy: event.target.value as CrmMetaAssignmentStrategy }))}><option value="round_robin">Round robin</option><option value="least_queue">Menor fila</option><option value="fallback_only">Somente contingência</option></select></label>
        <label>Equipe<select value={draft.teamId} onChange={(event) => setDraft((current) => ({ ...current, teamId: event.target.value }))} disabled={draft.assignmentStrategy === "fallback_only"}><option value="">Selecione</option>{compatibleTeams.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><small>{draft.teamId ? `${selectedTeamMemberCount} membro(s) ativo(s) elegível(is)` : "Obrigatória para distribuição automática"}</small></label>
        <label>Papel atribuído<select value={draft.assignmentRole} onChange={(event) => setDraft((current) => ({ ...current, assignmentRole: event.target.value as CrmMetaAssignmentRole, teamId: "" }))}><option value="sdr">SDR</option><option value="broker">Corretor</option></select></label>
        <label>Responsável de contingência<select value={draft.fallbackOwnerUserId} onChange={(event) => setDraft((current) => ({ ...current, fallbackOwnerUserId: event.target.value }))}><option value="">Selecione</option>{activeMembers.map((item) => <option key={item.user_id} value={item.user_id}>{profileLabel(item.user_id, data)}</option>)}</select><small>Obrigatório para ativar a rota</small></label>
        <label>SLA de primeiro contato (min)<input type="number" min="5" max="10080" value={draft.firstContactSlaMinutes} onChange={(event) => setDraft((current) => ({ ...current, firstContactSlaMinutes: Number(event.target.value) }))} /></label>
        <label>DDI padrão<input value={draft.defaultCountryCallingCode} onChange={(event) => setDraft((current) => ({ ...current, defaultCountryCallingCode: event.target.value.replace(/\D/g, "") }))} inputMode="numeric" maxLength={3} /></label>
      </div>
      <label className={styles.activation}><input type="checkbox" checked={draft.active} onChange={(event) => setDraft((current) => ({ ...current, active: event.target.checked }))} /><span><strong>Ativar recebimento automático</strong><small>Somente ative após cadastrar Page/Form, equipe elegível e responsável de contingência.</small></span></label>
      {draft.active && activationBlockers.length > 0 && <div className={`feedback ${styles.blockers}`}><strong>Ativação bloqueada</strong>{activationBlockers.map((item) => <span key={item}>• {item}</span>)}</div>}
      {error && <div className="feedback error">{error}</div>}
      {feedback && <div className="feedback">{feedback}</div>}
      <footer><button type="submit" className="primary" disabled={busy || blockers.length > 0}>{busy ? "Salvando..." : draft.active ? "Salvar e ativar rota" : "Salvar rascunho"}</button></footer>
    </form> : <div className={styles.readOnly}><strong>Visualização somente leitura</strong><span>Solicite a permissão “Configurar integrações comerciais” para cadastrar ou alterar as rotas Meta.</span></div>}
  </section>;
}
