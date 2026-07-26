"use client";

import { useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { CrmRecord, ErpData } from "../types";
import type { CrmEnterpriseData } from "./types";
import { CrmKpi, CrmSectionHeader, EmptyState, Status } from "./shared";
import {
  buildPrioritizedSdrQueue,
  followUpForOutcome,
  type SdrLeadContext,
  type SdrOutcome,
} from "./sdr-engine";

type QueueFilter = "priority" | "unanswered" | "mine" | "overdue";

const outcomeLabels: Record<SdrOutcome, string> = {
  nao_atendeu: "Não atendeu",
  retornar: "Pediu retorno",
  interessado: "Interesse confirmado",
  sem_interesse: "Sem interesse",
  visita_agendada: "Visita agendada",
  proposta_solicitada: "Proposta solicitada",
};

function formatDate(value: string | null | undefined) {
  if (!value) return "Não registrado";
  return new Date(value).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function actionTypeFor(channel: string) {
  if (channel === "telefone") return "ligacao";
  if (channel === "email") return "email";
  if (channel === "whatsapp") return "whatsapp";
  return "contato";
}

function priorityTone(label: SdrLeadContext["priorityLabel"]) {
  if (label === "Crítica") return "danger";
  if (label === "Alta") return "warning";
  if (label === "Normal") return "info";
  return "neutral";
}

export function SdrWorkbench({
  data,
  crm,
  openActivity,
  reload,
}: {
  data: ErpData;
  crm: CrmEnterpriseData;
  openActivity: (lead?: CrmRecord) => void;
  reload: () => Promise<void>;
}) {
  const [filter, setFilter] = useState<QueueFilter>("priority");
  const [selectedId, setSelectedId] = useState("");
  const [outcome, setOutcome] = useState<SdrOutcome>("nao_atendeu");
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const now = new Date();
  const contexts = buildPrioritizedSdrQueue(data, crm, now);
  const queue = (() => {
    if (filter === "unanswered") {
      return contexts.filter((item) => !item.lead.first_response_at);
    }
    if (filter === "mine") {
      return contexts.filter(
        (item) => item.lead.sdr_user_id === data.session.user.id,
      );
    }
    if (filter === "overdue") {
      return contexts.filter(
        (item) =>
          (item.lead.sla_due_at &&
            new Date(item.lead.sla_due_at) < now) ||
          (item.nextPendingAction?.scheduled_at &&
            new Date(item.nextPendingAction.scheduled_at) < now),
      );
    }
    return contexts;
  })();
  const selected =
    queue.find((item) => item.lead.id === selectedId) || queue[0] || null;

  function clearMessages() {
    setFeedback("");
    setError("");
  }

  async function claim(context: SdrLeadContext) {
    clearMessages();
    if (
      context.lead.sdr_user_id &&
      context.lead.sdr_user_id !== data.session.user.id
    ) {
      setError(
        `Este lead já está sob responsabilidade de ${context.sdrName}.`,
      );
      return;
    }

    const client = getSupabase();
    if (!client) return;
    setBusy(`claim-${context.lead.id}`);
    const nowIso = new Date().toISOString();
    const assignment = await client
      .from("crm_records")
      .update({
        sdr_user_id: data.session.user.id,
        owner_user_id: data.session.user.id,
        updated_at: nowIso,
      })
      .eq("organization_id", data.organization.id)
      .eq("id", context.lead.id)
      .is("sdr_user_id", null)
      .select("id")
      .maybeSingle();

    if (assignment.error) {
      setError(assignment.error.message);
      setBusy("");
      return;
    }
    if (!assignment.data) {
      setError(
        "O lead foi assumido por outro SDR. A fila será atualizada para evitar conflito.",
      );
      setBusy("");
      await reload();
      return;
    }

    if (!context.nextPendingAction && context.recommendation.scheduledAt) {
      const scheduled = await client.from("crm_actions").insert({
        organization_id: data.organization.id,
        crm_record_id: context.lead.id,
        action_type: "tarefa",
        channel: context.recommendation.channel,
        subject: context.recommendation.title,
        scheduled_at: context.recommendation.scheduledAt,
        action_status: "pendente",
        assigned_to: data.session.user.id,
        created_by: data.session.user.id,
        metadata: {
          sdr_cadence: true,
          source: "sdr_workbench",
          no_external_delivery: true,
        },
      });
      if (scheduled.error) {
        setError(
          `Lead atribuído, mas a tarefa não foi criada: ${scheduled.error.message}`,
        );
      } else {
        await client
          .from("crm_records")
          .update({
            next_action_at: context.recommendation.scheduledAt,
            updated_at: nowIso,
          })
          .eq("organization_id", data.organization.id)
          .eq("id", context.lead.id);
      }
    }

    setFeedback(
      "Lead atribuído e próxima tarefa preparada. Nenhuma mensagem foi enviada.",
    );
    setBusy("");
    await reload();
  }

  async function scheduleRecommendation(context: SdrLeadContext) {
    clearMessages();
    if (!context.lead.sdr_user_id) {
      setError("Assuma o lead antes de preparar a cadência.");
      return;
    }
    if (context.lead.sdr_user_id !== data.session.user.id) {
      setError(`A cadência está sob responsabilidade de ${context.sdrName}.`);
      return;
    }
    if (!context.recommendation.scheduledAt) {
      setError(
        "Esta recomendação exige decisão humana e não pode ser agendada automaticamente.",
      );
      return;
    }
    if (context.nextPendingAction) {
      setError("Já existe uma tarefa pendente para este lead.");
      return;
    }

    const client = getSupabase();
    if (!client) return;
    setBusy(`schedule-${context.lead.id}`);
    const assignedTo =
      context.lead.sdr_user_id || data.session.user.id;
    const task = await client.from("crm_actions").insert({
      organization_id: data.organization.id,
      crm_record_id: context.lead.id,
      action_type: "tarefa",
      channel: context.recommendation.channel,
      subject: context.recommendation.title,
      scheduled_at: context.recommendation.scheduledAt,
      action_status: "pendente",
      assigned_to: assignedTo,
      created_by: data.session.user.id,
      metadata: {
        sdr_cadence: true,
        source: "sdr_workbench",
        recommendation_kind: context.recommendation.kind,
        no_external_delivery: true,
      },
    });

    if (task.error) {
      setError(task.error.message);
      setBusy("");
      return;
    }

    const leadUpdate = await client
      .from("crm_records")
      .update({
        next_action_at: context.recommendation.scheduledAt,
        updated_at: new Date().toISOString(),
      })
      .eq("organization_id", data.organization.id)
      .eq("id", context.lead.id);
    if (leadUpdate.error) setError(leadUpdate.error.message);
    else
      setFeedback(
        "Tarefa adicionada à cadência. O contato externo continua sujeito à ação do SDR.",
      );
    setBusy("");
    await reload();
  }

  async function registerAttempt(context: SdrLeadContext) {
    clearMessages();
    if (!context.lead.sdr_user_id) {
      setError("Assuma o lead antes de registrar uma tentativa.");
      return;
    }
    if (context.lead.sdr_user_id !== data.session.user.id) {
      setError(
        `Somente ${context.sdrName} pode registrar uma tentativa nesta carteira.`,
      );
      return;
    }
    if (
      !context.lead.phone &&
      !context.lead.email &&
      !context.contact?.phone &&
      !context.contact?.email
    ) {
      setError("Complete o telefone ou e-mail antes de registrar a tentativa.");
      return;
    }

    const client = getSupabase();
    if (!client) return;
    setBusy(`attempt-${context.lead.id}`);
    const registeredAt = new Date();
    const nowIso = registeredAt.toISOString();
    const channel = context.recommendation.channel === "cadastro"
      ? "whatsapp"
      : context.recommendation.channel;
    const attemptNumber = Number(context.lead.attempts || 0) + 1;

    const activityPayload = {
      action_type: actionTypeFor(channel),
      channel,
      completed_at: nowIso,
      action_status: "concluida" as const,
      outcome,
      assigned_to: data.session.user.id,
      metadata: {
        ...(context.nextPendingAction?.metadata || {}),
        sdr_cadence: true,
        source: "sdr_workbench",
        attempt_number: attemptNumber,
        no_external_delivery: true,
      },
    };
    const activity = context.nextPendingAction
      ? await client
          .from("crm_actions")
          .update(activityPayload)
          .eq("organization_id", data.organization.id)
          .eq("id", context.nextPendingAction.id)
      : await client.from("crm_actions").insert({
          organization_id: data.organization.id,
          crm_record_id: context.lead.id,
          subject: `${attemptNumber}ª tentativa SDR · ${outcomeLabels[outcome]}`,
          scheduled_at: nowIso,
          created_by: data.session.user.id,
          ...activityPayload,
        });
    if (activity.error) {
      setError(activity.error.message);
      setBusy("");
      return;
    }

    const remainingPending = context.pendingActions.filter(
      (item) => item.id !== context.nextPendingAction?.id,
    );
    const followUp =
      remainingPending.length === 0
        ? followUpForOutcome(outcome, attemptNumber, registeredAt)
        : null;
    const nextScheduledAt =
      remainingPending[0]?.scheduled_at || followUp?.scheduledAt || null;
    const update = await client
      .from("crm_records")
      .update({
        sdr_user_id: context.lead.sdr_user_id || data.session.user.id,
        owner_user_id: context.lead.owner_user_id || data.session.user.id,
        last_contact_at: nowIso,
        first_response_at: context.lead.first_response_at || nowIso,
        attempts: attemptNumber,
        stagnation_at: nowIso,
        next_action_at: nextScheduledAt,
        priority:
          outcome === "interessado" ||
          outcome === "visita_agendada" ||
          outcome === "proposta_solicitada"
            ? "alta"
            : context.lead.priority || "normal",
        temperature:
          outcome === "interessado" ||
          outcome === "visita_agendada" ||
          outcome === "proposta_solicitada"
            ? "quente"
            : context.lead.temperature || "morno",
        updated_at: nowIso,
      })
      .eq("organization_id", data.organization.id)
      .eq("id", context.lead.id);

    if (update.error) {
      setError(
        `A atividade foi registrada, mas o lead não foi atualizado: ${update.error.message}`,
      );
      setBusy("");
      await reload();
      return;
    }

    let followUpFailed = false;
    if (followUp) {
      const nextTask = await client.from("crm_actions").insert({
        organization_id: data.organization.id,
        crm_record_id: context.lead.id,
        action_type: "tarefa",
        channel,
        subject: followUp.subject,
        scheduled_at: followUp.scheduledAt,
        action_status: "pendente",
        assigned_to: data.session.user.id,
        created_by: data.session.user.id,
        metadata: {
          sdr_cadence: true,
          source: "sdr_workbench",
          previous_outcome: outcome,
          no_external_delivery: true,
        },
      });
      if (nextTask.error) {
        followUpFailed = true;
        setError(
          `Tentativa registrada, mas o próximo passo não foi agendado: ${nextTask.error.message}`,
        );
      }
    }

    if (!followUpFailed) {
      setFeedback(
        followUp
          ? `Tentativa registrada e próxima tarefa programada para ${formatDate(followUp.scheduledAt)}.`
          : remainingPending.length
            ? "Tentativa registrada. A próxima tarefa já existente foi preservada, sem duplicação."
            : "Tentativa registrada. A cadência foi encerrada para revisão humana.",
      );
    }
    setBusy("");
    await reload();
  }

  const unanswered = contexts.filter(
    (item) => !item.lead.first_response_at,
  ).length;
  const mine = contexts.filter(
    (item) => item.lead.sdr_user_id === data.session.user.id,
  ).length;
  const overdue = contexts.filter(
    (item) =>
      (item.lead.sla_due_at && new Date(item.lead.sla_due_at) < now) ||
      (item.nextPendingAction?.scheduled_at &&
        new Date(item.nextPendingAction.scheduled_at) < now),
  ).length;
  const actionsToday = crm.actions.filter(
    (item) =>
      item.created_by === data.session.user.id &&
      item.action_status === "concluida" &&
      new Date(item.created_at).toDateString() === now.toDateString(),
  ).length;

  return (
    <div className="crm5-stack sdr67">
      <CrmSectionHeader
        eyebrow="MESA DE PRÉ-VENDAS"
        title="SDR contextual e cadência assistida"
        description="Prioridade calculada pelo CRM, próxima melhor ação e histórico completo — sem disparos externos automáticos."
        actions={
          <button onClick={() => openActivity(selected?.lead)}>
            + Atividade manual
          </button>
        }
      />
      {(feedback || error) && (
        <button
          className={`sdr67-feedback ${error ? "error" : ""}`}
          onClick={() => {
            setFeedback("");
            setError("");
          }}
        >
          {error || feedback}
          <span>×</span>
        </button>
      )}
      <section className="crm5-kpis four">
        <CrmKpi
          label="Sem primeira abordagem"
          value={unanswered}
          detail="Priorizados por SLA e contexto"
          tone={unanswered ? "red" : "green"}
        />
        <CrmKpi
          label="Minha carteira"
          value={mine}
          detail="Leads sob sua responsabilidade"
          tone="blue"
        />
        <CrmKpi
          label="SLA ou tarefa vencida"
          value={overdue}
          detail="Exigem atuação imediata"
          tone={overdue ? "orange" : "green"}
        />
        <CrmKpi
          label="Interações hoje"
          value={actionsToday}
          detail="Atividades concluídas e registradas"
          tone="lime"
        />
      </section>

      <section className="sdr67-toolbar" aria-label="Filtros da fila SDR">
        {(
          [
            ["priority", "Prioridade automática"],
            ["unanswered", "Sem abordagem"],
            ["mine", "Minha carteira"],
            ["overdue", "Vencidos"],
          ] as Array<[QueueFilter, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            className={filter === value ? "active" : ""}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
        <span>{queue.length} lead(s)</span>
      </section>

      <div className="sdr67-workspace">
        <section className="crm5-panel sdr67-queue-panel">
          <header>
            <div>
              <small>FILA INTELIGENTE</small>
              <h3>Ordem recomendada de atuação</h3>
            </div>
          </header>
          <div className="sdr67-queue">
            {queue.map((context, index) => (
              <button
                key={context.lead.id}
                className={
                  selected?.lead.id === context.lead.id ? "active" : ""
                }
                onClick={() => setSelectedId(context.lead.id)}
              >
                <b className="sdr67-position">{index + 1}</b>
                <div>
                  <strong>{context.lead.person_name}</strong>
                  <small>
                    {context.projectName} · {context.stage?.name || context.lead.stage}
                  </small>
                  <span>{context.recommendation.title}</span>
                </div>
                <div className="sdr67-priority">
                  <strong>{context.priorityScore}</strong>
                  <Status tone={priorityTone(context.priorityLabel)}>
                    {context.priorityLabel}
                  </Status>
                </div>
              </button>
            ))}
            {!queue.length && (
              <EmptyState
                title="Fila sem itens"
                text="Nenhum lead corresponde ao filtro selecionado."
              />
            )}
          </div>
        </section>

        <section className="crm5-panel sdr67-context-panel">
          {selected ? (
            <>
              <header className="sdr67-context-header">
                <div>
                  <small>CONTEXTO 360° DO CRM</small>
                  <h3>{selected.lead.person_name}</h3>
                  <p>
                    {selected.lead.phone ||
                      selected.contact?.phone ||
                      "Telefone não informado"}{" "}
                    ·{" "}
                    {selected.lead.email ||
                      selected.contact?.email ||
                      "E-mail não informado"}
                  </p>
                </div>
                <Status tone={priorityTone(selected.priorityLabel)}>
                  Prioridade {selected.priorityLabel.toLowerCase()} ·{" "}
                  {selected.priorityScore}
                </Status>
              </header>

              <div className="sdr67-context-grid">
                <article>
                  <small>Interesse</small>
                  <strong>{selected.projectName}</strong>
                  <span>
                    Área{" "}
                    {selected.lead.preferred_area_min
                      ? `${selected.lead.preferred_area_min}–${selected.lead.preferred_area_max || "?"} m²`
                      : "não definida"}
                    {" · "}
                    {selected.lead.financing_interest
                      ? "com interesse em financiamento"
                      : "financiamento não sinalizado"}
                  </span>
                </article>
                <article>
                  <small>Origem e campanha</small>
                  <strong>
                    {selected.campaign?.name ||
                      selected.lead.utm_campaign ||
                      "Sem campanha"}
                  </strong>
                  <span>
                    {selected.lead.source ||
                      selected.lead.source_channel ||
                      "Origem não informada"}
                    {selected.lead.utm_source
                      ? ` · UTM ${selected.lead.utm_source}`
                      : ""}
                  </span>
                </article>
                <article>
                  <small>Etapa e responsáveis</small>
                  <strong>{selected.stage?.name || selected.lead.stage}</strong>
                  <span>
                    Titular: {selected.ownerName} · SDR: {selected.sdrName} ·
                    Corretor: {selected.brokerName}
                  </span>
                </article>
                <article>
                  <small>Última interação</small>
                  <strong>
                    {selected.lastInteraction?.subject || "Sem interação"}
                  </strong>
                  <span>
                    {formatDate(
                      selected.lastInteraction?.completed_at ||
                        selected.lead.last_contact_at,
                    )}
                    {selected.lastInteraction?.outcome
                      ? ` · ${selected.lastInteraction.outcome.replaceAll("_", " ")}`
                      : ""}
                  </span>
                </article>
              </div>

              {selected.lead.notes && (
                <aside className="sdr67-notes">
                  <small>OBSERVAÇÕES DO LEAD</small>
                  <p>{selected.lead.notes}</p>
                </aside>
              )}

              <section className="sdr67-next-action">
                <div>
                  <small>PRÓXIMA MELHOR AÇÃO</small>
                  <h4>{selected.recommendation.title}</h4>
                  <p>{selected.recommendation.reason}</p>
                  <span>
                    Canal sugerido:{" "}
                    <b>{selected.recommendation.channel}</b>
                    {selected.recommendation.scheduledAt
                      ? ` · ${formatDate(selected.recommendation.scheduledAt)}`
                      : ""}
                  </span>
                </div>
                <div>
                  {!selected.lead.sdr_user_id && (
                    <button
                      disabled={Boolean(busy)}
                      onClick={() => claim(selected)}
                    >
                      {busy === `claim-${selected.lead.id}`
                        ? "Atribuindo..."
                        : "Assumir e preparar"}
                    </button>
                  )}
                  {selected.recommendation.canAutomateTask &&
                    !selected.nextPendingAction &&
                    selected.lead.sdr_user_id === data.session.user.id && (
                      <button
                        disabled={Boolean(busy)}
                        onClick={() => scheduleRecommendation(selected)}
                      >
                        {busy === `schedule-${selected.lead.id}`
                          ? "Agendando..."
                          : "Agendar recomendação"}
                      </button>
                    )}
                  <button
                    className="primary"
                    disabled={Boolean(busy)}
                    onClick={() => openActivity(selected.lead)}
                  >
                    Abrir atividade
                  </button>
                </div>
              </section>

              <section className="sdr67-attempt">
                <div>
                  <small>REGISTRO RÁPIDO E SEGURO</small>
                  <strong>Resultado da tentativa</strong>
                  <span>
                    Registra no histórico e cria o próximo passo. Não envia
                    WhatsApp ou e-mail.
                  </span>
                </div>
                <select
                  value={outcome}
                  disabled={
                    selected.lead.sdr_user_id !== data.session.user.id
                  }
                  onChange={(event) =>
                    setOutcome(event.target.value as SdrOutcome)
                  }
                >
                  {Object.entries(outcomeLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <button
                  className="primary"
                  disabled={
                    Boolean(busy) ||
                    selected.lead.sdr_user_id !== data.session.user.id
                  }
                  onClick={() => registerAttempt(selected)}
                >
                  {busy === `attempt-${selected.lead.id}`
                    ? "Registrando..."
                    : selected.lead.sdr_user_id === data.session.user.id
                      ? "Registrar e cadenciar"
                      : "Assuma o lead primeiro"}
                </button>
              </section>

              <div className="sdr67-bottom-grid">
                <section>
                  <header>
                    <small>TAREFAS</small>
                    <strong>{selected.pendingActions.length} pendente(s)</strong>
                  </header>
                  <div>
                    {selected.pendingActions.slice(0, 4).map((action) => (
                      <article key={action.id}>
                        <Status
                          tone={
                            action.scheduled_at &&
                            new Date(action.scheduled_at) < now
                              ? "danger"
                              : "info"
                          }
                        >
                          {action.channel || action.action_type}
                        </Status>
                        <div>
                          <strong>{action.subject}</strong>
                          <small>{formatDate(action.scheduled_at)}</small>
                        </div>
                      </article>
                    ))}
                    {!selected.pendingActions.length && (
                      <span className="sdr67-muted">
                        Nenhuma tarefa pendente.
                      </span>
                    )}
                  </div>
                </section>
                <section>
                  <header>
                    <small>HISTÓRICO</small>
                    <strong>
                      {selected.completedActions.length} interação(ões)
                    </strong>
                  </header>
                  <div>
                    {selected.completedActions.slice(0, 5).map((action) => (
                      <article key={action.id}>
                        <Status tone="success">
                          {action.channel || action.action_type}
                        </Status>
                        <div>
                          <strong>{action.subject}</strong>
                          <small>
                            {formatDate(action.completed_at)}
                            {action.outcome
                              ? ` · ${action.outcome.replaceAll("_", " ")}`
                              : ""}
                          </small>
                        </div>
                      </article>
                    ))}
                    {!selected.completedActions.length && (
                      <span className="sdr67-muted">
                        O lead ainda não possui histórico.
                      </span>
                    )}
                  </div>
                </section>
              </div>

              <footer className="sdr67-signals">
                <small>Fatores de prioridade:</small>
                {selected.priorityReasons.map((reason) => (
                  <span key={reason}>{reason}</span>
                ))}
                {!selected.priorityReasons.length && (
                  <span>sem fator extraordinário</span>
                )}
              </footer>
            </>
          ) : (
            <EmptyState
              title="Sem leads em aberto"
              text="A mesa SDR será preenchida quando novos leads entrarem no CRM."
            />
          )}
        </section>
      </div>
    </div>
  );
}
