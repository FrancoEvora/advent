import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [route, historyComponent, historyStyles, contract] = await Promise.all([
  readFile("src/app/api/crm/conversations/route.ts", "utf8"),
  readFile(
    "src/components/erp/crm-v5/lead-conversation-history.tsx",
    "utf8",
  ),
  readFile(
    "src/components/erp/crm-v5/lead-conversation-history.module.css",
    "utf8",
  ),
  readFile("src/lib/crm/conversation-history.ts", "utf8"),
]);

test("endpoint valida JSON e limita os bytes realmente recebidos", () => {
  assert.match(route, /mediaType !== "application\/json"/);
  assert.match(route, /415,[\s\S]*"JSON_CONTENT_TYPE_REQUIRED"/);
  assert.match(route, /request\.body\.getReader\(\)/);
  assert.match(route, /byteLength \+= value\.byteLength/);
  assert.match(route, /byteLength > MAX_BODY_BYTES/);
  assert.match(route, /413, "REQUEST_TOO_LARGE"/);
});

test("mensagens usam cursor keyset composto sem offset ou count", () => {
  assert.match(route, /\.order\("occurred_at", \{ ascending: false \}\)/);
  assert.match(route, /\.order\("id", \{ ascending: false \}\)/);
  assert.match(
    route,
    /occurred_at\.lt\.\$\{cursor\.occurredAt\}[\s\S]*occurred_at\.eq\.\$\{cursor\.occurredAt\}[\s\S]*id\.lt\.\$\{cursor\.id\}/,
  );
  assert.match(route, /\.limit\(PAGE_SIZE \+ 1\)/);
  assert.match(route, /nextCursor:/);
  assert.match(contract, /nextCursor: string \| null/);
  assert.doesNotMatch(route, /\.range\(/);
  assert.doesNotMatch(route, /count:\s*"exact"/);
});

test("erro ao carregar mais não apaga a timeline nem disputa controller", () => {
  assert.match(historyComponent, /refreshControllerRef/);
  assert.match(historyComponent, /loadMoreControllerRef/);
  assert.match(historyComponent, /loadMoreError/);
  assert.match(historyComponent, /setMessages\(\(current\) =>/);
  assert.doesNotMatch(historyComponent, /const controllerRef =/);
});

test("timeline tem rolagem limitada e preserva a posição", () => {
  assert.match(historyStyles, /max-height:\s*min\(68vh, 780px\)/);
  assert.match(historyStyles, /overflow-y:\s*auto/);
  assert.match(historyStyles, /overscroll-behavior:\s*contain/);
  assert.match(historyComponent, /pending\.scrollTop \+ timeline\.scrollHeight/);
});

test("histórico reabre mídia privada sem expor o caminho do storage", () => {
  assert.match(route, /server_media_contract/);
  assert.match(route, /createSignedUrls\(chunk, MEDIA_URL_TTL_SECONDS\)/);
  assert.match(route, /MEDIA_URL_TTL_SECONDS = 10 \* 60/);
  assert.match(route, /legacyMessageMediaRefs/);
  assert.match(route, /vitoria-simulations\/\$\{organizationId\}\/\$\{sessionId\}/);
  assert.match(route, /delete metadata\.server_media_refs/);
  assert.match(route, /delete metadata\.server_media_contract/);
  assert.doesNotMatch(contract, /storagePath|storageBucket|serverMedia/);
});
