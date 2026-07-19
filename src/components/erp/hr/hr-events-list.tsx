"use client";

import { getSupabase } from "@/lib/supabase";
import type { ErpData, HrEvent } from "../types";
import { dateAtNoon, money, shortDate } from "../utils";
import { Empty } from "../views-dashboard";

export function HrEventsList({ data, mutate }: { data: ErpData; mutate: (operation: () => Promise<void>, success: string) => Promise<void> }) {
  async function approve(event: HrEvent) { await mutate(async () => { const client = getSupabase(); if (!client) throw new Error("Supabase indisponível."); const result = await client.from("hr_events").update({ status: "aprovado", approved_by: data.session.user.id, approved_at: new Date().toISOString() }).eq("id", event.id); if (result.error) throw new Error(result.error.message); }, "Evento aprovado e incluído no caixa."); }
  return <div className="hr-events-list">{data.hrEvents.map(event => { const employee = data.hrEmployees.find(item => item.id === event.employee_id); return <article key={event.id}><div><span className={`purchase-status ${event.status}`}>{event.status}</span><strong>{event.event_type.replaceAll("_", " ")}</strong><small>{employee?.full_name || "Colaborador"} · {event.due_date ? shortDate.format(dateAtNoon(event.due_date)) : "sem pagamento"}</small></div><b>{money.format(Number(event.amount))}</b>{event.status === "previsto" && <button className="primary" onClick={() => approve(event)}>Aprovar</button>}</article>; })}{!data.hrEvents.length && <Empty text="Nenhum evento de RH registrado." />}</div>;
}
