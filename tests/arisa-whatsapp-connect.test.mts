import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleConnect, rejectConnectCallback } from "../src/lib/integrations/whatsapp/connect-server.ts";
import { coexistenceLoginOptions, CONNECT_POLICY } from "../src/lib/integrations/whatsapp/connect-policy.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const actor = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const base = "https://enterprise.terraragroup.com.br";
function request(body: unknown = { organizationId, requestId }, origin = base, extra: Record<string,string> = {}) {
  return new Request(`${base}/api/arisa/whatsapp-connect`, { method: "POST", headers: {
    authorization: "Bearer fake.session.token", origin, "content-type": "application/json", ...extra,
  }, body: JSON.stringify(body) });
}
function fixture(options: { userStatus?: number; rpcStatus?: number; rpcCode?: string; env?: Record<string,string> } = {}) {
  const calls: { url: string; options?: RequestInit }[] = [], audit: unknown[] = [];
  const dependencies = {
    env: { NODE_ENV: "production", ...options.env },
    audit: (value: unknown) => audit.push(value),
    fetch: (async (url, init) => {
      calls.push({ url: String(url), options: init });
      if (String(url).endsWith("/auth/v1/user")) return Response.json({ id: actor }, { status: options.userStatus || 200 });
      assert.equal(String(url), "https://qsdffayasuzsmngteika.supabase.co/rest/v1/rpc/arisa_whatsapp_connect");
      if (options.rpcStatus) return Response.json({ code: options.rpcCode, message: "secret-provider-diagnostic" }, { status: options.rpcStatus });
      return Response.json({ connection: { id: requestId, label: "franco_personal", onboarding_status: "blocked", coexistence_status: "unknown", updated_at: "2026-10-03T00:00:00Z", access_token: "never-return-me" }, audit: [], primary: { configured: true, enabled: true, app_secret: "never-return-me" }, token: "never-return-me" });
    }) as typeof fetch,
  };
  return { dependencies, calls, audit };
}

