"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { CrmAction, CrmRecord, ErpData } from "../types";
import { money } from "../utils";
import type { CrmEnterpriseData, CrmSection } from "./types";
import type { SalesData } from "./sales/types";
import { CrmKpi, CrmSectionHeader, EmptyState, Status } from "./shared";
import { LeadCommunicationMaterialsModal } from "./lead-communication-materials-modal";
import {
  buildCampaignStrategy,
  buildDailyStrategy,
  buildLeadStrategies,
  buildObjectionSummary,
  OBJECTION_LABELS,
} from "./strategy-engine";
import styles from "./strategy-view.module.css";

const PAGE_SIZE = 25;

const biaReasonLabels: Record<string, string> = {
  BIA_ALREADY_QUEUED: "Este lead já está na fila da Bia.",
  BIA_BULK_CONSENT_REQUIRED:
    "O lead não possui autorização de WhatsApp documentada para este fluxo.",
  BIA_PHONE_INVALID: "O telefone do lead não é válido para WhatsApp.",
  BIA_CONTACT_PAUSED: "O contato está pausado, bloqueado ou pediu atendimento humano.",
  BIA_CAMPAIGN_ALREADY_CONTACTED:
    "A Bia já possui histórico de atendimento com este telefone.",
  BIA_CAMPAIGN_DISABLED:
    "Não existe uma configuração ativa da Bia para este empreendimento.",
  BIA_CAMPAIGN_LEAD_INACTIVE:
    "O lead não está elegível para atendimento automático neste momento.",
  BIA_QUEUE_FORBIDDEN:
    "Seu perfil não possui permissão para colocar leads na fila da Bia.",
};

