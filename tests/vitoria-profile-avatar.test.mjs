import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

const avatarPath = new URL("../public/vitoria/vitoria-avatar.webp", import.meta.url);
const legacyAvatarPath = new URL("../public/vitoria/vitoria-portrait.svg", import.meta.url);
const component = readFileSync(
  new URL("../src/components/public-agent/PublicAgentExperience.tsx", import.meta.url),
  "utf8",
);
const types = readFileSync(
  new URL("../src/lib/public-agent/types.ts", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260817180049_vitoria_profile_avatar.sql",
    import.meta.url,
  ),
  "utf8",
);

test("perfil público usa o retrato fotográfico otimizado da Bia", () => {
  const avatar = readFileSync(avatarPath);
  assert.equal(avatar.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(avatar.subarray(8, 12).toString("ascii"), "WEBP");
  assert.ok(statSync(avatarPath).size < 50_000);
  assert.equal(existsSync(legacyAvatarPath), false);
  assert.match(component, /DEFAULT_VITORIA_AVATAR = "\/vitoria\/vitoria-avatar\.webp"/);
  assert.match(component, /source === LEGACY_VITORIA_AVATAR \? DEFAULT_VITORIA_AVATAR : source/);
  assert.match(component, /<Image/);
  assert.match(component, /setFailedAvatarSources/);
  assert.match(component, /PUBLIC_AGENT_DISPLAY_NAME = "Bia"/);
  assert.match(component, /\) : "B"}/);
});

test("contrato e configuração persistem a foto sem apagar metadados do perfil", () => {
  assert.match(types, /export type PublicAgentAvatar/);
  assert.match(types, /avatar\?: PublicAgentAvatar \| null/);
  assert.match(migration, /hero_image_url = '\/vitoria\/vitoria-avatar\.webp'/);
  assert.match(migration, /jsonb_typeof\(experience\.avatar\) = 'object'/);
  assert.match(migration, /'mode', 'photo'/);
  assert.match(migration, /'imageUrl', '\/vitoria\/vitoria-avatar\.webp'/);
  assert.match(migration, /affected_rows <> 1/);
});
