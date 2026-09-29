import test from "node:test";
import assert from "node:assert/strict";
import { createAgentApiHandler } from "../src/lib/agent-api/server.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const OTHER = "99999999-9999-4999-8999-999999999999";
const ID = "44444444-4444-4444-8444-444444444444";
const ID2 = "55555555-5555-4555-8555-555555555555";
const TOKEN = "Bearer header.payload.signature";
const baseEnv = {
  EVORA_AGENT_API_ENABLED: "true",
  NEXT_PUBLIC_SUPABASE_URL: "https://testproject.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
  EVORA_AGENT_API_PILOT_SCOPES: JSON.stringify([{ user_id: USER, organization_id: ORG, project_ids: [PROJECT] }]),
};
type Fixture = {
  env?: Record<string, string | undefined>;
  user?: unknown;
  member?: unknown;
  rows?: unknown;
  authStatus?: number;
  dataStatus?: number;
  dataBody?: string;
  throwNetwork?: boolean;
  auditThrows?: boolean;
};
function fixture(options: Fixture = {}) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const events: unknown[] = [];
  let clock = Date.parse("2026-09-29T23:30:00.000Z");
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (options.throwNetwork) throw new Error("SECRET failure with token and SQL");
    if (url.pathname === "/auth/v1/user") {
      return Response.json(options.user ?? { id: USER, role: "authenticated", is_anonymous: false }, { status: options.authStatus ?? 200 });
    }
    if (url.pathname === "/rest/v1/organization_members") {
      return Response.json(options.member ?? [{ user_id: USER, organization_id: ORG, role: "admin", active: true }]);
    }
    if (options.dataBody !== undefined) return new Response(options.dataBody, { status: options.dataStatus ?? 200 });
    return Response.json(options.rows ?? [{ id: ID, organization_id: ORG, project_id: PROJECT,
      person_name: "Cliente de teste", phone: "SECRET", cpf_cnpj: "SECRET", notes: "SECRET", lead_score: 70 }],
    { status: options.dataStatus ?? 200 });
  }) as typeof fetch;
  const handle = createAgentApiHandler({ env: { ...baseEnv, ...options.env }, fetch: fetcher,
    now: () => clock, audit: event => { if (options.auditThrows) throw new Error("audit"); events.push(event); } });
  return { handle, calls, events, advance: (ms: number) => { clock += ms; } };
}
function request(query = `project_id=${PROJECT}`, options: { method?: string; headers?: Record<string, string>; noAuth?: boolean } = {}) {
  return new Request(`https://enterprise.example/api/agent/v1/leads${query ? `?${query}` : ""}`, {
    method: options.method ?? "GET", headers: { ...(options.noAuth ? {} : { authorization: TOKEN }),
      "x-evora-organization-id": ORG, ...options.headers },
  });
}

