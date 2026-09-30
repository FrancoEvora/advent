import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const oauth = source("src/lib/mcp/oauth.ts");
const server = source("src/lib/mcp/server.ts");
const data = source("src/lib/mcp/data.ts");
const tools = source("src/lib/mcp/tools.ts");
const migration = source("supabase/migrations/20260930010500_bia_dot_mcp_oauth.sql");
const consent = source("src/app/oauth/authorize/OAuthConsent.tsx");

test("OAuth is bound to the stable ChatGPT client, callback, resource and PKCE", () => {
  assert.match(oauth, /https:\/\/chatgpt\.com\/oauth\/client\.json/);
  assert.match(oauth, /https:\/\/chatgpt\.com\/connector_platform_oauth_redirect/);
  assert.match(oauth, /MCP_ORIGIN = "https:\/\/enterprise\.terraragroup\.com\.br"/);
  assert.ok(oauth.includes('export const MCP_RESOURCE = `${MCP_ORIGIN}/mcp`;'));
  assert.match(oauth, /code_challenge_method/);
  assert.match(oauth, /S256/);
  assert.match(oauth, /client_id_metadata_document_supported:\s*true/);
  assert.match(oauth, /token_endpoint_auth_methods_supported:\s*\["none"\]/);
  assert.match(oauth, /authorization_response_iss_parameter_supported:\s*true/);
});

test("delegated tokens are opaque, hashed at rest and short-lived", () => {
  assert.match(oauth, /randomBytes\(32\)/);
  assert.match(oauth, /sha256\(accessToken\)/);
  assert.match(oauth, /sha256\(refreshToken\)/);
  assert.match(oauth, /ACCESS_TTL_MS\s*=\s*60 \* 60 \* 1000/);
  assert.match(oauth, /REFRESH_TTL_MS\s*=\s*30 \* 24 \* 60 \* 60 \* 1000/);
  assert.doesNotMatch(migration, /access_token\s+text/i);
  assert.match(migration, /access_token_hash text not null unique/i);
  assert.match(migration, /refresh_token_hash text unique/i);
});

test("token store is closed to browser roles", () => {
  for (const table of ["mcp_oauth_authorization_codes", "mcp_oauth_tokens"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from anon, authenticated`, "i"));
    assert.match(migration, new RegExp(`grant all on table public\\.${table} to service_role`, "i"));
  }
});

test("MCP transport implements discovery, initialization and tools", () => {
  assert.match(server, /server\/discover/);
  assert.match(server, /initialize/);
  assert.match(server, /tools\/list/);
  assert.match(server, /tools\/call/);
  assert.match(server, /mcp\/www_authenticate/);
  assert.match(server, /WWW-Authenticate/);
  assert.match(server, /2026-07-28/);
  assert.match(server, /2025-11-25/);
});

test("published tools are all read-only and OAuth protected", () => {
  for (const name of ["get_profile", "list_projects", "search_leads", "get_lead", "get_inventory", "get_lot"]) {
    assert.match(tools, new RegExp(`name: "${name}"`));
  }
  assert.match(tools, /readOnlyHint:\s*true/);
  assert.match(tools, /destructiveHint:\s*false/);
  assert.match(tools, /type:\s*"oauth2"/);
  for (const forbidden of ["send_whatsapp", "reserve_lot", "update_lead", "change_price", "create_proposal"]) {
    assert.doesNotMatch(tools, new RegExp(`name: "${forbidden}"`));
  }
});

test("data tools are hard-scoped to Solaris and exclude high-risk CRM fields", () => {
  assert.match(data, /SOLARIS_PROJECT_ID/);
  assert.match(data, /organization_id/);
  for (const forbidden of [
    "cpf_cnpj", "monthly_income", "street", "address_number",
    "spouse_document", "minimum_price", "strategic_reason", "notes",
  ]) {
    assert.doesNotMatch(data, new RegExp(`["']${forbidden}["']`));
  }
  assert.match(data, /is_binding_offer:\s*false/);
  assert.match(data, /data_is_untrusted:\s*true/);
});

test("consent screen states the actual limited permission", () => {
  assert.match(consent, /somente leitura/i);
  assert.match(consent, /sem enviar WhatsApp, alterar lead, reservar lote ou mudar preço/i);
  assert.match(consent, /signInWithPassword/);
  assert.doesNotMatch(consent, /localStorage\.setItem\([^)]*password/i);
});
