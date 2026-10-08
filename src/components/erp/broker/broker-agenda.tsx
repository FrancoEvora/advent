"use client";

import { useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase";
import type { BrokerAppointment, BrokerData } from "./load-broker-data";
import { date, localInput } from "./broker-format";
import styles from "./broker-workspace.module.css";

export function appointmentLeadId(item: BrokerAppointment, loaded: BrokerData) {
  return ["crm_record", "crm_records"].includes(item.related_type || "") ? item.related_id : loaded.crm.actions.find(row => row.id === item.related_id)?.crm_record_id || null;
}

export function BrokerAgenda({ loaded, openLead, done }: { loaded: BrokerData; openLead: (id: string) => void; done: (message: string) => Promise<void> }) {
  const [editing, setEditing] = useState<BrokerAppointment | "new" | null>(null);
  const [status, setStatus] = useState("active");
  const [leadFilter, setLeadFilter] = useState("");
  const rows = loaded.activities.filter(item => (status === "all" || !["cancelada", "concluida"].includes(item.status)) && (!leadFilter || appointmentLeadId(item, loaded) === leadFilter));
  return <section>
    <div className={styles.sectionTitle}><div><small>ROTINA COMERCIAL</small><h2>Minha agenda</h2><p>Seus compromissos e os próximos passos de cada atendimento.</p></div><button className="primary" onClick={() => setEditing("new")}>+ Novo compromisso</button></div>
    <div className={styles.filters}><select aria-label="Filtrar agenda por cliente" value={leadFilter} onChange={e => setLeadFilter(e.target.value)}><option value="">Todos os clientes</option>{loaded.crm.records.map(row => <option key={row.id} value={row.id}>{row.person_name}</option>)}</select><select aria-label="Situação da agenda" value={status} onChange={e => setStatus(e.target.value)}><option value="active">Pendentes e em andamento</option><option value="all">Todos os compromissos</option></select><span>{rows.length} compromissos</span></div>
    <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Data e horário</th><th>Compromisso</th><th>Cliente</th><th>Prazo</th><th>Situação</th><th>Ações</th></tr></thead><tbody>{rows.map(item => {
      const leadId = appointmentLeadId(item, loaded);
      const lead = loaded.crm.records.find(row => row.id === leadId);
      const assignment = loaded.crm.assignments.find(row => row.user_activity_id === item.id);
      return <tr key={item.id}><td>{date(item.starts_at || item.due_at)}</td><td><strong>{assignment ? "Atendimento comercial" : item.title}</strong></td><td>{lead?.person_name || "Compromisso pessoal"}</td><td>{date(item.due_at)}</td><td><span className={styles.badge}>{({ pendente: "Pendente", em_andamento: "Em andamento", concluida: "Concluído", cancelada: "Cancelado" } as Record<string, string>)[item.status] || item.status}</span></td><td><div className={styles.actions}><button onClick={() => setEditing(item)}>Gerenciar</button>{leadId && <button onClick={() => openLead(leadId)}>Atendimento</button>}</div></td></tr>;
    })}</tbody></table></div>
    {!rows.length && <div className={styles.empty}>Nenhum compromisso neste filtro.</div>}
    {editing && <BrokerAppointmentModal key={typeof editing === "string" ? editing : editing.id} loaded={loaded} item={editing === "new" ? undefined : editing} close={() => setEditing(null)} done={done} />}
  </section>;
}

export function BrokerAppointmentModal({ loaded, item, initialLeadId, close, done }: { loaded: BrokerData; item?: BrokerAppointment; initialLeadId?: string; close: () => void; done: (message: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const assignment = loaded.crm.assignments.find(row => row.user_activity_id === item?.id);
  const [defaultEnd] = useState(() => localInput(item?.due_at || new Date(Date.now() + 3600000).toISOString()));
  const leadId = item ? appointmentLeadId(item, loaded) : initialLeadId;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true); setError("");
    try {
      const result = await getSupabase()!.rpc("save_broker_appointment", { p_organization_id: loaded.data.membership.organization_id, p_activity_id: item?.id || null, p_record_id: item ? leadId : String(form.get("lead") || "") || null, p_title: String(form.get("title")), p_starts_at: new Date(`${form.get("starts")}:00-03:00`).toISOString(), p_due_at: new Date(`${form.get("due")}:00-03:00`).toISOString(), p_status: String(form.get("status")), p_notes: String(form.get("notes") || "") });
      if (result.error) throw result.error;
      await done("Compromisso atualizado na sua agenda."); close();
    } catch (cause) { setError((cause as { message?: string })?.message || "Não foi possível salvar o compromisso."); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop"><form className={`modal large ${styles.detail}`} role="dialog" aria-modal="true" aria-label="Gerenciar compromisso" onSubmit={save}>
    <button type="button" className="modal-close" aria-label="Fechar compromisso" disabled={busy} onClick={close}>×</button><header><small>MINHA AGENDA · HORÁRIO DE BRASÍLIA</small><h2>{item ? "Gerenciar compromisso" : "Novo compromisso"}</h2></header>
    <fieldset disabled={busy} className={styles.formGrid}>
      <label>Cliente<select name="lead" defaultValue={leadId || ""} disabled={Boolean(item)}><option value="">Compromisso pessoal</option>{loaded.crm.records.map(row => <option key={row.id} value={row.id}>{row.person_name}</option>)}</select></label>
      <label>Título<input name="title" required maxLength={180} defaultValue={assignment ? "Atendimento comercial" : item?.title || ""} /></label>
      <label>Início<input name="starts" type="datetime-local" required defaultValue={localInput(item?.starts_at || item?.due_at)} /></label><label>Prazo / término<input name="due" type="datetime-local" required defaultValue={defaultEnd} /></label>
      <label>Situação<select name="status" defaultValue={item?.status || "pendente"}><option value="pendente">Pendente</option><option value="em_andamento">Em andamento</option><option value="concluida">Concluído</option>{!assignment && <option value="cancelada">Cancelado</option>}</select></label>
      {!assignment && <label>Observações<textarea name="notes" rows={3} maxLength={4000} defaultValue={item?.description || ""} /></label>}
    </fieldset>
    {error && <p className="feedback error" role="alert">{error}</p>}<footer className={styles.actions}><button type="button" disabled={busy} onClick={close}>Voltar</button><button className="primary" disabled={busy}>{busy ? "Salvando…" : "Salvar compromisso"}</button></footer>
  </form></div>;
}