for (const enabled of [undefined, "false", "1", "TRUE"]) {
  test(`disabled feature fails closed: ${enabled}`, async () => {
    const f = fixture({ env: { EVORA_AGENT_API_ENABLED: enabled } });
    const res = await f.handle(request(), ["leads"]);
    assert.equal(res.status, 503); assert.equal(f.calls.length, 0);
    assert.equal((await res.json()).error.code, "AGENT_API_DISABLED");
  });
}
for (const method of ["POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
  test(`no writes or implicit method side effects: ${method}`, async () => {
    const f = fixture(); const res = await f.handle(request("", { method }), ["leads"]);
    assert.equal(res.status, 405); assert.equal(res.headers.get("allow"), "GET"); assert.equal(f.calls.length, 0);
  });
}
for (const env of [
  { NEXT_PUBLIC_SUPABASE_URL: "http://testproject.supabase.co" },
  { NEXT_PUBLIC_SUPABASE_URL: "https://attacker.example" },
  { NEXT_PUBLIC_SUPABASE_URL: "https://testproject.supabase.co.attacker.example" },
  { NEXT_PUBLIC_SUPABASE_URL: "https://testproject.supabase.co/path" },
  { NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_never_use" },
  { NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "eyJ.service.role" },
  { EVORA_AGENT_API_PILOT_SCOPES: "[]" },
  { EVORA_AGENT_API_PILOT_SCOPES: "bad-json" },
  { EVORA_AGENT_API_PILOT_SCOPES: JSON.stringify([{ user_id: USER, organization_id: ORG, project_ids: [] }]) },
  { EVORA_AGENT_API_PILOT_SCOPES: JSON.stringify([{ user_id: USER, organization_id: ORG, project_ids: ["*"] }]) },
  { EVORA_AGENT_API_PILOT_SCOPES: JSON.stringify([{ user_id: USER, organization_id: ORG, project_ids: [PROJECT], admin: true }]) },
]) {
  test(`configuration is fail-closed: ${JSON.stringify(env)}`, async () => {
    const f = fixture({ env }); const res = await f.handle(request(), ["leads"]);
    assert.equal(res.status, 503); assert.equal(f.calls.length, 0);
    assert.equal((await res.json()).error.code, "AGENT_API_NOT_CONFIGURED");
  });
}
test("duplicate pilot entries do not merge or broaden access", async () => {
  const entry = { user_id: USER, organization_id: ORG, project_ids: [PROJECT] };
  const f = fixture({ env: { EVORA_AGENT_API_PILOT_SCOPES: JSON.stringify([entry, entry]) } });
  assert.equal((await f.handle(request(), ["leads"])).status, 503); assert.equal(f.calls.length, 0);
});
test("authentication required; no cookie fallback", async () => {
  const f = fixture(); const res = await f.handle(request(undefined, { noAuth: true, headers: { cookie: "session=fixture" } }), ["leads"]);
  assert.equal(res.status, 401); assert.match(res.headers.get("www-authenticate")!, /^Bearer/); assert.equal(f.calls.length, 0);
});
for (const token of ["Bearer sb_secret_test", "header.payload.signature", "Bearer invalid", `Bearer ${"a".repeat(9000)}`]) {
  test(`malformed or non-user credential rejected: ${token.slice(0, 35)}`, async () => {
    const f = fixture(); assert.equal((await f.handle(request(undefined, { headers: { authorization: token } }), ["leads"])).status, 401);
    assert.equal(f.calls.length, 0);
  });
}
for (const authStatus of [400, 401, 403, 404]) {
  test(`Supabase Auth rejection ${authStatus} prevents any data query`, async () => {
    const f = fixture({ authStatus }); assert.equal((await f.handle(request(), ["leads"])).status, 401); assert.equal(f.calls.length, 1);
  });
}
for (const user of [{ id: USER, role: "service_role" }, { id: USER, role: "authenticated", is_anonymous: true }, { id: "wrong", role: "authenticated" }]) {
  test(`non-user principal rejected: ${JSON.stringify(user)}`, async () => {
    const f = fixture({ user }); assert.equal((await f.handle(request(), ["leads"])).status, 401); assert.equal(f.calls.length, 1);
  });
}
test("user metadata cannot authorize access", async () => {
  const f = fixture({ user: { id: OTHER, role: "authenticated", user_metadata: { role: "admin", user_id: USER } } });
  assert.equal((await f.handle(request(), ["leads"])).status, 403); assert.equal(f.calls.length, 1);
});
for (const member of [[], [{ user_id: USER, organization_id: ORG, role: "admin", active: false }],
  [{ user_id: USER, organization_id: ORG, role: "corretor", active: true }],
  [{ user_id: USER, organization_id: ORG, role: "diretoria", active: true }],
  [{ user_id: OTHER, organization_id: ORG, role: "admin", active: true }],
  [{ user_id: USER, organization_id: OTHER, role: "admin", active: true }]]) {
  test(`membership must be current, matching and admin: ${JSON.stringify(member)}`, async () => {
    const f = fixture({ member }); assert.equal((await f.handle(request(), ["leads"])).status, 403); assert.equal(f.calls.length, 2);
  });
}
test("organization cannot be switched", async () => {
  const f = fixture(); assert.equal((await f.handle(request(undefined, { headers: { "x-evora-organization-id": OTHER } }), ["leads"])).status, 403);
  assert.equal(f.calls.length, 1);
});
test("project cannot be switched", async () => {
  const f = fixture(); assert.equal((await f.handle(request(`project_id=${OTHER}`), ["leads"])).status, 403); assert.equal(f.calls.length, 1);
});
for (const query of ["", "project_id=bad", `project_id=${PROJECT}&limit=0`, `project_id=${PROJECT}&limit=51`,
  `project_id=${PROJECT}&limit=1.5`, `project_id=${PROJECT}&limit=1&limit=2`,
  `project_id=${PROJECT}&cursor=bad`, `project_id=${PROJECT}&select=*`,
  `project_id=${PROJECT}&organization_id=${OTHER}`, `project_id=${PROJECT}&q=%25`,
  `project_id=${PROJECT}&q=*`, `project_id=${PROJECT}&q=x),organization_id.neq.null`,
  `project_id=${PROJECT}&q=${"a".repeat(81)}`, `project_id=${PROJECT}&status=x%0Ay`]) {
  test(`input validation: ${query.slice(0, 90)}`, async () => {
    const f = fixture(); assert.equal((await f.handle(request(query), ["leads"])).status, 400); assert.equal(f.calls.length, 0);
  });
}
test("invalid detail UUID rejected before accessing upstream", async () => {
  const f = fixture(); assert.equal((await f.handle(request(), ["leads", "bad"])).status, 400); assert.equal(f.calls.length, 0);
});
test("detail routes reject list filters", async () => {
  const f = fixture(); assert.equal((await f.handle(request(`project_id=${PROJECT}&cursor=${ID}`), ["leads", ID])).status, 400);
});
test("unknown operation never reaches data layer", async () => {
  const f = fixture(); assert.equal((await f.handle(request(), ["send_whatsapp"])).status, 404); assert.equal(f.calls.length, 0);
});
test("leads uses verified user's token and tenant/project filters; secrets and PII excluded", async () => {
  const f = fixture(); const res = await f.handle(request(`project_id=${PROJECT}&q=Jo%C3%A3o&status=aberta`), ["leads"]);
  assert.equal(res.status, 200); const body = await res.json(); assert.equal(body.data[0].person_name, "Cliente de teste");
  assert.equal(body.data[0].phone, undefined); assert.equal(body.data[0].cpf_cnpj, undefined); assert.equal(body.data[0].notes, undefined);
  assert.equal(body.data[0].organization_id, undefined); assert.equal(body.meta.mode, "read_only");
  const dataCall = f.calls[2]; assert.equal(dataCall.url.pathname, "/rest/v1/crm_records");
  assert.equal(dataCall.url.searchParams.get("organization_id"), `eq.${ORG}`);
  assert.equal(dataCall.url.searchParams.get("project_id"), `eq.${PROJECT}`);
  assert.equal(dataCall.url.searchParams.get("person_name"), "ilike.*João*");
  assert.equal(dataCall.url.searchParams.get("record_status"), "eq.aberta");
  assert.equal(dataCall.url.searchParams.get("order"), "id.asc");
  assert.ok(!dataCall.url.searchParams.get("select")!.includes("phone"));
  for (const { url, init } of f.calls) {
    assert.equal(init.method, "GET"); assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store");
    assert.equal(new Headers(init.headers).get("authorization"), TOKEN);
    assert.equal(new Headers(init.headers).get("apikey"), "sb_publishable_fixture");
    assert.ok(!url.href.includes("signature"));
  }
  assert.ok(!JSON.stringify(body).includes("SECRET"));
  const logs = JSON.stringify(f.events);
  for (const forbidden of ["SECRET", "João", "Cliente", TOKEN, ORG, USER]) assert.ok(!logs.includes(forbidden));
  assert.equal(res.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(res.headers.get("vercel-cdn-cache-control"), "no-store");
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});
test("capabilities is authenticated and explicitly REST, not an installed Dot/MCP", async () => {
  const f = fixture(); const res = await f.handle(request(""), []); const body = await res.json();
  assert.equal(res.status, 200); assert.equal(body.data.protocol, "REST");
  assert.equal(body.data.writes_enabled, false); assert.equal(body.data.mcp_endpoint_implemented, false); assert.equal(f.calls.length, 2);
});
test("keyset pagination returns only requested size and forwards cursor", async () => {
  const row = { id: ID, organization_id: ORG, project_id: PROJECT };
  const f = fixture({ rows: [row, { ...row, id: ID2 }] });
  const res = await f.handle(request(`project_id=${PROJECT}&limit=1&cursor=${USER}`), ["leads"]);
  const body = await res.json(); assert.equal(res.status, 200); assert.equal(body.data.length, 1);
  assert.deepEqual(body.pagination, { limit: 1, has_more: true, next_cursor: ID });
  assert.equal(f.calls[2].url.searchParams.get("id"), `gt.${USER}`); assert.equal(f.calls[2].url.searchParams.get("limit"), "2");
});
test("projects always intersects allowlist with cursor and organization", async () => {
  const f = fixture({ rows: [{ id: PROJECT, organization_id: ORG, name: "Empreendimento de teste" }] });
  const res = await f.handle(request(`cursor=${USER}`), ["projects"]); assert.equal(res.status, 200);
  assert.deepEqual(f.calls[2].url.searchParams.getAll("id"), [`in.(${PROJECT})`, `gt.${USER}`]);
  assert.equal(f.calls[2].url.searchParams.get("active"), "eq.true");
});
test("inventory reflects source price and never exposes confidential floor", async () => {
  const f = fixture({ rows: [{ id: ID, organization_id: ORG, project_id: PROJECT, unit_code: "A-01",
    list_price: "480000.50", price_per_sqm: "1200", area: "400", minimum_price: 1, strategic_reason: "SECRET", status: "reservado" }] });
  const res = await f.handle(request(), ["inventory", ID]); const body = await res.json();
  assert.equal(res.status, 200); assert.equal(body.data.list_price, 480000.5); assert.equal(body.data.currency, "BRL");
  assert.equal(body.data.status, "reservado"); assert.equal(body.data.is_binding_offer, false);
  assert.equal(body.data.minimum_price, undefined); assert.equal(body.data.strategic_reason, undefined);
  assert.equal(f.calls[2].url.searchParams.get("id"), `eq.${ID}`);
});
for (const price of [null, "", 0, -100, "invalid", "Infinity"]) {
  test(`missing/invalid price never becomes a fictitious offer: ${price}`, async () => {
    const f = fixture({ rows: [{ id: ID, organization_id: ORG, project_id: PROJECT, list_price: price }] });
    const body = await (await f.handle(request(), ["inventory"])).json();
    assert.equal(body.data[0].list_price, null); assert.equal(body.data[0].price_status, "not_configured");
  });
}
for (const row of [{ id: ID, organization_id: OTHER, project_id: PROJECT },
  { id: ID, organization_id: ORG, project_id: OTHER }, { id: "bad", organization_id: ORG, project_id: PROJECT }]) {
  test(`defense in depth rejects unexpected source scope: ${JSON.stringify(row)}`, async () => {
    const f = fixture({ rows: [row] }); const res = await f.handle(request(), ["leads"]);
    assert.equal(res.status, 502); assert.equal((await res.json()).data, undefined);
  });
}
test("detail ID mismatch is rejected", async () => {
  const f = fixture({ rows: [{ id: ID2, organization_id: ORG, project_id: PROJECT }] });
  assert.equal((await f.handle(request(), ["leads", ID])).status, 502);
});
test("unauthorized project returned by upstream is rejected", async () => {
  const f = fixture({ rows: [{ id: OTHER, organization_id: ORG }] });
  assert.equal((await f.handle(request(""), ["projects"])).status, 502);
});
test("missing and invisible detail return identical 404", async () => {
  const f = fixture({ rows: [] }); const res = await f.handle(request(), ["leads", ID]); assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, "NOT_FOUND");
});
test("empty list is not fabricated", async () => {
  const f = fixture({ rows: [] }); const body = await (await f.handle(request(), ["leads"])).json();
  assert.deepEqual(body.data, []); assert.equal(body.pagination.next_cursor, null); assert.equal(body.pagination.has_more, false);
});
for (const dataStatus of [401, 403, 429, 500]) {
  test(`upstream ${dataStatus} errors are sanitized`, async () => {
    const f = fixture({ dataStatus, dataBody: "SECRET SQL token" }); const res = await f.handle(request(), ["leads"]);
    assert.equal(res.status, [401, 403].includes(dataStatus) ? 403 : dataStatus === 429 ? 503 : 502);
    assert.ok(!(await res.text()).includes("SECRET")); assert.ok(!JSON.stringify(f.events).includes("SECRET"));
  });
}
test("network errors never expose original exception", async () => {
  const f = fixture({ throwNetwork: true }); const res = await f.handle(request(), ["leads"]);
  assert.equal(res.status, 503); assert.ok(!(await res.text()).includes("SECRET"));
});
test("malformed or oversized upstream payloads fail closed", async () => {
  for (const dataBody of ["invalid-json", JSON.stringify({ unexpected: true }), `"${"x".repeat(512 * 1024)}"`]) {
    const f = fixture({ dataBody }); assert.equal((await f.handle(request(), ["leads"])).status, 502);
  }
});
test("throttle is bounded per actor, has retry-after, and expires", async () => {
  const f = fixture({ rows: [] });
  for (let i = 0; i < 60; i++) assert.equal((await f.handle(request(), ["leads"])).status, 200);
  const limited = await f.handle(request(), ["leads"]); assert.equal(limited.status, 429); assert.equal(limited.headers.get("retry-after"), "60");
  f.advance(60001); assert.equal((await f.handle(request(), ["leads"])).status, 200);
});
test("logging failure cannot change response or bypass checks", async () => {
  const f = fixture({ auditThrows: true }); assert.equal((await f.handle(request(), ["leads"])).status, 200);
  assert.equal((await f.handle(request(undefined, { noAuth: true }), ["leads"])).status, 401);
});
