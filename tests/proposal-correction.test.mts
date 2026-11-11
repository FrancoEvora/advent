import assert from "node:assert/strict";
import test from "node:test";
import { proposalCorrectionDescription, proposalCorrectionIndex } from "../src/lib/proposal-correction.ts";

test("IPCA is named explicitly and expanded for the customer", () => {
  assert.equal(proposalCorrectionIndex(" ipca "), "IPCA");
  assert.equal(proposalCorrectionDescription("IPCA"), "IPCA (Índice Nacional de Preços ao Consumidor Amplo)");
});
test("historical indexers are preserved and absent values do not invent IPCA", () => {
  assert.equal(proposalCorrectionDescription("IGP-M"), "IGP-M");
  assert.equal(proposalCorrectionDescription("Sem indexador"), "Sem indexador");
  assert.equal(proposalCorrectionDescription(null), "Não informado");
});
