import type { SupabaseClient } from "npm:@supabase/supabase-js@2.110.7";
import { isObject, ManagerError, operationKey, UUID, type Obj } from "./arisa-manager.ts";
import { googleToken } from "./arisa-mail.ts";
import { mailService } from "./arisa-mail-runtime.ts";
import { calendarId, eventId, eventInput, googleCalendar, participants, requireMeetingContext, safeEvent, timeRange, timezone } from "./arisa-calendar.ts";

type Context = { requestId: string; messageId?: string; lease?: string };
export async function calendarService(admin: SupabaseClient, action: string, org: string, actor: string, args: Obj = {}): Promise<Obj> {
  const result = await admin.rpc("arisa_calendar_service", { p_action: action, p_org: org, p_actor: actor, p_args: args });
  if (result.error) throw new ManagerError(/^[A-Z_]+$/.test(result.error.message) ? result.error.message : "CALENDAR_ARCHIVE_FAILED", result.error.code === "42501" ? 403 : 409);
  return isObject(result.data) ? result.data : {};
}
const eventPath = (calendar: string, id: string) => `calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(id)}`;
async function busyEvents(access: string, calendar: string, start: string, end: string, ignore?: string) {
  const params = new URLSearchParams({ timeMin: start, timeMax: end, singleEvents: "true", orderBy: "startTime", maxResults: "250" });
  const busy: Obj[] = []; let pages = 0;
  do {
    const result = await googleCalendar(access, `calendars/${encodeURIComponent(calendar)}/events?` + params);
    const events = Array.isArray(result.items) ? result.items.filter(isObject) : [];
    busy.push(...events.filter(e => e.id !== ignore && e.status !== "cancelled" && e.transparency !== "transparent" && !(Array.isArray(e.attendees) && e.attendees.filter(isObject).some(p => p.self === true && p.responseStatus === "declined"))));
    if (!result.nextPageToken) return busy.map(e => safeEvent(e, calendar));
    params.set("pageToken", String(result.nextPageToken)); pages++;
  } while (pages < 4);
  throw new ManagerError("CALENDAR_LIMIT", 409); // Never schedule against an incomplete conflict scan.
}
async function finish(admin: SupabaseClient, org: string, actor: string, op: Obj, event: Obj) {
  const communication = calendarCommunication(event, String(op.action));
  try { return { ...await calendarService(admin, "finish", org, actor, { id: op.id, event: safeEvent(event, String(op.calendar_id)) }), communication }; }
  catch {
    await calendarService(admin, "fail", org, actor, { id: op.id, status: "unknown", error: "CALENDAR_ARCHIVE_FAILED" }).catch(() => {});
    return { ok: false, operation_id: op.id, status: "unknown", provider_confirmed: true, event: safeEvent(event, String(op.calendar_id)), communication, message: "O evento existe no Google. Falta conferir o registro interno; não repita a criação." };
  }
}
function calendarCommunication(event: Obj, action: string): Obj {
  return { kind: "calendar_invitation", action, provider: "Google Calendar", notifications_requested: Array.isArray(event.attendees) && event.attendees.length > 0,
    email_sent: false, delivery_confirmed: false, attendee_acceptance_confirmed: false,
    note: "Esta operação trata o convite da agenda. E-mail de acompanhamento é uma etapa separada: use send_email com calendar_event_id quando solicitado." };
}
async function reconcile(admin: SupabaseClient, org: string, actor: string, access: string, op: Obj) {
  if (op.status === "completed") {
    const stored = isObject(op.result) ? op.result : {};
    return { ...stored, communication: calendarCommunication(isObject(stored.event) ? stored.event : {}, String(op.action)), replayed: true };
  }
  if (op.status === "running" && Date.now() - Date.parse(String(op.updated_at)) < 120000) return { ok: false, operation_id: op.id, status: "running", message: "Já existe uma operação em andamento. Aguarde; não repetir o evento ou convite." };
  try {
    const event = await googleCalendar(access, eventPath(String(op.calendar_id), String(op.provider_event_id)));
    const properties = isObject(event.extendedProperties) && isObject(event.extendedProperties.private) ? event.extendedProperties.private : {};
    if ((op.action === "create" && properties.arisaOperationKey === op.operation_key) || (op.action === "update" && properties.arisaLastOperation === op.operation_key) || (op.action === "cancel" && event.status === "cancelled")) return finish(admin, org, actor, op, event);
    return { ok: false, operation_id: op.id, status: "unknown", event: safeEvent(event, String(op.calendar_id)), message: "Evento localizado, mas o resultado desta operação não foi comprovado. Não repetir automaticamente." };
  } catch (error) {
    if (op.action === "cancel" && error instanceof ManagerError && error.code === "CALENDAR_NOT_FOUND") return finish(admin, org, actor, op, { id: op.provider_event_id, status: "cancelled", summary: "Evento cancelado" });
    if (error instanceof ManagerError && error.code === "CALENDAR_NOT_FOUND") return { ok: false, operation_id: op.id, status: "unknown", message: "O evento ainda não foi localizado. Nenhum novo convite foi disparado; confira novamente antes de criar outro." };
    throw error;
  }
}

