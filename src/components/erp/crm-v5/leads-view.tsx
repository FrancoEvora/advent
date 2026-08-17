"use client";

import { useEffect, useMemo, useState } from "react";

import type { CrmRecord, ErpData } from "../types";
import { CrmSectionHeader, EmptyState, Status, UserName } from "./shared";
import type { CrmEnterpriseData } from "./types";
import styles from "./leads-view.module.css";

type LeadSort =
  | "origin_desc"
  | "origin_asc"
  | "name_asc"
  | "name_desc"
  | "project_asc"
  | "next_action_asc"
  | "score_desc"
  | "sla_asc";

type AiShadowLead = {
  crmRecordId: string;
  status: string;
  messageId: string | null;
  deliveryStatus: string | null;
  draft: string | null;
  qualityScore: number | null;
  supervisorDecision: string | null;
  updatedAt: string | null;
};

type AiShadowResponse = {
  enabled?: boolean;
  leads?: AiShadowLead[];
};

type AiPrepareResponse = {
  prepared?: boolean;
  message?: {
    messageId: string;
    content: string;
    deliveryStatus: string;
    preparedAt: string | null;
  };
  error?: string;
};

type LeadArchiveDependencies = {
  activities: number;
  activeContracts: number;
  activeProposals: number;
  activeReservations: number;
  aiJobs: number;
  alerts: number;
  assignments: number;
  attributions: number;
  contracts: number;
  conversations: number;
  messages: number;
  opportunityEvents: number;
  proposals: number;
  reservations: number;
};

type LeadArchiveResponse = {
  ok?: boolean;
  action?: "preview" | "archive";
  archived?: boolean;
  alreadyArchived?: boolean;
  recordStatus?: string;
  contactLinked?: boolean;
  dependencies?: LeadArchiveDependencies;
  archiveAllowed?: boolean;
  blockingReasons?: string[];
  closedConversations?: number;
  closedSessions?: number;
  message?: string;
  error?: string;
  code?: string;
  correlationId?: string;
};

const leadCollator = new Intl.Collator("pt-BR", {
  sensitivity: "base",
  numeric: true,
});

const leadDateFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const leadTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function urgency(lead: CrmRecord) {
  if (lead.record_status !== "aberta") return "neutral";
  if (lead.sla_due_at && new Date(lead.sla_due_at) < new Date()) return "danger";
  if (lead.priority === "urgente" || lead.temperature === "quente") return "warning";
  return "info";
}

function originDate(lead: CrmRecord) {
  return lead.originated_at || lead.created_at || null;
}

