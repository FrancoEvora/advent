import type { Contact, CrmAction, CrmRecord, ErpData } from "../types";
import type {
  CrmCampaign,
  CrmEnterpriseData,
  CrmStage,
} from "./types";

const HOUR = 60 * 60 * 1000;

export type SdrOutcome =
  | "nao_atendeu"
  | "retornar"
  | "interessado"
  | "sem_interesse"
  | "visita_agendada"
  | "proposta_solicitada";

export type SdrRecommendationKind =
  | "complete_contact"
  | "first_contact"
  | "follow_up"
  | "execute_task"
  | "qualify"
  | "handoff"
  | "review";

export interface SdrRecommendation {
  kind: SdrRecommendationKind;
  title: string;
  reason: string;
  channel: string;
  scheduledAt: string | null;
  canAutomateTask: boolean;
}

export interface SdrLeadContext {
  lead: CrmRecord;
  contact: Contact | null;
  stage: CrmStage | null;
  campaign: CrmCampaign | null;
  projectName: string;
  ownerName: string;
  sdrName: string;
  brokerName: string;
  actions: CrmAction[];
  pendingActions: CrmAction[];
  completedActions: CrmAction[];
  lastInteraction: CrmAction | null;
  nextPendingAction: CrmAction | null;
  priorityScore: number;
  priorityLabel: "Crítica" | "Alta" | "Normal" | "Baixa";
  priorityReasons: string[];
  recommendation: SdrRecommendation;
}

function dateValue(value: string | null | undefined) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function profileName(data: ErpData, id: string | null | undefined) {
  if (!id) return "Não atribuído";
  const profile = data.profiles.find((item) => item.id === id);
  return profile?.full_name || profile?.email || "Usuário sem nome";
}

function actionMoment(action: CrmAction) {
  return dateValue(
    action.completed_at || action.scheduled_at || action.created_at,
  );
}

function channelFor(lead: CrmRecord, contact: Contact | null, attempt: number) {
  const hasPhone = Boolean(lead.phone || contact?.phone);
  const hasEmail = Boolean(lead.email || contact?.email);

  if (hasPhone && hasEmail) {
    return ["whatsapp", "telefone", "email"][attempt % 3];
  }
  if (hasPhone) return attempt % 2 === 0 ? "whatsapp" : "telefone";
  if (hasEmail) return "email";
  return "cadastro";
}

function nextBusinessMoment(from: Date, delayHours: number) {
  const next = new Date(from.getTime() + delayHours * HOUR);
  const startHour = 8;
  const startMinute = 30;
  const endHour = 18;

  if (next.getDay() === 0) next.setDate(next.getDate() + 1);
  if (next.getDay() === 6) next.setDate(next.getDate() + 2);

  if (
    next.getHours() < startHour ||
    (next.getHours() === startHour && next.getMinutes() < startMinute)
  ) {
    next.setHours(startHour, startMinute, 0, 0);
  } else if (next.getHours() >= endHour) {
    next.setDate(next.getDate() + 1);
    if (next.getDay() === 6) next.setDate(next.getDate() + 2);
    if (next.getDay() === 0) next.setDate(next.getDate() + 1);
    next.setHours(startHour, startMinute, 0, 0);
  }

  return next;
}

export function cadenceDelayHours(attempts: number) {
  if (attempts <= 0) return 0;
  if (attempts === 1) return 4;
  if (attempts === 2) return 24;
  if (attempts === 3) return 48;
  return 72;
}

export function nextCadenceMoment(
  attempts: number,
  now = new Date(),
): string | null {
  if (attempts >= 5) return null;
  return nextBusinessMoment(now, cadenceDelayHours(attempts)).toISOString();
}

