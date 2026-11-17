export type ReportRow = { id: string; [key: string]: unknown };
export type BrokerReportSource = { records: ReportRow[]; assignments: ReportRow[]; actions: ReportRow[]; appointments: ReportRow[]; proposals: ReportRow[]; reservations: ReportRow[]; contracts: ReportRow[] };
export type ActivityLine = { id: string; date: string; type: string; title: string; lead: string; status: string; notes: string };
const value = (row: ReportRow, key: string) => String(row[key] ?? "");
export function reportDay(date: string): string {
  if (!date) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const parsed = new Date(date);
  if (!Number.isFinite(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(parsed);
}
export function buildBrokerActivityReport(source: BrokerReportSource, brokerId: string, start: string, end: string, now = new Date().toISOString()) {
  if (!brokerId || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) throw new Error("Selecione um corretor e um período válido.");
  const inPeriod = (date: string) => { const day = reportDay(date); return Boolean(day && day >= start && day <= end); };
  const names = new Map(source.records.map(row => [row.id, value(row, "person_name")]));
  const assignments = source.assignments.filter(row => row.assigned_user_id === brokerId && row.assignment_role === "corretor");
  const received: ReportRow[] = assignments.filter(row => inPeriod(value(row, "assigned_at"))).map(row => ({ ...row, lead_name: names.get(value(row, "crm_record_id")) || "Lead não disponível" }));
  const current = source.records.filter(row => row.broker_user_id === brokerId && row.record_status !== "arquivada");
  const ownedActions = source.actions.filter(row => (row.assigned_to || row.created_by) === brokerId);
  const actions = ownedActions.filter(row => ["created_at", "scheduled_at", "completed_at"].some(key => inPeriod(value(row, key))));
  const linkedAgenda = new Set(source.assignments.filter(row => row.crm_action_id).map(row => value(row, "user_activity_id")));
  const agenda = source.appointments.filter(row => row.owner_user_id === brokerId && !linkedAgenda.has(row.id) && !(row.related_type === "crm_action" || row.related_type === "crm_actions") && ["crm_record", "crm_records"].includes(value(row, "related_type")));
  const appointments = agenda.filter(row => ["created_at", "starts_at", "due_at", "completed_at"].some(key => inPeriod(value(row, key))));
  const completed = actions.filter(row => row.action_status === "concluida" && inPeriod(value(row, "completed_at")));
  const completedAgenda = appointments.filter(row => row.status === "concluida" && inPeriod(value(row, "completed_at")));
  const proposalsByBroker = source.proposals.filter(row => row.created_by === brokerId);
  const proposalIds = new Set(proposalsByBroker.map(row => row.id));
  const proposals = proposalsByBroker.filter(row => inPeriod(value(row, "created_at")));
  const reservations = source.reservations.filter(row => (row.created_by === brokerId || proposalIds.has(value(row, "proposal_id"))) && inPeriod(value(row, "created_at")));
  const contracts = source.contracts.filter(row => proposalIds.has(value(row, "proposal_id")) && inPeriod(value(row, "signed_at")) && row.status === "assinado");
  const sold = new Set(contracts.map(row => value(row, "proposal_id")));
  const salesValue = proposalsByBroker.filter(row => sold.has(row.id)).reduce((sum, row) => sum + Number(row.sale_price || 0), 0);
  const pending = ownedActions.filter(row => row.action_status === "pendente" && value(row, "scheduled_at") && Date.parse(value(row, "scheduled_at")) < Date.parse(now));
  const pendingAgenda = agenda.filter(row => !["concluida", "cancelada"].includes(value(row, "status")) && value(row, "due_at") && Date.parse(value(row, "due_at")) < Date.parse(now));
  const open = current.filter(row => row.record_status === "aberta");
  const missingNext = open.filter(row => !row.next_action_at);
  const lines: ActivityLine[] = [
    ...actions.map(row => ({ id: `crm-${row.id}`, date: value(row, "completed_at") || value(row, "scheduled_at") || value(row, "created_at"), type: value(row, "action_type"), title: value(row, "subject"), lead: names.get(value(row, "crm_record_id")) || "Lead não disponível", status: value(row, "action_status"), notes: [value(row, "outcome"), value(row, "notes")].filter(Boolean).join(" · ") })),
    ...appointments.map(row => ({ id: `agenda-${row.id}`, date: value(row, "completed_at") || value(row, "starts_at") || value(row, "due_at") || value(row, "created_at"), type: value(row, "activity_type") || "agenda", title: value(row, "title"), lead: names.get(value(row, "related_id")) || "Lead não disponível", status: value(row, "status"), notes: value(row, "description") })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const visits = completed.filter(row => /visita/i.test(value(row, "action_type"))).length + completedAgenda.filter(row => /visita/i.test(value(row, "activity_type"))).length;
  const acknowledgment = received.filter(row => value(row, "acknowledged_at") && Date.parse(value(row, "acknowledged_at")) >= Date.parse(value(row, "assigned_at")));
  const acknowledgmentHours = acknowledgment.length ? acknowledgment.reduce((sum, row) => sum + (Date.parse(value(row, "acknowledged_at")) - Date.parse(value(row, "assigned_at"))) / 3600000, 0) / acknowledgment.length : null;
  return { received, current, open, missingNext, actions, appointments, completedCount: completed.length + completedAgenda.length, visits, proposals, reservations, contracts, salesValue, pending, pendingAgenda, lines, acknowledgmentHours };
}
export function reportCsv(rows: string[][]): string {
  return '\uFEFF' + rows.map(row => row.map(cell => '"' + (/^[=+@\-\t\r]/.test(cell) ? "'" + cell : cell).replaceAll('"', '""') + '"').join(';')).join('\r\n');
}
