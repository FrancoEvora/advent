import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  MetaWebhookInputError,
  authorizeBearer,
  correlationIdFromHeader,
  correlationIdOrNew,
  extractMetaPageIdsForSignature,
  isStructurallyValidWorkerAuthorization,
  parseMetaVerificationRequest,
  parseMetaWebhookPayload,
  verifyMetaWebhookSignature,
  verifyMetaWebhookCandidateCoverage,
} from "../src/lib/integrations/meta/webhook-core.ts";
import {
  buildMetaIngestPayload,
  normalizePhoneE164,
} from "../src/lib/integrations/meta/lead-normalization.ts";
import {
  assertMatchingMetaIdentifier,
  isMetaAuthOrPermissionError,
  MetaGraphRequestError,
} from "../src/lib/integrations/meta/graph-error.ts";
import {
  parseMetaCredentialBearer,
  parseMetaCredentialStatus,
  resolveConditionalWebhookSecrets,
} from "../src/lib/integrations/meta/credential-contract.ts";
import {
  MetaCredentialStoreError,
  parseMetaWorkerRuntimeCredential,
  parseMetaWebhookRuntimeCredentialResult,
} from "../src/lib/integrations/meta/credential-store.ts";

const encoder = new TextEncoder();

function leadPayload(overrides = {}) {
  return {
    object: "page",
    entry: [
      {
        id: "123456789",
        time: 1_786_000_000,
        changes: [
          {
            field: "leadgen",
            value: {
              leadgen_id: "987654321",
              page_id: "123456789",
              form_id: "1122334455",
              ad_id: "5566778899",
              created_time: 1_786_000_000,
              ...overrides,
            },
          },
        ],
      },
    ],
  };
}

test("valida X-Hub-Signature-256 sobre os bytes brutos", () => {
  const body = encoder.encode(JSON.stringify(leadPayload()));
  const secret = "segredo-de-aplicativo-meta-para-testes";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  assert.equal(verifyMetaWebhookSignature(body, signature, secret), true);
  assert.equal(
    verifyMetaWebhookSignature(encoder.encode("{}"), signature, secret),
    false,
  );
  assert.equal(verifyMetaWebhookSignature(body, "sha1=abc", secret), false);
});

test("extrai Page IDs sem confiar no payload antes de selecionar o App Secret", () => {
  const body = encoder.encode(JSON.stringify(leadPayload()));
  assert.deepEqual(extractMetaPageIdsForSignature(body), ["123456789"]);
  assert.deepEqual(extractMetaPageIdsForSignature(encoder.encode("{")), []);
});

test("aceita cobertura multi-tenant somente quando todas as Pages compartilham o App Secret", () => {
  const body = encoder.encode(JSON.stringify(leadPayload()));
  const sharedSecret = "app-secret-compartilhado-com-tamanho-valido";
  const signature = `sha256=${createHmac("sha256", sharedSecret).update(body).digest("hex")}`;
  assert.equal(verifyMetaWebhookCandidateCoverage(body, signature, ["10", "20"], [
    { pageIds: ["10"], appSecret: sharedSecret },
    { pageIds: ["20"], appSecret: sharedSecret },
  ]), true);
  assert.equal(verifyMetaWebhookCandidateCoverage(body, signature, ["10", "20"], [
    { pageIds: ["10"], appSecret: sharedSecret },
    { pageIds: ["20"], appSecret: "outro-app-secret-com-tamanho-valido" },
  ]), false);
});

