"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { CrmRecord, ErpData } from "../types";
import type { CrmEnterpriseData } from "./types";
import { CrmKpi, CrmSectionHeader, EmptyState, Status } from "./shared";
import styles from "./bia-queue-view.module.css";

type QueueStatus = "staged" | "dispatched" | "cancelled";

type QueueItem = {
  id: string;
  crmRecordId: string;
  name: string;
  phone: string | null;
  projectId: string | null;
  projectName: string | null;
  source: string;
  temperature: string | null;
  score: number;
  status: QueueStatus;
  lastError: string | null;
  recommendedSettingsId: string | null;
  dispatchedSettingsId: string | null;
  campaignId: string | null;
  queuedAt: string;
  dispatchedAt: string | null;
};

type QueueSetting = {
  id: string;
  projectId: string;
  templateName: string;
  name: string;
  openingIntent: string | null;
  enabled: boolean;
};

type MetaTemplate = {
  name: string;
  language: string;
  category: string;
  status: "APPROVED";
  header: string;
  body: string;
  footer: string;
  buttons: string[];
  plainText: string;
  parameterCount: number;
  sendable: boolean;
  compatibilityReason: string | null;
};

type QueueOverview = {
  channel: { enabled?: boolean; verified?: boolean; phone?: string | null };
  settings: QueueSetting[];
  counts: {
    staged: number;
    dispatched: number;
    cancelled: number;
    alerts: number;
  };
  items: QueueItem[];
};

type QueuePreviewItem = {
  queueId: string;
  crmRecordId: string;
  name: string;
  ready: boolean;
  reason: string | null;
};

type QueuePreview = {
  selected: number;
  eligible: number;
  blocked: number;
  items: QueuePreviewItem[];
};

type QueueDelivery = {
  queueId: string;
  queueStatus: QueueStatus;
  campaignId: string | null;
  campaignStatus: string | null;
  templateName: string | null;
  jobStatus: string | null;
  deliveryStatus: string | null;
  errorCode: string | null;
  providerMessageId: string | null;
  dispatchedAt: string | null;
  outboundAt: string | null;
};

const reasonLabels: Record<string, string> = {
  BIA_TEMPLATE_PROJECT_MISMATCH:
    "A mensagem escolhida não pertence ao empreendimento deste lead.",
  BIA_BULK_CONSENT_REQUIRED:
    "Não há opt-in de WhatsApp documentado para esta abordagem.",
  BIA_CAMPAIGN_ALREADY_CONTACTED:
    "Já houve contato anterior com este número. Use retomada/remarketing, não a mensagem inicial.",
  BIA_CONTACT_PAUSED:
    "O contato possui opt-out, bloqueio real ou atendimento humano ativo.",
  BIA_PHONE_INVALID: "Telefone inválido para WhatsApp.",
  BIA_CAMPAIGN_DISABLED:
    "Não há configuração ativa para este empreendimento.",
  BIA_CAMPAIGN_LEAD_INACTIVE:
    "O lead deixou de estar elegível para esta abordagem.",
};

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("pt-BR")
    : "—";
}

function deliveryLabel(delivery: QueueDelivery | undefined) {
  const status = delivery?.deliveryStatus || delivery?.jobStatus || "";
  const labels: Record<string, string> = {
    pending: "Aguardando",
    processing: "Processando",
    sending: "Enviando",
    awaiting_template: "Validando Meta",
    awaiting_consent: "Validando consentimento",
    accepted: "Aceito pela Meta",
    sent: "Enviado",
    delivered: "Entregue",
    read: "Lido",
    failed: "Falhou",
    unknown: "Resultado incerto",
    skipped: "Ignorado",
  };
  return labels[status] || (delivery?.campaignStatus === "scheduled" ? "Agendado" : "Disparado");
}

function localDateTimeNow() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

