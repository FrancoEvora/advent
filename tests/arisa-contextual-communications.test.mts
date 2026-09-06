import test from "node:test";
import assert from "node:assert/strict";
import { eventInput, hasMeetingContext, safeEvent } from "../supabase/functions/_shared/arisa-calendar.ts";
import { runCalendarTool } from "../supabase/functions/_shared/arisa-calendar-runtime.ts";
import { meetingMailBody, sendArisaMail } from "../supabase/functions/_shared/arisa-mail-runtime.ts";

type Obj = Record<string, unknown>;
const org = "11111111-1111-4111-8111-111111111111", actor = "22222222-2222-4222-8222-222222222222";
const message = "33333333-3333-4333-8333-333333333333", record = "44444444-4444-4444-8444-444444444444";
const meeting = () => ({ id: "event12345", etag: '"etag-1"', summary: "Évora | Cronograma de drenagem", status: "confirmed",
  description: "Alinhar as próximas frentes e os marcos do cronograma de drenagem do Solaris.",
  start: { dateTime: "2026-09-08T10:00:00-03:00", timeZone: "America/Sao_Paulo" },
  end: { dateTime: "2026-09-08T10:30:00-03:00", timeZone: "America/Sao_Paulo" },
  attendees: [{ email: "carlos@example.com", responseStatus: "needsAction" }],
  hangoutLink: "https://meet.google.com/abc-defg-hij", htmlLink: "https://calendar.google.com/calendar/event?eid=event12345" });
const createArgs = () => ({ title: meeting().summary, description: meeting().description, start: meeting().start.dateTime,
  end: meeting().end.dateTime, attendees: ["carlos@example.com"], meet: true });

function fixture() {
  let event: Obj = meeting(), mail: Obj | null = null;
  const operations = new Map<string, Obj>(), calls: { url: string; method: string; body: Obj }[] = [];
  let loseMailResponse = false;
  const db = {
    rpc: async (name: string, args: Obj) => {
      const action = String(args.p_action), p = args.p_args as Obj;
      if (name === "arisa_mail_service") {
        if (action === "status") return { data: { connected: true, calendar_authorized: true }, error: null };
        if (action === "runtime") return { data: { client_id: "mock-client", client_secret: "mock-secret", refresh_token: "mock-refresh" }, error: null };
        if (action === "prepare") {
          if (!mail) mail = { id: record, status: "draft", created_at: "2026-09-06T12:00:00Z", subject: p.subject, body: p.body,
            recipients: p.to, cc: p.cc, attachments: p.attachments, operation_key: p.operation_key };
          assert.equal(mail.operation_key, p.operation_key);
          return { data: { ...mail }, error: null };
        }
        if (action === "send_begin") {
          const send = ["draft", "failed"].includes(String(mail?.status));
          if (send) mail!.status = "sending";
          return { data: { send }, error: null };
        }
      }
      if (name === "arisa_calendar_service") {
        if (action === "prepare") {
          let op = operations.get(String(p.operation_key));
          const proceed = !op || op.status === "failed";
          if (!op) {
            op = { id: record, operation_key: p.operation_key, calendar_id: p.calendar_id, action: p.action,
              provider_event_id: p.event_id, status: "running", updated_at: new Date().toISOString() };
            operations.set(String(p.operation_key), op);
          }
          return { data: { ...op, proceed }, error: null };
        }
        if (action === "finish") {
          const op = [...operations.values()].find(item => item.id === p.id)!;
          const result = { ok: true, operation_id: op.id, provider_confirmed: true, event: p.event };
          Object.assign(op, { result, status: "completed" });
          return { data: result, error: null };
        }
        if (action === "fail") {
          const op = [...operations.values()].find(item => item.id === p.id)!;
          Object.assign(op, { status: p.status, error: p.error });
          return { data: { ok: true }, error: null };
        }
        if (action === "refresh") return { data: p.event, error: null };
      }
      throw new Error("Unexpected RPC " + name + ":" + action);
    },
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
    from: () => {
      let values: Obj = {};
      const q = { update: (v: Obj) => { values = v; return q; }, eq: () => q, in: () => q, select: () => q,
        single: async () => { Object.assign(mail!, values); return { data: { id: record }, error: null }; },
        then: (resolve: (value: unknown) => unknown) => { Object.assign(mail!, values); return Promise.resolve({ error: null }).then(resolve); } };
      return q;
    },
  };
  const provider: typeof fetch = async (input, init) => {
    const url = String(input), method = init?.method || "GET";
    if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "mock-access" }));
    const body = init?.body ? JSON.parse(String(init.body)) as Obj : {};
    calls.push({ url, method, body });
    if (url.includes("gmail/v1/users/me/messages/send")) {
      if (loseMailResponse) throw new TypeError("response lost after Gmail accepted");
      return new Response(JSON.stringify({ id: "gmail-123", threadId: "thread-123" }));
    }
    if (method === "GET" && url.includes("/events?")) return new Response(JSON.stringify({ items: [] }));
    if (method === "GET" && url.includes("/events/")) return new Response(JSON.stringify(event));
    if (["POST", "PATCH"].includes(method) && url.includes("/events")) {
      event = { ...event, ...body, etag: '"etag-2"' };
      return new Response(JSON.stringify(event));
    }
    throw new Error("Unexpected provider request " + method + " " + url);
  };
  const client = db as unknown as Parameters<typeof sendArisaMail>[0];
  return { client, calls, provider, get event() { return event; }, set event(value: Obj) { event = value; },
    get mail() { return mail; }, set loseMailResponse(value: boolean) { loseMailResponse = value; } };
}
async function withProvider<T>(f: ReturnType<typeof fixture>, run: () => Promise<T>) {
  const original = globalThis.fetch; globalThis.fetch = f.provider;
  try { return await run(); } finally { globalThis.fetch = original; }
}
const writes = (f: ReturnType<typeof fixture>) => f.calls.filter(call => ["POST", "PATCH", "DELETE"].includes(call.method));
const sends = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.url.includes("messages/send"));