function buildRecommendation(
  lead: CrmRecord,
  contact: Contact | null,
  stage: CrmStage | null,
  pending: CrmAction[],
  completed: CrmAction[],
  now: Date,
): SdrRecommendation {
  const attempts = Number(lead.attempts || 0);
  const nextPending = pending[0];
  const hasContact = Boolean(
    lead.phone || lead.email || contact?.phone || contact?.email,
  );

  if (!hasContact) {
    return {
      kind: "complete_contact",
      title: "Completar telefone ou e-mail",
      reason:
        "O lead não possui um canal de contato válido. Corrija o cadastro antes da cadência.",
      channel: "cadastro",
      scheduledAt: null,
      canAutomateTask: false,
    };
  }

  if (nextPending) {
    return {
      kind: "execute_task",
      title: nextPending.subject,
      reason:
        !nextPending.scheduled_at
          ? "Há uma tarefa pendente sem horário definido."
          : dateValue(nextPending.scheduled_at) <= now.getTime()
            ? "Há uma tarefa vencida ou prevista para agora."
            : "A próxima tarefa da cadência já está programada.",
      channel:
        nextPending.channel || channelFor(lead, contact, Math.max(attempts, 0)),
      scheduledAt: nextPending.scheduled_at,
      canAutomateTask: false,
    };
  }

  const latestOutcome = completed[0]?.outcome;
  if (
    (latestOutcome === "interessado" ||
      latestOutcome === "visita_agendada" ||
      latestOutcome === "proposta_solicitada") &&
    !lead.broker_user_id &&
    Number(stage?.probability || lead.probability || 0) >= 40
  ) {
    return {
      kind: "handoff",
      title: "Encaminhar ao corretor",
      reason:
        "O interesse está qualificado e o lead ainda não possui corretor responsável.",
      channel: "interno",
      scheduledAt: null,
      canAutomateTask: false,
    };
  }

  if (attempts >= 5) {
    return {
      kind: "review",
      title: "Revisar continuidade da abordagem",
      reason:
        "A cadência segura chegou a cinco tentativas. A próxima decisão deve ser humana.",
      channel: "interno",
      scheduledAt: null,
      canAutomateTask: false,
    };
  }

  if (!lead.first_response_at) {
    return {
      kind: "first_contact",
      title: "Realizar primeiro contato",
      reason:
        "O lead ainda não possui primeira abordagem registrada no histórico.",
      channel: channelFor(lead, contact, attempts),
      scheduledAt: nextCadenceMoment(attempts, now),
      canAutomateTask: true,
    };
  }

  if (!lead.project_id || !lead.budget_max || !lead.preferred_area_min) {
    return {
      kind: "qualify",
      title: "Completar qualificação comercial",
      reason:
        "Empreendimento, orçamento ou área de interesse ainda estão incompletos.",
      channel: channelFor(lead, contact, attempts),
      scheduledAt: nextCadenceMoment(attempts, now),
      canAutomateTask: true,
    };
  }

  return {
    kind: "follow_up",
    title: "Fazer acompanhamento contextual",
    reason:
      "Retome o último contato considerando interesse, campanha, etapa e tarefas anteriores.",
    channel: channelFor(lead, contact, attempts),
    scheduledAt: nextCadenceMoment(attempts, now),
    canAutomateTask: true,
  };
}

function calculatePriority(
  lead: CrmRecord,
  pending: CrmAction[],
  lastInteraction: CrmAction | null,
  now: Date,
) {
  let score = Math.min(35, Math.max(0, Number(lead.lead_score || 0) * 0.35));
  const reasons: string[] = [];
  const nowMs = now.getTime();

  if (!lead.first_response_at) {
    score += 20;
    reasons.push("sem primeira abordagem");
  }
  if (lead.priority === "urgente") {
    score += 22;
    reasons.push("prioridade urgente");
  } else if (lead.priority === "alta") {
    score += 12;
    reasons.push("prioridade alta");
  }
  if (lead.temperature === "quente") {
    score += 12;
    reasons.push("lead quente");
  }
  if (lead.sla_due_at && dateValue(lead.sla_due_at) < nowMs) {
    const overdueHours = Math.max(
      1,
      (nowMs - dateValue(lead.sla_due_at)) / HOUR,
    );
    score += Math.min(25, 12 + overdueHours / 2);
    reasons.push("SLA vencido");
  }
  if (pending[0] && dateValue(pending[0].scheduled_at) <= nowMs) {
    score += 14;
    reasons.push("tarefa vencida");
  }

  const lastMoment =
    (lastInteraction ? actionMoment(lastInteraction) : 0) ||
    dateValue(lead.last_contact_at || lead.updated_at || lead.created_at);
  if (lastMoment) {
    const inactiveHours = (nowMs - lastMoment) / HOUR;
    if (inactiveHours >= 48) {
      score += Math.min(18, inactiveHours / 12);
      reasons.push("sem interação recente");
    } else if (inactiveHours >= 0 && inactiveHours < 2) {
      score -= 18;
      reasons.push("contato muito recente");
    }
  }

  if (!lead.phone && !lead.email) {
    score -= 20;
    reasons.push("cadastro sem contato");
  }
  if (Number(lead.attempts || 0) >= 5) {
    score -= 12;
    reasons.push("cadência concluída");
  }

  const normalized = Math.round(Math.min(100, Math.max(0, score)));
  const label: SdrLeadContext["priorityLabel"] =
    normalized >= 75
      ? "Crítica"
      : normalized >= 55
        ? "Alta"
        : normalized >= 30
          ? "Normal"
          : "Baixa";

  return { score: normalized, label, reasons: reasons.slice(0, 4) };
}

