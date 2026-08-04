"use client";

import { useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ErpData } from "../types";
import type {
  CrmAssignmentRole,
  CrmAssignmentStatus,
  CrmEnterpriseData,
  CrmLeadAssignment,
} from "./types";
import type { SdrLeadContext } from "./sdr-engine";
import { Status } from "./shared";

const activeStatuses: CrmAssignmentStatus[] = [
  "atribuida",
  "aceita",
  "em_atendimento",
];

const statusLabels: Record<CrmAssignmentStatus, string> = {
  atribuida: "Aguardando aceite",
  aceita: "Aceita",
  em_atendimento: "Em atendimento",
  concluida: "Concluída",
  recusada: "Recusada",
  cancelada: "Cancelada",
  substituida: "Substituída",
};

const roleLabels: Record<CrmAssignmentRole, string> = {
  sdr: "SDR",
  corretor: "Corretor",
};

const directorBriefPrompts = [
  "Objetivo do contato",
  "Condição comercial sensível",
  "Objeção que exige cuidado",
  "Resultado esperado",
] as const;

function dateTimeLocal(hoursAhead: number) {
  const value = new Date(Date.now() + hoursAhead * 60 * 60 * 1000);
  value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
  return value.toISOString().slice(0, 16);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Sem prazo";
  return new Date(value).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function assignmentTone(assignment: CrmLeadAssignment) {
  if (
    activeStatuses.includes(assignment.status) &&
    assignment.due_at &&
    new Date(assignment.due_at) < new Date()
  ) {
    return "danger";
  }
  if (assignment.status === "concluida") return "success";
  if (assignment.priority === "urgente") return "danger";
  if (assignment.priority === "alta") return "warning";
  return "info";
}

function asTextList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function SdrAssignmentPanel({
  data,
  crm,
  selected,
  can,
  reload,
}: {
  data: ErpData;
  crm: CrmEnterpriseData;
  selected: SdrLeadContext | null;
  can: (permission: string) => boolean;
  reload: () => Promise<void>;
}) {
  const [assignmentRole, setAssignmentRole] =
    useState<CrmAssignmentRole>("sdr");
  const [assignedUserId, setAssignedUserId] = useState("");
  const [priority, setPriority] = useState<"normal" | "alta" | "urgente">(
    "alta",
  );
  const [dueAt, setDueAt] = useState(() => dateTimeLocal(2));
  const [briefDraft, setBriefDraft] = useState({ leadId: "", text: "" });
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const canAssign = can("crm.assign");
  const canSupervise = can("crm.monitor_team") || canAssign;
  const selectedLeadId = selected?.lead.id || "";
  const instructions =
    briefDraft.leadId === selectedLeadId ? briefDraft.text : "";

  function setInstructions(
    next: string | ((current: string) => string),
  ) {
    setBriefDraft((current) => {
      const currentText =
        current.leadId === selectedLeadId ? current.text : "";
      const value =
        typeof next === "function" ? next(currentText) : next;
      return { leadId: selectedLeadId, text: value.slice(0, 4000) };
    });
  }

  const profileName = (userId: string) =>
    data.profiles.find((profile) => profile.id === userId)?.full_name ||
    data.members.find((member) => member.user_id === userId)?.role ||
    "Usuário";

  const candidates = useMemo(() => {
    const roleTeamIds = new Set(
      crm.teams
        .filter((team) => {
          if (!team.active) return false;
          const teamType = team.team_type.toLowerCase();
          return assignmentRole === "sdr"
            ? ["sdr", "pre_vendas", "pre-vendas"].includes(teamType)
            : ["corretor", "corretores", "vendas", "comercial"].includes(
                teamType,
              );
        })
        .map((team) => team.id),
    );
    const teamUsers = new Set(
      crm.teamMembers
        .filter(
          (member) =>
            member.active &&
            (roleTeamIds.has(member.team_id) ||
              member.team_role.toLowerCase().includes(assignmentRole)),
        )
        .map((member) => member.user_id),
    );
    return data.members.filter(
      (member) =>
        member.active &&
        (member.role === assignmentRole || teamUsers.has(member.user_id)),
    );
  }, [assignmentRole, crm.teamMembers, crm.teams, data.members]);

  const effectiveAssignedUserId = candidates.some(
    (candidate) => candidate.user_id === assignedUserId,
  )
    ? assignedUserId
    : candidates[0]?.user_id || "";

  const leadAssignments = selected
    ? crm.assignments.filter(
        (assignment) => assignment.crm_record_id === selected.lead.id,
      )
    : [];
  const activeAssignments = crm.assignments.filter((assignment) =>
    activeStatuses.includes(assignment.status),
  );
  const myAssignments = activeAssignments.filter(
    (assignment) => assignment.assigned_user_id === data.session.user.id,
  );
  const overdueAssignments = activeAssignments.filter(
    (assignment) =>
      assignment.due_at && new Date(assignment.due_at) < new Date(),
  );
  const openAssignmentAlerts = crm.alerts.filter(
    (alert) =>
      alert.status !== "resolvido" &&
      alert.assigned_to === data.session.user.id &&
      (!selected || alert.crm_record_id === selected.lead.id),
  );

  function clearMessages() {
    setMessage("");
    setError("");
  }

  function addBriefPrompt(prompt: string) {
    setInstructions((current) => {
      const prefix = current.trim() ? `${current.trim()}\n` : "";
      return `${prefix}${prompt}: `;
    });
  }

  async function assignLead() {
    clearMessages();
    if (!selected || !effectiveAssignedUserId || !dueAt) {
      setError("Selecione o profissional e defina o prazo de atendimento.");
      return;
    }
    const client = getSupabase();
    if (!client) return;
    setBusy("assign");
    try {
      const result = await client.rpc("assign_crm_record", {
        p_crm_record_id: selected.lead.id,
        p_assignment_role: assignmentRole,
        p_assigned_user_id: effectiveAssignedUserId,
        p_priority: priority,
        p_due_at: new Date(dueAt).toISOString(),
        p_instructions: instructions.trim() || null,
      });
      if (result.error) throw result.error;
      setMessage(
        `${roleLabels[assignmentRole]} designado. A atividade, o alerta e o insight de abordagem foram enviados ao profissional.`,
      );
      setInstructions("");
      await reload();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível concluir a designação.",
      );
    } finally {
      setBusy("");
    }
  }

  async function changeStatus(
    assignment: CrmLeadAssignment,
    nextStatus: CrmAssignmentStatus,
  ) {
    clearMessages();
    const client = getSupabase();
    if (!client) return;
    setBusy(`${assignment.id}-${nextStatus}`);
    try {
      const result = await client.rpc("set_crm_assignment_status", {
        p_assignment_id: assignment.id,
        p_status: nextStatus,
      });
      if (result.error) throw result.error;
      setMessage(
        nextStatus === "concluida"
          ? "Atendimento concluído e supervisão atualizada."
          : nextStatus === "em_atendimento"
            ? "Atendimento iniciado. O diretor poderá acompanhar o SLA."
            : "Designação aceita e registrada na agenda.",
      );
      await reload();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível atualizar a designação.",
      );
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      {(message || error) && (
        <div
          className={`sdr67-feedback ${error ? "error" : ""}`}
          role={error ? "alert" : "status"}
        >
          <span>{error || message}</span>
          <button
            type="button"
            aria-label="Fechar aviso"
            onClick={clearMessages}
          >
            ×
          </button>
        </div>
      )}

      {canSupervise && (
        <section className="crm5-panel sdr67-supervision">
          <header>
            <div>
              <small>CONTROLE DA DIREÇÃO COMERCIAL</small>
              <h3>Designações, aceite e SLA</h3>
              <p>
                Acompanhe quem recebeu cada atendimento e intervenha antes do
                vencimento.
              </p>
            </div>
            <div className="sdr67-supervision-kpis">
              <span>
                <b>{activeAssignments.length}</b> ativas
              </span>
              <span>
                <b>
                  {
                    activeAssignments.filter(
                      (assignment) => assignment.status === "atribuida",
                    ).length
                  }
                </b>{" "}
                sem aceite
              </span>
              <span className={overdueAssignments.length ? "late" : ""}>
                <b>{overdueAssignments.length}</b> vencidas
              </span>
            </div>
          </header>
          <div className="sdr67-supervision-list">
            {activeAssignments.slice(0, 6).map((assignment) => {
              const lead = crm.records.find(
                (record) => record.id === assignment.crm_record_id,
              );
              return (
                <article key={assignment.id}>
                  <Status tone={assignmentTone(assignment)}>
                    {statusLabels[assignment.status]}
                  </Status>
                  <div>
                    <strong>{lead?.person_name || "Lead não localizado"}</strong>
                    <small>
                      {roleLabels[assignment.assignment_role]} ·{" "}
                      {profileName(assignment.assigned_user_id)}
                    </small>
                  </div>
                  <time>{formatDate(assignment.due_at)}</time>
                </article>
              );
            })}
            {!activeAssignments.length && (
              <span className="sdr67-muted">
                Nenhuma designação ativa neste momento.
              </span>
            )}
          </div>
        </section>
      )}

      <section className="crm5-panel sdr67-assignment-panel">
        <header>
          <div>
            <small>DESIGNAÇÃO FORMAL E AGENDA</small>
            <h3>
              {selected
                ? `Atendimento de ${selected.lead.person_name}`
                : "Selecione um lead"}
            </h3>
            <p>
              O profissional recebe atividade, alerta, prazo e orientação de
              abordagem no próprio sistema.
            </p>
          </div>
          {!canSupervise && (
            <div className="sdr67-personal-summary">
              <b>{myAssignments.length}</b>
              <span>designação(ões) na sua agenda</span>
            </div>
          )}
        </header>

        {canAssign && selected && (
          <div className="sdr67-assignment-console">
            <div className="sdr67-assignment-fields">
              <label>
                Função
                <select
                  value={assignmentRole}
                  onChange={(event) => {
                    const nextRole = event.target.value as CrmAssignmentRole;
                    setAssignmentRole(nextRole);
                    setAssignedUserId("");
                    setDueAt(dateTimeLocal(nextRole === "sdr" ? 2 : 24));
                  }}
                >
                  <option value="sdr">SDR</option>
                  <option value="corretor">Corretor</option>
                </select>
              </label>
              <label>
                Profissional
                <select
                  value={effectiveAssignedUserId}
                  onChange={(event) => setAssignedUserId(event.target.value)}
                >
                  {!candidates.length && (
                    <option value="">Nenhum profissional elegível</option>
                  )}
                  {candidates.map((candidate) => (
                    <option key={candidate.user_id} value={candidate.user_id}>
                      {profileName(candidate.user_id)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Prioridade
                <select
                  value={priority}
                  onChange={(event) =>
                    setPriority(
                      event.target.value as "normal" | "alta" | "urgente",
                    )
                  }
                >
                  <option value="normal">Normal</option>
                  <option value="alta">Alta</option>
                  <option value="urgente">Urgente</option>
                </select>
              </label>
              <label>
                Prazo do atendimento
                <input
                  type="datetime-local"
                  value={dueAt}
                  min={dateTimeLocal(0)}
                  onChange={(event) => setDueAt(event.target.value)}
                />
              </label>
            </div>

            <section className="sdr67-arisa-brief">
              <header>
                <span className="sdr67-arisa-mark" aria-hidden="true">✦</span>
                <div>
                  <small>BRIEFING INTELIGENTE · ARISA</small>
                  <h4>Contexto da direção para este atendimento</h4>
                  <p>
                    Registre o objetivo executivo. A Arisa o combinará com o
                    histórico do lead para montar abordagem, perguntas e sequência.
                  </p>
                </div>
                <span className="sdr67-human-review">Revisão humana</span>
              </header>
              <div
                className="sdr67-arisa-signals"
                role="group"
                aria-label="Contexto atual do lead"
              >
                <span><small>Criticidade</small><b>{selected.priorityLabel}</b></span>
                <span><small>Etapa</small><b>{selected.stage?.name || selected.lead.stage}</b></span>
                <span><small>Próxima ação</small><b>{selected.recommendation.title}</b></span>
              </div>
              <label>
                Orientação estratégica opcional
                <textarea
                  rows={5}
                  maxLength={4000}
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  placeholder="Ex.: priorizar entendimento da necessidade, confirmar prazo de decisão e evitar prometer condição comercial antes da validação da diretoria."
                />
                <span>{instructions.length}/4.000 caracteres</span>
              </label>
              <div className="sdr67-brief-prompts">
                <small>Estruture rapidamente:</small>
                {directorBriefPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => addBriefPrompt(prompt)}
                  >
                    + {prompt}
                  </button>
                ))}
              </div>
              <footer>
                <p>
                  O insight é interno, não envia mensagens automaticamente e
                  deve ser validado pelo profissional antes do contato.
                </p>
                <button
                  type="button"
                  className="primary"
                  disabled={busy === "assign" || !effectiveAssignedUserId}
                  aria-busy={busy === "assign"}
                  onClick={assignLead}
                >
                  {busy === "assign" ? "Preparando insight..." : "Designar com insight da Arisa"}
                </button>
              </footer>
            </section>
          </div>
        )}

        {selected && (
          <div className="sdr67-assignment-list">
            {leadAssignments.slice(0, 4).map((assignment) => {
              const guidance = assignment.guidance || {};
              const questions = asTextList(guidance.questions);
              const nextSteps = asTextList(guidance.next_steps);
              const cautions = asTextList(guidance.cautions);
              const isMine =
                assignment.assigned_user_id === data.session.user.id;
              return (
                <article key={assignment.id}>
                  <header>
                    <div>
                      <Status tone={assignmentTone(assignment)}>
                        {statusLabels[assignment.status]}
                      </Status>
                      <strong>
                        {roleLabels[assignment.assignment_role]} ·{" "}
                        {profileName(assignment.assigned_user_id)}
                      </strong>
                    </div>
                    <time>Prazo {formatDate(assignment.due_at)}</time>
                  </header>
                  {assignment.instructions && (
                    <p className="sdr67-director-note">
                      <b>Contexto informado pela direção</b>
                      <span>{assignment.instructions}</span>
                    </p>
                  )}
                  <section className="sdr67-guidance">
                    <small>✦ INSIGHT DA ARISA PARA O DESIGNADO</small>
                    <h4>
                      {guidance.headline ||
                        guidance.objective ||
                        "Conduzir o próximo contato com contexto"}
                    </h4>
                    <p>
                      {guidance.approach ||
                        guidance.objective ||
                        "Revise o histórico, confirme a necessidade atual e registre o próximo passo no CRM."}
                    </p>
                    {guidance.opening_suggestion && (
                      <blockquote>{guidance.opening_suggestion}</blockquote>
                    )}
                    {(questions.length > 0 || nextSteps.length > 0) && (
                      <div>
                        {questions.length > 0 && (
                          <span>
                            <b>Perguntas sugeridas</b>
                            {questions.slice(0, 3).join(" · ")}
                          </span>
                        )}
                        {nextSteps.length > 0 && (
                          <span>
                            <b>Sequência recomendada</b>
                            {nextSteps.slice(0, 3).join(" · ")}
                          </span>
                        )}
                      </div>
                    )}
                    <footer>
                      Canal sugerido: {guidance.recommended_channel || "a validar"}.
                      {cautions.length
                        ? ` Atenção: ${cautions.slice(0, 2).join(" · ")}`
                        : " Confirme as condições comerciais antes do contato."}
                    </footer>
                  </section>
                  {isMine && activeStatuses.includes(assignment.status) && (
                    <footer className="sdr67-assignment-actions">
                      {assignment.status === "atribuida" && (
                        <button
                          disabled={Boolean(busy)}
                          onClick={() => changeStatus(assignment, "aceita")}
                        >
                          Aceitar designação
                        </button>
                      )}
                      {assignment.status === "aceita" && (
                        <button
                          className="primary"
                          disabled={Boolean(busy)}
                          onClick={() =>
                            changeStatus(assignment, "em_atendimento")
                          }
                        >
                          Iniciar atendimento
                        </button>
                      )}
                      {assignment.status === "em_atendimento" && (
                        <button
                          className="primary"
                          disabled={Boolean(busy)}
                          onClick={() => changeStatus(assignment, "concluida")}
                        >
                          Concluir atendimento
                        </button>
                      )}
                    </footer>
                  )}
                </article>
              );
            })}
            {!leadAssignments.length && (
              <span className="sdr67-muted">
                Este lead ainda não possui designação formal.
              </span>
            )}
          </div>
        )}

        {openAssignmentAlerts.length > 0 && (
          <aside className="sdr67-assignment-alert">
            <b>{openAssignmentAlerts.length} alerta(s) exigem sua atenção</b>
            <span>
              {openAssignmentAlerts
                .slice(0, 2)
                .map((alert) => alert.title)
                .join(" · ")}
            </span>
          </aside>
        )}
      </section>
    </>
  );
}
