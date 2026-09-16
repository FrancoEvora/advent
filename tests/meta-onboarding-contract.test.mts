import { test } from "node:test";
import assert from "node:assert/strict";
import { signOnboardingState, verifyOnboardingState, sameWhatsAppIdentity, metaErrorMessage } from "../src/lib/integrations/meta/onboarding-contract.ts";

const secret = "testing-only-secret-with-at-least-32-characters";
const identity = { organizationId: "org-a", userId: "user-a" };
test("OAuth state is bound to the user, organization, cookie and expiry", () => {
  const state = signOnboardingState({ ...identity, channel: "instagram" }, secret, 1000);
  assert.equal(verifyOnboardingState(state, state, secret, identity, 1001).channel, "instagram");
  for (const wrong of [{ ...identity, userId: "user-b" }, { ...identity, organizationId: "org-b" }]) assert.throws(() => verifyOnboardingState(state, state, secret, wrong, 1001));
  assert.throws(() => verifyOnboardingState(state, "", secret, identity, 1001));
  assert.throws(() => verifyOnboardingState(state, state, secret, identity, 601000));
  assert.throws(() => verifyOnboardingState(state + "x", state + "x", secret, identity, 1001));
  assert.throws(() => verifyOnboardingState(state, state, "a-different-long-secret-value-for-signing", identity, 1001));
  assert.notEqual(state, signOnboardingState({ ...identity, channel: "instagram" }, secret, 1000));
});
test("WhatsApp authorization cannot replace a number or WABA with existing histories", () => {
  assert.equal(sameWhatsAppIdentity({}, "11", "22"), true);
  assert.equal(sameWhatsAppIdentity({ phone_number_id: "11", waba_id: "22" }, "11", "22"), true);
  assert.equal(sameWhatsAppIdentity({ phone_number_id: "11", waba_id: "22" }, "33", "22"), false);
  assert.equal(sameWhatsAppIdentity({ phone_number_id: "11", waba_id: "22" }, "11", "44"), false);
});
test("provider errors have actionable messages without raw provider payloads", () => {
  assert.match(metaErrorMessage(190), /expirou/);
  assert.match(metaErrorMessage(200), /permissões/);
  assert.match(metaErrorMessage(613), /temporariamente/);
});