test("App Secret sem Verify Token valida POST, mas não habilita verificação GET", () => {
  const runtime = {
    candidates: [{
      organization_id: "123e4567-e89b-42d3-a456-426614174000",
      page_ids: ["1296933085661158"],
      app_secret: "app-secret-sem-verify-token-com-tamanho-valido",
      verify_token: null,
    }],
    unresolved_page_ids: [],
  };
  const post = parseMetaWebhookRuntimeCredentialResult(runtime, ["1296933085661158"]);
  assert.equal(post.candidates[0].verifyToken, null);
  assert.throws(
    () => parseMetaWebhookRuntimeCredentialResult(runtime),
    (error) => error instanceof MetaCredentialStoreError && error.kind === "invalid_contract",
  );

  const get = parseMetaWebhookRuntimeCredentialResult({
    candidates: [{
      organization_id: "123e4567-e89b-42d3-a456-426614174000",
      page_ids: ["1296933085661158"],
      verify_token: "verify-token-sem-app-secret-com-tamanho-valido",
    }],
    unresolved_page_ids: [],
  });
  assert.equal(get.candidates[0].appSecret, null);
  assert.equal(get.candidates[0].verifyToken, "verify-token-sem-app-secret-com-tamanho-valido");

  assert.throws(
    () => parseMetaWebhookRuntimeCredentialResult({
      ...runtime,
      candidates: [{ ...runtime.candidates[0], verify_token: "segredo-extra-nao-permitido-em-post" }],
    }, ["1296933085661158"]),
    (error) => error instanceof MetaCredentialStoreError && error.kind === "invalid_contract",
  );
  assert.throws(
    () => parseMetaWebhookRuntimeCredentialResult({
      candidates: [{
        organization_id: "123e4567-e89b-42d3-a456-426614174000",
        page_ids: ["1296933085661158"],
        verify_token: "verify-token-sem-app-secret-com-tamanho-valido",
        app_secret: "segredo-extra-nao-permitido-em-get",
      }],
      unresolved_page_ids: [],
    }),
    (error) => error instanceof MetaCredentialStoreError && error.kind === "invalid_contract",
  );
});

test("fallback bootstrap lê somente o segredo necessário em GET ou POST", () => {
  const unused = () => { throw new Error("segredo não utilizado foi lido"); };
  const get = resolveConditionalWebhookSecrets(
    [],
    unused,
    () => "verify-token-bootstrap-com-tamanho-valido",
  );
  assert.equal(get.appSecret, null);
  assert.equal(get.verifyToken, "verify-token-bootstrap-com-tamanho-valido");

  const post = resolveConditionalWebhookSecrets(
    ["1296933085661158"],
    () => "app-secret-bootstrap-com-tamanho-valido",
    unused,
  );
  assert.equal(post.appSecret, "app-secret-bootstrap-com-tamanho-valido");
  assert.equal(post.verifyToken, null);
});

test("API de credenciais exige Bearer estruturalmente válido", () => {
  assert.equal(parseMetaCredentialBearer(null), null);
  assert.equal(parseMetaCredentialBearer("Basic abc"), null);
  assert.equal(parseMetaCredentialBearer("Bearer curto"), null);
  assert.equal(
    parseMetaCredentialBearer(`Bearer ${"a".repeat(32)}`),
    "a".repeat(32),
  );
});

test("contrato do worker aceita apenas endpoint exato e Bearer de até 512 caracteres", () => {
  const valid = parseMetaWorkerRuntimeCredential({
    worker_url: "https://erp.evora.example/api/integrations/meta/leads/process",
    worker_secret: "a".repeat(64),
  });
  assert.equal(valid.workerSecret.length, 64);
  assert.throws(
    () => parseMetaWorkerRuntimeCredential({
      worker_url: "https://erp.evora.example/api/integrations/meta/leads/process?bypass=1",
      worker_secret: "a".repeat(64),
    }),
    (error) => error instanceof MetaCredentialStoreError && error.kind === "invalid_contract",
  );
  assert.throws(
    () => parseMetaWorkerRuntimeCredential({
      worker_url: "https://erp.evora.example/api/integrations/meta/leads/process",
      worker_secret: "a".repeat(513),
    }),
    (error) => error instanceof MetaCredentialStoreError && error.kind === "invalid_contract",
  );
});