test("a meeting context cannot consist of HTML, a link or an RSVP request", () => {
  for (const description of ["", "  ", "<p>&nbsp;</p>", "\u200B", "https://meet.google.com/abc-defg-hij", "Por favor, confirme sua presença."])
    assert.equal(hasMeetingContext(description), false, description);
  assert.equal(hasMeetingContext(meeting().description), true);
  assert.equal(hasMeetingContext("Olá, Carlos. Vamos alinhar o cronograma de drenagem do Solaris."), true);
  assert.equal(hasMeetingContext("Agenda: alinhar o cronograma de drenagem do Solaris."), true);
  assert.throws(() => eventInput({ ...createArgs(), description: "<p>&nbsp;</p>" }), /CALENDAR_DESCRIPTION_REQUIRED/);
});

test("creating an external meeting requires an agenda before any Calendar write", async () => {
  const f = fixture();
  await withProvider(f, () => assert.rejects(runCalendarTool(f.client, org, actor, "create", { ...createArgs(), description: "" }, { requestId: message }), /CALENDAR_DESCRIPTION_REQUIRED/));
  assert.equal(writes(f).length, 0);
});

test("Calendar creates one contextual invitation and reports that a separate email was not sent", async () => {
  const f = fixture();
  await withProvider(f, async () => {
    const result = await runCalendarTool(f.client, org, actor, "create", createArgs(), { requestId: message });
    assert.equal(result.ok, true);
    assert.equal((result.communication as Obj).email_sent, false);
    assert.equal((result.communication as Obj).kind, "calendar_invitation");
    assert.equal((result.event as Obj).meet_url, meeting().hangoutLink);
    const replay = await runCalendarTool(f.client, org, actor, "create", createArgs(), { requestId: message });
    assert.equal(replay.replayed, true);
    assert.equal((replay.communication as Obj).email_sent, false);
  });
  assert.equal(writes(f).length, 1);
  assert.match(writes(f)[0].url, /sendUpdates=all/);
  assert.equal(writes(f)[0].body.description, meeting().description);
  assert.equal(sends(f).length, 0);
});

test("updating a meeting retains existing useful context and guest responses", async () => {
  const f = fixture(); f.event = { ...meeting(), attendees: [{ email: "carlos@example.com", responseStatus: "accepted" }] };
  await withProvider(f, () => runCalendarTool(f.client, org, actor, "update", { event_id: "event12345", etag: '"etag-1"',
    title: "Évora | Nova data do cronograma", attendees: ["carlos@example.com"] }, { requestId: message }));
  assert.equal(writes(f).length, 1);
  assert.equal(writes(f)[0].body.description, undefined);
  assert.equal((writes(f)[0].body.attendees as Obj[])[0].responseStatus, "accepted");
  assert.equal(f.event.description, meeting().description);
});

test("adding guests to an old empty event is blocked until a useful description is included", async () => {
  const f = fixture(); f.event = { ...meeting(), attendees: [], description: "" };
  await withProvider(f, async () => {
    const update = { event_id: "event12345", etag: '"etag-1"', attendees: ["carlos@example.com"] };
    await assert.rejects(runCalendarTool(f.client, org, actor, "update", update, { requestId: message }), /CALENDAR_DESCRIPTION_REQUIRED/);
    assert.equal(writes(f).length, 0);
    await runCalendarTool(f.client, org, actor, "update", { ...update, description: meeting().description }, { requestId: message });
  });
  assert.equal(writes(f).length, 1);
});