export async function runCalendarTool(admin: SupabaseClient, org: string, actor: string, action: string, args: Obj = {}, context?: Context): Promise<Obj> {
  const status = await mailService(admin, "status", org, actor);
  if (action === "status") return { connected: status.connected === true && status.calendar_authorized === true, mailbox: status.connected_email, calendar_authorized: status.calendar_authorized === true, configuration: "/arisa?painel=email", timezone: "America/Sao_Paulo" };
  if (status.connected !== true || status.calendar_authorized !== true) throw new ManagerError("CALENDAR_AUTH_REQUIRED", 409);
  const config = await mailService(admin, "runtime", org, actor), token = await googleToken(config), access = String(token.access_token);
  if (action === "calendars") {
    const params = new URLSearchParams({ maxResults: "100" });
    if (typeof args.page_token === "string" && args.page_token.length <= 4096) params.set("pageToken", args.page_token);
    const result = await googleCalendar(access, "users/me/calendarList?" + params);
    return { calendars: Array.isArray(result.items) ? result.items.filter(isObject).map(c => ({ id: c.id, title: c.summary, timezone: c.timeZone, role: c.accessRole, primary: c.primary === true, conference: c.conferenceProperties })) : [], next_page: result.nextPageToken ?? null, checked_at: new Date().toISOString() };
  }
  const calendar = calendarId(args.calendar_id ?? "primary");
  if (action === "list") {
    const range = timeRange(args.start, args.end), zone = timezone(args.timezone), params = new URLSearchParams({ timeMin: range.start, timeMax: range.end, timeZone: zone, singleEvents: "true", orderBy: "startTime", maxResults: "50" });
    if (typeof args.query === "string") params.set("q", args.query.slice(0, 250));
    if (typeof args.page_token === "string" && args.page_token.length <= 4096) params.set("pageToken", args.page_token);
    const result = await googleCalendar(access, `calendars/${encodeURIComponent(calendar)}/events?` + params);
    return { events: Array.isArray(result.items) ? result.items.filter(isObject).map(e => safeEvent(e, calendar)) : [], next_page: result.nextPageToken ?? null, timezone: result.timeZone ?? zone, checked_at: new Date().toISOString() };
  }
  if (action === "availability") {
    const range = timeRange(args.start, args.end, 31), zone = timezone(args.timezone);
    const ids = [...new Set([calendar, ...participants(args.attendees ?? [])])];
    if (ids.length > 50) throw new ManagerError("CALENDAR_INVALID", 422);
    const result = await googleCalendar(access, "freeBusy", { method: "POST", body: JSON.stringify({ timeMin: range.start, timeMax: range.end, timeZone: zone, items: ids.map(id => ({ id })) }) });
    const calendars = isObject(result.calendars) ? result.calendars : {};
    const availability = ids.map(id => { const item = isObject(calendars[id]) ? calendars[id] : null; return { calendar: id, known: Boolean(item && !item.errors && Array.isArray(item.busy)), busy: Array.isArray(item?.busy) ? item.busy : null, error: item?.errors ? "calendar_not_shared_or_unavailable" : !item ? "missing_response" : null }; });
    return { start: range.start, end: range.end, timezone: zone, availability, complete: availability.every(i => i.known), checked_at: new Date().toISOString(), note: "Agenda não compartilhada não significa horário livre. Convite enviado também não significa aceite." };
  }
  if (action === "get") {
    const event = await googleCalendar(access, eventPath(calendar, eventId(args.event_id)));
    await calendarService(admin, "refresh", org, actor, { event: safeEvent(event, calendar) });
    return { event: safeEvent(event, calendar) };
  }
  if (action === "reconcile") {
    if (typeof args.operation_id !== "string" || !UUID.test(args.operation_id)) throw new ManagerError("CALENDAR_INVALID", 422);
    return reconcile(admin, org, actor, access, await calendarService(admin, "get_operation", org, actor, { id: args.operation_id }));
  }
  if (!["create", "update", "cancel"].includes(action) || !context || !UUID.test(context.requestId)) throw new ManagerError("CALENDAR_INVALID", 422);
  const mutation = action === "cancel" ? {} : eventInput(args, action === "update");
  const target = action === "create" ? "new" : eventId(args.event_id);
  if (action !== "create" && (typeof args.etag !== "string" || !args.etag || args.etag.length > 1024 || /[\r\n\0]/.test(args.etag))) throw new ManagerError("CALENDAR_CHANGED", 409);
  const key = await operationKey("calendar_" + action, { actor, request: context.requestId, target });
  const id = action === "create" ? "a" + key : target;
  const op = await calendarService(admin, "prepare", org, actor, { action, operation_key: key, payload_hash: await operationKey(action, args), calendar_id: calendar, event_id: id, message_id: context.messageId ?? null, lease: context.lease ?? null });
  if (!op.proceed) return reconcile(admin, org, actor, access, op);
  let writeStarted = false;
  try {
    let before: Obj = {};
    if (action !== "create") {
      before = await googleCalendar(access, eventPath(calendar, id));
      if (before.etag !== args.etag) throw new ManagerError("CALENDAR_CHANGED", 412);
      if (before.recurrence) throw new ManagerError("CALENDAR_INVALID", 422); // Edit an occurrence, not an entire recurring series implicitly.
    }
    // PATCH omits unchanged fields. Validate the effective event, including retained guests
    // and description, before any provider write can trigger an empty invitation.
    if (action !== "cancel") requireMeetingContext({ ...before, ...mutation });
    if (action !== "cancel" && mutation.start && mutation.end) {
      const busy = await busyEvents(access, calendar, String((mutation.start as Obj).dateTime), String((mutation.end as Obj).dateTime), action === "update" ? id : undefined);
      if (busy.length && args.allow_conflict !== true) {
        await calendarService(admin, "fail", org, actor, { id: op.id, status: "failed", error: "CALENDAR_CONFLICT" });
        return { ok: false, status: "conflict", conflicts: busy, message: "Há compromisso sobreposto. Sugira outro horário ou peça autorização explícita para manter a sobreposição." };
      }
    }
    const params = new URLSearchParams({ sendUpdates: "all", ...(action === "cancel" ? {} : { conferenceDataVersion: "1" }) });
    let result: Obj;
    if (action === "cancel") {
      writeStarted = true;
      await googleCalendar(access, eventPath(calendar, id) + "?" + params, { method: "DELETE", headers: { "If-Match": String(args.etag) } });
      result = { ...before, status: "cancelled", conferenceData: null, hangoutLink: null };
    } else {
      const original = isObject(before.extendedProperties) ? before.extendedProperties : {}, priv = isObject(original.private) ? original.private : {};
      const body: Obj = { ...mutation, extendedProperties: { ...original, private: { ...priv, ...(action === "create" ? { arisaOperationKey: key } : {}), arisaLastOperation: key } } };
      if (action === "create") { body.id = id; body.guestsCanModify = false; }
      if (action === "update" && Array.isArray(body.attendees)) {
        const previous = Array.isArray(before.attendees) ? before.attendees.filter(isObject) : [];
        body.attendees = body.attendees.filter(isObject).map(person => { const existing = previous.find(p => String(p.email).toLowerCase() === person.email); return existing ? { ...person, responseStatus: existing.responseStatus, optional: existing.optional } : person; });
      }
      if ((action === "create" && args.meet !== false) || (args.meet === true && !safeEvent(before, calendar).meet_url)) {
        body.conferenceData = { createRequest: { requestId: String(op.id), conferenceSolutionKey: { type: "hangoutsMeet" } } };
      }
      writeStarted = true;
      try {
        result = await googleCalendar(access, action === "create" ? `calendars/${encodeURIComponent(calendar)}/events?${params}` : eventPath(calendar, id) + "?" + params, { method: action === "create" ? "POST" : "PATCH", ...(action === "update" ? { headers: { "If-Match": String(args.etag) } } : {}), body: JSON.stringify(body) });
      } catch (error) {
        if (action === "create" && error instanceof ManagerError && error.code === "CALENDAR_ALREADY_EXISTS") {
          result = await googleCalendar(access, eventPath(calendar, id));
          const properties = isObject(result.extendedProperties) && isObject(result.extendedProperties.private) ? result.extendedProperties.private : {};
          if (properties.arisaOperationKey !== key) throw new ManagerError("CALENDAR_BUSY", 409);
        } else throw error;
      }
      if (result.id !== id) throw new ManagerError("CALENDAR_UNAVAILABLE", 502);
      // Google can return the event before it has generated the conference URL.
      for (let attempt = 0; attempt < 3 && safeEvent(result, calendar).meet_status === "pending"; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
        try { result = await googleCalendar(access, eventPath(calendar, id)); } catch { break; }
      }
    }
    return finish(admin, org, actor, op, result);
  } catch (error) {
    const knownRejection = error instanceof ManagerError && [400,401,403,404,410,412,413,422,429].includes(error.status);
    const code = error instanceof ManagerError ? error.code : "CALENDAR_UNAVAILABLE", status = !writeStarted || knownRejection ? "failed" : "unknown";
    await calendarService(admin, "fail", org, actor, { id: op.id, status, error: code }).catch(() => {});
    if (status === "unknown") return { ok: false, status, operation_id: op.id, message: "Resultado em conferência. Use calendar_reconcile; não repetir a criação, alteração ou convite." };
    throw error;
  }
}
