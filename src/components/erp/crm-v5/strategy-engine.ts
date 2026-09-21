import type { CrmAction, CrmRecord, ErpData } from "../types";
import type { CrmEnterpriseData } from "./types";

export type StrategyUrgency = "critical" | "high" | "normal";
export type StrategyLevel = "alta" | "media" | "baixa";
export type ObjectionKey =
  | "preco"
  | "parcela"
  | "entrada"
  | "financiamento"
  | "localizacao"
  | "momento"
  | "confianca";

export const OBJECTION_LABELS: Record<ObjectionKey, string> = {
  preco: "Preço / valor",
  parcela: "Parcela",
  entrada: "Entrada",
  financiamento: "Financiamento",
  localizacao: "Localização / acesso",
  momento: "Momento de compra",
  confianca: "Confiança / segurança",
};

export interface LeadStrategyInsight {
  record: CrmRecord;
  score: number;
  level: StrategyLevel;
  action: {
    title: string;
    reason: string;
    urgency: StrategyUrgency;
  };
  offer: {
    title: string;
    reason: string;
  };
  objections: ObjectionKey[];
  drivers: string[];
  qualified: boolean;
  needsFirstResponse: boolean;
  overdue: boolean;
  brokerReady: boolean;
  staleDays: number | null;
  campaignLabel: string;
}

export interface CampaignStrategyInsight {
  key: string;
  label: string;
  leads: number;
  open: number;
  won: number;
  lost: number;
  hot: number;
  averageScore: number;
  closedConversion: number;
  pipeline: number;
}

export interface DailyStrategy {
  highPriority: number;
  immediateAction: number;
  brokerReady: number;
  financialObjection: number;
  reactivation: number;
  plan: string[];
}

const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const finite = (value: unknown, fallback = 0) => {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
};

const clamp = (value: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, value));

const dateValue = (value?: string | null) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

const hoursSince = (value: string | null | undefined, now: Date) => {
  const date = dateValue(value);
  if (!date) return null;
  return Math.max(0, (now.getTime() - date.getTime()) / 3_600_000);
};

const isPast = (value: string | null | undefined, now: Date) => {
  const date = dateValue(value);
  return Boolean(date && date.getTime() < now.getTime());
};