function queueStatusLabel(reason: string | null | undefined) {
  if (reason === "BIA_BULK_CONSENT_REQUIRED") return "Requer opt-in";
  if (reason === "BIA_CAMPAIGN_ALREADY_CONTACTED") return "Retomar";
  if (reason) return "Bloqueado";
  return "Em fila";
}

function deliveryTone(delivery: QueueDelivery | undefined) {
  const status = delivery?.deliveryStatus || delivery?.jobStatus || "";
  if (["accepted", "sent", "delivered", "read"].includes(status)) return "success" as const;
  if (["failed", "unknown"].includes(status)) return "danger" as const;
  if (["pending", "processing", "sending", "awaiting_template", "awaiting_consent"].includes(status)) return "warning" as const;
  return "info" as const;
}

export function BiaQueueView({
  data,
  crm,
  openLead,
}: {
  data: ErpData;
  crm: CrmEnterpriseData;
  openLead: (lead: CrmRecord) => void;
}) {
  const [overview, setOverview] = useState<QueueOverview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [settingsId, setSettingsId] = useState("");
  const [status, setStatus] = useState<"staged" | "all">("staged");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<QueuePreview | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, QueueDelivery>>({});
  const [consentLead, setConsentLead] = useState<QueueItem | null>(null);
  const [consentSource, setConsentSource] = useState("whatsapp");
  const [consentAt, setConsentAt] = useState(localDateTimeNow());
  const [consentNote, setConsentNote] = useState("");
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [templates, setTemplates] = useState<MetaTemplate[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateError, setTemplateError] = useState("");
  const [dispatchError, setDispatchError] = useState("");

  const rpc = useCallback(
    async (action: string, args: Record<string, unknown> = {}) => {
      const client = getSupabase();
      if (!client) throw new Error("Supabase indisponível.");
      const result = await client.rpc("bia_strategy_queue_admin", {
        p_organization_id: data.organization.id,
        p_action: action,
        p_args: args,
      });
      if (result.error) throw new Error(result.error.message);
      return result.data as unknown;
    },
    [data.organization.id],
  );

  const loadTemplates = useCallback(async () => {
    const client = getSupabase();
    if (!client) {
      setTemplateError("Supabase indisponível.");
      return;
    }
    setTemplateBusy(true);
    setTemplateError("");
    try {
      const response = await client.functions.invoke("bia-whatsapp-outbound", {
        body: {
          organizationId: data.organization.id,
          action: "templates",
        },
      });
      if (response.error) {
        let code = "";
        try {
          code = (await response.error.context?.json())?.error || "";
        } catch {
          // Transport errors may not have a JSON body.
        }
        throw new Error(code || response.error.message || "BIA_TEMPLATE_UNAVAILABLE");
      }
      if (!response.data?.ok || !Array.isArray(response.data?.data)) {
        throw new Error(response.data?.error || "BIA_TEMPLATE_UNAVAILABLE");
      }
      const liveTemplates = response.data.data as MetaTemplate[];
      setTemplates(liveTemplates);
      setTemplateName((current) => {
        if (current && liveTemplates.some((item) => item.name === current)) {
          return current;
        }
        return liveTemplates.find((item) => item.sendable)?.name || "";
      });
    } catch (caught) {
      setTemplates([]);
      setTemplateName("");
      setTemplateError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível consultar os templates aprovados na Meta.",
      );
    } finally {
      setTemplateBusy(false);
    }
  }, [data.organization.id]);

  const load = useCallback(async () => {
    try {
      const client = getSupabase();
      if (!client) throw new Error("Supabase indisponível.");
      const [value, deliveryResult] = await Promise.all([
        rpc("overview") as Promise<QueueOverview>,
        client.rpc("bia_strategy_queue_delivery", {
          p_organization_id: data.organization.id,
        }),
      ]);
      if (deliveryResult.error) throw new Error(deliveryResult.error.message);
      setOverview(value);
      const deliveryRows = (deliveryResult.data || []) as QueueDelivery[];
      setDeliveries(
        Object.fromEntries(deliveryRows.map((item) => [item.queueId, item])),
      );
      setSettingsId((current) => {
        if (current && value.settings.some((item) => item.id === current))
          return current;
        return value.settings[0]?.id || "";
      });
      setSelected((current) => {
        const staged = new Set(
          value.items
            .filter((item) => item.status === "staged")
            .map((item) => item.id),
        );
        return new Set([...current].filter((id) => staged.has(id)));
      });
      setError("");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível carregar a fila da Bia.",
      );
    }
  }, [data.organization.id, rpc]);

  useEffect(() => {
    void load();
    void loadTemplates();
  }, [load, loadTemplates]);

  const visible = useMemo(() => {
    const needle = normalize(query);
    return (overview?.items || []).filter((item) => {
      if (status === "staged" && item.status !== "staged") return false;
      if (!needle) return true;
      return normalize(
        [
          item.name,
          item.phone || "",
          item.projectName || "",
          item.source,
          item.temperature || "",
          reasonLabels[item.lastError || ""] || item.lastError || "",
        ].join(" "),
      ).includes(needle);
    });
  }, [overview?.items, query, status]);

  const stagedVisible = visible.filter((item) => item.status === "staged");
  const allVisibleSelected =
    stagedVisible.length > 0 &&
    stagedVisible.every((item) => selected.has(item.id));
  const selectedCount = selected.size;
  const selectedKey = [...selected].sort().join(",");
  const selectedSetting =
    overview?.settings.find((item) => item.id === settingsId) || null;
  const selectedTemplate =
    templates.find((item) => item.name === templateName) || null;
  const channelReady =
    overview?.channel.enabled === true && overview?.channel.verified === true;
  const readyCount = preview?.eligible || 0;
  const blockedCount = preview?.blocked || 0;
  const previewByQueueId = useMemo(
    () =>
      Object.fromEntries(
        (preview?.items || []).map((item) => [item.queueId, item]),
      ),
    [preview],
  );
  const hasPendingDelivery = Object.values(deliveries).some((delivery) =>
    ["pending", "processing", "sending", "awaiting_template", "awaiting_consent"].includes(
      delivery.deliveryStatus || delivery.jobStatus || "",
    ),
  );

  useEffect(() => {
    if (!settingsId || !selectedKey) {
      setPreview(null);
      return;
    }
    let active = true;
    const client = getSupabase();
    if (!client) return;
    void client
      .rpc("bia_strategy_queue_preview", {
        p_organization_id: data.organization.id,
        p_settings_id: settingsId,
        p_queue_ids: selectedKey.split(","),
      })
      .then(({ data: value, error: previewError }) => {
        if (!active) return;
        if (previewError) {
          setPreview(null);
          setError(previewError.message);
          return;
        }
        setPreview(value as QueuePreview);
      });
    return () => {
      active = false;
    };
  }, [data.organization.id, selectedKey, settingsId]);

  useEffect(() => {
    if (!hasPendingDelivery) return;
    const timer = window.setInterval(() => {
      void load();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [hasPendingDelivery, load]);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const item of stagedVisible) next.delete(item.id);
      } else {
        for (const item of stagedVisible) next.add(item.id);
      }
      return next;
    });
  }

  async function fire() {
    if (
      !selectedCount ||
      !settingsId ||
      !selectedSetting ||
      !selectedTemplate ||
      !selectedTemplate.sendable ||
      readyCount < 1
    ) return;
    if (
      !window.confirm(
        `Disparar o template Meta “${selectedTemplate.name}” para ${readyCount} lead${readyCount === 1 ? "" : "s"} elegível${readyCount === 1 ? "" : "is"}? ${blockedCount} selecionado(s) permanecerão na fila.`,
      )
    )
      return;

    setBusy(true);
    setError("");
    setDispatchError("");
    setNotice("");
    try {
      const result = (await rpc("fire", {
        settingsId,
        templateName: selectedTemplate.name,
        queueIds: [...selected],
      })) as {
        ok?: boolean;
        eligible?: number;
        blocked?: number;
        reason?: string;
        campaignId?: string;
      };
      if (!result.ok) {
        throw new Error(
          result.reason === "BIA_QUEUE_NO_ELIGIBLE_RECIPIENTS"
            ? "Nenhum dos leads selecionados está elegível para esta mensagem inicial."
            : result.reason || "Não foi possível disparar a fila.",
        );
      }
      setNotice(
        `Campanha criada. ${Number(result.eligible || 0)} lead${Number(result.eligible || 0) === 1 ? "" : "s"} enviado${Number(result.eligible || 0) === 1 ? "" : "s"} ao worker; ${Number(result.blocked || 0)} permaneceram na fila. Acompanhe abaixo: Aguardando → Validando Meta → Aceito → Entregue/Lido.`,
      );
      setSelected(new Set());
      setPreview(null);
      setStatus("all");
      await load();
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : "Não foi possível iniciar o disparo.";
      setDispatchError(message);
      setError(message);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function recordOptin() {
    if (!consentLead || !consentConfirmed || consentNote.trim().length < 5) return;
    const client = getSupabase();
    if (!client) {
      setError("Supabase indisponível.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await client.rpc("bia_strategy_queue_record_optin", {
        p_organization_id: data.organization.id,
        p_crm_record_id: consentLead.crmRecordId,
        p_source: consentSource,
        p_consent_at: new Date(consentAt).toISOString(),
        p_note: consentNote.trim(),
      });
      if (result.error) throw new Error(result.error.message);
      setNotice(
        `Opt-in de WhatsApp registrado para ${consentLead.name}. O lead será revalidado antes de qualquer disparo.`,
      );
      setConsentLead(null);
      setConsentNote("");
      setConsentConfirmed(false);
      setConsentAt(localDateTimeNow());
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível registrar o opt-in.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function openExistingConversation(item: QueueItem) {
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    const client = getSupabase();
    if (!client) {
      tab?.close();
      setError("Supabase indisponível.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await client.rpc("bia_strategy_queue_find_thread", {
        p_organization_id: data.organization.id,
        p_queue_id: item.id,
      });
      if (result.error) throw new Error(result.error.message);
      const payload = result.data as { found?: boolean; threadId?: string | null };
      if (!payload?.found || !payload.threadId) {
        throw new Error("Não encontrei uma conversa WhatsApp existente para este lead.");
      }
      const url = `/bia?painel=whatsapp&conversa=${encodeURIComponent(payload.threadId)}`;
      if (tab) tab.location.replace(url);
      else window.location.assign(url);
    } catch (caught) {
      tab?.close();
      setError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível abrir a conversa.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function cancelSelected() {
    if (!selectedCount) return;
    if (!window.confirm(`Remover ${selectedCount} lead(s) da fila de disparo?`))
      return;
    setBusy(true);
    setError("");
    try {
      await rpc("cancel", { queueIds: [...selected] });
      setSelected(new Set());
      setNotice("Leads removidos da fila de disparo.");
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível remover os leads da fila.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="crm5-stack">
      <CrmSectionHeader
        eyebrow="BIA · WHATSAPP"
        title="Fila da Bia"
        description="Revise os leads colocados em fila, escolha a mensagem inicial aprovada e só então autorize o disparo."
        actions={
          <button onClick={() => void load()} disabled={busy}>
            ↻ Atualizar
          </button>
        }
      />

      {notice && (
        <button className="notice" onClick={() => setNotice("")}>
          {notice}
          <span>×</span>
        </button>
      )}
      {error && <div className="feedback error">{error}</div>}

      <section className="crm5-kpis four">
        <CrmKpi
          label="Em fila"
          value={overview?.counts.staged ?? "—"}
          detail="Aguardando seleção e disparo"
          tone="blue"
        />
        <CrmKpi
          label="Selecionados"
          value={selectedCount}
          detail={selectedCount ? `${readyCount} apto(s) · ${blockedCount} bloqueado(s)` : "Selecione leads para validar"}
          tone="green"
        />
        <CrmKpi
          label="Disparados"
          value={overview?.counts.dispatched ?? "—"}
          detail="Já encaminhados ao worker da Bia"
          tone="lime"
        />
        <CrmKpi
          label="Com alerta"
          value={overview?.counts.alerts ?? "—"}
          detail="Falharam em alguma validação recente"
          tone="orange"
        />
      </section>

      <section className="crm5-panel">
        <header>
          <div>
            <small>CONTROLE DE DISPARO</small>
            <h3>Mensagem inicial</h3>
          </div>
          <Status tone={channelReady ? "success" : "warning"}>
            {channelReady ? "WhatsApp pronto" : "Canal indisponível"}
          </Status>
        </header>

        <div className={styles.templateToolbar}>
          <div>
            <strong>Templates aprovados na Meta</strong>
            <span>
              {templates.length
                ? `${templates.length} opção(ões) APPROVED em pt_BR`
                : "Consultando a conta WhatsApp da Évora"}
            </span>
          </div>
          <button
            type="button"
            disabled={templateBusy}
            onClick={() => void loadTemplates()}
          >
            {templateBusy ? "Consultando..." : "↻ Atualizar templates"}
          </button>
        </div>

        {templateError && (
          <div className="feedback error">
            Não foi possível consultar o catálogo da Meta: {templateError}
          </div>
        )}

        {templates.length ? (
          <div className={styles.templateCatalog}>
            {templates.map((template) => (
              <label
                className={[
                  styles.templateCard,
                  templateName === template.name ? styles.templateSelected : "",
                  !template.sendable ? styles.templateUnavailable : "",
                ].filter(Boolean).join(" ")}
                key={template.name}
              >
                <div className={styles.templateChoice}>
                  <input
                    type="radio"
                    name="bia-meta-template"
                    value={template.name}
                    checked={templateName === template.name}
                    disabled={!template.sendable || busy}
                    onChange={() => setTemplateName(template.name)}
                  />
                  <div>
                    <strong>{template.name}</strong>
                    <small>
                      {template.category || "Categoria não informada"} · {template.language} · APPROVED
                    </small>
                  </div>
                  <Status tone={template.sendable ? "success" : "warning"}>
                    {template.sendable ? "Apto" : "Requer ajuste"}
                  </Status>
                </div>

                <div className={styles.templateText}>
                  {template.header && (
                    <strong className={styles.templateHeaderText}>
                      {template.header}
                    </strong>
                  )}
                  <p>{template.body}</p>
                  {template.footer && (
                    <small className={styles.templateFooter}>
                      {template.footer}
                    </small>
                  )}
                  {Boolean(template.buttons?.length) && (
                    <div className={styles.templateButtons}>
                      {template.buttons.map((button) => (
                        <span key={button}>{button}</span>
                      ))}
                    </div>
                  )}
                </div>

                {template.compatibilityReason && (
                  <em className={styles.templateWarning}>
                    {template.compatibilityReason}
                  </em>
                )}
              </label>
            ))}
          </div>
        ) : !templateBusy && !templateError ? (
          <EmptyState
            title="Nenhum template aprovado encontrado"
            text="A conta WhatsApp não retornou templates APPROVED em pt_BR."
          />
        ) : null}

        <div className={styles.dispatchActions}>
          <button
            className="primary"
            disabled={
              busy ||
              templateBusy ||
              !channelReady ||
              !settingsId ||
              !selectedTemplate?.sendable ||
              !selectedCount ||
              readyCount < 1
            }
            onClick={() => void fire()}
          >
            {busy
              ? "Processando..."
              : selectedCount
                ? `Disparar · ${readyCount}/${selectedCount}`
                : "Disparar"}
          </button>
          <small>
            {selectedTemplate
              ? `Selecionado: ${selectedTemplate.name}. O worker consulta novamente a Meta antes do envio e usa exatamente este template APPROVED.`
              : "Escolha acima uma das mensagens aprovadas pela Meta."}
          </small>
          <small>
            {selectedCount
              ? readyCount
                ? `${readyCount} selecionado(s) estão prontos; ${blockedCount} permanecem bloqueados pelos guardrails.`
                : "Nenhum selecionado está apto para a mensagem inicial. Veja o motivo em cada lead abaixo."
              : "Selecione os leads. O backend validará consentimento, histórico, telefone, opt-out e empreendimento antes de liberar o disparo."}
          </small>
          {dispatchError && (
            <div className="feedback error" role="alert">
              Falha ao disparar: {dispatchError}
            </div>
          )}
        </div>
      </section>

      <section className="crm5-panel">
        <header>
          <div>
            <small>LEADS EM STAGING</small>
            <h3>Selecionar destinatários</h3>
          </div>
          <span>{visible.length} registros exibidos</span>
        </header>

        <div className={styles.toolbar}>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar nome, telefone, empreendimento ou origem..."
          />
          <select
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as "staged" | "all")
            }
          >
            <option value="staged">Somente em fila</option>
            <option value="all">Fila + histórico</option>
          </select>
          <button
            type="button"
            disabled={!stagedVisible.length}
            onClick={toggleAllVisible}
          >
            {allVisibleSelected ? "Desmarcar todos" : "Selecionar todos"}
          </button>
          <button
            type="button"
            disabled={busy || !selectedCount}
            onClick={() => void cancelSelected()}
          >
            Remover da fila
          </button>
        </div>

        {visible.length ? (
          <div className={styles.table}>
            <div className={styles.headerRow}>
              <span></span>
              <span>Lead</span>
              <span>Empreendimento</span>
              <span>Origem</span>
              <span>Score</span>
              <span>Status</span>
              <span></span>
            </div>
            {visible.map((item) => {
              const lead = crm.records.find(
                (record) => record.id === item.crmRecordId,
              );
              const livePreview = previewByQueueId[item.id];
              const displayReason =
                item.status === "staged"
                  ? livePreview?.reason ?? item.lastError
                  : item.lastError;
              const delivery = deliveries[item.id];
              return (
                <div className={styles.row} key={item.id}>
                  <label className={styles.checkbox}>
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      disabled={item.status !== "staged" || busy}
                      onChange={() => toggle(item.id)}
                      aria-label={`Selecionar ${item.name}`}
                    />
                  </label>
                  <div>
                    <strong>{item.name}</strong>
                    <small>
                      {item.phone || "Sem telefone"} ·{" "}
                      {item.temperature || "sem temperatura"}
                    </small>
                    {displayReason ? (
                      <em>
                        {reasonLabels[displayReason] || displayReason}
                      </em>
                    ) : livePreview?.ready ? (
                      <em>Pronto para receber o template inicial selecionado.</em>
                    ) : null}
                  </div>
                  <span>{item.projectName || "—"}</span>
                  <span>{item.source}</span>
                  <b>{Math.round(Number(item.score) || 0)}</b>
                  <div>
                    <Status
                      tone={
                        item.status === "staged"
                          ? displayReason
                            ? "warning"
                            : livePreview?.ready
                              ? "success"
                              : "info"
                          : item.status === "dispatched"
                            ? deliveryTone(delivery)
                            : "neutral"
                      }
                    >
                      {item.status === "staged"
                        ? livePreview?.ready
                          ? "Pronto"
                          : queueStatusLabel(displayReason)

                        : item.status === "dispatched"
                          ? deliveryLabel(delivery)
                          : "Removido"}
                    </Status>
                    <small>
                      {item.status === "dispatched"
                        ? delivery?.errorCode
                          ? `${delivery.errorCode} · ${formatDate(item.dispatchedAt)}`
                          : `${delivery?.templateName || "template Meta"} · ${formatDate(item.dispatchedAt)}`
                        : formatDate(item.queuedAt)}
                    </small>
                  </div>
                  <div className={styles.rowActions}>
                    {item.status === "staged" &&
                      displayReason === "BIA_BULK_CONSENT_REQUIRED" && (
                        <button
                          type="button"
                          className="primary"
                          disabled={busy}
                          onClick={() => {
                            setConsentLead(item);
                            setConsentSource("whatsapp");
                            setConsentAt(localDateTimeNow());
                            setConsentNote("");
                            setConsentConfirmed(false);
                          }}
                        >
                          Registrar opt-in
                        </button>
                      )}
                    {item.status === "staged" &&
                      displayReason === "BIA_CAMPAIGN_ALREADY_CONTACTED" && (
                        <button
                          type="button"
                          className="primary"
                          disabled={busy}
                          onClick={() => void openExistingConversation(item)}
                        >
                          Retomar
                        </button>
                      )}
                    <button
                      type="button"
                      disabled={!lead}
                      onClick={() => lead && openLead(lead)}
                    >
                      Abrir
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="Nenhum lead na fila"
            text={
              status === "staged"
                ? "Use a ação “Enviar para fila da Bia” na Estratégia IA para adicionar leads."
                : "Nenhum registro corresponde aos filtros atuais."
            }
          />
        )}
      </section>

      {consentLead && (
        <div className={styles.modalBackdrop} role="presentation">
          <section
            className={styles.consentModal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="bia-optin-title"
          >
            <header>
              <div>
                <small>WHATSAPP · EVIDÊNCIA DE CONSENTIMENTO</small>
                <h3 id="bia-optin-title">Registrar opt-in de {consentLead.name}</h3>
              </div>
              <button
                type="button"
                onClick={() => setConsentLead(null)}
                aria-label="Fechar"
              >
                ×
              </button>
            </header>

            <p>
              Registre somente quando houver evidência real de que o lead
              autorizou receber mensagens da <strong>Évora Urbanismo</strong>{" "}
              pelo WhatsApp. Este registro ficará vinculado ao número e será
              auditável.
            </p>

            <label>
              Como o consentimento foi dado?
              <select
                value={consentSource}
                onChange={(event) => setConsentSource(event.target.value)}
              >
                <option value="whatsapp">WhatsApp anterior</option>
                <option value="telefone">Ligação telefônica</option>
                <option value="presencial">Presencial</option>
                <option value="formulario">Formulário externo</option>
                <option value="email">E-mail</option>
                <option value="outro">Outro meio documentado</option>
              </select>
            </label>

            <label>
              Data e hora do consentimento
              <input
                type="datetime-local"
                value={consentAt}
                onChange={(event) => setConsentAt(event.target.value)}
              />
            </label>

            <label>
              Evidência / observação
              <textarea
                value={consentNote}
                onChange={(event) => setConsentNote(event.target.value)}
                placeholder="Ex.: lead respondeu no WhatsApp autorizando receber informações do Solaris pela Évora."
                maxLength={500}
                rows={4}
              />
            </label>

            <label className={styles.confirmConsent}>
              <input
                type="checkbox"
                checked={consentConfirmed}
                onChange={(event) => setConsentConfirmed(event.target.checked)}
              />
              <span>
                Confirmo que o lead autorizou receber mensagens da Évora
                Urbanismo pelo WhatsApp.
              </span>
            </label>

            <div className={styles.modalActions}>
              <button type="button" onClick={() => setConsentLead(null)}>
                Cancelar
              </button>
              <button
                type="button"
                className="primary"
                disabled={
                  busy ||
                  !consentConfirmed ||
                  consentNote.trim().length < 5 ||
                  !consentAt
                }
                onClick={() => void recordOptin()}
              >
                {busy ? "Registrando..." : "Registrar opt-in"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