export function buildSdrContext(
  lead: CrmRecord,
  data: ErpData,
  crm: CrmEnterpriseData,
  now = new Date(),
): SdrLeadContext {
  const contact = lead.contact_id
    ? data.contacts.find((item) => item.id === lead.contact_id) || null
    : null;
  const stage =
    crm.stages.find(
      (item) => item.id === lead.stage_id || item.code === lead.stage,
    ) || null;
  const campaign =
    crm.campaigns.find((item) => item.id === lead.campaign_id) || null;
  const actions = crm.actions
    .filter((item) => item.crm_record_id === lead.id)
    .sort((a, b) => actionMoment(b) - actionMoment(a));
  const pendingActions = actions
    .filter((item) => item.action_status === "pendente")
    .sort((a, b) => {
      const aDate = a.scheduled_at
        ? dateValue(a.scheduled_at)
        : Number.POSITIVE_INFINITY;
      const bDate = b.scheduled_at
        ? dateValue(b.scheduled_at)
        : Number.POSITIVE_INFINITY;
      return aDate - bDate;
    });
  const completedActions = actions.filter(
    (item) => item.action_status === "concluida",
  );
  const lastInteraction = completedActions[0] || null;
  const priority = calculatePriority(
    lead,
    pendingActions,
    lastInteraction,
    now,
  );

  return {
    lead,
    contact,
    stage,
    campaign,
    projectName:
      data.projects.find((item) => item.id === lead.project_id)?.name ||
      "Empreendimento não definido",
    ownerName: profileName(data, lead.owner_user_id),
    sdrName: profileName(data, lead.sdr_user_id),
    brokerName: profileName(data, lead.broker_user_id),
    actions,
    pendingActions,
    completedActions,
    lastInteraction,
    nextPendingAction: pendingActions[0] || null,
    priorityScore: priority.score,
    priorityLabel: priority.label,
    priorityReasons: priority.reasons,
    recommendation: buildRecommendation(
      lead,
      contact,
      stage,
      pendingActions,
      completedActions,
      now,
    ),
  };
}

export function buildPrioritizedSdrQueue(
  data: ErpData,
  crm: CrmEnterpriseData,
  now = new Date(),
) {
  return crm.records
    .filter((item) => item.record_status === "aberta")
    .map((lead) => buildSdrContext(lead, data, crm, now))
    .sort((a, b) => {
      if (a.priorityScore !== b.priorityScore) {
        return b.priorityScore - a.priorityScore;
      }
      const aSla = a.lead.sla_due_at
        ? dateValue(a.lead.sla_due_at)
        : Number.POSITIVE_INFINITY;
      const bSla = b.lead.sla_due_at
        ? dateValue(b.lead.sla_due_at)
        : Number.POSITIVE_INFINITY;
      return aSla - bSla;
    });
}

export function followUpForOutcome(
  outcome: SdrOutcome,
  attemptsAfterRegistration: number,
  now = new Date(),
) {
  if (outcome === "sem_interesse" || attemptsAfterRegistration >= 5) {
    return null;
  }

  const delay =
    outcome === "proposta_solicitada"
      ? 4
      : outcome === "visita_agendada"
        ? 24
        : outcome === "interessado"
          ? 4
          : cadenceDelayHours(attemptsAfterRegistration);
  const subject =
    outcome === "proposta_solicitada"
      ? "Acompanhar elaboração da proposta"
      : outcome === "visita_agendada"
        ? "Confirmar visita e orientações"
        : outcome === "interessado"
          ? "Completar qualificação e encaminhamento"
          : `Cadência SDR · tentativa ${attemptsAfterRegistration + 1}`;

  return {
    subject,
    scheduledAt: nextBusinessMoment(now, delay).toISOString(),
  };
}