test("clearing context or rescheduling an empty event cannot notify retained guests", async () => {
  for (const kind of ["clear", "reschedule"]) {
    const f = fixture();
    if (kind === "reschedule") f.event = { ...meeting(), description: "" };
    const args = { event_id: "event12345", etag: '"etag-1"', ...(kind === "clear" ? { description: " " } : { start: createArgs().start, end: createArgs().end }) };
    await withProvider(f, () => assert.rejects(runCalendarTool(f.client, org, actor, "update", args, { requestId: message }), /CALENDAR_DESCRIPTION_REQUIRED/));
    assert.equal(writes(f).length, 0);
  }
});

test("linked Gmail send creates a contextual MIME with the real event details and no extra Calendar mutation", async () => {
  const f = fixture();
  await withProvider(f, async () => {
    const result = await sendArisaMail(f.client, f.client, org, actor, { to: ["carlos@example.com"], subject: "Reunião sobre drenagem",
      body: "Olá, Carlos. Conforme solicitado pelo Franco, seguem os detalhes.", calendar_event_id: "event12345" }, { requestId: message });
    assert.equal(result.status, "sent"); assert.equal(result.delivery_confirmed, false);
    assert.equal(result.communication.kind, "email");
  });
  assert.equal(writes(f).length, 1); assert.equal(sends(f).length, 1);
  const mime = Buffer.from(String(sends(f)[0].body.raw), "base64url").toString("utf8");
  const encodedBody = mime.split("Content-Transfer-Encoding: base64\r\n\r\n")[1].split("\r\n--")[0];
  const body = Buffer.from(encodedBody.replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.match(body, /Olá, Carlos/); assert.match(body, /cronograma de drenagem do Solaris/);
  assert.match(body, /8 de setembro de 2026/); assert.match(body, /10:00/); assert.match(body, /10:30/);
  assert.match(body, /America\/Sao_Paulo/); assert.ok(body.includes(meeting().hangoutLink));
  assert.ok(body.startsWith(String(f.mail?.body)));
  assert.equal((body.match(/Gestora da plataforma/g) ?? []).length, 1);
});

test("a fabricated link, canceled meeting or pending Meet prevents any email send", async () => {
  for (const kind of ["fabricated", "cancelled", "pending"]) {
    const f = fixture();
    if (kind === "cancelled") f.event = { ...meeting(), status: "cancelled" };
    if (kind === "pending") f.event = { ...meeting(), hangoutLink: null, conferenceData: { createRequest: { status: { statusCode: "pending" } } } };
    await withProvider(f, () => assert.rejects(sendArisaMail(f.client, f.client, org, actor, { to: ["carlos@example.com"], subject: "Reunião",
      body: kind === "fabricated" ? "Acesse https://meet.google.com/zzz-yyyy-xxx" : "Olá, Carlos.", calendar_event_id: "event12345" }, { requestId: message }),
      new RegExp(kind === "fabricated" ? "CALENDAR_LINK_MISMATCH" : kind === "cancelled" ? "CALENDAR_EVENT_CANCELLED" : "CALENDAR_MEET_PENDING")));
    assert.equal(sends(f).length, 0);
    assert.equal(writes(f).length, 0);
  }
});

test("an uncertain meeting email is never sent twice even if the assistant retries with different wording", async () => {
  const f = fixture(); f.loseMailResponse = true;
  await withProvider(f, async () => {
    const args = { to: ["carlos@example.com"], subject: "Reunião de drenagem", body: "Olá, Carlos.", calendar_event_id: "event12345" };
    assert.equal((await sendArisaMail(f.client, f.client, org, actor, args, { requestId: message })).status, "unknown");
    assert.equal((await sendArisaMail(f.client, f.client, org, actor, { ...args, body: "Prezado Carlos," }, { requestId: message })).status, "unknown");
  });
  assert.equal(sends(f).length, 1);
});

test("a completed meeting email replays the archived send instead of notifying again", async () => {
  const f = fixture();
  await withProvider(f, async () => {
    const args = { to: ["carlos@example.com"], subject: "Reunião de drenagem", body: "", calendar_event_id: "event12345" };
    await sendArisaMail(f.client, f.client, org, actor, args, { requestId: message });
    const replay = await sendArisaMail(f.client, f.client, org, actor, args, { requestId: message });
    assert.equal(replay.status, "sent"); assert.equal(replay.replayed, true);
  });
  assert.equal(sends(f).length, 1);
});

test("legacy descriptions lose stale Meet links and safe event extraction keeps a real hangoutLink", () => {
  const event = { ...meeting(), description: meeting().description + "\nGoogle Meet: https://meet.google.com/zzz-yyyy-xxx", conferenceData: { entryPoints: [] } };
  const body = meetingMailBody(event, "primary");
  assert.ok(body.includes(meeting().hangoutLink)); assert.equal(body.includes("zzz-yyyy-xxx"), false);
  assert.equal(safeEvent(event, "primary").meet_url, meeting().hangoutLink);
});