test("status de credenciais nunca propaga valores secretos do RPC", () => {
  const parsed = parseMetaCredentialStatus({
    organization_id: "123e4567-e89b-42d3-a456-426614174000",
    app_secret: {
      configured: true,
      version: 2,
      configured_at: "2026-08-11T12:00:00Z",
      updated_at: "2026-08-11T13:00:00Z",
      value: "NAO_PODE_VAZAR",
    },
    verify_token: { configured: false, value: "NAO_PODE_VAZAR" },
    pages: [{
      page_id: "1296933085661158",
      route_count: 1,
      active_route_count: 0,
      access_token: { configured: true, version: 1, value: "NAO_PODE_VAZAR" },
    }],
    ready: {
      webhook_verification: false,
      signature_validation: true,
      graph_pages: 1,
    },
    app_secret_value: "NAO_PODE_VAZAR",
  });
  assert.equal(parsed.appSecret.configured, true);
  assert.equal(parsed.pages[0].pageId, "1296933085661158");
  assert.equal(JSON.stringify(parsed).includes("NAO_PODE_VAZAR"), false);

  const registeredOnly = parseMetaCredentialStatus({
    organization_id: "123e4567-e89b-42d3-a456-426614174000",
    app_secret: { configured: false },
    verify_token: { configured: false },
    pages: [{
      page_id: "1296933085661158",
      route_count: 0,
      active_route_count: 0,
      access_token: { configured: false },
    }],
    ready: {},
  });
  assert.equal(registeredOnly.pages[0].accessToken.configured, false);
});

test("extrai apenas notificações leadgen e normaliza IDs", () => {
  const payload = leadPayload();
  payload.entry[0].changes.unshift({ field: "feed", value: { item: "ignore" } });
  const parsed = parseMetaWebhookPayload(encoder.encode(JSON.stringify(payload)));

  assert.equal(parsed.notifications.length, 1);
  assert.deepEqual(parsed.notifications[0], {
    eventKey: "meta:leadgen:987654321",
    leadgenId: "987654321",
    pageId: "123456789",
    formId: "1122334455",
    adId: "5566778899",
    createdTime: 1_786_000_000,
    entryIndex: 0,
    changeIndex: 1,
    value: payload.entry[0].changes[1].value,
  });
});

test("elimina duplicata do mesmo lead na mesma entrega", () => {
  const payload = leadPayload();
  payload.entry[0].changes.push(payload.entry[0].changes[0]);
  const parsed = parseMetaWebhookPayload(encoder.encode(JSON.stringify(payload)));
  assert.equal(parsed.notifications.length, 1);
});

test("preserva leadgen sem form_id para reconciliação manual", () => {
  const payload = leadPayload();
  delete payload.entry[0].changes[0].value.form_id;
  const parsed = parseMetaWebhookPayload(encoder.encode(JSON.stringify(payload)));
  assert.equal(parsed.notifications[0].formId, null);
});

test("aceita delivery oficial de até 1.000 updates e rejeita o excedente", () => {
  const payload = leadPayload();
  payload.entry[0].changes = Array.from({ length: 1_000 }, (_, index) => ({
    field: "leadgen",
    value: {
      leadgen_id: String(9_000_000_000 + index),
      page_id: "123456789",
      form_id: "1122334455",
      created_time: 1_786_000_000,
    },
  }));
  const parsed = parseMetaWebhookPayload(encoder.encode(JSON.stringify(payload)));
  assert.equal(parsed.notifications.length, 1_000);

  payload.entry[0].changes.push({
    field: "leadgen",
    value: {
      leadgen_id: "999999999999",
      page_id: "123456789",
      form_id: "1122334455",
    },
  });
  assert.throws(
    () => parseMetaWebhookPayload(encoder.encode(JSON.stringify(payload))),
    (error) =>
      error instanceof MetaWebhookInputError &&
      error.code === "META_PAYLOAD_TOO_COMPLEX",
  );
});

test("rejeita leadgen sem identificador Meta estrito", () => {
  const body = encoder.encode(
    JSON.stringify(leadPayload({ leadgen_id: "../token" })),
  );
  assert.throws(
    () => parseMetaWebhookPayload(body),
    (error) =>
      error instanceof MetaWebhookInputError &&
      error.code === "INVALID_META_PAYLOAD",
  );
});

