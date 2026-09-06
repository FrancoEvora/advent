import test from "node:test";
import assert from "node:assert/strict";
import { ARISA_EMAIL, GOOGLE_REDIRECT, GOOGLE_SCOPES, GOOGLE_ERRORS, authorizationUrl, completeGoogleGrant, googleToken, gmail } from "../supabase/functions/_shared/arisa-mail.ts";
import { ManagerError } from "../supabase/functions/_shared/arisa-manager.ts";

const config = { client_id: "test-client", client_secret: "test-secret", refresh_token: "test-refresh", sender: ARISA_EMAIL };
const reply = (body: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(body), { status });
const rejects = async (fn: () => Promise<unknown>, code: string, status?: number) => assert.rejects(fn, (e: unknown) => e instanceof ManagerError && e.code === code && (status === undefined || e.status === status));

test("OAuth still uses offline consent, exact redirect, mailbox and PKCE", () => {
  const url = new URL(authorizationUrl("test-client", "test-state", "challenge"));
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.match(url.searchParams.get("prompt") || "", /consent/);
  assert.equal(url.searchParams.get("redirect_uri"), GOOGLE_REDIRECT);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "test-state");
  assert.equal(url.searchParams.get("login_hint"), ARISA_EMAIL);
});
for (const [reason, expected] of [
  ["invalid_client", "GOOGLE_CLIENT_INVALID"], ["unauthorized_client", "GOOGLE_CLIENT_INVALID"],
  ["invalid_grant", "GOOGLE_AUTH_CODE_INVALID"], ["redirect_uri_mismatch", "GOOGLE_REDIRECT_MISMATCH"],
  ["invalid_scope", "GOOGLE_PERMISSIONS_MISSING"], ["invalid_request", "GOOGLE_OAUTH_REQUEST_INVALID"],
  ["unsupported_grant_type", "GOOGLE_OAUTH_REQUEST_INVALID"],
]) test(`authorization code exchange classifies ${reason}`, async () => {
  await rejects(() => googleToken(config, "test-code", "test-verifier", reply({ error: reason, error_description: "SECRET_MUST_NOT_BE_EXPOSED" }, 400)), expected, 409);
  assert.ok(GOOGLE_ERRORS[expected]);
  assert.ok(!GOOGLE_ERRORS[expected].includes("SECRET_MUST_NOT_BE_EXPOSED"));
});
test("invalid_grant means reconnect only during refresh, not first connection", async () => {
  await rejects(() => googleToken(config, undefined, undefined, reply({ error: "invalid_grant" }, 400)), "GOOGLE_RECONNECT_REQUIRED", 409);
});
test("token outages and quotas are not mislabeled as expired authorization", async () => {
  await rejects(() => googleToken(config, "code", "verifier", reply({ error: "server_error" }, 503)), "GOOGLE_UNAVAILABLE", 503);
  await rejects(() => googleToken(config, "code", "verifier", reply({}, 429)), "GOOGLE_LIMIT", 429);
  await rejects(() => googleToken(config, "code", "verifier", async () => { throw new TypeError("network detail SECRET"); }), "GOOGLE_UNAVAILABLE", 503);
  await rejects(() => googleToken(config, "code", "verifier", reply({})), "GOOGLE_INVALID_RESPONSE", 502);
});
test("missing local credentials are rejected before contacting Google", async () => {
  const unexpected: typeof fetch = async () => { assert.fail("unexpected network request"); };
  await rejects(() => googleToken({}, "code", "verifier", unexpected), "GOOGLE_CLIENT_INVALID");
  await rejects(() => googleToken({ ...config, refresh_token: null }, undefined, undefined, unexpected), "GOOGLE_REFRESH_TOKEN_MISSING");
  await rejects(() => googleToken(config, "", "verifier", unexpected), "GOOGLE_AUTH_CODE_INVALID");
});
test("exchange uses PKCE; subsequent calls automatically use stored refresh token", async () => {
  let count = 0;
  const request: typeof fetch = async (url, options) => {
    assert.equal(String(url), "https://oauth2.googleapis.com/token");
    const body = options!.body as URLSearchParams;
    assert.equal(body.get("client_secret"), config.client_secret);
    if (count++ === 0) { assert.equal(body.get("grant_type"), "authorization_code"); assert.equal(body.get("code_verifier"), "verifier"); assert.equal(body.get("redirect_uri"), GOOGLE_REDIRECT); }
    else { assert.equal(body.get("grant_type"), "refresh_token"); assert.equal(body.get("refresh_token"), config.refresh_token); assert.equal(body.has("code"), false); }
    return new Response(JSON.stringify({ access_token: "access" }));
  };
  await googleToken(config, "code", "verifier", request);
  await googleToken(config, undefined, undefined, request);
  assert.equal(count, 2);
});
for (const [reason, expected] of [
  ["SERVICE_DISABLED", "GOOGLE_API_DISABLED"], ["accessNotConfigured", "GOOGLE_API_DISABLED"],
  ["ACCESS_TOKEN_SCOPE_INSUFFICIENT", "GOOGLE_PERMISSIONS_MISSING"], ["insufficientPermissions", "GOOGLE_PERMISSIONS_MISSING"],
  ["domainPolicy", "GOOGLE_WORKSPACE_BLOCKED"], ["ORG_RESTRICTION_VIOLATION", "GOOGLE_WORKSPACE_BLOCKED"],
  ["userRateLimitExceeded", "GOOGLE_LIMIT"], ["dailyLimitExceeded", "GOOGLE_LIMIT"], ["unknown", "GOOGLE_ACCESS_DENIED"],
]) test(`Gmail 403 classifies ${reason} without pretending token expiry`, async () => {
  await rejects(() => gmail("access", "profile", {}, reply({ error: { errors: [{ reason }], details: [{ reason }] } }, 403)), expected, 403);
});
test("Gmail failures preserve HTTP status for nonduplicating mail delivery", async () => {
  await rejects(() => gmail("access", "profile", {}, reply({}, 401)), "GOOGLE_RECONNECT_REQUIRED", 401);
  await rejects(() => gmail("access", "history", {}, reply({}, 404)), "GOOGLE_NOT_FOUND", 404);
  await rejects(() => gmail("access", "profile", {}, reply({ error: { status: "FAILED_PRECONDITION" } }, 400)), "GOOGLE_MAILBOX_UNAVAILABLE", 400);
  await rejects(() => gmail("access", "messages/send", {}, reply({}, 503)), "GOOGLE_UNAVAILABLE", 503);
  let calls = 0;
  await rejects(() => gmail("access", "messages/send", { method: "POST" }, async () => { calls++; throw new Error("response lost"); }), "GOOGLE_UNAVAILABLE", 503);
  assert.equal(calls, 1, "never retry a possibly accepted send");
});
const grant = { access_token: "access", scope: GOOGLE_SCOPES.join(" ") };
function flow(token: unknown, mailbox = ARISA_EMAIL, refreshedMailbox = mailbox): typeof fetch {
  let profiles = 0;
  return async (url, options) => {
    if (String(url).includes("oauth2")) {
      const body = options!.body as URLSearchParams;
      return new Response(JSON.stringify(body.get("grant_type") === "refresh_token" ? { access_token: "renewed" } : token));
    }
    return new Response(JSON.stringify({ emailAddress: profiles++ ? refreshedMailbox : mailbox }));
  };
}
test("new refresh token is retained only after scopes and exact mailbox validation", async () => {
  const connected = await completeGoogleGrant(config, "code", "verifier", async () => { assert.fail("must not load old token"); }, flow({ ...grant, refresh_token: "new-refresh" }));
  assert.equal(connected.refresh_token, "new-refresh"); assert.equal(connected.email, ARISA_EMAIL);
});
test("omitted refresh token preserves and validates the same account's existing token", async () => {
  const connected = await completeGoogleGrant(config, "code", "verifier", async () => config, flow(grant));
  assert.equal(connected.refresh_token, config.refresh_token);
});
test("missing first refresh token, wrong client and wrong sender cannot produce connected state", async () => {
  for (const previous of [null, { ...config, client_id: "other-client" }, { ...config, sender: "other@example.com" }]) {
    await rejects(() => completeGoogleGrant(config, "code", "verifier", async () => previous, flow(grant)), "GOOGLE_REFRESH_TOKEN_MISSING");
  }
});
test("wrong initial or stored mailbox is rejected", async () => {
  await rejects(() => completeGoogleGrant(config, "code", "verifier", async () => config, flow({ ...grant, refresh_token: "new" }, "other@example.com")), "GOOGLE_ACCOUNT_MISMATCH");
  await rejects(() => completeGoogleGrant(config, "code", "verifier", async () => config, flow(grant, ARISA_EMAIL, "other@example.com")), "GOOGLE_ACCOUNT_MISMATCH");
});
test("partial consent is not mislabeled as wrong mailbox", async () => {
  await rejects(() => completeGoogleGrant(config, "code", "verifier", async () => config, flow({ ...grant, scope: GOOGLE_SCOPES[0], refresh_token: "new" })), "GOOGLE_PERMISSIONS_MISSING");
});
test("revoked old refresh token cannot be reused or produce connected state", async () => {
  const request: typeof fetch = async (url, options) => {
    if (String(url).includes("oauth2")) {
      if ((options!.body as URLSearchParams).get("grant_type") === "refresh_token") return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      return new Response(JSON.stringify(grant));
    }
    return new Response(JSON.stringify({ emailAddress: ARISA_EMAIL }));
  };
  await rejects(() => completeGoogleGrant(config, "code", "verifier", async () => config, request), "GOOGLE_RECONNECT_REQUIRED");
});
