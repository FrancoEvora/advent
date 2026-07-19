"use client";

import { getSupabase } from "@/lib/supabase";
import type { FinancialEntry } from "./types";
import type { AdminProps } from "./views-admin";
import { dateAtNoon, money, shortDate } from "./utils";
import { Empty, Kpi, PanelTitle } from "./views-dashboard";

export function ApprovalsView({ data, mutate }: AdminProps) {
  const pending = data.approvals.filter(item => item.status === "pendente");
  const cashRisk = pending.filter(item => data.entries.find(entry => entry.id === item.entry_id)?.cash_risk);
  async function decide(requestId: string, entry: FinancialEntry, decision: "aprovado" | "rejeitado") {
    await mutate(async () => {
      const supabase = getSupabase(); if (!supabase) throw new Error("Supabase indisponível.");
      const now = new Date().toISOString();
      const [requestResult, entryResult] = await Promise.all([
        supabase.from("approval_requests").update({ status: decision, decided_at: now, assigned_to: data.session.user.id, comment: decision === "aprovado" ? "Aprovado pela administração" : "Rejeitado pela administração" }).eq("id", requestId),
        supabase.from("financial_entries").update({ approval_status: decision, approved_by: decision === "aprovado" ? data.session.user.id : null, approved_at: decision === "aprovado" ? now : null }).eq("id", entry.id),
      ]);
      if (requestResult.error) throw new Error(requestResult.error.message);
      if (entryResult.error) throw new Error(entryResult.error.message);
    }, decision === "aprovado" ? "Lançamento aprovado." : "Lançamento rejeitado.");
  }
  return <div className="stack"><section className="kpi-grid four"><Kpi label="Pendentes" value={String(pending.length)} detail="Aguardando decisão" tone="warning" /><Kpi label="Risco de caixa" value={String(cashRisk.length)} detail="Exigem atenção especial" tone="danger" /><Kpi label="Aprovadas" value={String(data.approvals.filter(item => item.status === "aprovado").length)} detail="Histórico" tone="positive" /><Kpi label="Alçada automática" value={money.format(Number(data.settings.approval_threshold))} detail="Limite configurado" tone="gold" /></section><section className="panel"><PanelTitle eyebrow="ALÇADAS E EXCEÇÕES" title="Fila de aprovações" />{pending.map(request => { const entry = data.entries.find(item => item.id === request.entry_id); if (!entry) return null; return <article className={`approval-row approval-row-v3 ${entry.cash_risk ? "cash-risk" : ""}`} key={request.id}><div><span className={`movement-badge ${entry.type}`}>{entry.type === "entrada" ? "↓" : "↑"}</span><div><strong>{entry.description}</strong><small>{shortDate.format(dateAtNoon(entry.due_date))} · {data.costCenters.find(center => center.id === entry.cost_center_id)?.name || data.categories.find(category => category.id === entry.category_id)?.name || "Sem classificação"}</small>{(request.reason || entry.risk_reason) && <p>{request.reason || entry.risk_reason}</p>}{entry.recommended_due_date && <em>Data recomendada: {shortDate.format(dateAtNoon(entry.recommended_due_date))}</em>}</div></div><b>{money.format(Number(entry.amount))}</b><div><button onClick={() => decide(request.id, entry, "rejeitado")}>Rejeitar</button><button className="primary" onClick={() => decide(request.id, entry, "aprovado")}>Aprovar exceção</button></div></article>; })}{!pending.length && <Empty text="Nenhuma aprovação pendente." />}</section></div>;
}
