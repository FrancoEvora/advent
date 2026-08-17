import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const {
  cityFromMessage,
  confirmsHold,
  explicitNameFromMessage,
  isLocationStatement,
  marketingConsentDecision,
  serviceConsentDecision,
} = await import(new URL(
  "../supabase/functions/_shared/vitoria-intent.ts",
  import.meta.url,
).href);

const {
  parseBalloonPlan,
  parseDownPaymentInstallments,
  parseEntryPercentage,
  parseTermMonths,
  wantsPaymentSimulation,
} = await import(new URL(
  "../supabase/functions/_shared/vitoria-commercial.ts",
  import.meta.url,
).href);

test("consentimento de serviço rejeita negativas antes de qualquer positivo", () => {
  assert.equal(serviceConsentDecision("Não autorizo contato, mas autorizo marketing", true), false);
  assert.equal(serviceConsentDecision("Não autorizo contato e não quero marketing", true), false);
  assert.equal(serviceConsentDecision("Não autorizo o uso dos meus dados", true), false);
  assert.equal(serviceConsentDecision("Não me ligue mais", true), false);
  assert.equal(serviceConsentDecision("Revogo meu consentimento", true), false);
  assert.equal(serviceConsentDecision("Não me chama mais", true), false);
  assert.equal(serviceConsentDecision("Não quero que me liguem", true), false);
  assert.equal(serviceConsentDecision("Retiro meu consentimento", true), false);
  assert.equal(serviceConsentDecision("Cancelo minha autorização", true), false);
  assert.equal(serviceConsentDecision("Pode parar de me ligar", true), false);
  assert.equal(serviceConsentDecision("Não autorizo marketing, mas autorizo o contato da Évora", true), true);
});

test("captura de nome não confunde origem ou cidade com a pessoa", () => {
  assert.equal(explicitNameFromMessage("Sou de Monte Carmelo"), null);
  assert.equal(explicitNameFromMessage("Sou embaixador da marca"), null);
  assert.equal(explicitNameFromMessage("Meu nome é João da Silva"), "João da Silva");
  assert.equal(explicitNameFromMessage("Me chamo Ana Paula"), "Ana Paula");
  assert.equal(explicitNameFromMessage("Meu nome é João da Silva e quero reservar"), "João da Silva");
  assert.equal(explicitNameFromMessage("Me chamo Ana Paula e moro em Uberlândia"), "Ana Paula");
  assert.equal(explicitNameFromMessage("Me chamo Maria. Quero reservar"), "Maria");
  assert.equal(isLocationStatement("Sou de Monte Carmelo"), true);
  assert.equal(isLocationStatement("Moro em Uberlândia"), true);
  assert.equal(isLocationStatement("João de Souza"), false);
  assert.equal(cityFromMessage("Moro em Uberlândia"), "Uberlândia");
  assert.equal(cityFromMessage("Moro em Uberlândia e quero reservar"), "Uberlândia");
  assert.equal(cityFromMessage("Sou de Monte Carmelo. Quero conhecer o Solaris"), "Monte Carmelo");
});

test("confirmação genérica só vale no estado canônico de consentimento", () => {
  assert.equal(serviceConsentDecision("Sim, autorizo", false), null);
  assert.equal(serviceConsentDecision("Sim, autorizo", true), true);
  assert.equal(serviceConsentDecision("Autorizo o contato da Évora", false), true);
  assert.equal(serviceConsentDecision("Pode me ligar", false), true);
});

test("marketing permanece separado do consentimento de atendimento", () => {
  assert.equal(marketingConsentDecision("Autorizo o contato, mas não quero marketing"), false);
  assert.equal(marketingConsentDecision("Quero receber novidades e ofertas"), true);
  assert.equal(marketingConsentDecision("Autorizo o contato da Évora"), null);
  assert.equal(marketingConsentDecision("Retiro meu consentimento para marketing"), false);
  assert.equal(marketingConsentDecision("Cancelo minha autorização de marketing"), false);
  assert.equal(serviceConsentDecision("Retiro meu consentimento para marketing", false), null);
  assert.equal(serviceConsentDecision("Cancelo minha autorização de marketing", false), null);
});

test("bloqueio exige ação positiva e a unidade exata", () => {
  const unit = "SOL-B-12";
  assert.equal(confirmsHold(`Confirmo o bloqueio do lote ${unit}`, unit), true);
  assert.equal(confirmsHold(`Confirmar bloqueio do lote ${unit}`, unit), true);
  assert.equal(confirmsHold(`Não pode bloquear o lote ${unit}`, unit), false);
  assert.equal(confirmsHold(`Não confirmo o bloqueio do lote ${unit}`, unit), false);
  assert.equal(confirmsHold(`Sim, mas não faça a reserva do lote ${unit}`, unit), false);
  assert.equal(confirmsHold("Sim", unit), false);
  assert.equal(confirmsHold("Confirmo o bloqueio do lote SOL-C-04", unit), false);
  assert.equal(confirmsHold(`Confirmo o bloqueio do lote ${unit}0`, unit), false);
  assert.equal(confirmsHold(`Confirmo ${unit}, não SOL-C-04`, unit), false);
});

