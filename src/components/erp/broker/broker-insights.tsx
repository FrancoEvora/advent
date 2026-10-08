"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { CrmRecord } from "../types";
import { buildLeadStrategy, OBJECTION_LABELS } from "../crm-v5/strategy-engine";
import type { SalesData } from "../crm-v5/sales/types";
import type { BrokerData } from "./load-broker-data";
import { date } from "./broker-format";
import styles from "./broker-workspace.module.css";

type BiaContext = { last_message: string | null; updated_at: string | null; facts: unknown; questions: unknown; next_step: string | null };
const emptySales: SalesData = { units: [], policies: [], reservations: [], proposals: [], approvals: [], installments: [], contracts: [], templates: [], communications: [], snapshots: [] };

export function BrokerInsights({ lead, loaded }: { lead: CrmRecord; loaded: BrokerData }) {
  const [context, setContext] = useState<BiaContext | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    void getSupabase()!.rpc("get_broker_lead_insights", { p_record_id: lead.id }).then(result => {
      if (!alive) return;
      if (result.error) setError("Não foi possível consultar o último atendimento da Bia.");
      else setContext(result.data as BiaContext);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [lead.id]);
  const insight = buildLeadStrategy(lead, loaded.data, loaded.crm, emptySales);
  const assignment = loaded.crm.assignments.find(row => row.crm_record_id === lead.id && ["atribuida", "aceita", "em_atendimento"].includes(row.status));
  const compatible = loaded.units.filter(unit => (!lead.project_id || unit.project_id === lead.project_id) && (!lead.budget_max || unit.list_price <= lead.budget_max) && (!lead.preferred_area_min || unit.area >= lead.preferred_area_min) && (!lead.preferred_area_max || unit.area <= lead.preferred_area_max));
  return <section className={styles.guidance} aria-label="Insights da Bia"><small>INSIGHTS DA BIA</small><h3>{insight.action.title}</h3><p>{insight.action.reason}</p><div className={styles.insightGrid}><div><strong>Próximo passo sugerido</strong><p>{assignment?.guidance.objective || insight.offer.title}</p>{assignment?.guidance.opening_suggestion && <details><summary>Sugestão de abordagem</summary><p>{assignment.guidance.opening_suggestion}</p></details>}</div><div><strong>Pontos para o atendimento</strong>{insight.objections.length ? <p>Possíveis objeções: {insight.objections.map(key => OBJECTION_LABELS[key]).join(", ")}.</p> : <p>Confirme objetivo da compra, orçamento, metragem e prazo de decisão.</p>}<p>{compatible.length} lotes disponíveis compatíveis com os filtros cadastrados.</p>{assignment?.guidance.questions?.length ? <ul>{assignment.guidance.questions.slice(0, 4).map(question => <li key={question}>{question}</li>)}</ul> : null}</div></div><small>Recomendações baseadas no cadastro e no histórico disponível.</small>
    {loading && <p role="status">Consultando atendimento da Bia…</p>}{error && <p role="alert">{error}</p>}{context?.last_message ? <details><summary>Última mensagem da Bia · {date(context.updated_at)}</summary><p>{context.last_message}</p></details> : !loading && !error ? <p>A Bia ainda não possui uma mensagem registrada neste atendimento.</p> : null}
  </section>;
}
