"use client";
import { getSupabase } from "@/lib/supabase";
import type { FinancialEntry } from "./types";
import type { AdminProps } from "./views-admin";
import { dateAtNoon, money, shortDate } from "./utils";
import { Empty, Kpi, PanelTitle } from "./views-dashboard";

export function ApprovalsView({ data, mutate }: AdminProps) {
  const pending = data.approvals.filter((item) => item.status === "pendente");
  async function decide(requestId: string, entry: FinancialEntry, decision: "aprovado" | "rejeitado") {
    await mutate(async () => {
      const supabase = getSupabase(); if (!supabase) throw new Error("Supabase indisponível."); const now = new Date().toISOString();
      const [requestResult, entryResult] = await Promise.all([
        supabase.from("approval_requests").update({ status: decision, decided_at: now, assigned_to: data.session.user.id }).eq("id", requestId),
        supabase.from("financial_entries").update({ approval_status: decision, approved_by: decision === "aprovado" ? data.session.user.id : null, approved_at: decision === "aprovado" ? now : null }).eq("id", entry.id),
      ]);
      if (requestResult.error) throw new Error(requestResult.error.message); if (entryResult.error) throw new Error(entryResult.error.message);
    }, decision === "aprovado" ? "Lançamento aprovado." : "Lançamento rejeitado.");
  }
  return <div className="stack"><section className="kpi-grid three"><Kpi label="Pendentes" value={String(pending.length)} detail="Aguardando decisão" tone="warning" /><Kpi label="Aprovadas" value={String(data.approvals.filter(a => a.status === "aprovado").length)} detail="Histórico" tone="positive" /><Kpi label="Alçada automática" value={money.format(Number(data.settings.approval_threshold))} detail="Limite configurado" tone="gold" /></section><section className="panel"><PanelTitle eyebrow="ALÇADAS" title="Fila de aprovações" />{pending.map((request) => { const entry = data.entries.find((item) => item.id === request.entry_id); if (!entry) return null; return <article className="approval-row" key={request.id}><div><span className={`movement-badge ${entry.type}`}>{entry.type === "entrada" ? "↓" : "↑"}</span><div><strong>{entry.description}</strong><small>{shortDate.format(dateAtNoon(entry.due_date))} · {data.costCenters.find(c => c.id === entry.cost_center_id)?.name || "Sem centro"}</small></div></div><b>{money.format(Number(entry.amount))}</b><div><button onClick={() => decide(request.id, entry, "rejeitado")}>Rejeitar</button><button className="primary" onClick={() => decide(request.id, entry, "aprovado")}>Aprovar</button></div></article>; })}{!pending.length && <Empty text="Nenhuma aprovação pendente." />}</section></div>;
}
