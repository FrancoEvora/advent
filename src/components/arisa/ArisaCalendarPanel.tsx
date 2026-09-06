"use client";

import { useEffect, useState } from "react";
import { workspaceCall } from "./workspace-client";
import { errorText } from "./chat-client";
import styles from "./workspace.module.css";

type Calendar = { id: string; title: string; primary: boolean; role: string };
type Event = { id: string; title: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; meet_url: string | null; google_url: string | null; meet_status: string; status: string; attendees: { email: string; response: string }[] };
const responses: Record<string, string> = { accepted: "Confirmado", declined: "Recusado", tentative: "Talvez", needsAction: "Aguardando resposta" };
const dateLabel = (value?: { dateTime?: string; date?: string }) => value?.dateTime ? new Date(value.dateTime).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : value?.date || "Não informado";
function safeLink(value: string | null, meet = false) {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" && (meet ? url.hostname === "meet.google.com" : ["calendar.google.com", "www.google.com"].includes(url.hostname)) ? url.href : undefined; } catch { return undefined; }
}
export default function ArisaCalendarPanel({ organizationId, connected, authorized, busy: parentBusy, onConnect }: { organizationId: string; connected: boolean; authorized: boolean; busy: boolean; onConnect: () => void }) {
  const [calendars, setCalendars] = useState<Calendar[]>([]), [selected, setSelected] = useState("primary");
  const [events, setEvents] = useState<Event[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [nextPage, setNextPage] = useState<string | null>(null);
  const [start, setStart] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }));
  const [end, setEnd] = useState(() => new Date(Date.now() + 7 * 86400000).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }));
  useEffect(() => {
    let alive = true;
    if (connected && authorized) void workspaceCall("arisa-mail", { action: "calendar_calendars", organizationId }).then(data => { if (alive) setCalendars(data.calendars || []); }).catch(e => { if (alive) setError(errorText(e)); });
    return () => { alive = false; };
  }, [organizationId, connected, authorized]);
  async function load(more = false) {
    if (busy) return;
    if (!start || !end || end < start) { setError("Informe um período válido."); return; }
    setBusy(true); setError("");
    try {
      const until = new Date(end + "T00:00:00Z"); until.setUTCDate(until.getUTCDate() + 1);
      const data = await workspaceCall("arisa-mail", { action: "calendar_list", organizationId, args: { calendar_id: selected, start: start + "T00:00:00-03:00", end: until.toISOString().slice(0, 10) + "T00:00:00-03:00", timezone: "America/Sao_Paulo", ...(more && nextPage ? { page_token: nextPage } : {}) } });
      setEvents(previous => more ? [...previous, ...(data.events || [])] : data.events || []); setNextPage(data.next_page || null); setLoaded(true);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <section className={styles.card} aria-labelledby="arisa-calendar-title">
    <div className={styles.meta}>GOOGLE AGENDA E MEET</div><h3 id="arisa-calendar-title">Agenda da Arisa</h3>
    {!connected || !authorized ? <><p>O acesso ao Gmail não concede acesso à agenda. Autorize esta função uma vez para a Arisa consultar horários, criar reuniões, gerar Google Meet, enviar convites e reagendar compromissos.</p><button className={styles.primary} disabled={parentBusy} onClick={onConnect}>Autorizar Agenda e Meet</button><p><small>Ative a Google Calendar API no mesmo projeto Google Cloud. A conexão de e-mail existente será preservada caso a nova autorização não seja concluída.</small></p></> : <>
      <p>Peça no chat: “Consulte minha agenda de amanhã” ou “Crie uma reunião com Meet e envie o convite”. A Arisa usa a conta corporativa conectada e verifica conflitos antes de agendar.</p>
      <p><small>Horários abaixo em São Paulo. Os compromissos tratados pela Arisa também são registrados na agenda interna. Os dados são atualizados quando consultados; aceite do convite é informado pelo Google.</small></p>
      <div className={styles.row}><label>Agenda<select value={selected} onChange={e => { setSelected(e.target.value); setLoaded(false); setEvents([]); setNextPage(null); }} disabled={busy}><option value="primary">Agenda principal da Arisa</option>{calendars.filter(c => !c.primary).map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label><label>De<input type="date" value={start} onChange={e => { setStart(e.target.value); setNextPage(null); setLoaded(false); }} disabled={busy} /></label><label>Até<input type="date" value={end} onChange={e => { setEnd(e.target.value); setNextPage(null); setLoaded(false); }} disabled={busy} /></label><button disabled={busy} onClick={() => void load()}>Consultar agenda</button></div>
      {loaded && !events.length && <p role="status">Nenhum compromisso encontrado neste período.</p>}
      {loaded && events.map(event => <article key={event.id} className={styles.card}><h4>{event.title}</h4><p>{dateLabel(event.start)} até {dateLabel(event.end)}</p>{event.attendees.length > 0 && <ul>{event.attendees.map(person => <li key={person.email}>{person.email} · {responses[person.response] || "Resposta não informada"}</li>)}</ul>}<div className={styles.row}>{safeLink(event.meet_url, true) && <a href={safeLink(event.meet_url, true)} target="_blank" rel="noreferrer">Entrar no Google Meet</a>}{safeLink(event.google_url) && <a href={safeLink(event.google_url)} target="_blank" rel="noreferrer">Abrir no Google Agenda</a>}</div>{event.meet_status === "pending" && <p role="status">O Google está gerando o link. Consulte novamente; não é necessário recriar o evento.</p>}</article>)}
      {nextPage && <button disabled={busy} onClick={() => void load(true)}>Carregar próximos compromissos</button>}
    </>}{error && <p role="alert" className={styles.error}>{error}</p>}{busy && <p role="status">Consultando o Google Agenda…</p>}
  </section>;
}
