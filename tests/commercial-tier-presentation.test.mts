import assert from "node:assert/strict";
import test from "node:test";
import { simulationSummary, compactCommercial } from "../supabase/functions/enterprise-bia-agent-gateway/core.ts";
test("Bia announces the chosen scenario's rate, not the old flat policy rate", () => {
  const text = simulationSummary({ unitCode: "TEST-A-01", area: 300, price: 360000, downPayment: 36000, downPaymentInstallments: 1, monthlyInterestRate: 0.0033, indexer: "IPCA", balloonCount: 0, scenarios: [{ months: 96, monthlyPayment: 4000, monthlyInterestRate: 0.0033 }, { months: 180, monthlyPayment: 3000, monthlyInterestRate: 0.006 }] });
  assert.match(text!, /0,6% ao mês/);
  assert.match(text!, /180 parcelas/);
});
test("Bia receives rate tiers but not internal policy parameters", () => {
  const tiers = [{ max_installments: 180, monthly_interest_rate: 0.006 }];
  const result = compactCommercial({ policy: { parameters: { interest_rate_tiers: tiers, internal_discount: 0.5 } } })!;
  assert.deepEqual((result.policy as { parameters: unknown }).parameters, { interest_rate_tiers: tiers });
});