function dateNumber(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareOptionalDates(
  first: string | null | undefined,
  second: string | null | undefined,
  direction: "asc" | "desc",
) {
  const left = dateNumber(first);
  const right = dateNumber(second);
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return direction === "asc" ? left - right : right - left;
}

function formatOriginDate(value: string | null) {
  const timestamp = dateNumber(value);
  if (timestamp === null) return "Não informado";
  const date = new Date(timestamp);
  return `${leadDateFormatter.format(date)} · ${leadTimeFormatter.format(date)}`;
}

function isMetaLead(lead: CrmRecord) {
  return (
    lead.source_channel === "meta_lead_ads" ||
    lead.utm_source?.toLowerCase() === "meta" ||
    (lead.source || "").toLowerCase().includes("meta lead") ||
    (lead.tags || []).some((tag) => tag.toLowerCase() === "meta")
  );
}

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function normalizeWhatsApp(value: string) {
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("55") ? digits : `55${digits}`;
}

function aiStatusLabel(value: AiShadowLead | undefined) {
  if (!value) return null;
  if (value.supervisorDecision === "block") return "Bloqueado pelo supervisor";
  if (value.deliveryStatus === "prepared") return "WhatsApp preparado";
  if (value.status === "human_required") return "Requer humano";
  if (value.status === "human_active") return "Humano assumiu";
  if (value.status === "paused") return "IA pausada";
  if (value.draft) return "Rascunho pronto";
  if (value.status === "failed") return "Falha na análise";
  return "Vitória em análise";
}

function preparationError(code: string | undefined) {
  switch (code) {
    case "COPILOT_APPROVAL_PERMISSION_REQUIRED":
      return "Seu perfil não pode aprovar mensagens da Vitória.";
    case "AI_DRAFT_PREPARE_FORBIDDEN":
      return "A preparação foi bloqueada pelas regras de comunicação.";
    case "AI_DRAFT_PREPARE_REJECTED":
      return "Este rascunho não está mais disponível. Atualize a carteira.";
    case "INVALID_MESSAGE_CONTENT":
      return "Revise o texto: a mensagem deve ter entre 1 e 1.200 caracteres.";
    default:
      return "Não foi possível preparar a mensagem no momento.";
  }
}

export function LeadsView({
  data,
  crm,
  openLead,
  openActivity,
  reload,
  onArchived,
  focusId = null,
}: {
  data: ErpData;
  crm: CrmEnterpriseData;
  openLead: (lead?: CrmRecord) => void;
  openActivity: (lead?: CrmRecord) => void;
  reload: () => Promise<void>;
  onArchived: (recordId: string) => void;
  focusId?: string | null;
}) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(focusId ? "todos" : "aberta");
  const [temperature, setTemperature] = useState("todos");
  const [sort, setSort] = useState<LeadSort>("origin_desc");
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiByLead, setAiByLead] = useState<Record<string, AiShadowLead>>({});
  const [reviewLeadId, setReviewLeadId] = useState<string | null>(null);
  const [reviewContent, setReviewContent] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [archiveLeadId, setArchiveLeadId] = useState<string | null>(null);
  const [archiveConfirmation, setArchiveConfirmation] = useState("");
  const [archivePreview, setArchivePreview] =
    useState<LeadArchiveResponse | null>(null);
  const [archiveError, setArchiveError] = useState("");
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveFeedback, setArchiveFeedback] = useState("");
  const canArchiveLead = data.membership.role === "admin";

  const projectById = useMemo(
    () => new Map(data.projects.map((project) => [project.id, project.name])),
    [data.projects],
  );

  const aiRecordIds = useMemo(
    () =>
      crm.records
        .filter((record) => record.record_status !== "arquivada")
        .map((record) => record.id)
        .sort(),
    [crm.records],
  );

  const reviewLead = useMemo(
    () => crm.records.find((record) => record.id === reviewLeadId) || null,
    [crm.records, reviewLeadId],
  );
  const reviewAi = reviewLeadId ? aiByLead[reviewLeadId] : undefined;
  const archiveLead = useMemo(
    () => crm.records.find((record) => record.id === archiveLeadId) || null,
    [archiveLeadId, crm.records],
  );

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function loadAiShadow() {
      const token = data.session.access_token;
      if (!token || !aiRecordIds.length) {
        setAiEnabled(false);
        setAiByLead({});
        return;
      }

      const collected: Record<string, AiShadowLead> = {};
      let enabled = false;

      try {
        for (const batch of chunks(aiRecordIds, 200)) {
          const response = await fetch("/api/ai/leads/shadow", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              organizationId: data.organization.id,
              crmRecordIds: batch,
            }),
            cache: "no-store",
            signal: controller.signal,
          });

          if (response.status === 401 || response.status === 403) {
            if (!cancelled) {
              setAiEnabled(false);
              setAiByLead({});
            }
            return;
          }
          if (!response.ok) throw new Error("AI_SHADOW_READ_FAILED");

          const payload = (await response.json()) as AiShadowResponse;
          enabled = enabled || payload.enabled === true;
          for (const lead of payload.leads || []) {
            if (lead.crmRecordId) collected[lead.crmRecordId] = lead;
          }
        }

        if (!cancelled) {
          setAiEnabled(enabled);
          setAiByLead(collected);
        }
      } catch (error) {
        if (
          cancelled ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          return;
        }
        setAiEnabled(false);
        setAiByLead({});
      }
    }

    void loadAiShadow();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [aiRecordIds, data.organization.id, data.session.access_token]);

  useEffect(() => {
    if (!reviewLeadId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !reviewBusy) {
        setReviewLeadId(null);
        setReviewError("");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [reviewBusy, reviewLeadId]);

  useEffect(() => {
    if (!archiveLeadId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !archiveBusy) {
        setArchiveLeadId(null);
        setArchiveConfirmation("");
        setArchivePreview(null);
        setArchiveError("");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [archiveBusy, archiveLeadId]);

  function openAiReview(lead: CrmRecord, ai: AiShadowLead) {
    if (!ai.draft || !ai.messageId) return;
    setReviewLeadId(lead.id);
    setReviewContent(ai.draft);
    setReviewError("");
  }

  function closeAiReview() {
    if (reviewBusy) return;
    setReviewLeadId(null);
    setReviewContent("");
    setReviewError("");
  }

  function closeArchiveDialog(force = false) {
    if (archiveBusy && !force) return;
    setArchiveLeadId(null);
    setArchiveConfirmation("");
    setArchivePreview(null);
    setArchiveError("");
  }

  async function archiveRequest(
    lead: CrmRecord,
    action: "preview" | "archive",
  ) {
    const response = await fetch("/api/crm/leads/archive", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action,
        organizationId: data.organization.id,
        crmRecordId: lead.id,
        ...(action === "archive"
          ? { confirmation: archiveConfirmation }
          : {}),
      }),
      cache: "no-store",
    });
    let payload: LeadArchiveResponse = {};
    try {
      payload = (await response.json()) as LeadArchiveResponse;
    } catch {
      // A mensagem segura abaixo substitui respostas que não sejam JSON.
    }
    if (!response.ok || payload.ok !== true) {
      const reference = payload.correlationId
        ? ` Referência: ${payload.correlationId}.`
        : "";
      throw new Error(
        `${payload.error || "Não foi possível concluir a operação."}${reference}`,
      );
    }
    return payload;
  }

  async function openArchiveDialog(lead: CrmRecord) {
    if (!canArchiveLead || lead.record_status === "arquivada") return;
    setArchiveLeadId(lead.id);
    setArchiveConfirmation("");
    setArchivePreview(null);
    setArchiveError("");
    setArchiveBusy(true);
    try {
      const preview = await archiveRequest(lead, "preview");
      setArchivePreview(preview);
    } catch (error) {
      setArchiveError(
        error instanceof Error
          ? error.message
          : "Não foi possível verificar os vínculos do lead.",
      );
    } finally {
      setArchiveBusy(false);
    }
  }

  async function confirmArchiveLead() {
    if (
      !archiveLead ||
      !canArchiveLead ||
      archiveConfirmation !== "EXCLUIR" ||
      !archivePreview?.dependencies ||
      archivePreview.archiveAllowed !== true
    ) {
      return;
    }
    setArchiveBusy(true);
    setArchiveError("");
    try {
      const result = await archiveRequest(archiveLead, "archive");
      if (!result.archived) {
        throw new Error("O CRM não confirmou o arquivamento do lead.");
      }
      onArchived(archiveLead.id);
      setArchiveFeedback(
        result.alreadyArchived
          ? "O lead já estava arquivado. Nenhum dado foi apagado."
          : "Lead excluído da operação ativa. Os canais de atendimento foram encerrados e todo o histórico permaneceu preservado para auditoria.",
      );
      closeArchiveDialog(true);
      setStatus("aberta");
      void reload();
    } catch (error) {
      setArchiveError(
        error instanceof Error
          ? error.message
          : "Não foi possível arquivar o lead.",
      );
    } finally {
      setArchiveBusy(false);
    }
  }

  async function prepareAndOpenWhatsApp() {
    if (!reviewLead || !reviewAi?.messageId || !reviewAi.draft) return;
    const phone = normalizeWhatsApp(reviewLead.phone || "");
    const content = reviewContent.normalize("NFC").trim();
    if (!phone) {
      setReviewError("O lead não possui WhatsApp cadastrado.");
      return;
    }
    if (!content || content.length > 1_200) {
      setReviewError("A mensagem deve ter entre 1 e 1.200 caracteres.");
      return;
    }

    const popup = window.open("", "_blank");
    if (popup) popup.opener = null;
    setReviewBusy(true);
    setReviewError("");

    try {
      const response = await fetch("/api/ai/leads/shadow/prepare", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${data.session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          organizationId: data.organization.id,
          crmRecordId: reviewLead.id,
          messageId: reviewAi.messageId,
          content,
        }),
        cache: "no-store",
      });
      const payload = (await response.json()) as AiPrepareResponse;
      if (!response.ok || !payload.prepared || !payload.message) {
        throw new Error(payload.error || "AI_DRAFT_PREPARE_UNAVAILABLE");
      }

      const prepared = payload.message;
      setAiByLead((current) => ({
        ...current,
        [reviewLead.id]: {
          ...current[reviewLead.id],
          status: "human_active",
          messageId: prepared.messageId,
          deliveryStatus: "prepared",
          draft: null,
          updatedAt: prepared.preparedAt || new Date().toISOString(),
        },
      }));

      const whatsappUrl = `https://wa.me/${phone}?text=${encodeURIComponent(
        prepared.content,
      )}`;
      if (popup) {
        popup.location.href = whatsappUrl;
      } else {
        window.location.href = whatsappUrl;
      }
      setReviewLeadId(null);
      setReviewContent("");
    } catch (error) {
      popup?.close();
      setReviewError(
        preparationError(error instanceof Error ? error.message : undefined),
      );
    } finally {
      setReviewBusy(false);
    }
  }

  const rows = useMemo(() => {
    const query = q.trim().toLocaleLowerCase("pt-BR");
    const filtered = crm.records.filter((item) => {
      if (status === "todos" && item.record_status === "arquivada") return false;
      if (status !== "todos" && item.record_status !== status) return false;
      if (temperature !== "todos" && item.temperature !== temperature) {
        return false;
      }
      if (!query) return true;
      const project = item.project_id
        ? projectById.get(item.project_id) || ""
        : "";
      return `${item.person_name} ${item.company_name || ""} ${
        item.phone || ""
      } ${item.email || ""} ${project} ${item.source || ""}`
        .toLocaleLowerCase("pt-BR")
        .includes(query);
    });

    return filtered.slice().sort((first, second) => {
      let result = 0;
      switch (sort) {
        case "origin_asc":
          result = compareOptionalDates(
            originDate(first),
            originDate(second),
            "asc",
          );
          break;
        case "name_asc":
          result = leadCollator.compare(
            first.person_name || "",
            second.person_name || "",
          );
          break;
        case "name_desc":
          result = leadCollator.compare(
            second.person_name || "",
            first.person_name || "",
          );
          break;
        case "project_asc":
          result = leadCollator.compare(
            (first.project_id && projectById.get(first.project_id)) ||
              "Não definido",
            (second.project_id && projectById.get(second.project_id)) ||
              "Não definido",
          );
          break;
        case "next_action_asc":
          result = compareOptionalDates(
            first.next_action_at,
            second.next_action_at,
            "asc",
          );
          break;
        case "score_desc":
          result =
            Number(second.lead_score || 0) - Number(first.lead_score || 0);
          break;
        case "sla_asc":
          result = compareOptionalDates(
            first.sla_due_at,
            second.sla_due_at,
            "asc",
          );
          break;
        case "origin_desc":
        default:
          result = compareOptionalDates(
            originDate(first),
            originDate(second),
            "desc",
          );
          break;
      }
      if (result !== 0) return result;
      const byName = leadCollator.compare(
        first.person_name || "",
        second.person_name || "",
      );
      return byName || first.id.localeCompare(second.id);
    });
  }, [crm.records, projectById, q, sort, status, temperature]);

  useEffect(() => {
    if (!focusId || !rows.some((item) => item.id === focusId)) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`agenda-record-${focusId}`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusId, rows]);

  return (
    <div className="crm5-stack">
      <CrmSectionHeader
        eyebrow="CARTEIRA COMERCIAL"
        title="Leads e clientes potenciais"
        description="Pesquisa, segmentação, score, responsáveis, prioridade, origem e próxima ação."
        actions={
          <button className="primary" onClick={() => openLead()}>
            + Novo lead
          </button>
        }
      />

      {archiveFeedback && (
        <div className={styles.archiveFeedback} role="status">
          <span>{archiveFeedback}</span>
          <button
            type="button"
            aria-label="Fechar confirmação"
            onClick={() => setArchiveFeedback("")}
          >
            ×
          </button>
        </div>
      )}

      <section className={`crm5-toolbar ${styles.toolbar}`}>
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Buscar por nome, empresa, telefone ou e-mail"
        />
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="aberta">Em aberto</option>
          <option value="ganha">Ganhos</option>
          <option value="perdida">Perdidos</option>
          <option value="arquivada">Arquivados</option>
          <option value="todos">Todos ativos</option>
        </select>
        <select
          value={temperature}
          onChange={(event) => setTemperature(event.target.value)}
        >
          <option value="todos">Todas as temperaturas</option>
          <option value="quente">Quentes</option>
          <option value="morno">Mornos</option>
          <option value="frio">Frios</option>
        </select>
        <select
          aria-label="Ordenar leads"
          value={sort}
          onChange={(event) => setSort(event.target.value as LeadSort)}
        >
          <option value="origin_desc">Cadastro: mais recentes</option>
          <option value="origin_asc">Cadastro: mais antigos</option>
          <option value="name_asc">Nome: A a Z</option>
          <option value="name_desc">Nome: Z a A</option>
          <option value="project_asc">Empreendimento: A a Z</option>
          <option value="next_action_asc">Próxima ação: mais próxima</option>
          <option value="score_desc">Score: maior primeiro</option>
          <option value="sla_asc">SLA: mais urgente</option>
        </select>
        <span>{rows.length} registros</span>
      </section>

      <section className="crm5-panel">
        <div className={`crm5-lead-table ${styles.table}`}>
          <header>
            <span>Lead</span>
            <span>Empreendimento</span>
            <span>Cadastro</span>
            <span>Score</span>
            <span>Responsáveis</span>
            {aiEnabled && <span>Atendimento IA</span>}
            <span>Próxima ação</span>
            <span>Ações</span>
          </header>

          {rows.map((lead) => {
            const ai = aiByLead[lead.id];
            const aiLabel = aiStatusLabel(ai);
            return (
              <article
                id={`agenda-record-${lead.id}`}
                data-record-id={lead.id}
                tabIndex={lead.id === focusId ? -1 : undefined}
                className={
                  lead.id === focusId ? "agenda-linked-target" : undefined
                }
                key={lead.id}
              >
                <div>
                  <strong>{lead.person_name}</strong>
                  <small>
                    {lead.company_name || lead.phone || lead.email || "Sem contato"}
                  </small>
                  <div className="crm5-tags">
                    {(lead.tags || []).slice(0, 3).map((tag) => (
                      <i key={tag}>{tag}</i>
                    ))}
                  </div>
                </div>

                <div>
                  <strong>
                    {(lead.project_id && projectById.get(lead.project_id)) ||
                      "Não definido"}
                  </strong>
                  <small>
                    {lead.source ||
                      lead.source_channel ||
                      "Origem não informada"}
                  </small>
                </div>

                <div className={styles.origin}>
                  <strong>{formatOriginDate(originDate(lead))}</strong>
                  <small>
                    {isMetaLead(lead) ? "Cadastro na Meta" : "Cadastro no CRM"}
                  </small>
                </div>

                <div>
                  <b
                    className={`crm5-score ${
                      Number(lead.lead_score || 0) >= 70 ? "hot" : ""
                    }`}
                  >
                    {lead.lead_score || 0}
                  </b>
                  <Status tone={urgency(lead)}>
                    {lead.temperature || "morno"}
                  </Status>
                </div>

                <div>
                  <small>
                    SDR: <UserName id={lead.sdr_user_id} data={data} />
                  </small>
                  <small>
                    Corretor: <UserName id={lead.broker_user_id} data={data} />
                  </small>
                </div>

                {aiEnabled && (
                  <div className={styles.aiStatus}>
                    {aiLabel ? (
                      <>
                        <strong>{aiLabel}</strong>
                        <small>
                          {ai?.qualityScore !== null &&
                          ai?.qualityScore !== undefined
                            ? `Qualidade ${ai.qualityScore}/100`
                            : "Modo sombra"}
                        </small>
                        {ai?.draft && (
                          <small title={ai.draft}>{ai.draft}</small>
                        )}
                        {ai?.draft && ai.messageId && (
                          <button
                            type="button"
                            className={styles.reviewButton}
                            onClick={() => openAiReview(lead, ai)}
                          >
                            Revisar
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <strong>Sem análise</strong>
                        <small>Vitória ainda não processou</small>
                      </>
                    )}
                  </div>
                )}

                <div>
                  <strong>
                    {lead.next_action_at
                      ? new Date(lead.next_action_at).toLocaleString("pt-BR", {
                          timeZone: "America/Sao_Paulo",
                          day: "2-digit",
                          month: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "Não agendada"}
                  </strong>
                  <small>
                    {lead.sla_due_at
                      ? `SLA ${new Date(lead.sla_due_at).toLocaleString(
                          "pt-BR",
                          {
                            timeZone: "America/Sao_Paulo",
                            day: "2-digit",
                            month: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          },
                        )}`
                      : "Sem SLA"}
                  </small>
                </div>

                <div>
                  {lead.record_status !== "arquivada" && (
                    <button onClick={() => openActivity(lead)}>Atividade</button>
                  )}
                  <button onClick={() => openLead(lead)}>
                    {lead.record_status === "arquivada" ? "Visualizar" : "Editar"}
                  </button>
                  {canArchiveLead && lead.record_status !== "arquivada" ? (
                    <button
                      type="button"
                      className={styles.archiveButton}
                      onClick={() => void openArchiveDialog(lead)}
                    >
                      Excluir
                    </button>
                  ) : lead.record_status === "arquivada" ? (
                    <Status tone="neutral">Arquivado</Status>
                  ) : null}
                </div>
              </article>
            );
          })}

          {!rows.length && (
            <EmptyState
              title="Nenhum lead encontrado"
              text="Ajuste os filtros ou cadastre uma nova oportunidade."
            />
          )}
        </div>
      </section>

      {reviewLead && reviewAi?.draft && reviewAi.messageId && (
        <div
          className={styles.reviewBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeAiReview();
          }}
        >
          <section
            className={styles.reviewDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="vitoria-review-title"
          >
            <header>
              <div>
                <small>REVISÃO HUMANA OBRIGATÓRIA</small>
                <h3 id="vitoria-review-title">Mensagem da Vitória</h3>
                <p>
                  {reviewLead.person_name} ·{" "}
                  {(reviewLead.project_id &&
                    projectById.get(reviewLead.project_id)) ||
                    "Empreendimento não definido"}
                </p>
              </div>
              <button
                type="button"
                aria-label="Fechar revisão"
                disabled={reviewBusy}
                onClick={closeAiReview}
              >
                ×
              </button>
            </header>

            <div className={styles.reviewMetrics}>
              <span>
                Supervisor
                <strong>
                  {reviewAi.supervisorDecision === "revise"
                    ? "Revisado"
                    : "Aprovado"}
                </strong>
              </span>
              <span>
                Qualidade
                <strong>
                  {reviewAi.qualityScore !== null
                    ? `${reviewAi.qualityScore}/100`
                    : "Não informada"}
                </strong>
              </span>
              <span>
                Canal
                <strong>WhatsApp</strong>
              </span>
            </div>

            <label className={styles.reviewField}>
              Mensagem final
              <textarea
                autoFocus
                maxLength={1_200}
                rows={8}
                value={reviewContent}
                disabled={reviewBusy}
                onChange={(event) => {
                  setReviewContent(event.target.value);
                  setReviewError("");
                }}
              />
              <small>{reviewContent.length}/1.200 caracteres</small>
            </label>

            <div className={styles.reviewNotice}>
              <strong>Nenhum envio automático será realizado.</strong>
              <p>
                A aprovação registra a revisão na Enterprise e abre o WhatsApp
                com a mensagem preparada. O profissional ainda precisa conferir
                e confirmar o envio no aplicativo.
              </p>
            </div>

            {reviewError && (
              <p className={styles.reviewError} role="alert">
                {reviewError}
              </p>
            )}

            <footer>
              <button
                type="button"
                disabled={reviewBusy}
                onClick={closeAiReview}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="primary"
                disabled={reviewBusy || !reviewContent.trim()}
                onClick={() => void prepareAndOpenWhatsApp()}
              >
                {reviewBusy ? "Registrando revisão..." : "Aprovar e abrir WhatsApp"}
              </button>
            </footer>
          </section>
        </div>
      )}

      {archiveLead && (
        <div
          className={styles.archiveBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeArchiveDialog();
          }}
        >
          <section
            className={styles.archiveDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="lead-archive-title"
            aria-describedby="lead-archive-description"
          >
            <header>
              <div>
                <small>EXCLUSÃO ADMINISTRATIVA</small>
                <h3 id="lead-archive-title">Excluir lead da operação?</h3>
                <p>{archiveLead.person_name}</p>
              </div>
              <button
                type="button"
                aria-label="Fechar exclusão"
                disabled={archiveBusy}
                onClick={() => closeArchiveDialog()}
              >
                ×
              </button>
            </header>

            <div className={styles.archiveBody}>
              <div className={styles.archiveSafety}>
                <strong>O lead será arquivado, não apagado fisicamente.</strong>
                <p id="lead-archive-description">
                  Ele sairá da carteira ativa, do funil e das filas comerciais.
                  O histórico necessário à auditoria e à continuidade comercial
                  permanecerá no ERP.
                </p>
              </div>

              {archiveBusy && !archivePreview ? (
                <p className={styles.archiveLoading} role="status">
                  Verificando conversas, atividades e negociações vinculadas...
                </p>
              ) : archivePreview?.dependencies ? (
                <div className={styles.archiveDependencies}>
                  <span>
                    Conversas e mensagens
                    <strong>
                      {archivePreview.dependencies.conversations +
                        archivePreview.dependencies.messages}
                    </strong>
                  </span>
                  <span>
                    Atividades e alertas
                    <strong>
                      {archivePreview.dependencies.activities +
                        archivePreview.dependencies.alerts}
                    </strong>
                  </span>
                  <span>
                    Atribuições, IA e eventos
                    <strong>
                      {archivePreview.dependencies.assignments +
                        archivePreview.dependencies.aiJobs +
                        archivePreview.dependencies.opportunityEvents +
                        archivePreview.dependencies.attributions}
                    </strong>
                  </span>
                  <span>
                    Propostas, reservas e contratos
                    <strong>
                      {archivePreview.dependencies.proposals +
                        archivePreview.dependencies.reservations +
                        archivePreview.dependencies.contracts}
                    </strong>
                  </span>
                </div>
              ) : null}

              {archivePreview?.archiveAllowed === false && (
                <div className={styles.archiveBlocked} role="alert">
                  <strong>Exclusão bloqueada por segurança comercial</strong>
                  {(archivePreview.blockingReasons || []).map((reason) => (
                    <p key={reason}>{reason}</p>
                  ))}
                </div>
              )}

              <div className={styles.archivePreservation}>
                <strong>Será preservado</strong>
                <ul>
                  <li>todo o histórico de conversa e de atividades;</li>
                  <li>atribuições, origem, eventos e trilha de auditoria;</li>
                  <li>
                    propostas, reservas e contratos encerrados, sem alteração
                    automática;
                  </li>
                  <li>
                    canais de atendimento, que serão fechados para impedir novas
                    mensagens e tarefas no lead arquivado;
                  </li>
                  <li>
                    {archivePreview?.contactLinked
                      ? "o cadastro do contato vinculado."
                      : "os demais cadastros e documentos da organização."}
                  </li>
                </ul>
              </div>

              {archivePreview?.archiveAllowed !== false && (
                <label className={styles.archiveConfirmation}>
                  Para confirmar, digite <strong>EXCLUIR</strong>
                  <input
                    autoFocus={!archiveBusy}
                    autoComplete="off"
                    spellCheck={false}
                    value={archiveConfirmation}
                    disabled={archiveBusy || !archivePreview?.dependencies}
                    onChange={(event) => {
                      setArchiveConfirmation(event.target.value.toUpperCase());
                      setArchiveError("");
                    }}
                    placeholder="EXCLUIR"
                  />
                </label>
              )}

              {archiveError && (
                <p className={styles.archiveError} role="alert">
                  {archiveError}
                </p>
              )}
            </div>

            <footer>
              <button
                type="button"
                disabled={archiveBusy}
                onClick={() => closeArchiveDialog()}
              >
                Cancelar
              </button>
              <button
                type="button"
                className={styles.archiveConfirmButton}
                disabled={
                  archiveBusy ||
                  archiveConfirmation !== "EXCLUIR" ||
                  !archivePreview?.dependencies ||
                  archivePreview.archiveAllowed !== true
                }
                onClick={() => void confirmArchiveLead()}
              >
                {archiveBusy ? "Arquivando..." : "Excluir e arquivar lead"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
