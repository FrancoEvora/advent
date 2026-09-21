"use client";

import { useMemo } from "react";
import type { CrmRecord, ErpData } from "../types";
import { money } from "../utils";
import type { CrmEnterpriseData } from "./types";
import type { SalesData } from "./sales/types";
import { CrmKpi, CrmSectionHeader, EmptyState, Status } from "./shared";
import {
  buildCampaignStrategy,
  buildDailyStrategy,
  buildLeadStrategies,
  buildObjectionSummary,
  OBJECTION_LABELS,
} from "./strategy-engine";
import styles from "./strategy-view.module.css";

export function StrategyView({
  data,
  crm,
  sales,
  openLead,
  openActivity,
  reload,
}: {
  data: ErpData;
  crm: CrmEnterpriseData;
  sales: SalesData;
  openLead: (lead: CrmRecord) => void;
  openActivity: (lead: CrmRecord) => void;
  reload: () => Promise<void>;
}) {
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
  const priority = insights.slice(0, 12);
  const maxObjection = Math.max(1, ...objections.map((item) => item.count));

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
          <span>{priority.length} de {insights.length} oportunidades</span>
        </header>
        {priority.length ? (
          <div className={styles.priorityList}>
            {priority.map((item) => (
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
                  <button onClick={() => openLead(item.record)}>Abrir lead</button>
                  <button
                    className="primary"
                    onClick={() => openActivity(item.record)}
                  >
                    Criar ação
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            title="Nenhuma oportunidade aberta"
            text="A fila estratégica aparecerá assim que houver leads ativos no CRM."
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
                O painel recomenda o próximo passo; ele não dispara contato,
                concede desconto nem assume compromisso comercial sozinho.
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
    </div>
  );
}