test("rejeita Page ID divergente entre entry e leadgen assinado", () => {
  const body = encoder.encode(JSON.stringify(leadPayload({ page_id: "999999999" })));
  assert.throws(
    () => parseMetaWebhookPayload(body),
    (error) => error instanceof MetaWebhookInputError && error.code === "INVALID_META_PAYLOAD",
  );
});

test("rejeita JSON excessivamente profundo", () => {
  const payload = leadPayload();
  let nested = payload.entry[0].changes[0].value;
  for (let index = 0; index < 20; index += 1) {
    nested.deep = {};
    nested = nested.deep;
  }
  assert.throws(
    () => parseMetaWebhookPayload(encoder.encode(JSON.stringify(payload))),
    (error) =>
      error instanceof MetaWebhookInputError &&
      error.code === "META_PAYLOAD_TOO_COMPLEX",
  );
});

test("confirma desafio apenas com verify token em tempo constante", () => {
  const params = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.verify_token": "token-de-verificacao-comprido",
    "hub.challenge": "challenge_123",
  });
  assert.equal(
    parseMetaVerificationRequest(params, "token-de-verificacao-comprido"),
    "challenge_123",
  );
  params.set("hub.verify_token", "incorreto");
  assert.throws(() =>
    parseMetaVerificationRequest(params, "token-de-verificacao-comprido"),
  );
});

