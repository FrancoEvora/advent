import assert from "node:assert/strict";
import test from "node:test";
import { policyMonthlyRate, policyEntryRate, maximumBalloons, type CommercialPolicy } from "../src/lib/commercial-policy.ts";

const policy: CommercialPolicy = { monthly_interest_rate: 0.0033, max_installments: 180, min_down_payment_pct: 0.1, max_down_payment_installments: 6, down_payment_interest_rate: 0.0033, balloon_frequency_months: 12, balloon_limit_pct: 0.4, parameters: { interest_rate_tiers: [{ max_installments: 96, monthly_interest_rate: 0.0033 }, { max_installments: 120, monthly_interest_rate: 0.005 }, { max_installments: 180, monthly_interest_rate: 0.006 }], annual_balloon_max_count: 4, down_payment_options: [{ installments: 3, monthly_interest_rate: 0 }, { installments: 6, monthly_interest_rate: 0.0033 }] } };
test("monthly interest follows term boundaries", () => {
  for (const [term, rate] of [[1, 0.0033], [96, 0.0033], [97, 0.005], [120, 0.005], [121, 0.006], [180, 0.006]]) assert.equal(policyMonthlyRate(policy, term), rate);
  assert.equal(policyMonthlyRate(policy, 181), 0);
});
test("entry preserves separately configured interest, including interest-free options", () => {
  assert.equal(policyEntryRate(policy, 1), 0);
  assert.equal(policyEntryRate(policy, 3), 0);
  assert.equal(policyEntryRate(policy, 4), 0.0033);
  assert.equal(policyEntryRate(policy, 6), 0.0033);
});
test("no more than four annual balloons within the financed term", () => {
  assert.equal(maximumBalloons(policy, 180), 4);
  assert.equal(maximumBalloons(policy, 36), 3);
  assert.equal(maximumBalloons(policy, 11), 0);
});
test("policies without tiers keep their configured rate", () => {
  assert.equal(policyMonthlyRate({ ...policy, parameters: {} }, 180), 0.0033);
});