test("condições comerciais só extraem entrada explícita e balões completos", () => {
  assert.equal(parseEntryPercentage("juros de 0,33% ao mês"), null);
  assert.equal(parseEntryPercentage("entrada de 15%"), 0.15);
  assert.equal(parseEntryPercentage("20% de entrada"), 0.2);
  assert.equal(parseTermMonths("quero em 150 parcelas"), 150);
  assert.equal(parseTermMonths("prazo de 120 meses"), 120);
  assert.equal(parseTermMonths("entrada de 10% em 12x e saldo em 120 meses"), 120);
  assert.equal(parseTermMonths("entrada de 15% em 10 parcelas e restante em 150 parcelas"), 150);
  assert.equal(parseTermMonths("entrada em 12x"), null);
  assert.equal(parseDownPaymentInstallments("entrada de 10% em 6x"), 6);
  assert.equal(parseDownPaymentInstallments("prazo de 120 meses"), null);
  assert.equal(wantsPaymentSimulation("entrada em 6x"), true);
  assert.equal(wantsPaymentSimulation("Simule para mim"), true);
  assert.equal(wantsPaymentSimulation("entrada de 10%, 120 meses e 7 balões"), true);
  assert.equal(wantsPaymentSimulation("7 balões anuais de R$ 25.000"), true);
  assert.equal(wantsPaymentSimulation("120 meses"), true);
  assert.equal(wantsPaymentSimulation("os juros são 0,33%?"), false);
  assert.deepEqual(
    parseBalloonPlan("Quero 7 balões anuais de R$ 25.000"),
    { requested: true, count: 7, amount: 25_000 },
  );
  assert.deepEqual(
    parseBalloonPlan("Quero pagar com balões"),
    { requested: true, count: null, amount: null },
  );
  assert.deepEqual(
    parseBalloonPlan("Simular sem balões"),
    { requested: true, count: 0, amount: 0 },
  );
});

test("contrato v4 contém fencing, serialização e commit atômico", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/20260816223000_vitoria_public_runtime_v4.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /lease_token uuid not null/);
  assert.match(sql, /PUBLIC_AGENT_STALE_LEASE/);
  assert.match(sql, /PUBLIC_AGENT_REQUEST_IN_PROGRESS/);
  assert.match(sql, /commit_public_agent_action_message_v4/);
  assert.match(sql, /perform public\.append_public_agent_turn/);
  assert.match(sql, /request_kind = 'message'/);
  assert.match(sql, /p_expected_revision bigint/);
  assert.match(sql, /p_source text/);
  assert.match(sql, /complete_public_agent_request_v4/);
  assert.match(sql, /get_public_agent_request_response_v4/);
  assert.match(sql, /public_agent_public_audio_metadata/);
  assert.match(sql, /'public_audio', user_audio_value/);
  assert.match(sql, /'paymentDraft', payment_draft_value/);
  assert.match(sql, /'transcribe'/);
  assert.match(
    sql,
    /revoke all on function public\.commit_public_agent_action_v4[\s\S]+?from public, anon, authenticated, service_role/,
  );
  assert.doesNotMatch(
    sql,
    /grant execute on function public\.commit_public_agent_action_v4[\s\S]+?to service_role/,
  );
});

test("simulação v4 usa política, estoque e fórmula canônicos do Enterprise", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/20260816224500_vitoria_payment_simulation_v4.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /crm_negotiation_parameters/);
  assert.match(sql, /crm_inventory_units/);
  assert.match(sql, /balloon_limit_pct/);
  assert.match(sql, /allow_down_payment_installments/);
  assert.match(sql, /unit_row\.list_price - down_payment - balloon_total/);
  assert.match(sql, /'balloonTotal', balloon_total/);
  assert.match(sql, /jsonb_typeof\(policy_row\.parameters -> 'plan_options'\) = 'array'/);
  assert.match(sql, /jsonb_typeof\(policy_row\.parameters -> 'down_payment_options'\) = 'array'/);
  assert.match(sql, /down_payment_interest_rate/);
  assert.match(sql, /term_options := array/);
  assert.match(sql, /assert_public_agent_service_role/);
});

test("runtime OpenAI entrega o vector store somente ao service role", () => {
  const sql = readFileSync(
    new URL(
      "../supabase/migrations/20260816230000_vitoria_runtime_credentials_vector_store_v4.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /'knowledge_vector_store_id', runtime\.knowledge_vector_store_id/);
  assert.match(sql, /auth\.jwt\(\) ->> 'role'/);
  assert.match(sql, /revoke all on function public\.get_crm_ai_runtime_credentials\(uuid\)/);
  assert.match(sql, /grant execute on function public\.get_crm_ai_runtime_credentials\(uuid\)[\s\S]+?to service_role/);
});

test("BFF e gateway falham fechados e a OpenAI permanece server-side", () => {
  const server = readFileSync(
    new URL("../src/lib/public-agent/server.ts", import.meta.url),
    "utf8",
  );
  const gateway = readFileSync(
    new URL("../supabase/functions/enterprise-vitoria-agent-gateway/index.ts", import.meta.url),
    "utf8",
  );
  const runtime = readFileSync(
    new URL("../supabase/functions/enterprise-vitoria-agent/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(server, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(server, /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  assert.match(server, /apikey: publishableKey\(\)/);
  assert.doesNotMatch(server, /EVORA_PUBLIC_AGENT_/);
  assert.doesNotMatch(server, /DEFAULT_SUPABASE_URL|DEFAULT_PUBLISHABLE_KEY/);
  assert.match(gateway, /SUPABASE_PUBLISHABLE_KEYS/);
  assert.match(gateway, /request\.headers\.get\("apikey"\)/);
  assert.match(gateway, /constantTimeEqual\(configured, candidate\)/);
  assert.match(gateway, /JSON\.parse\(raw\)/);
  assert.doesNotMatch(gateway, /SUPABASE_ANON_KEY/);
  assert.doesNotMatch(gateway, /VITORIA_PUBLIC_AGENT_INGRESS_KEY/);
  assert.doesNotMatch(gateway, /sb_publishable_/);
  assert.match(runtime, /https:\/\/api\.openai\.com\/v1\/responses/);
  assert.match(runtime, /text:\{format:\{type:"json_schema"/);
  assert.match(runtime, /store:false/);
  assert.doesNotMatch(runtime, /audio\/ogg/);
});
