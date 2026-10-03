import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { handleConnect, handleConnectWebhook, routeCoexistenceAccountEvent, safeSnapshot } from "../src/lib/integrations/whatsapp/connect-server.ts";
import { coexistenceLoginOptions, CONNECT_POLICY, parseMetaEvent, maskPhone } from "../src/lib/integrations/whatsapp/connect-policy.ts";
const org = "11111111-1111-4111-8111-111111111111", actor = "22222222-2222-4222-8222-222222222222", sid = "33333333-3333-4333-8333-333333333333";
const base = "https://enterprise.terraragroup.com.br", nonce = "a".repeat(64), app = "2341160449962178", waba = "123456789", phone = "987654321", token = "private-token-".repeat(5), secret = "private-secret";
function req(body: Record<string, unknown> = { organizationId: org }, origin = base) { return new Request(`${base}/api/arisa/whatsapp-connect`, { method: "POST", headers: { authorization: "Bearer fake.session.token", origin, "content-type": "application/json" }, body: JSON.stringify(body) }); }
const args = { organizationId: org, sessionId: sid, nonce };
const finish = { ...args, action: "finalize", event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", wabaId: waba };
function fixture(options: { deny?: string; notCoex?: boolean; failSync?: boolean; consumed?: boolean; wrongApp?: boolean; existing?: boolean } = {}) {
  const calls: { url: string; body?: Record<string, unknown> }[] = [], audit: unknown[] = [];
  const snapshot = { connection: { id: sid, label: "franco_personal", onboarding_status: "connected", coexistence_status: "verified", updated_at: "2026-10-03", access_token: token, operations: {}, app_secret: secret }, primary: { configured: true, enabled: true }, configuration: { appId: app, configId: "12345678", ready: true, secret }, audit: [], token };
  const dependencies = { env: { NODE_ENV: "production", SUPABASE_SECRET_KEY: "server-key-".repeat(5) }, audit: (a: unknown) => audit.push(a), fetch: (async (input, init) => {
    const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url, body });
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: actor });
    if (url.endsWith("/arisa_coexistence_webhook_lookup")) return Response.json({ connections: body.p_waba_id === waba ? [{ id: sid }] : [] });
    if (url.includes("/rest/v1/rpc/")) {
      assert.equal(url, "https://qsdffayasuzsmngteika.supabase.co/rest/v1/rpc/arisa_coexistence_service");
      const action = body.p_action, a = body.p_args;
      if (options.deny) return Response.json({ message: options.deny, code: "42501" }, { status: 403 });
      if (action === "begin") return Response.json({ sessionId: sid, expiresAt: "2026-10-03T23:00:00Z", appId: app, configId: "12345678", secret });
      if (action === "config") return Response.json({ appId: app, appSecret: secret, verifyToken: "verify-secret" });
      if (action === "claim") return Response.json({ alreadyExchanged: Boolean(options.consumed) });
      if (action === "claim_complete") return Response.json({ token, connectionId: sid });
      if (action === "save_assets" && options.existing) return Response.json({ message: "EXISTING_CHANNEL_PROTECTED" }, { status: 409 });
      if (action === "operation") return Response.json(a.state === "start" ? { execute: true } : { ok: true });
      if (action === "webhook_config") return Response.json({ appSecret: secret, verifyToken: "verify-secret", wabaId: waba, phoneNumberId: phone });
      return Response.json(snapshot);
    }
    assert.match(url, /^https:\/\/graph\.facebook\.com\/v26\.0\//);
    if (url.includes("oauth/access_token")) return Response.json({ access_token: token, expires_in: 5184000 });
    if (url.includes("debug_token")) return Response.json({ data: { is_valid: true, app_id: options.wrongApp ? "9999999" : app, scopes: ["whatsapp_business_management", "whatsapp_business_messaging"] } });
    if (url.includes("phone_numbers")) return Response.json({ data: [{ id: phone, display_phone_number: "+55 99 99999-4321", is_on_biz_app: !options.notCoex, platform_type: "CLOUD_API" }] });
    if (url.includes("subscribed_apps")) return Response.json({ success: true });
    if (url.includes("smb_app_data")) { if (options.failSync) throw new Error("private-request-url-and-token"); return Response.json({ request_id: "sync-request" }); }
    throw new Error("Unexpected URL");
  }) as typeof fetch };
  return { dependencies, calls, audit, snapshot };
}
test("official coexistence options exclude traditional registration", () => {
  assert.equal(CONNECT_POLICY.launchAllowed, true); assert.equal(coexistenceLoginOptions("12345678").extras.featureType, "whatsapp_business_app_onboarding");
  assert.throws(() => coexistenceLoginOptions("bad")); assert.equal(maskPhone("+55 11 98765 4321"), "•••• 4321");
});
test("strict postMessage origin and event allowlist", () => {
  const payload = JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: finish.event, data: { waba_id: waba, phone_number_id: phone, token } });
  assert.deepEqual(parseMetaEvent("https://www.facebook.com", payload), { event: finish.event, wabaId: waba, phoneNumberId: phone });
  for (const origin of ["https://facebook.com.evil.test", "https://evilfacebook.com", "null", base]) assert.equal(parseMetaEvent(origin, payload), null);
  assert.equal(parseMetaEvent("https://www.facebook.com", payload.replace(finish.event, "FINISH")), null);
  assert.equal(parseMetaEvent("https://www.facebook.com", "bad"), null);
});
for (const origin of ["https://evil.example", `${base}.evil.example`, "http://enterprise.terraragroup.com.br", "null", ""]) test(`origin rejected before network: ${origin}`, async () => {
  const f = fixture(); assert.equal((await handleConnect(req(undefined, origin), "begin", f.dependencies)).status, 403); assert.equal(f.calls.length, 0);
});
test("missing authentication and GET callback rejected", async () => {
  const f = fixture(); assert.equal((await handleConnect(new Request(base), "status", f.dependencies)).status, 401);
  assert.equal((await handleConnect(new Request(`${base}?code=secret-code`), "callback", f.dependencies)).status, 405); assert.equal(f.calls.length, 0);
});
test("administrator validation occurs before Meta", async () => {
  const f = fixture({ deny: "ADMIN_REQUIRED" }); assert.equal((await handleConnect(req(), "begin", f.dependencies)).status, 403);
  assert.equal(f.calls.filter(c => c.url.includes("facebook.com")).length, 0);
});
test("begin returns nonce, persists only its digest and does not call Meta", async () => {
  const f = fixture(); const r = await handleConnect(req(), "begin", f.dependencies), body = await r.json();
  assert.equal(r.status, 200); assert.match(body.nonce, /^[a-f0-9]{64}$/); assert.notEqual(f.calls[1].body?.p_args.nonceHash, body.nonce);
  assert.doesNotMatch(JSON.stringify(body), /private-secret|server-key/); assert.equal(f.calls.length, 2);
});
test("status excludes credentials and unknown future fields", async () => {
  const f = fixture(), r = await handleConnect(new Request(`${base}?organizationId=${org}`, { headers: { authorization: "Bearer fake.session.token" } }), "status", f.dependencies);
  assert.equal(r.status, 200); assert.doesNotMatch(await r.text(), /private-token|private-secret|access_token|server-key/);
  assert.doesNotMatch(JSON.stringify(safeSnapshot(f.snapshot)), /private-token|private-secret/);
});
test("code exchanged and stored only server-side immediately", async () => {
  const f = fixture(); const r = await handleConnect(req({ ...args, action: "exchange", code: "single-use-code" }), "callback", f.dependencies);
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, exchanged: true });
  assert.ok(f.calls.some(c => c.body?.p_action === "token" && c.body.p_args.token === token));
  assert.doesNotMatch(JSON.stringify(f.audit), /single-use-code|private-token|private-secret/);
});
test("retry does not exchange a consumed code", async () => {
  const f = fixture({ consumed: true }); assert.equal((await handleConnect(req({ ...args, action: "exchange", code: "single-use-code" }), "callback", f.dependencies)).status, 200);
  assert.equal(f.calls.filter(c => c.url.includes("facebook.com")).length, 0);
});
test("coexistence verified before subscription, requests sync without registering or sending", async () => {
  const f = fixture(), r = await handleConnect(req(finish), "callback", f.dependencies); assert.equal(r.status, 200);
  const saved = f.calls.findIndex(c => c.body?.p_action === "save_assets"), sub = f.calls.findIndex(c => c.url.includes("subscribed_apps")); assert.ok(saved > 0 && sub > saved);
  assert.equal(f.calls.filter(c => c.url.includes("smb_app_data")).length, 2);
  assert.ok(f.calls.some(c => c.body?.p_action === "finish")); assert.doesNotMatch(f.calls.map(c => c.url).join("\n"), /\/register|\/deregister|\/messages/);
});
for (const option of ["notCoex", "wrongApp", "existing"] as const) test(`rejects ${option} before any Meta mutation`, async () => {
  const f = fixture({ [option]: true }); const r = await handleConnect(req(finish), "callback", f.dependencies); assert.ok(r.status >= 400);
  assert.equal(f.calls.filter(c => c.url.includes("facebook.com") && c.body).length, 0);
});
test("ambiguous sync failure is recorded and never retried automatically", async () => {
  const f = fixture({ failSync: true }); const r = await handleConnect(req(finish), "callback", f.dependencies); assert.equal((await r.json()).error, "SYNC_REVIEW_REQUIRED");
  assert.equal(f.calls.filter(c => c.url.includes("smb_app_data")).length, 1); assert.ok(f.calls.some(c => c.body?.p_action === "operation" && c.body.p_args.state === "uncertain"));
  assert.doesNotMatch(JSON.stringify(f.audit), /private-request|private-token/);
});
test("cancel never calls Meta", async () => { const f = fixture(); assert.equal((await handleConnect(req({ ...args, action: "cancel" }), "callback", f.dependencies)).status, 200); assert.equal(f.calls.length, 2); });
const payload = () => ({ object: "whatsapp_business_account", entry: [{ id: waba, changes: [{ field: "history", value: { metadata: { phone_number_id: phone }, history: [{ metadata: { progress: 100 } }] } }] }] });
function webhook(body: unknown, signature = true) { const raw = JSON.stringify(body); return new Request(base, { method: "POST", headers: { "x-hub-signature-256": signature ? `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` : `sha256=${"0".repeat(64)}` }, body: raw }); }
test("signed webhook goes only to its own private channel", async () => {
  const f = fixture(); assert.equal((await handleConnectWebhook(webhook(payload()), sid, f.dependencies)).status, 200);
  assert.equal(f.calls[1].body?.p_action, "webhook_ingest"); assert.equal(f.calls[1].body?.p_args.progress, 100);
});
test("invalid signature and cross-channel data cannot be stored", async () => {
  const f = fixture(); assert.equal((await handleConnectWebhook(webhook(payload(), false), sid, f.dependencies)).status, 403); assert.equal(f.calls.length, 1);
  const p = payload(); p.entry[0].id = "99999999"; const g = fixture(); assert.equal((await handleConnectWebhook(webhook(p), sid, g.dependencies)).status, 403); assert.equal(g.calls.length, 1);
});
test("webhook verification requires exact token", async () => {
  const f = fixture(); const r = await handleConnectWebhook(new Request(`${base}?hub.mode=subscribe&hub.verify_token=verify-secret&hub.challenge=1234`), sid, f.dependencies); assert.equal(await r.text(), "1234");
  assert.equal((await handleConnectWebhook(new Request(`${base}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1234`), sid, f.dependencies)).status, 403);
});
test("oversized callback body rejected before authentication calls", async () => {
  const f = fixture(); assert.equal((await handleConnect(req({ ...args, code: "a".repeat(17000) }), "callback", f.dependencies)).status, 413); assert.equal(f.calls.length, 0);
});
test("database guards protect existing channels, secrets and disabled automation", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261003181949_arisa_whatsapp_coexistence_onboarding.sql", import.meta.url), "utf8");
  assert.match(sql, /EXISTING_CHANNEL_PROTECTED/); assert.match(sql, /from public,anon,authenticated/); assert.match(sql, /nonce_hash=p_args/); assert.match(sql, /vault.create_secret/);
  assert.doesNotMatch(sql, /set automation_enabled\s*=\s*true/i);
});
test("default callback delegates signed personal account removal without changing primary routing", async () => {
  const p = { object: "whatsapp_business_account", entry: [{ id: waba, changes: [{ field: "account_update", value: { event: "PARTNER_REMOVED" } }] }] };
  const f = fixture(), request = webhook(p), raw = new TextEncoder().encode(JSON.stringify(p));
  assert.equal((await routeCoexistenceAccountEvent(request, raw, f.dependencies))?.status, 200);
  assert.ok(f.calls.some(c => c.body?.p_action === "webhook_ingest" && c.body.p_args.disconnected === true));
  p.entry[0].id = "999999999"; const g = fixture();
  assert.equal(await routeCoexistenceAccountEvent(webhook(p), new TextEncoder().encode(JSON.stringify(p)), g.dependencies), null);
});
test("default callback leaves ordinary primary messages on the existing path without extra lookups", async () => {
  const p = { object: "whatsapp_business_account", entry: [{ id: waba, changes: [{ field: "messages", value: { metadata: { phone_number_id: phone } } }] }] };
  const f = fixture(); assert.equal(await routeCoexistenceAccountEvent(webhook(p), new TextEncoder().encode(JSON.stringify(p)), f.dependencies), null); assert.equal(f.calls.length, 0);
});
test("default callback rejects forged personal account events without ingestion", async () => {
  const p = { object: "whatsapp_business_account", entry: [{ id: waba, changes: [{ field: "account_update", value: { event: "PARTNER_REMOVED" } }] }] };
  const f = fixture(); assert.equal((await routeCoexistenceAccountEvent(webhook(p, false), new TextEncoder().encode(JSON.stringify(p)), f.dependencies))?.status, 403);
  assert.equal(f.calls.filter(c => c.body?.p_action === "webhook_ingest").length, 0);
});
