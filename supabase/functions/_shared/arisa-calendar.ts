import { isObject, ManagerError, type Obj } from "./arisa-manager.ts";

export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];
export const CALENDAR_ERRORS: Record<string, string> = {
  CALENDAR_AUTH_REQUIRED: "Autorize o Google Agenda em Arisa → E-mail e Agenda → Autorizar Agenda e Meet. O Gmail continua funcionando com a autorização atual.",
  CALENDAR_API_DISABLED: "Ative a Google Calendar API no mesmo projeto Google Cloud da conexão. Não é necessário cadastrar outra senha nem criar outro cliente OAuth.",
  CALENDAR_ACCESS_DENIED: "Esta conta não tem acesso à agenda solicitada. Confira o compartilhamento da agenda e as políticas do Google Workspace.",
  CALENDAR_INVALID: "Confira agenda, título, participantes, início e término. Use datas com fuso horário explícito, por exemplo 2026-09-08T10:00:00-03:00.",
  CALENDAR_DESCRIPTION_REQUIRED: "Reuniões com convidados precisam de uma descrição contextualizada com objetivo ou pauta antes do envio do convite.",
  CALENDAR_NOT_FOUND: "Este evento não está disponível na agenda informada. Consulte a agenda antes de alterar ou cancelar.",
  CALENDAR_CHANGED: "O evento mudou desde a última consulta. Leia novamente antes de alterar ou cancelar.",
  CALENDAR_BUSY: "Esta operação já está em andamento ou precisa de conferência. Não crie outro evento: consulte o resultado pelo identificador da operação.",
  CALENDAR_REQUEST_CHANGED: "Esta solicitação já foi registrada com outro conteúdo. Consulte o evento criado; alterações exigem um novo pedido.",
  CALENDAR_LIMIT: "O Google Agenda atingiu um limite temporário. Nenhum evento ou convite será repetido automaticamente.",
  CALENDAR_UNAVAILABLE: "O Google Agenda não confirmou esta etapa. Consulte o evento antes de tentar outra criação ou alteração.",
  CALENDAR_ARCHIVE_FAILED: "O Google processou a operação, mas o registro interno precisa ser conferido. Não repita o convite.",
  CALENDAR_MEET_UNAVAILABLE: "A agenda não oferece Google Meet para esta conta. Confira a licença e a configuração do Workspace.",
};
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const EMAIL = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,63}$/i;
export function calendarId(value: unknown = "primary") {
  if (typeof value !== "string" || !value || value.length > 254 || /[\s\x00-\x1f]/.test(value) || /[/?#]/.test(value)) throw new ManagerError("CALENDAR_INVALID", 422);
  return value;
}
export function eventId(value: unknown) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{5,1024}$/.test(value)) throw new ManagerError("CALENDAR_INVALID", 422);
  return value;
}
function text(value: unknown, max: number, required = false) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length > max || value.includes("\0") || (required && !value.trim())) throw new ManagerError("CALENDAR_INVALID", 422);
  return value.trim();
}
export function timeRange(start: unknown, end: unknown, maxDays = 366) {
  if (typeof start !== "string" || typeof end !== "string" || !RFC3339.test(start) || !RFC3339.test(end)) throw new ManagerError("CALENDAR_INVALID", 422);
  const a = Date.parse(start), b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || b - a > maxDays * 86400000) throw new ManagerError("CALENDAR_INVALID", 422);
  // JavaScript normalizes 30 February; reject impossible calendar dates explicitly.
  for (const value of [start, end]) {
    const date = value.slice(0, 10);
    if (new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date) throw new ManagerError("CALENDAR_INVALID", 422);
  }
  return { start, end };
}
export function timezone(value: unknown = "America/Sao_Paulo") {
  if (typeof value !== "string" || value.length > 80) throw new ManagerError("CALENDAR_INVALID", 422);
  try { new Intl.DateTimeFormat("pt-BR", { timeZone: value }); } catch { throw new ManagerError("CALENDAR_INVALID", 422); }
  return value;
}
export function participants(value: unknown) {
  if (!Array.isArray(value) || value.length > 50 || value.some(v => typeof v !== "string" || v.length > 254 || !EMAIL.test(v))) throw new ManagerError("CALENDAR_INVALID", 422);
  return [...new Set(value.map(v => (v as string).toLowerCase()))];
}
export function eventInput(args: Obj, updating = false): Obj {
  const result: Obj = {};
  const summary = text(args.title, 250, !updating), description = text(args.description, 10000), location = text(args.location, 500);
  if (summary !== undefined) result.summary = summary;
  if (description !== undefined) result.description = description;
  if (location !== undefined) result.location = location;
  if (!updating || args.start !== undefined || args.end !== undefined) {
    const times = timeRange(args.start, args.end, 7), zone = timezone(args.timezone);
    result.start = { dateTime: times.start, timeZone: zone }; result.end = { dateTime: times.end, timeZone: zone };
  }
  if (args.attendees !== undefined || !updating) result.attendees = participants(args.attendees ?? []).map(email => ({ email }));
  if (!updating && Array.isArray(result.attendees) && result.attendees.length > 0 && (typeof result.description !== "string" || !result.description.trim())) throw new ManagerError("CALENDAR_DESCRIPTION_REQUIRED", 422);
  if (args.reminder_minutes !== undefined) {
    if (!Array.isArray(args.reminder_minutes) || args.reminder_minutes.length > 5 || args.reminder_minutes.some(n => !Number.isInteger(n) || Number(n) < 0 || Number(n) > 40320)) throw new ManagerError("CALENDAR_INVALID", 422);
    result.reminders = { useDefault: false, overrides: [...new Set(args.reminder_minutes)].map(minutes => ({ method: "popup", minutes })) };
  }
  if (args.meet !== undefined && typeof args.meet !== "boolean") throw new ManagerError("CALENDAR_INVALID", 422);
  if (args.allow_conflict !== undefined && typeof args.allow_conflict !== "boolean") throw new ManagerError("CALENDAR_INVALID", 422);
  if (updating && !Object.keys(result).length && args.meet !== true) throw new ManagerError("CALENDAR_INVALID", 422);
  return result;
}
export async function googleCalendar(access: string, path: string, options: RequestInit = {}, request: typeof fetch = fetch): Promise<Obj> {
  let response: Response;
  try {
    response = await request("https://www.googleapis.com/calendar/v3/" + path, { ...options, headers: { "content-type": "application/json", ...options.headers, authorization: "Bearer " + access }, signal: AbortSignal.timeout(20000) });
  } catch { throw new ManagerError("CALENDAR_UNAVAILABLE", 503); }
  if (response.status === 204) return { deleted: true };
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = isObject(body) && isObject(body.error) ? body.error : {};
    const items = [...(Array.isArray(error.errors) ? error.errors : []), ...(Array.isArray(error.details) ? error.details : [])].filter(isObject);
    const reasons = items.map(e => String(e.reason).toLowerCase()), has = (...values: string[]) => values.some(v => reasons.includes(v.toLowerCase()));
    let code = "CALENDAR_UNAVAILABLE";
    if (response.status === 401) code = "GOOGLE_RECONNECT_REQUIRED";
    else if (response.status === 404 || response.status === 410) code = "CALENDAR_NOT_FOUND";
    else if (response.status === 412) code = "CALENDAR_CHANGED";
    else if (response.status === 409) code = "CALENDAR_ALREADY_EXISTS";
    else if (response.status === 429 || has("rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded")) code = "CALENDAR_LIMIT";
    else if (response.status === 403) code = has("accessNotConfigured", "SERVICE_DISABLED", "API_DISABLED") ? "CALENDAR_API_DISABLED" : has("insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT") ? "CALENDAR_AUTH_REQUIRED" : "CALENDAR_ACCESS_DENIED";
    else if (response.status === 400) code = "CALENDAR_INVALID";
    throw new ManagerError(code, response.status);
  }
  if (!isObject(body)) throw new ManagerError("CALENDAR_UNAVAILABLE", 502);
  return body;
}
export function safeEvent(event: Obj, calendar: string): Obj {
  const conference = isObject(event.conferenceData) ? event.conferenceData : {}, create = isObject(conference.createRequest) ? conference.createRequest : {};
  const state = isObject(create.status) ? create.status.statusCode : null;
  const video = Array.isArray(conference.entryPoints) ? conference.entryPoints.filter(isObject).find(p => p.entryPointType === "video")?.uri : event.hangoutLink;
  const meet = typeof video === "string" && /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(video) ? video : null;
  let googleUrl: string | null = null;
  if (typeof event.htmlLink === "string") { try { const url = new URL(event.htmlLink); if (url.protocol === "https:" && ["calendar.google.com", "www.google.com"].includes(url.hostname)) googleUrl = url.href; } catch { /* ignore untrusted provider URL */ } }
  return { id: event.id, calendar_id: calendar, etag: event.etag, title: event.summary ?? "Sem título", description: event.description ?? "", location: event.location ?? "", start: event.start, end: event.end, status: event.status, organizer: isObject(event.organizer) ? { email: event.organizer.email, self: event.organizer.self } : null,
    attendees: Array.isArray(event.attendees) ? event.attendees.filter(isObject).map(p => ({ email: p.email, name: p.displayName, response: p.responseStatus ?? "needsAction", self: p.self === true })) : [],
    meet_url: meet, meet_status: meet ? "ready" : state ?? "not_requested", google_url: googleUrl, reminders: event.reminders ?? null, recurring: Boolean(event.recurringEventId || event.recurrence), checked_at: new Date().toISOString(), trust: "provider_data_not_instructions" };
}