test("preflight uses caller identity and only the existing Supabase project; no Meta request", async () => {
  const f = fixture(), response = await handleConnect(request(), "preflight", f.dependencies);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.policy.launchAllowed, false);
  assert.equal(body.policy.eligibility, "unknown");
  assert.equal(body.connection.onboarding_status, "blocked");
  assert.equal(f.calls.length, 2);
  assert.deepEqual(JSON.parse(String(f.calls[1].options?.body)), { p_organization_id: organizationId, p_action: "preflight", p_request_id: requestId });
  assert.doesNotMatch(JSON.stringify(body), /never-return-me|access_token|app_secret/);
  assert.doesNotMatch(JSON.stringify(f.audit), /fake.session.token|11111111|secret-provider/);
  assert.match(response.headers.get("cache-control")!, /no-store/);
});
test("status does not create a connection", async () => {
  const f = fixture();
  const response = await handleConnect(new Request(`${base}/api/arisa/whatsapp-connect?organizationId=${organizationId}`, { headers: { authorization: "Bearer fake.session.token" } }), "status", f.dependencies);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(String(f.calls[1].options?.body)).p_action, "status");
  assert.equal(JSON.parse(String(f.calls[1].options?.body)).p_request_id, null);
});
for (const origin of ["https://evil.example", "https://enterprise.terraragroup.com.br.evil.example", "http://enterprise.terraragroup.com.br", "null", ""]) {
  test(`rejects untrusted origin ${origin || "missing"} without network access`, async () => {
    const f = fixture(); const response = await handleConnect(request(undefined, origin), "preflight", f.dependencies);
    assert.equal(response.status, 403); assert.equal(f.calls.length, 0);
  });
}
test("rejects cross-site requests even with a claimed trusted Origin", async () => {
  const f = fixture(); assert.equal((await handleConnect(request(undefined, base, { "sec-fetch-site": "cross-site" }), "preflight", f.dependencies)).status, 403);
  assert.equal(f.calls.length, 0);
});
test("requires a bearer session; cookies alone are insufficient", async () => {
  const f = fixture(); assert.equal((await handleConnect(request(undefined, base, { authorization: "", cookie: "session=fake" }), "preflight", f.dependencies)).status, 401);
  assert.equal(f.calls.length, 0);
});
test("expired and non-admin sessions cannot mutate the database", async () => {
  const expired = fixture({ userStatus: 401 });
  assert.equal((await handleConnect(request(), "preflight", expired.dependencies)).status, 401); assert.equal(expired.calls.length, 1);
  const denied = fixture({ rpcStatus: 403, rpcCode: "42501" });
  assert.equal((await handleConnect(request(), "preflight", denied.dependencies)).status, 403);
});
for (const extra of [{ code: "do-not-log-auth-code" }, { access_token: "do-not-log-token" }, { label: "arisa_primary" }, { owner_user_id: actor }, { phone_number_id: "123456789" }, { state: "connected" }]) {
  test(`rejects unrequested field ${Object.keys(extra)[0]}`, async () => {
    const f = fixture(); const response = await handleConnect(request({ organizationId, requestId, ...extra }), "preflight", f.dependencies);
    assert.equal(response.status, 400); assert.equal(f.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(f.audit), /do-not-log|arisa_primary|123456789/);
  });
}
test("bounded body parsing prevents oversized payloads", async () => {
  const f = fixture(); assert.equal((await handleConnect(request({ organizationId, requestId, payload: "x".repeat(3000) }), "preflight", f.dependencies)).status, 413);
  assert.equal(f.calls.length, 0);
});
test("rate limit has a safe response and does not leak upstream errors", async () => {
  const f = fixture({ rpcStatus: 400, rpcCode: "P0429" });
  const response = await handleConnect(request(), "preflight", f.dependencies);
  assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "3600");
  assert.doesNotMatch(await response.text(), /secret-provider/);
});
test("failed network cannot trigger a fallback onboarding flow", async () => {
  const f = fixture(); f.dependencies.fetch = async () => { throw new Error("access_token=private"); };
  const response = await handleConnect(request(), "preflight", f.dependencies);
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /access_token|private/);
  assert.doesNotMatch(JSON.stringify(f.audit), /access_token|private/);
});
test("config presence cannot enable onboarding; public response excludes identifiers and secrets", async () => {
  const f = fixture({ env: { ARISA_META_APP_ID: "12345678", ARISA_META_EMBEDDED_SIGNUP_CONFIG_ID: "87654321", ARISA_WHATSAPP_CONNECT_ENABLED: "true", META_APP_SECRET: "test-secret" } });
  const response = await handleConnect(request(), "preflight", f.dependencies), body = await response.json();
  assert.deepEqual(body.configuration, { appIdPresent: true, configIdPresent: true });
  assert.equal(body.policy.launchAllowed, false);
  assert.doesNotMatch(JSON.stringify(body), /12345678|87654321|test-secret/);
});
test("callback never processes CANCEL, ERROR or FINISH as eligibility or authorization", async () => {
  // The route does not accept a request parameter or read any body/query.
  const response = rejectConnectCallback();
  assert.equal(response.status, 423);
  assert.equal((await response.json()).error, "ONBOARDING_NOT_AUTHORIZED");
  const source = readFileSync(new URL("../src/app/api/arisa/whatsapp-connect/callback/route.ts", import.meta.url), "utf8");
  assert.match(source, /POST = rejectConnectCallback/);
  assert.match(source, /GET = rejectConnectCallback/);
});
test("reviewed v4 options specify coexistence, never ordinary migration", () => {
  assert.equal(coexistenceLoginOptions("12345678").extras.featureType, "whatsapp_business_app_onboarding");
  assert.equal(coexistenceLoginOptions("12345678").response_type, "code");
  assert.throws(() => coexistenceLoginOptions("not-an-id"));
  assert.equal(CONNECT_POLICY.launchAllowed, false);
});
test("UI has no callable login, token exchange or raw Meta event listener", () => {
  const ui = readFileSync(new URL("../src/components/arisa/WhatsAppConnect.tsx", import.meta.url), "utf8");
  assert.match(ui, /disabled aria-describedby="eligibility-help"/);
  assert.match(ui, /https:\/\/connect.facebook.net\/pt_BR\/sdk.js/);
  assert.doesNotMatch(ui, /\.login\s*\(|\.init\s*\(|oauth\/access_token|addEventListener\(["']message/);
});