function normalized(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function quickActionSubject(kind: "material" | "remarketing_7" | "remarketing_30") {
  if (kind === "material") return "Envio de material comercial";
  if (kind === "remarketing_7") return "Remarketing · 7 dias";
  return "Remarketing · 30 dias";
}

export function StrategyView({
  data,
  crm,
  sales,
  openLead,
  openActivity,
  reload,
  setSection,
}: {
  data: ErpData;
  crm: CrmEnterpriseData;
  sales: SalesData;
  openLead: (lead: CrmRecord) => void;
  openActivity: (lead: CrmRecord) => void;
  reload: () => Promise<void>;
  setSection: (value: CrmSection) => void;
}) {
  const [query, setQuery] = useState("");
  const [temperature, setTemperature] = useState("all");
  const [scoreBand, setScoreBand] = useState("all");
  const [source, setSource] = useState("all");
  const [recommendedAction, setRecommendedAction] = useState("all");
  const [sortBy, setSortBy] = useState("score_desc");
  const [page, setPage] = useState(1);
  const [busyLeadId, setBusyLeadId] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [materialAction, setMaterialAction] = useState<{
    action: CrmAction;
    lead: CrmRecord;
  } | null>(null);

  const insights = useMemo(
    () => buildLeadStrategies(data, crm, sales, new Date()),
    [crm, data, sales],
  );
  const daily = useMemo(() => buildDailyStrategy(insights), [insights]);
  const objections = useMemo(
    () => buildObjectionSummary(insights),
    [insights],
  );
  const campaigns = useMemo(
    () => buildCampaignStrategy(crm, insights),
    [crm, insights],
  );

  const sourceOptions = useMemo(
    () =>
      [...new Set(insights.map((item) => item.campaignLabel).filter(Boolean))].sort(
        (a, b) => a.localeCompare(b, "pt-BR"),
      ),
    [insights],
  );
  const actionOptions = useMemo(
    () =>
      [...new Set(insights.map((item) => item.action.title))].sort((a, b) =>
        a.localeCompare(b, "pt-BR"),
      ),
    [insights],
  );

  const filtered = useMemo(() => {
    const needle = normalized(query);
    const result = insights.filter((item) => {
      if (temperature !== "all" && item.record.temperature !== temperature)
        return false;
      if (source !== "all" && item.campaignLabel !== source) return false;
      if (
        recommendedAction !== "all" &&
        item.action.title !== recommendedAction
      )
        return false;
      if (scoreBand === "high" && item.score < 75) return false;
      if (scoreBand === "medium" && (item.score < 55 || item.score >= 75))
        return false;
      if (scoreBand === "low" && item.score >= 55) return false;
      if (!needle) return true;

      const searchable = normalized(
        [
          item.record.person_name,
          item.record.company_name,
          item.record.phone,
          item.record.email,
          item.record.source,
          item.record.source_channel,
          item.campaignLabel,
          item.action.title,
          item.offer.title,
          ...item.objections.map((key) => OBJECTION_LABELS[key]),
        ]
          .filter(Boolean)
          .join(" "),
      );
      return searchable.includes(needle);
    });

    return result.slice().sort((a, b) => {
      if (sortBy === "score_asc") return a.score - b.score;
      if (sortBy === "name_asc")
        return a.record.person_name.localeCompare(b.record.person_name, "pt-BR");
      if (sortBy === "newest")
        return String(b.record.created_at).localeCompare(String(a.record.created_at));
      if (sortBy === "oldest")
        return String(a.record.created_at).localeCompare(String(b.record.created_at));
      if (sortBy === "stale_desc")
        return (b.staleDays || 0) - (a.staleDays || 0);
      return b.score - a.score;
    });
  }, [
    insights,
    query,
    recommendedAction,
    scoreBand,
    sortBy,
    source,
    temperature,
  ]);

  useEffect(() => {
    setPage(1);
  }, [query, temperature, scoreBand, source, recommendedAction, sortBy]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageItems = filtered.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE,
  );
  const maxObjection = Math.max(1, ...objections.map((item) => item.count));
  const canQueueBia = data.membership.role === "admin";

  function clearFilters() {
    setQuery("");
    setTemperature("all");
    setScoreBand("all");
    setSource("all");
    setRecommendedAction("all");
    setSortBy("score_desc");
  }

  async function createQuickActivity(
    lead: CrmRecord,
    kind: "material" | "remarketing_7" | "remarketing_30",
  ) {
    const client = getSupabase();
    if (!client) throw new Error("Supabase indisponível.");

    const delayDays =
      kind === "remarketing_7" ? 7 : kind === "remarketing_30" ? 30 : 0;
    const scheduledAt = new Date(
      Date.now() + (delayDays ? delayDays * 24 * 60 * 60 * 1000 : 5 * 60 * 1000),
    ).toISOString();
    const subject = quickActionSubject(kind);
    const result = await client.rpc("create_crm_activity_with_broker", {
      p_crm_record_id: lead.id,
      p_action_type: kind === "material" ? "whatsapp" : "tarefa",
      p_channel: "whatsapp",
      p_subject: subject,
      p_scheduled_at: scheduledAt,
      p_completed: false,
      p_outcome: null,
      p_duration_minutes: null,
      p_assigned_to: data.session.user.id,
      p_broker_user_id: null,
      p_notes:
        kind === "material"
          ? "Atividade criada pela Estratégia IA para preparação e envio de material comercial."
          : `Ação de remarketing criada pela Estratégia IA para ${delayDays} dias.`,
    });
    if (result.error) throw new Error(result.error.message);
    const payload = result.data as Record<string, unknown> | null;
    const actionId =
      payload && typeof payload.action_id === "string" ? payload.action_id : "";
    if (!actionId) throw new Error("A atividade foi criada sem identificador.");

    if (kind === "material") {
      const row = await client
        .from("crm_actions")
        .select("*")
        .eq("organization_id", data.organization.id)
        .eq("id", actionId)
        .single();
      if (row.error || !row.data)
        throw new Error(
          row.error?.message || "Não foi possível abrir a atividade de materiais.",
        );
      setMaterialAction({ action: row.data as CrmAction, lead });
      setNotice("Atividade criada. Selecione agora o material a encaminhar.");
    } else {
      setNotice(
        delayDays === 7
          ? "Remarketing agendado para 7 dias."
          : "Remarketing agendado para 30 dias.",
      );
    }
    await reload();
  }

  async function queueBia(lead: CrmRecord) {
    if (!canQueueBia) {
      setError("Somente administradores podem encaminhar diretamente para a fila da Bia.");
      return;
    }
    if (
      !window.confirm(
        `Enviar ${lead.person_name} para a fila da Bia? O contato só será processado se houver consentimento válido e o canal estiver elegível.`,
      )
    )
      return;

    const client = getSupabase();
    if (!client) throw new Error("Supabase indisponível.");
    const result = await client.rpc("bia_strategy_enqueue_lead", {
      p_organization_id: data.organization.id,
      p_crm_record_id: lead.id,
    });
    if (result.error) throw new Error(result.error.message);
    const payload = result.data as
      | { ok?: boolean; reason?: string; campaignId?: string }
      | null;
    if (!payload?.ok) {
      const reason = payload?.reason || "BIA_QUEUE_UNAVAILABLE";
      throw new Error(
        biaReasonLabels[reason] ||
          "O lead não está elegível para entrar na fila da Bia.",
      );
    }
    setNotice(`${lead.person_name} foi colocado na Fila da Bia. Nenhuma mensagem foi enviada ainda.`);
    await reload();
  }

  async function handleQuickAction(lead: CrmRecord, action: string) {
    if (!action) return;
    setNotice("");
    setError("");
    if (action === "open") {
      openLead(lead);
      return;
    }
    if (action === "activity") {
      openActivity(lead);
      return;
    }
    if (action === "bia_queue") {
      setSection("bia_queue");
      return;
    }
    if (action === "campaigns") {
      setSection("whatsapp_campaigns");
      return;
    }

    setBusyLeadId(lead.id);
    try {
      if (action === "bia") await queueBia(lead);
      else if (action === "material") await createQuickActivity(lead, "material");
      else if (action === "remarketing_7")
        await createQuickActivity(lead, "remarketing_7");
      else if (action === "remarketing_30")
        await createQuickActivity(lead, "remarketing_30");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível executar a ação selecionada.",
      );
    } finally {
      setBusyLeadId("");
    }
  }

  return (
    <div className="crm5-stack">
      <CrmSectionHeader
        eyebrow="INTELIGÊNCIA COMERCIAL"
        title="Estratégia de Vendas por IA"
        description="Uma leitura acionável da carteira: prioridade, próxima melhor ação, próxima melhor oferta, objeções e qualidade das campanhas."
        actions={
          <button className="primary" onClick={() => void reload()}>
            ↻ Atualizar estratégia
          </button>
        }
      />

      {notice && (
        <button className="notice" onClick={() => setNotice("")}>
          {notice}
          <span>×</span>
        </button>
      )}
      {error && (
        <button className="feedback error" onClick={() => setError("")}>
          {error}
        </button>
      )}

      <section className={styles.strategyHero}>
        <div className={styles.heroGrid}>
          <div className={styles.heroCopy}>
            <small>PLANO DE AÇÃO · HOJE</small>
            <h3>O que a equipe comercial deve fazer agora</h3>
            <p>
              O motor cruza o score já registrado no CRM com urgência, estágio,
              qualificação, histórico de contato, ações vencidas e objeções.
              O resultado é uma fila objetiva de atuação — sem inventar preço,
              condição ou disponibilidade.
            </p>
            <div className={styles.plan}>
              {daily.plan.map((item, index) => (
                <div className={styles.planItem} key={item}>
                  <b>{index + 1}</b>
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>
          <aside className={styles.heroMetric}>
            <div>
              <small>LEADS EM ALTA PRIORIDADE</small>
              <strong>{daily.highPriority}</strong>
              <span>Score de ação ≥ 75</span>
            </div>
            <div className={styles.legend}>
              O score representa prioridade comercial de atuação, e não uma
              probabilidade estatística de compra. Cada recomendação permanece
              auditável pelos sinais que a originaram.
            </div>
          </aside>
        </div>
      </section>

      <section className="crm5-kpis">
        <CrmKpi
          label="Ação imediata"
          value={daily.immediateAction}
          detail="SLA, resposta ou atividade pendente"
          tone={daily.immediateAction ? "red" : "green"}
        />
        <CrmKpi
          label="Prontos para corretor"
          value={daily.brokerReady}
          detail="Qualificados, prioritários e sem corretor"
          tone="green"
        />
        <CrmKpi
          label="Objeção financeira"
          value={daily.financialObjection}
          detail="Preço, parcela, entrada ou financiamento"
          tone="orange"
        />
        <CrmKpi
          label="Reativação"
          value={daily.reactivation}
          detail="Sem contato há pelo menos 7 dias"
          tone="blue"
        />
        <CrmKpi
          label="Carteira aberta"
          value={insights.length}
          detail="Leads analisados em tempo real"
          tone="lime"
        />
      </section>

      <section className="crm5-panel">
        <header>
          <div>
            <small>PRÓXIMA MELHOR AÇÃO + OFERTA</small>
            <h3>Fila de prioridade comercial</h3>
          </div>
          <span>
            {filtered.length} de {insights.length} oportunidades
          </span>
        </header>

        <div className={styles.filterPanel}>
          <label className={styles.searchField}>
            <span>Buscar lead</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Nome, telefone, campanha, origem, objeção..."
            />
          </label>
          <label>
            <span>Score</span>
            <select value={scoreBand} onChange={(e) => setScoreBand(e.target.value)}>
              <option value="all">Todos</option>
              <option value="high">Alta prioridade · 75+</option>
              <option value="medium">Média · 55–74</option>
              <option value="low">Baixa · até 54</option>
            </select>
          </label>
          <label>
            <span>Temperatura</span>
            <select
              value={temperature}
              onChange={(e) => setTemperature(e.target.value)}
            >
              <option value="all">Todas</option>
              <option value="quente">Quente</option>
              <option value="morno">Morno</option>
              <option value="frio">Frio</option>
            </select>
          </label>
          <label>
            <span>Origem</span>
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="all">Todas</option>
              {sourceOptions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Ação recomendada</span>
            <select
              value={recommendedAction}
              onChange={(e) => setRecommendedAction(e.target.value)}
            >
              <option value="all">Todas</option>
              {actionOptions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Ordenar por</span>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="score_desc">Score · maior primeiro</option>
              <option value="score_asc">Score · menor primeiro</option>
              <option value="name_asc">Nome · A–Z</option>
              <option value="newest">Mais recentes</option>
              <option value="oldest">Mais antigos</option>
              <option value="stale_desc">Mais tempo sem contato</option>
            </select>
          </label>
          <button type="button" onClick={clearFilters}>
            Limpar filtros
          </button>
        </div>

        {pageItems.length ? (
          <>
            <div className={styles.priorityList}>
              {pageItems.map((item) => (
                <article className={styles.leadCard} key={item.record.id}>
                  <div className={styles.score}>
                    <div>
                      <strong>{item.score}</strong>
                      <small>score</small>
                    </div>
                  </div>
                  <div className={styles.leadIdentity}>
                    <strong>{item.record.person_name || "Lead sem nome"}</strong>
                    <small>
                      {item.campaignLabel}
                      {item.record.temperature
                        ? ` · ${item.record.temperature}`
                        : ""}
                    </small>
                    <div className={styles.miniTags}>
                      {item.qualified && (
                        <span className={styles.miniTag}>qualificado</span>
                      )}
                      {item.brokerReady && (
                        <span className={styles.miniTag}>pronto p/ corretor</span>
                      )}
                      {item.objections.slice(0, 2).map((key) => (
                        <span className={styles.miniTag} key={key}>
                          {OBJECTION_LABELS[key]}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div
                    className={styles.actionBlock}
                    data-urgency={item.action.urgency}
                  >
                    <Status
                      tone={
                        item.action.urgency === "critical"
                          ? "danger"
                          : item.action.urgency === "high"
                            ? "warning"
                            : "info"
                      }
                    >
                      Próxima ação
                    </Status>
                    <strong>{item.action.title}</strong>
                    <small>{item.action.reason}</small>
                  </div>
                  <div className={styles.offerBlock}>
                    <Status tone="info">Próxima oferta</Status>
                    <strong>{item.offer.title}</strong>
                    <small>{item.offer.reason}</small>
                  </div>
                  <div className={styles.cardActions}>
                    <select
                      aria-label={`Ações para ${item.record.person_name}`}
                      defaultValue=""
                      disabled={busyLeadId === item.record.id}
                      onChange={(event) => {
                        const action = event.target.value;
                        event.target.value = "";
                        void handleQuickAction(item.record, action);
                      }}
                    >
                      <option value="">
                        {busyLeadId === item.record.id
                          ? "Processando..."
                          : "Ações do lead"}
                      </option>
                      <option value="open">Abrir lead</option>
                      <option value="activity">Registrar atividade</option>
                      <option value="bia" disabled={!canQueueBia}>
                        Enviar para fila da Bia
                      </option>
                      <option value="bia_queue">Abrir Fila da Bia</option>
                      <option value="material">Enviar material</option>
                      <option value="remarketing_7">Remarketing · 7 dias</option>
                      <option value="remarketing_30">Remarketing · 30 dias</option>
                      <option value="campaigns">Abrir campanhas WhatsApp</option>
                    </select>
                  </div>
                </article>
              ))}
            </div>

            {pageCount > 1 && (
              <div className={styles.pagination}>
                <button
                  disabled={safePage <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  ← Anterior
                </button>
                <span>
                  Página {safePage} de {pageCount}
                </span>
                <button
                  disabled={safePage >= pageCount}
                  onClick={() =>
                    setPage((current) => Math.min(pageCount, current + 1))
                  }
                >
                  Próxima →
                </button>
              </div>
            )}
          </>
        ) : (
          <EmptyState
            title="Nenhum lead encontrado"
            text="Ajuste os filtros ou limpe a busca para voltar à carteira completa."
          />
        )}
      </section>

      <div className="crm5-grid two">
        <section className="crm5-panel">
          <header>
            <div>
              <small>OBJEÇÕES</small>
              <h3>Barreiras detectadas na carteira</h3>
            </div>
          </header>
          {objections.length ? (
            <div className={styles.objectionRows}>
              {objections.map((item) => (
                <div className={styles.objectionRow} key={item.key}>
                  <span>{item.label}</span>
                  <i>
                    <b
                      style={{
                        width: `${Math.max(
                          7,
                          (item.count / maxObjection) * 100,
                        )}%`,
                      }}
                    />
                  </i>
                  <strong>{item.count}</strong>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.emptyInsight}>
              Ainda não há objeções textuais identificáveis nas notas e
              atividades dos leads abertos. Quanto melhor o registro da equipe,
              mais precisa fica esta leitura.
            </div>
          )}
        </section>

        <section className="crm5-panel">
          <header>
            <div>
              <small>GOVERNANÇA</small>
              <h3>Como o motor decide</h3>
            </div>
          </header>
          <div className={styles.governance}>
            <b>1</b>
            <div>
              <strong>Prioridade explicável</strong>
              <span>
                Considera score do CRM, temperatura, probabilidade, qualificação,
                recência, SLA, cadência e ações vencidas.
              </span>
            </div>
          </div>
          <div className={styles.governance}>
            <b>2</b>
            <div>
              <strong>Oferta sem alucinação</strong>
              <span>
                Só recomenda produto ou empreendimento já vinculados aos dados
                canônicos. Sem informação suficiente, a orientação é qualificar.
              </span>
            </div>
          </div>
          <div className={styles.governance}>
            <b>3</b>
            <div>
              <strong>Ação externa supervisionada</strong>
              <span>
                A entrada na fila da Bia respeita consentimento, opt-out, canal,
                duplicidade e demais guardrails comerciais antes de qualquer envio.
              </span>
            </div>
          </div>
        </section>
      </div>

      <section className="crm5-panel">
        <header>
          <div>
            <small>INTELIGÊNCIA DE CAMPANHAS</small>
            <h3>Qualidade comercial por origem</h3>
          </div>
          <span>Score médio considera apenas oportunidades abertas.</span>
        </header>
        {campaigns.length ? (
          <div className={styles.campaignTable}>
            <div className={styles.campaignHeader}>
              <span>Campanha / origem</span>
              <span>Leads</span>
              <span>Score</span>
              <span>Conversão</span>
              <span>Pipeline</span>
            </div>
            {campaigns.slice(0, 8).map((campaign) => (
              <div className={styles.campaignRow} key={campaign.key}>
                <strong title={campaign.label}>{campaign.label}</strong>
                <span>{campaign.leads}</span>
                <span>{campaign.averageScore || "—"}</span>
                <span>
                  {campaign.won + campaign.lost
                    ? `${campaign.closedConversion.toFixed(1)}%`
                    : "—"}
                </span>
                <span>{money.format(campaign.pipeline)}</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="Sem dados de campanha"
            text="As origens aparecerão quando os leads estiverem associados a campanhas ou canais."
          />
        )}
      </section>

      {materialAction && (
        <LeadCommunicationMaterialsModal
          data={data}
          action={materialAction.action}
          lead={materialAction.lead}
          close={() => setMaterialAction(null)}
        />
      )}
    </div>
  );
}
