import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const server = fs.readFileSync("src/lib/public-agent/server.ts", "utf8");

test("public agent retries transient edge throttling idempotently", () => {
  assert.match(server, /EDGE_MAX_ATTEMPTS\s*=\s*4/u);
  assert.match(server, /EDGE_RETRYABLE_STATUS\s*=\s*new Set\(\[429, 500, 502, 503, 504\]\)/u);
  assert.match(server, /retry-after/u);
  assert.match(server, /Public agent edge transient failure/u);
  assert.match(server, /clientMessageId:\s*input\.clientMessageId/u);
});

test("message retry budget remains inside the BFF request window", () => {
  assert.match(server, /action === "message" \? 30_000 : 20_000/u);
  assert.match(server, /}, 90_000\);/u);
});
