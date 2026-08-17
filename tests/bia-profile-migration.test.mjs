import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

const migrationsDirectory = new URL("../supabase/migrations/", import.meta.url);
const migrationNames = readdirSync(migrationsDirectory).filter((name) =>
  name.endsWith("_rename_public_agent_to_bia.sql"),
);
const migrationName = migrationNames[0];
const migration = migrationName
  ? readFileSync(new URL(migrationName, migrationsDirectory), "utf8")
  : "";
const avatarPath = new URL("../public/vitoria/vitoria-avatar.webp", import.meta.url);

test("a troca para Bia usa uma única migration posterior ao perfil anterior", () => {
  assert.deepEqual(migrationNames, ["20260817180106_rename_public_agent_to_bia.sql"]);
  assert.ok(Number(migrationName.slice(0, 14)) > 20260817180049);
  assert.match(migration, /where experience\.slug = 'solaris'/);
  assert.match(migration, /agent_name = 'Bia'/);
  assert.match(migration, /greeting_text =/);
  assert.match(migration, /Eu sou a Bia, da Évora/);
  assert.doesNotMatch(migration, /assistente\s+virtual|chatbot/i);
});

test("a migration mantém metadados e atualiza identidade e foto", () => {
  assert.match(migration, /hero_image_url = '\/vitoria\/vitoria-avatar\.webp'/);
  assert.match(migration, /when jsonb_typeof\(experience\.avatar\) = 'object'/);
  assert.match(migration, /\) \|\| jsonb_build_object\(/);
  assert.match(migration, /'displayName', 'Bia'/);
  assert.match(migration, /'imageUrl', '\/vitoria\/vitoria-avatar\.webp'/);
  assert.match(migration, /replace\(experience\.knowledge::text/);
  assert.match(migration, /replace\(experience\.theme::text/);
  assert.match(migration, /affected_rows <> 1/);
  assert.doesNotMatch(migration, /public_agent_messages|\bdelete\s+from\b/i);
});

test("o avatar publicado é exatamente o novo retrato aprovado da Bia", () => {
  const avatar = readFileSync(avatarPath);
  const digest = createHash("sha256").update(avatar).digest("hex");

  assert.equal(avatar.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(avatar.subarray(8, 12).toString("ascii"), "WEBP");
  assert.equal(digest, "4f0e2d1ef5d7e4181cdaddf88108b6e04acb1e332f2f98a1f5474699ec35941d");
  assert.ok(statSync(avatarPath).size < 50_000);
});