test("protege processador por Bearer e valida correlation id", () => {
  const secret = "segredo-interno-com-mais-de-trinta-e-dois-caracteres";
  assert.equal(authorizeBearer(`Bearer ${secret}`, secret), true);
  assert.equal(authorizeBearer(`bearer ${secret}`, secret), false);
  assert.equal(authorizeBearer("Bearer incorreto", secret), false);
  assert.equal(isStructurallyValidWorkerAuthorization(`Bearer ${"a".repeat(32)}`), true);
  assert.equal(isStructurallyValidWorkerAuthorization(`Bearer ${"a".repeat(513)}`), false);
  assert.equal(isStructurallyValidWorkerAuthorization(null), false);
  assert.equal(correlationIdFromHeader("meta/req-123"), "meta/req-123");
  assert.equal(correlationIdFromHeader("ab"), null);
  assert.equal(correlationIdFromHeader("abc"), "abc");
  assert.equal(correlationIdFromHeader("quebra\nheader"), null);
  assert.match(
    correlationIdOrNew("ab"),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("não degrada silenciosamente erros Meta de token ou permissão", () => {
  for (const metaCode of [10, 190, 200, 275, 294]) {
    assert.equal(
      isMetaAuthOrPermissionError(
        new MetaGraphRequestError(`META_GRAPH_${metaCode}`, 400, false, metaCode),
      ),
      true,
    );
  }
  assert.equal(
    isMetaAuthOrPermissionError(
      new MetaGraphRequestError("META_GRAPH_100", 400, false, 100),
    ),
    false,
  );
  assert.equal(
    isMetaAuthOrPermissionError(
      new MetaGraphRequestError("META_GRAPH_403", 403, false, null),
    ),
    true,
  );
});

test("rejeita atribuição cruzada entre webhook assinado e Graph", () => {
  assert.doesNotThrow(() =>
    assertMatchingMetaIdentifier("123", "123", "META_ID_MISMATCH"),
  );
  assert.doesNotThrow(() =>
    assertMatchingMetaIdentifier(null, "123", "META_ID_MISMATCH"),
  );
  assert.throws(
    () => assertMatchingMetaIdentifier("123", "456", "META_ID_MISMATCH"),
    (error) =>
      error instanceof MetaGraphRequestError &&
      error.code === "META_ID_MISMATCH" &&
      error.retryable === false,
  );
});

test("normaliza telefone brasileiro sem duplicar o DDI", () => {
  assert.equal(normalizePhoneE164("(34) 99999-1234"), "+5534999991234");
  assert.equal(normalizePhoneE164("+55 34 99999-1234"), "+5534999991234");
  assert.equal(normalizePhoneE164("(415) 555-2671", "1"), "+14155552671");
  assert.equal(normalizePhoneE164("(34) 99999-1234", "0"), null);
  assert.equal(normalizePhoneE164("99999-1234"), null);
  assert.equal(normalizePhoneE164("0034"), null);
});

test("não presume opt-in; aceita somente disclaimer explicitamente configurado", () => {
  const bundle = {
    provider: "meta",
    channel: "meta_lead_ads",
    fetched_at: "2026-08-11T12:00:00.000Z",
    lead: {
      id: "987654321",
      created_time: "2026-08-11T11:59:00.000Z",
      field_data: [
        { name: "full_name", values: ["Maria da Silva"] },
        { name: "phone_number", values: ["(34) 99999-1234"] },
        { name: "marketing_consent", values: ["sim"] },
      ],
      custom_disclaimer_responses: [
        { checkbox_key: "aceite_comunicacoes", is_checked: "1" },
      ],
    },
    attribution: {
      provider_account_id: "10",
      campaign_id: "20",
      campaign_name: "Solaris",
      adset_id: "30",
      adset_name: "Famílias",
      ad_id: "40",
      ad_name: "Natureza",
      creative_id: "50",
      creative_name: "Vídeo",
      form_id: "60",
      form_name: "Solaris Leads",
      page_id: "70",
      page_name: "Solaris",
      publisher_platform: "facebook",
      placement: null,
      attribution_incomplete: true,
      enrichment_warnings: ["META_FORM_ENRICHMENT_UNAVAILABLE"],
    },
    graph: { ad: null, form: null },
    webhook: {
      event_key: "meta:leadgen:987654321",
      leadgen_id: "987654321",
      page_id: "70",
      form_id: "60",
      ad_id: "40",
      created_time: 1_786_446_000,
    },
  };

  const unknown = buildMetaIngestPayload(bundle);
  assert.equal(unknown.person.marketing_consent_status, "unknown");
  assert.equal("marketing_consent_source" in unknown.person, false);

  const explicit = buildMetaIngestPayload(bundle, "55", ["aceite_comunicacoes"]);
  assert.equal(explicit.person.marketing_consent_status, "granted");
  assert.equal(
    explicit.person.marketing_consent_source,
    "meta_custom_disclaimer:aceite_comunicacoes",
  );
  assert.equal(explicit.attribution.attribution_incomplete, true);
  assert.deepEqual(explicit.attribution.enrichment_warnings, [
    "META_FORM_ENRICHMENT_UNAVAILABLE",
  ]);
});

test("preserva lead Meta sem nome usando fallback canônico", () => {
  const payload = buildMetaIngestPayload({
    provider: "meta",
    channel: "meta_lead_ads",
    fetched_at: "2026-08-11T12:00:00.000Z",
    lead: {
      id: "1234567890123456",
      field_data: [
        { name: "phone_number", values: ["(34) 99999-1234"] },
      ],
    },
    attribution: {
      provider_account_id: null,
      campaign_id: null,
      campaign_name: null,
      adset_id: null,
      adset_name: null,
      ad_id: null,
      ad_name: null,
      creative_id: null,
      creative_name: null,
      form_id: "60",
      form_name: null,
      page_id: "70",
      page_name: null,
      publisher_platform: "facebook",
      placement: null,
      attribution_incomplete: false,
      enrichment_warnings: [],
    },
    graph: { ad: null, form: null },
    webhook: {
      event_key: "meta:leadgen:1234567890123456",
      leadgen_id: "1234567890123456",
      page_id: "70",
      form_id: "60",
      ad_id: null,
      created_time: null,
    },
  });
  assert.equal(payload.person.name, "Lead Meta 90123456");
  assert.equal(payload.person.phone_e164, "+5534999991234");
});
