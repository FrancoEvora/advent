import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const chatClient = read("src/components/arisa/chat-client.ts");
const manager = read("supabase/functions/arisa-manager/index.ts");
const migration = read("supabase/migrations/20260921213437_bia_arisa_30mb_file_limit.sql");
const constraintsMigration = read("supabase/migrations/20260921214414_bia_arisa_30mb_db_constraints.sql");

test("Bia and Arisa chat accept files up to 30 MB", () => {
  assert.match(chatClient, /file\.size > 31457280/);
  assert.match(chatClient, /no máximo 30 MB/);
  assert.doesNotMatch(chatClient, /8388608|no máximo 8 MB/);
});

test("manager processing uses the same 30 MB ceiling for stored files", () => {
  const matches = manager.match(/stored\.data\.size\s*>\s*31457280/g) || [];
  assert.ok(matches.length >= 2);
  assert.doesNotMatch(manager, /stored\.data\.size\s*>\s*8388608/);
});

test("storage buckets and document intake are standardized at 30 MB", () => {
  assert.match(migration, /file_size_limit = 31457280/);
  assert.match(migration, /document_max_size_mb = 30/);
  assert.match(migration, /least\(coalesce\(document_max_size_mb,30\),30\)/);
  assert.match(migration, /coalesce\(v_limit,31457280\)/);
});


test("database check constraints no longer cap Bia/Arisa files at 8 MB", () => {
  assert.match(constraintsMigration, /arisa_chat_files_size_bytes_check/);
  assert.match(constraintsMigration, /arisa_operation_items_size_bytes_check/);
  assert.match(constraintsMigration, /bia_customer_files_size_bytes_check/);
  assert.match(constraintsMigration, /size_bytes between 1 and 31457280/g);
  assert.match(constraintsMigration, /bia_customer_tools_v1/);
});
