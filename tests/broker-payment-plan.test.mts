import assert from "node:assert/strict";
import test from "node:test";
import { buildBrokerPlan, calendarMonth, entryDate, nextMonthlyDate, roundMoney, type BrokerPlanInput } from "../src/lib/broker-payment-plan.ts";

const base: BrokerPlanInput = { salePrice: 200000, downPayment: 0, downCount: 1, downDue: "2027-01-31", downRate: 0, downFrequencyDays: 30, months: 4, monthlyRate: 0.02, method: "price", firstDue: "2027-02-28", graceMonths: 0, balloonTotal: 0, balloonCount: 0, balloonFrequency: 12 };
test("Price reference: 200k, 2% monthly, four payments", () => {
  assert.deepEqual(buildBrokerPlan(base).map(row => row.amount), [52524.75, 52524.75, 52524.75, 52524.75]);
});
test("SACOC monthly gradient compounds each equal quota to its term", () => {
  assert.deepEqual(buildBrokerPlan({ ...base, salePrice: 120000, months: 3, monthlyRate: 0.01, method: "sacoc" }).map(row => row.amount), [40400, 40804, 41212.04]);
});
test("zero-rate schedules preserve principal to the cent, even tiny payments", () => {
  for (const method of ["price", "sacoc"] as const) for (const price of [0.01, 1, 100, 300000.01]) {
    const rows = buildBrokerPlan({ ...base, salePrice: price, months: 360, monthlyRate: 0, method });
    assert.equal(roundMoney(rows.reduce((sum, row) => sum + row.amount, 0)), price);
    assert.ok(rows.every(row => row.amount >= 0));
  }
});
test("entry and balloons do not inflate financed monthly principal", () => {
  const rows = buildBrokerPlan({ ...base, salePrice: 100, downPayment: 10, downCount: 3, balloonTotal: 10, balloonCount: 3, monthlyRate: 0 });
  assert.equal(roundMoney(rows.reduce((sum, row) => sum + row.amount, 0)), 100);
  assert.equal(roundMoney(rows.filter(row => row.installment_type === "entrada").reduce((sum, row) => sum + row.amount, 0)), 10);
});
test("month ends, leap years and December are clamped without rollover", () => {
  assert.equal(calendarMonth("2027-01-31", 1), "2027-02-28");
  assert.equal(calendarMonth("2028-01-31", 1), "2028-02-29");
  assert.equal(calendarMonth("2027-12-31", 1), "2028-01-31");
  assert.equal(entryDate("2027-01-31", 2, 30), "2027-03-31");
  assert.equal(nextMonthlyDate("2027-01-31", 3, 30), "2027-04-30");
  assert.equal(entryDate("2027-01-31", 1, 15), "2027-02-15");
});
test("grace changes dates only, not payment amounts", () => {
  const rows = buildBrokerPlan({ ...base, graceMonths: 2 });
  assert.equal(rows[0].due_date, "2027-04-28");
  assert.equal(rows[0].amount, 52524.75);
});
test("invalid intermediate form counts do not produce schedules", () => {
  assert.deepEqual(buildBrokerPlan({ ...base, months: NaN }), []);
  assert.deepEqual(buildBrokerPlan({ ...base, months: 100000000 }), []);
});
test("annual balloons fall on the 12th and 24th monthly payments, including grace", () => {
  const rows = buildBrokerPlan({ ...base, months: 24, balloonTotal: 80000, balloonCount: 2, graceMonths: 2 });
  const monthly = rows.filter(row => row.installment_type === "mensal");
  const balloons = rows.filter(row => row.installment_type === "balao");
  assert.equal(balloons[0].due_date, monthly[11].due_date);
  assert.equal(balloons[1].due_date, monthly[23].due_date);
  assert.equal(balloons[0].amount, 40000);
});
