"use client";
import { useEffect, useRef, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { buildBrokerActivityReport, reportCsv, reportDay, type BrokerReportSource, type ReportRow } from "@/lib/broker-activity-report";
import type { ErpData } from "../types";
import type { CrmEnterpriseData } from "./types";
import { escapeHtml, openPrintDocument } from "./sales/utils";
import styles from "./broker-activity-report.module.css";
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const label = (value: unknown) => String(value ?? "—").replaceAll("_", " ");
const date = (value: unknown) => value ? new Date(String(value)).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—";
const columns = {
  records: ["crm_records", "id,person_name,broker_user_id,record_status,stage,source,created_at,next_action_at,last_contact_at,lost_reason"],
  assignments: ["crm_lead_assignments", "id,crm_record_id,assignment_role,assigned_user_id,assigned_at,acknowledged_at,status,user_activity_id,crm_action_id"],
  actions: ["crm_actions", "id,crm_record_id,action_type,subject,scheduled_at,completed_at,action_status,notes,created_by,created_at,assigned_to,outcome"],
  appointments: ["user_activities", "id,owner_user_id,title,description,activity_type,status,starts_at,due_at,completed_at,created_at,related_type,related_id"],
  proposals: ["crm_proposals", "id,proposal_number,customer_name,created_by,created_at,status,approval_status,sale_price,crm_record_id"],
  reservations: ["crm_unit_reservations", "id,customer_name,created_by,created_at,status,expires_at,proposal_id"],
  contracts: ["crm_contracts", "id,contract_number,proposal_id,status,signed_at"],
} as const;
type Result = ReturnType<typeof buildBrokerActivityReport>;
type Snapshot = { report: Result; broker: string; start: string; end: string; generated: string };
export function BrokerActivityReport({ data, crm }: { data: ErpData; crm: CrmEnterpriseData }) {
  const today = reportDay(new Date().toISOString());
  const [brokerId, setBrokerId] = useState("");
  const [start, setStart] = useState(today.slice(0, 7) + "-01");
  const [end, setEnd] = useState(today);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("activities");
  const [page, setPage] = useState(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), [data.organization.id, data.session.user.id]);
  const ids = new Set([...data.members.filter(row => row.role === "corretor").map(row => row.user_id), ...crm.teamMembers.filter(row => row.team_role === "corretor").map(row => row.user_id), ...crm.assignments.filter(row => row.assignment_role === "corretor").map(row => row.assigned_user_id)]);
  const brokers = [...ids].map(id => ({ id, name: data.profiles.find(row => row.id === id)?.full_name || data.profiles.find(row => row.id === id)?.email || `Corretor ${id.slice(0, 8)}` })).sort((a, b) => a.name.localeCompare(b.name));
  function reset() { controller.current?.abort(); controller.current = null; setBusy(false); setSnapshot(null); setError(""); setPage(0); }
  async function generate() {
    if (controller.current) return;
    if (!brokerId || !start || !end || start > end) { setError("Selecione o corretor e um período válido."); return; }
    const client = getSupabase(); if (!client) { setError("Conexão indisponível."); return; }
    const abort = new AbortController(); controller.current = abort; setBusy(true); setError(""); setSnapshot(null);
    try {
      const permission = await client.rpc("has_app_permission", { p_organization_id: data.organization.id, p_permission_key: "crm.monitor_team" });
      if (permission.error || !permission.data) throw new Error("Não foi possível confirmar sua permissão para acompanhar a equipe.");
      const source = {} as BrokerReportSource;
      await Promise.all((Object.keys(columns) as (keyof BrokerReportSource)[]).map(async key => {
        const [table, fields]: readonly [string, string] = columns[key]; const rows: ReportRow[] = []; let after = "";
        for (;;) {
          let query = client.from(table).select(fields).eq("organization_id", data.organization.id).order("id").limit(500).abortSignal(abort.signal);
          if (key === "assignments") query = query.eq("assigned_user_id", brokerId).eq("assignment_role", "corretor");
          if (key === "proposals") query = query.eq("created_by", brokerId);
          if (key === "actions") query = query.or(`assigned_to.eq.${brokerId},and(assigned_to.is.null,created_by.eq.${brokerId})`);
          if (key === "appointments") query = query.eq("owner_user_id", brokerId).in("related_type", ["crm_record", "crm_records", "crm_action", "crm_actions"]);
          if (after) query = query.gt("id", after);
          const result = await query;
          if (result.error) throw new Error(`Falha ao consultar ${table}: ${result.error.message}`);
          const part = (result.data || []) as unknown as ReportRow[]; rows.push(...part);
          if (part.length < 500) break; after = part.at(-1)!.id;
        }
        source[key] = rows;
      }));
      if (abort.signal.aborted) return;
      const generated = new Date().toISOString();
      setSnapshot({ report: buildBrokerActivityReport(source, brokerId, start, end, generated), broker: brokers.find(row => row.id === brokerId)?.name || "Corretor", start, end, generated }); setPage(0);
    } catch (cause) { if (!abort.signal.aborted) setError((cause as Error).message || "Não foi possível gerar o relatório."); }
    finally { if (controller.current === abort) { controller.current = null; setBusy(false); } }
  }
  const report = snapshot?.report;
  const metrics = report ? [
    ["Leads distribuídos", String(new Set(report.received.map(row => row.crm_record_id)).size), "Recebidos no período"],
    ["Atividades concluídas", String(report.completedCount), "Conclusão no período"],
    ["Visitas concluídas", String(report.visits), "Tipo visita registrado"],
    ["Propostas criadas", String(report.proposals.length), "Autoria do corretor"],
    ["Reservas criadas", String(report.reservations.length), "Diretas ou ligadas à proposta"],
    ["Contratos assinados", String(report.contracts.length), money.format(report.salesValue)],
    ["Aceite do atendimento", report.acknowledgmentHours === null ? "Sem registro" : `${report.acknowledgmentHours.toFixed(1)} h`, "Média da distribuição ao aceite"],
  ] : [];
  const tables: Record<string, { title: string; headers: string[]; rows: string[][] }> = report ? {
    activities: { title: "Atividades e agenda comercial", headers: ["Data de referência", "Tipo", "Atividade", "Lead", "Situação atual", "Resultado / observações"], rows: report.lines.map(row => [date(row.date), label(row.type), row.title, row.lead, label(row.status), row.notes]) },
    portfolio: { title: "Carteira atual — independente do período", headers: ["Cliente", "Situação", "Etapa", "Origem", "Último contato", "Próxima ação", "Motivo de perda"], rows: report.current.map(row => [label(row.person_name), label(row.record_status), label(row.stage), label(row.source), date(row.last_contact_at), date(row.next_action_at), label(row.lost_reason)]) },
    assignments: { title: "Distribuições no período", headers: ["Lead", "Distribuição", "Aceite", "Situação atual"], rows: report.received.map(row => [label(row.lead_name), date(row.assigned_at), date(row.acknowledged_at), label(row.status)]) },
    proposals: { title: "Propostas criadas no período", headers: ["Proposta", "Cliente", "Criação", "Situação atual", "Aprovação", "Valor"], rows: report.proposals.map(row => [label(row.proposal_number), label(row.customer_name), date(row.created_at), label(row.status), label(row.approval_status), money.format(Number(row.sale_price || 0))]) },
    reservations: { title: "Reservas criadas no período", headers: ["Cliente", "Criação", "Vencimento", "Situação atual"], rows: report.reservations.map(row => [label(row.customer_name), date(row.created_at), date(row.expires_at), label(row.status)]) },
    contracts: { title: "Contratos assinados no período", headers: ["Contrato", "Assinatura", "Situação atual"], rows: report.contracts.map(row => [label(row.contract_number), date(row.signed_at), label(row.status)]) },
    pending: { title: "Pendências atuais — independente do período", headers: ["Atividade", "Prazo", "Situação"], rows: [...report.pending.map(row => [label(row.subject), date(row.scheduled_at), label(row.action_status)]), ...report.pendingAgenda.map(row => [label(row.title), date(row.due_at), label(row.status)])] },
  } : {};
  const table = tables[tab];
  function exportReport(print: boolean) {
    if (!snapshot) return;
    const metadata = [["Relatório do corretor", snapshot.broker], ["Período", `${snapshot.start} a ${snapshot.end}`], ["Gerado em", date(snapshot.generated)]];
    if (print) {
      const html = `<header><h1>Relatório do corretor</h1>${metadata.map(row => `<p>${row.map(escapeHtml).join(": ")}</p>`).join("")}</header><p>Horário de Brasília. Carteira e pendências refletem a consulta atual. Atividades incluem registros criados, agendados ou concluídos no período. Status são atuais. Somente registros disponíveis às suas permissões.</p><table>${metrics.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</table>${Object.values(tables).map(item => `<h2>${escapeHtml(item.title)}</h2><table><thead><tr>${item.headers.map(cell => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead><tbody>${item.rows.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`).join("")}`;
      openPrintDocument("Relatório do corretor", html); return;
    }
    const rows = [...metadata, [], ...metrics, ...Object.values(tables).flatMap(item => [[], [item.title], item.headers, ...item.rows])];
    const url = URL.createObjectURL(new Blob([reportCsv(rows)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `relatorio-corretor-${snapshot.start}-${snapshot.end}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className={styles.report}>
    <header><small>GESTÃO COMERCIAL</small><h2>Atividades por corretor</h2><p>Carteira, rotina de atendimento e resultados registrados no Enterprise.</p></header>
    <div className={styles.filters}>
      <label>Corretor<select value={brokerId} onChange={e => { reset(); setBrokerId(e.target.value); }}><option value="">Selecione o corretor</option>{brokers.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      <label>De<input type="date" value={start} onChange={e => { reset(); setStart(e.target.value); }} /></label>
      <label>Até<input type="date" value={end} onChange={e => { reset(); setEnd(e.target.value); }} /></label>
      <button className="primary" disabled={busy || !brokerId} onClick={() => void generate()}>{busy ? "Consultando registros…" : "Gerar relatório"}</button>
    </div>
    <div className={styles.tools}>{[7, 30, 90].map(days => <button key={days} onClick={() => { reset(); const d = new Date(`${today}T12:00:00-03:00`); d.setUTCDate(d.getUTCDate() - days + 1); setStart(reportDay(d.toISOString())); setEnd(today); }}>Últimos {days} dias</button>)}</div>
    {error && <p role="alert" className="feedback error">{error}</p>}
    {!snapshot && !busy && <p>Selecione um corretor e gere o relatório. Nenhum registro comercial será alterado.</p>}
    {snapshot && report && <>
      <div className={styles.heading}><div><h3>{snapshot.broker}</h3><p>{snapshot.start.split("-").reverse().join("/")} a {snapshot.end.split("-").reverse().join("/")} · Brasília · Atualizado em {date(snapshot.generated)}</p></div><div className={styles.tools}><button onClick={() => exportReport(false)}>Exportar CSV</button><button onClick={() => exportReport(true)}>Imprimir / salvar PDF</button></div></div>
      <div className={styles.metrics}>{metrics.map(([title, amount, note]) => <article key={title}><small>{title}</small><strong>{amount}</strong><span>{note}</span></article>)}</div>
      <div className={styles.attention}><strong>Carteira agora: {report.open.length} leads abertos</strong><span>{report.missingNext.length} sem próxima ação · {report.pending.length + report.pendingAgenda.length} atividades vencidas</span></div>
      <p className={styles.note}>Atividades: criadas, agendadas ou concluídas no período. Indicadores de conclusão e assinatura usam suas respectivas datas. Situações, carteira e pendências são atuais. A autoria das propostas identifica o corretor; o responsável registrado identifica a atividade. Aceite de atendimento não equivale a primeiro contato. PDFs e mensagens não comprovam atendimento realizado.</p>
      <nav className={styles.tools} aria-label="Seções do relatório">{Object.entries(tables).map(([key, item]) => <button key={key} aria-pressed={tab === key} onClick={() => { setTab(key); setPage(0); }}>{({ activities: "Atividades", portfolio: "Carteira", assignments: "Distribuições", proposals: "Propostas", reservations: "Reservas", contracts: "Contratos", pending: "Pendências" } as Record<string, string>)[key]} ({item.rows.length})</button>)}</nav>
      {table && <><h3>{table.title}</h3><div className={styles.table}><table><thead><tr>{table.headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{table.rows.slice(page * 30, (page + 1) * 30).map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell || "—"}</td>)}</tr>)}</tbody></table></div>{!table.rows.length && <p>Nenhum registro encontrado para estes critérios.</p>}<div className={styles.tools}><button disabled={!page} onClick={() => setPage(page - 1)}>Anterior</button><span>Página {page + 1} de {Math.max(1, Math.ceil(table.rows.length / 30))} · {table.rows.length} registros</span><button disabled={(page + 1) * 30 >= table.rows.length} onClick={() => setPage(page + 1)}>Próxima</button></div></>}
    </>}
  </section>;
}