function actionsFor(recordId: string, actions: CrmAction[]) {
  return actions
    .filter((action) => action.crm_record_id === recordId)
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export function detectObjections(
  record: CrmRecord,
  actions: CrmAction[],
): ObjectionKey[] {
  const text = normalize(
    [
      record.notes,
      record.lost_reason,
      ...actions.flatMap((action) => [
        action.subject,
        action.notes,
        action.outcome,
      ]),
    ]
      .filter(Boolean)
      .join(" "),
  );

  const rules: Array<[ObjectionKey, RegExp]> = [
    ["preco", /\b(preco|valor|caro|cara|custo|muito alto|so para rico|so pra rico)\b/],
    ["parcela", /\b(parcela|parcelas|prestacao|mensalidade|mensal)\b/],
    ["entrada", /\b(entrada|sinal|ato)\b/],
    ["financiamento", /\b(financiamento|financiar|credito|banco|caixa)\b/],
    ["localizacao", /\b(localizacao|distancia|longe|acesso|estrada)\b/],
    ["momento", /\b(vou pensar|pensar|depois|mais tarde|agora nao|momento|futuro|esperar)\b/],
    ["confianca", /\b(confianca|seguranca|entrega|registro|documentacao|obra|prazo da obra)\b/],
  ];

  return rules
    .filter(([, pattern]) => pattern.test(text))
    .map(([key]) => key);
}

function qualification(record: CrmRecord) {
  const hasProject = Boolean(record.project_id);
  const hasBudget =
    finite(record.budget_max, 0) > 0 ||
    finite(record.payment_capacity, 0) > 0 ||
    finite(record.monthly_income, 0) > 0;
  const hasArea =
    finite(record.preferred_area_min, 0) > 0 ||
    finite(record.preferred_area_max, 0) > 0;
  return {
    hasProject,
    hasBudget,
    hasArea,
    complete: hasProject && hasBudget && hasArea,
  };
}

function scoreLead(
  record: CrmRecord,
  actions: CrmAction[],
  now: Date,
): { score: number; drivers: string[]; staleDays: number | null } {
  const drivers: string[] = [];
  const savedScore = finite(record.lead_score, -1);
  const probability = clamp(finite(record.probability));
  let score =
    savedScore >= 0
      ? savedScore * 0.68 + probability * 0.14 + 8
      : 32 + probability * 0.24;

  if (record.temperature === "quente") {
    score += 10;
    drivers.push("temperatura quente");
  } else if (record.temperature === "morno") {
    score += 5;
    drivers.push("temperatura morna");
  }

  if (record.priority === "urgente") {
    score += 7;
    drivers.push("prioridade urgente");
  } else if (record.priority === "alta") {
    score += 4;
    drivers.push("prioridade alta");
  }

  const q = qualification(record);
  if (q.hasProject) score += 2;
  if (q.hasBudget) score += 3;
  if (q.hasArea) score += 3;
  if (q.complete) drivers.push("perfil comercial qualificado");

  const firstResponseAge = hoursSince(record.created_at, now);
  if (!record.first_response_at) {
    score += firstResponseAge !== null && firstResponseAge >= 1 ? 7 : 3;
    drivers.push("primeira resposta pendente");
  } else {
    score += 2;
  }

  const lastReference =
    record.last_contact_at ||
    actions.find((action) => action.completed_at)?.completed_at ||
    record.created_at;
  const lastContactHours = hoursSince(lastReference, now);
  const staleDays =
    lastContactHours === null ? null : Math.floor(lastContactHours / 24);

  if (lastContactHours !== null && lastContactHours <= 48) {
    score += 4;
    drivers.push("interação recente");
  } else if (lastContactHours !== null && lastContactHours >= 168) {
    score += 5;
    drivers.push("lead sem contato há mais de 7 dias");
  }

  if (
    isPast(record.sla_due_at, now) ||
    isPast(record.next_action_at, now) ||
    actions.some(
      (action) =>
        action.action_status === "pendente" &&
        isPast(action.scheduled_at, now),
    )
  ) {
    score += 8;
    drivers.push("ação comercial vencida");
  }

  const attempts = finite(record.attempts);
  if (attempts >= 5) {
    score -= 5;
    drivers.push("cadência já extensa");
  }

  if (record.broker_user_id) {
    score += 2;
    drivers.push("corretor já atribuído");
  }

  return { score: Math.round(clamp(score)), drivers, staleDays };
}

function nextBestAction(
  record: CrmRecord,
  actions: CrmAction[],
  objections: ObjectionKey[],
  score: number,
  now: Date,
) {
  const overdueSla = isPast(record.sla_due_at, now);
  const overdueAction =
    isPast(record.next_action_at, now) ||
    actions.some(
      (action) =>
        action.action_status === "pendente" &&
        isPast(action.scheduled_at, now),
    );
  const q = qualification(record);
  const staleHours = hoursSince(
    record.last_contact_at || record.created_at,
    now,
  );

  if (!record.first_response_at && overdueSla) {
    return {
      title: "Responder agora",
      reason: "Primeira resposta pendente e SLA vencido.",
      urgency: "critical" as const,
    };
  }
  if (!record.first_response_at) {
    return {
      title: "Fazer primeiro contato",
      reason: "O lead ainda não possui primeira resposta registrada.",
      urgency: "high" as const,
    };
  }
  if (overdueAction) {
    return {
      title: "Retomar atendimento",
      reason: "Há uma próxima ação ou atividade comercial vencida.",
      urgency: "critical" as const,
    };
  }
  if (!q.complete) {
    const missing = [
      !q.hasProject ? "empreendimento" : "",
      !q.hasBudget ? "orçamento/capacidade" : "",
      !q.hasArea ? "metragem" : "",
    ]
      .filter(Boolean)
      .join(", ");
    return {
      title: "Qualificar perfil",
      reason: `Falta confirmar ${missing}.`,
      urgency: "high" as const,
    };
  }
  if (score >= 75 && !record.broker_user_id) {
    return {
      title: "Encaminhar ao corretor",
      reason: "Lead qualificado, com alta prioridade e ainda sem corretor.",
      urgency: "high" as const,
    };
  }
  if (
    objections.some((key) =>
      ["preco", "parcela", "entrada", "financiamento"].includes(key),
    )
  ) {
    return {
      title: "Reformular condição",
      reason: "O histórico indica objeção financeira a ser trabalhada.",
      urgency: "normal" as const,
    };
  }
  if (score >= 75) {
    return {
      title: "Converter para visita/proposta",
      reason: "O lead reúne sinais suficientes para avançar no funil.",
      urgency: "high" as const,
    };
  }
  if (staleHours !== null && staleHours >= 168) {
    return {
      title: "Reativar lead",
      reason: "Não há contato registrado nos últimos 7 dias.",
      urgency: "normal" as const,
    };
  }
  return {
    title: "Nutrir relacionamento",
    reason: "Manter cadência contextual até surgir um novo sinal de intenção.",
    urgency: "normal" as const,
  };
}

function nextBestOffer(
  record: CrmRecord,
  data: ErpData,
  crm: CrmEnterpriseData,
) {
  const product = record.product_id
    ? crm.products.find((item) => item.id === record.product_id)
    : null;
  const project = record.project_id
    ? data.projects.find((item) => item.id === record.project_id)
    : null;
  const q = qualification(record);

  if (product) {
    return {
      title: `Priorizar ${product.name}`,
      reason: "Produto já vinculado ao interesse do lead.",
    };
  }
  if (project && record.financing_interest) {
    return {
      title: `Simulação financeira de ${project.name}`,
      reason: "Há interesse em financiamento registrado no CRM.",
    };
  }
  if (project && q.hasBudget && q.hasArea) {
    return {
      title: `Selecionar unidade compatível em ${project.name}`,
      reason: "Orçamento e metragem já permitem filtrar a oferta com segurança.",
    };
  }
  if (project) {
    return {
      title: `Apresentar opções de ${project.name}`,
      reason: "O empreendimento está definido, mas a oferta ainda depende de qualificação.",
    };
  }
  return {
    title: "Não recomendar produto ainda",
    reason: "Qualifique empreendimento, orçamento e metragem antes da oferta.",
  };
}

function campaignName(record: CrmRecord, crm: CrmEnterpriseData) {
  if (record.campaign_id) {
    const campaign = crm.campaigns.find((item) => item.id === record.campaign_id);
    if (campaign) return campaign.name;
  }
  return record.utm_campaign || record.source || record.source_channel || "Origem não informada";
}

export function buildLeadStrategy(
  record: CrmRecord,
  data: ErpData,
  crm: CrmEnterpriseData,
  now = new Date(),
): LeadStrategyInsight {
  const leadActions = actionsFor(record.id, crm.actions);
  const objections = detectObjections(record, leadActions);
  const scored = scoreLead(record, leadActions, now);
  const q = qualification(record);
  const action = nextBestAction(
    record,
    leadActions,
    objections,
    scored.score,
    now,
  );
  const needsFirstResponse = !record.first_response_at;
  const overdue =
    isPast(record.sla_due_at, now) ||
    isPast(record.next_action_at, now) ||
    leadActions.some(
      (item) =>
        item.action_status === "pendente" && isPast(item.scheduled_at, now),
    );
  const brokerReady =
    q.complete && scored.score >= 75 && !record.broker_user_id;

  return {
    record,
    score: scored.score,
    level:
      scored.score >= 75 ? "alta" : scored.score >= 55 ? "media" : "baixa",
    action,
    offer: nextBestOffer(record, data, crm),
    objections,
    drivers: scored.drivers,
    qualified: q.complete,
    needsFirstResponse,
    overdue,
    brokerReady,
    staleDays: scored.staleDays,
    campaignLabel: campaignName(record, crm),
  };
}

export function buildLeadStrategies(
  data: ErpData,
  crm: CrmEnterpriseData,
  now = new Date(),
) {
  return crm.records
    .filter((record) => record.record_status === "aberta")
    .map((record) => buildLeadStrategy(record, data, crm, now))
    .sort((a, b) => b.score - a.score || a.record.person_name.localeCompare(b.record.person_name));
}

export function buildObjectionSummary(insights: LeadStrategyInsight[]) {
  const counts = Object.keys(OBJECTION_LABELS).reduce(
    (acc, key) => {
      acc[key as ObjectionKey] = 0;
      return acc;
    },
    {} as Record<ObjectionKey, number>,
  );
  for (const insight of insights) {
    for (const key of insight.objections) counts[key] += 1;
  }
  return (Object.keys(counts) as ObjectionKey[])
    .map((key) => ({ key, label: OBJECTION_LABELS[key], count: counts[key] }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);
}

export function buildDailyStrategy(
  insights: LeadStrategyInsight[],
): DailyStrategy {
  const highPriority = insights.filter((item) => item.score >= 75).length;
  const immediateAction = insights.filter(
    (item) =>
      item.action.urgency === "critical" ||
      item.needsFirstResponse ||
      item.overdue,
  ).length;
  const brokerReady = insights.filter((item) => item.brokerReady).length;
  const financialObjection = insights.filter((item) =>
    item.objections.some((key) =>
      ["preco", "parcela", "entrada", "financiamento"].includes(key),
    ),
  ).length;
  const reactivation = insights.filter(
    (item) => item.staleDays !== null && item.staleDays >= 7,
  ).length;

  const plan = [
    immediateAction > 0
      ? `Atender ${immediateAction} lead${immediateAction === 1 ? "" : "s"} com primeira resposta, SLA ou ação pendente.`
      : "",
    brokerReady > 0
      ? `Encaminhar ${brokerReady} lead${brokerReady === 1 ? "" : "s"} qualificado${brokerReady === 1 ? "" : "s"} para corretor.`
      : "",
    financialObjection > 0
      ? `Trabalhar objeção financeira em ${financialObjection} lead${financialObjection === 1 ? "" : "s"} com argumento e condição adequados.`
      : "",
    reactivation > 0
      ? `Reativar ${reactivation} lead${reactivation === 1 ? "" : "s"} sem contato há pelo menos 7 dias.`
      : "",
  ].filter(Boolean);

  if (!plan.length) {
    plan.push("Nenhum gargalo crítico foi detectado na carteira aberta.");
  }

  return {
    highPriority,
    immediateAction,
    brokerReady,
    financialObjection,
    reactivation,
    plan,
  };
}

export function buildCampaignStrategy(
  crm: CrmEnterpriseData,
  insights: LeadStrategyInsight[],
): CampaignStrategyInsight[] {
  const insightById = new Map(insights.map((item) => [item.record.id, item]));
  const buckets = new Map<string, CampaignStrategyInsight & { scoreSum: number }>();

  for (const record of crm.records.filter(
    (item) => item.record_status !== "arquivada",
  )) {
    const campaign = record.campaign_id
      ? crm.campaigns.find((item) => item.id === record.campaign_id)
      : null;
    const key =
      campaign?.id ||
      record.utm_campaign ||
      record.source ||
      record.source_channel ||
      "sem-origem";
    const label =
      campaign?.name ||
      record.utm_campaign ||
      record.source ||
      record.source_channel ||
      "Origem não informada";
    const current =
      buckets.get(key) ||
      {
        key,
        label,
        leads: 0,
        open: 0,
        won: 0,
        lost: 0,
        hot: 0,
        averageScore: 0,
        closedConversion: 0,
        pipeline: 0,
        scoreSum: 0,
      };

    current.leads += 1;
    if (record.record_status === "aberta") {
      current.open += 1;
      current.pipeline += finite(record.estimated_value);
      const insight = insightById.get(record.id);
      if (insight) {
        current.scoreSum += insight.score;
        if (insight.score >= 75) current.hot += 1;
      }
    } else if (record.record_status === "ganha") {
      current.won += 1;
    } else if (record.record_status === "perdida") {
      current.lost += 1;
    }
    buckets.set(key, current);
  }

  return [...buckets.values()]
    .map(({ scoreSum, ...item }) => ({
      ...item,
      averageScore: item.open ? Math.round(scoreSum / item.open) : 0,
      closedConversion:
        item.won + item.lost
          ? (item.won / (item.won + item.lost)) * 100
          : 0,
    }))
    .sort(
      (a, b) =>
        b.averageScore - a.averageScore ||
        b.hot - a.hot ||
        b.leads - a.leads,
    );
}
