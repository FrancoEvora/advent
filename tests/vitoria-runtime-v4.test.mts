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
  asksGeneralPaymentConditions,
  parseBalloonPlan,
  parseDownPaymentInstallments,
  parseEntryPercentage,
  parseTermMonths,
  wantsPaymentSimulation,
} = await import(new URL(
  "../supabase/functions/_shared/vitoria-commercial.ts",
  import.meta.url,
).href);

const {
  asksHoldStatus,
  canRestoreHoldSuggestions,
  continuesAfterHold,
  holdConfirmationPrompt,
  leadCaptureRequested,
  removePrematureHoldSuggestions,
  rejectsOrDefersHold,
  selectedUnitPurchaseRequested,
  serviceConsentPrompt,
  socialReply,
  socialTurn,
  teamHandoffRequested,
  VITORIA_AGENT_SYSTEM_PROMPT,
  VITORIA_SUPERVISOR_SYSTEM_PROMPT,
} = await import(new URL(
  "../supabase/functions/_shared/vitoria-language.ts",
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

test("condições comerciais extraem entrada e detalhes parciais de balões", () => {
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
  assert.equal(wantsPaymentSimulation("Faça com as simulações"), true);
  assert.equal(wantsPaymentSimulation("Mudar a entrada"), true);
  assert.equal(wantsPaymentSimulation("Quero ajustar a entrada"), true);
  assert.equal(wantsPaymentSimulation("Alterar o prazo"), true);
  assert.equal(wantsPaymentSimulation("Não quero mudar o prazo"), false);
  assert.equal(wantsPaymentSimulation("Não quero calcular condições"), false);
  assert.equal(wantsPaymentSimulation("Não quero parcelas"), false);
  assert.equal(wantsPaymentSimulation("Não quero 5 balões"), false);
  assert.equal(wantsPaymentSimulation("A entrada está alta"), false);
  assert.equal(wantsPaymentSimulation("Não quero ajustar a entrada"), false);
  assert.equal(wantsPaymentSimulation("entrada de 10%, 120 meses e 7 balões"), true);
  assert.equal(wantsPaymentSimulation("7 balões anuais de R$ 25.000"), true);
  assert.equal(wantsPaymentSimulation("balões anuais de 20 mil"), true);
  assert.equal(wantsPaymentSimulation("5 balões"), true);
  assert.equal(wantsPaymentSimulation("120 meses"), true);
  assert.equal(wantsPaymentSimulation("os juros são 0,33%?"), false);
  assert.equal(
    wantsPaymentSimulation("Não quero parcelas acima de R$ 2.500; calcule em 150 meses"),
    true,
  );
  assert.equal(
    parseTermMonths("Não quero parcelas acima de R$ 2.500; calcule em 150 meses"),
    150,
  );
  assert.equal(parseTermMonths("Não quero 300 parcelas; simule em 150 meses"), 150);
  assert.equal(parseTermMonths("Não quero 300 parcelas mas simule em 150 meses"), 150);
  assert.equal(wantsPaymentSimulation("Não quero 300 parcelas mas simule em 150 meses"), true);
  assert.equal(parseTermMonths("Não quero 300 parcelas e sim 150 meses"), 150);
  assert.equal(parseEntryPercentage("Não quero entrada 20%; use 15%"), 0.15);
  assert.equal(parseEntryPercentage("Não quero entrada 20% mas use 15%"), 0.15);
  assert.deepEqual(
    parseBalloonPlan("Quero 7 balões anuais de R$ 25.000"),
    { requested: true, count: 7, amount: 25_000 },
  );
  assert.deepEqual(
    parseBalloonPlan("Quero pagar com balões"),
    { requested: true, count: null, amount: null },
  );
  assert.deepEqual(
    parseBalloonPlan("Balões anuais de 20 mil"),
    { requested: true, count: null, amount: 20_000 },
  );
  assert.deepEqual(
    parseBalloonPlan("Considere 5 balões"),
    { requested: true, count: 5, amount: null },
  );
  assert.deepEqual(
    parseBalloonPlan("Não quero 5 balões, quero 7 balões de R$ 20 mil"),
    { requested: true, count: 7, amount: 20_000 },
  );
  assert.deepEqual(
    parseBalloonPlan("Não quero 5 balões mas quero 7 balões de 20 mil"),
    { requested: true, count: 7, amount: 20_000 },
  );
  assert.deepEqual(
    parseBalloonPlan("Simular sem balões"),
    { requested: true, count: 0, amount: 0 },
  );
  for (const message of [
    "Não quero balões; calcule em 150 meses",
    "Não inclua balões, simule em 150 meses",
    "Retire os balões e calcule em 150 meses",
  ]) {
    assert.deepEqual(
      parseBalloonPlan(message),
      { requested: true, count: 0, amount: 0 },
    );
    assert.equal(wantsPaymentSimulation(message), true);
    assert.equal(parseTermMonths(message), 150);
  }
  assert.deepEqual(
    parseBalloonPlan("Não quero balões; quero 7 balões de 20 mil"),
    { requested: true, count: 7, amount: 20_000 },
  );
});

test("condições gerais independem de lote e não são confundidas com cálculo exato", () => {
  assert.equal(asksGeneralPaymentConditions("Quais são as condições de pagamento?"), true);
  assert.equal(asksGeneralPaymentConditions("Quero conhecer as condições"), true);
  assert.equal(asksGeneralPaymentConditions("Como funciona a entrada?"), true);
  assert.equal(asksGeneralPaymentConditions("Qual é a entrada mínima e quais os prazos?"), true);
  assert.equal(
    asksGeneralPaymentConditions("Não quero simular, só quero conhecer as condições"),
    true,
  );
  assert.equal(asksGeneralPaymentConditions("Calcule as condições do SOL-C-04"), false);
  assert.equal(asksGeneralPaymentConditions("Simule com entrada de 15%"), false);
  assert.equal(asksGeneralPaymentConditions("Não quero conhecer as condições"), false);
  assert.equal(asksGeneralPaymentConditions("A entrada mínima é 10%?"), true);
  assert.equal(asksGeneralPaymentConditions("Posso pagar em 150 meses?"), true);
  assert.equal(asksGeneralPaymentConditions("Pode ter 7 balões?"), true);
  assert.equal(asksGeneralPaymentConditions("Quero saber se a entrada mínima é 10%?"), true);
  assert.equal(asksGeneralPaymentConditions("Quero saber se pode pagar em 150 meses"), true);
  assert.equal(asksGeneralPaymentConditions("Calcule com entrada de 10%"), false);
  assert.equal(asksGeneralPaymentConditions("Faça em 150 meses"), false);
  assert.equal(asksGeneralPaymentConditions("Quero 7 balões de R$ 20 mil"), false);
  assert.equal(asksGeneralPaymentConditions("Quanto fica em 150 meses?"), false);
  assert.equal(asksGeneralPaymentConditions("Qual seria a parcela em 150 meses?"), false);
  assert.equal(asksGeneralPaymentConditions("Quanto pago por mês em 150 meses?"), false);
  assert.equal(asksGeneralPaymentConditions("A parcela em 150 meses seria quanto?"), false);
});

test("continuação contextual reconhece atalhos antigos sem aceitar negativas", () => {
  assert.equal(continuesAfterHold("Continuar conversando"), true);
  assert.equal(continuesAfterHold("Continuar por aqui"), true);
  assert.equal(continuesAfterHold("E agora?"), true);
  assert.equal(continuesAfterHold("Qual o próximo passo?"), true);
  assert.equal(continuesAfterHold("Não quero continuar conversando"), false);
  assert.equal(continuesAfterHold("Agora não, podemos continuar depois"), false);
  assert.equal(continuesAfterHold("Continuar com o lote SOL-C-09"), false);

  assert.equal(asksHoldStatus("Consultar status"), true);
  assert.equal(asksHoldStatus("Como está o bloqueio?"), true);
  assert.equal(asksHoldStatus("O lote ainda está reservado?"), true);
  assert.equal(asksHoldStatus("Não quero consultar o bloqueio"), false);
});

test("Bia conversa como vendedora sem esconder que é uma agente digital", () => {
  assert.match(VITORIA_AGENT_SYSTEM_PROMPT, /Você é Bia, agente comercial digital/iu);
  assert.match(VITORIA_SUPERVISOR_SYSTEM_PROMPT, /Supervisor de Excelência da Bia/iu);
  assert.match(VITORIA_AGENT_SYSTEM_PROMPT, /não abra a conversa com apresentação técnica/iu);
  assert.match(VITORIA_AGENT_SYSTEM_PROMPT, /Nunca afirme nem insinue que é humana/iu);
  assert.match(VITORIA_AGENT_SYSTEM_PROMPT, /Qualquer visitante pode consultar informações/iu);
  assert.match(VITORIA_AGENT_SYSTEM_PROMPT, /sem cadastro no ERP/iu);
  assert.match(VITORIA_AGENT_SYSTEM_PROMPT, /explique as condições vigentes a qualquer visitante/iu);
  assert.match(VITORIA_AGENT_SYSTEM_PROMPT, /Selecionar ou simular um lote nunca inicia bloqueio/iu);
  assert.match(VITORIA_AGENT_SYSTEM_PROMPT, /request_hold só é permitido quando a pessoa pedir claramente/iu);
  assert.match(VITORIA_AGENT_SYSTEM_PROMPT, /handoff_requested só pode ser true/iu);
  assert.match(VITORIA_AGENT_SYSTEM_PROMPT, /não transforme toda conversa em captação de lead/iu);
  assert.match(VITORIA_AGENT_SYSTEM_PROMPT, /um bloqueio ativo desta sessão mantém o lote como o contexto atual/iu);
  assert.match(VITORIA_AGENT_SYSTEM_PROMPT, /sem voltar a um menu genérico/iu);
  assert.match(VITORIA_SUPERVISOR_SYSTEM_PROMPT, /soar burocrático, repetitivo ou como chatbot/iu);
  assert.match(VITORIA_SUPERVISOR_SYSTEM_PROMPT, /nunca deve afirmar ou insinuar que é humana/iu);
  assert.match(VITORIA_SUPERVISOR_SYSTEM_PROMPT, /Não transforme cadastro, visita, simulação ou bloqueio em handoff/iu);
  assert.match(VITORIA_SUPERVISOR_SYSTEM_PROMPT, /Um bloqueio ativo da sessão mantém a unidade como contexto atual/iu);
  assert.match(VITORIA_SUPERVISOR_SYSTEM_PROMPT, /Condições vigentes são informativas e independem de lote/iu);
  assert.match(VITORIA_SUPERVISOR_SYSTEM_PROMPT, /Não sugira reserva na descoberta/iu);
});

test("captação não começa em uma saudação ou depois de uma recusa", () => {
  assert.equal(leadCaptureRequested("Olá, bom dia"), false);
  assert.equal(leadCaptureRequested("Este é um teste; não faça cadastro nem reserva"), false);
  assert.equal(leadCaptureRequested("Quero comprar o lote SOL-C-04"), false);
  assert.equal(leadCaptureRequested("Cadastre meus dados por aqui"), true);
  assert.equal(leadCaptureRequested("Quero falar com alguém da equipe"), true);
  assert.equal(leadCaptureRequested("Pode me ligar"), true);
});

test("intenção de compra usa o lote selecionado sem executar bloqueio ambíguo", () => {
  const unit = "SOL-C-04";
  assert.equal(selectedUnitPurchaseRequested("Quero comprar ar", unit), true);
  assert.equal(selectedUnitPurchaseRequested("Reservar este lote", unit), true);
  assert.equal(selectedUnitPurchaseRequested("Bloquear este lote", unit), true);
  assert.equal(selectedUnitPurchaseRequested("Fico com esse", unit), true);
  assert.equal(selectedUnitPurchaseRequested("Podemos seguir com este", unit), true);
  assert.equal(selectedUnitPurchaseRequested("Não quero comprar agora", unit), false);
  assert.equal(selectedUnitPurchaseRequested("Não reservar este lote", unit), false);
  assert.equal(selectedUnitPurchaseRequested("Quero comprar, mas não agora", unit), false);
  assert.equal(selectedUnitPurchaseRequested("Talvez eu compre depois", unit), false);
  assert.equal(selectedUnitPurchaseRequested("Quero comprar o SOL-B-12", unit), false);
  assert.equal(selectedUnitPurchaseRequested("Quero reservar depois", unit), false);
  assert.equal(selectedUnitPurchaseRequested("Quero reservar mais tarde", unit), false);
  assert.equal(selectedUnitPurchaseRequested("Quero reservar só depois de negociar", unit), false);
  assert.equal(selectedUnitPurchaseRequested("Quero reservar após negociar", unit), false);
  assert.equal(selectedUnitPurchaseRequested("Quero reservar, mas primeiro quero simular", unit), false);
  assert.equal(selectedUnitPurchaseRequested("Depois eu quero reservar este lote", unit), false);
  assert.equal(selectedUnitPurchaseRequested("Podemos fechar com esse só depois de simular", unit), false);
  assert.equal(selectedUnitPurchaseRequested("Quando eu terminar, quero reservar", unit), false);
  assert.equal(selectedUnitPurchaseRequested("Quero comprar no mês que vem", unit), false);
  assert.equal(selectedUnitPurchaseRequested("Quero comprar futuramente", unit), false);
  assert.equal(selectedUnitPurchaseRequested("Vamos seguir com este amanhã", unit), false);
  assert.equal(selectedUnitPurchaseRequested("Quero reservar daqui a um mês", unit), false);
  assert.equal(selectedUnitPurchaseRequested("Quero reservar na semana que vem", unit), false);
  assert.equal(selectedUnitPurchaseRequested("Quero reservar agora", unit), true);
  assert.equal(selectedUnitPurchaseRequested("Pode reservar este lote", unit), true);
  assert.equal(selectedUnitPurchaseRequested("Vamos seguir com este", unit), true);
  assert.equal(rejectsOrDefersHold("Só quero simular, não reserve"), true);
  assert.equal(rejectsOrDefersHold("Simule agora; reserva só depois"), true);
  assert.equal(rejectsOrDefersHold("Simule agora e depois me mostre os materiais"), false);
});

test("atalhos antigos de reserva são removidos quando a jornada ainda não amadureceu", () => {
  const legacyReplies = [
    "Simular pagamento",
    "Reservar este lote",
    "Bloquear este lote",
    "Ver fotos e materiais",
  ];
  assert.deepEqual(
    removePrematureHoldSuggestions(legacyReplies, false),
    ["Simular pagamento", "Ver fotos e materiais"],
  );
  assert.deepEqual(
    removePrematureHoldSuggestions(legacyReplies, true),
    legacyReplies,
  );
  assert.equal(canRestoreHoldSuggestions({
    unitCode: "SOL-C-04",
    latestAction: "show_inventory",
    completedSimulations: 0,
  }), false);
  assert.equal(canRestoreHoldSuggestions({
    unitCode: "SOL-C-04",
    latestAction: "show_policy",
    completedSimulations: 1,
  }), true);
  assert.equal(canRestoreHoldSuggestions({
    unitCode: "SOL-C-04",
    latestAction: "request_hold",
    completedSimulations: 0,
  }), true);
  assert.equal(canRestoreHoldSuggestions({
    unitCode: "SOL-C-04",
    latestAction: "hold_status",
    completedSimulations: 0,
  }), true);
  assert.equal(canRestoreHoldSuggestions({
    unitCode: null,
    latestAction: "request_hold",
    completedSimulations: 2,
  }), false);
});

test("pedido de equipe é reconhecido sem reabrir cadastro convertido", () => {
  assert.equal(teamHandoffRequested("Falar com especialista"), true);
  assert.equal(teamHandoffRequested("Quero falar com um especialista"), true);
  assert.equal(teamHandoffRequested("Prefiro conversar com a equipe"), true);
  assert.equal(teamHandoffRequested("Não quero falar com consultor"), false);
  assert.equal(teamHandoffRequested("Quero ver as condições"), false);
});

test("confirmação, consentimento e despedida preservam fluidez e segurança", () => {
  const confirmation = holdConfirmationPrompt("SOL-C-04");
  assert.match(confirmation, /SOL-C-04/);
  assert.match(confirmation, /não bloquear o lote errado/iu);
  assert.doesNotMatch(confirmation, /sujeit[oa] à aprovação administrativa/iu);

  const consent = serviceConsentPrompt("hold");
  assert.match(consent, /autorização de contato/iu);
  assert.match(consent, /não ativa mensagens de marketing/iu);

  assert.equal(socialTurn("Muito obrigado. Boa tarde"), "farewell");
  assert.equal(socialTurn("Obrigado!"), "thanks");
  assert.equal(socialTurn("Boa tarde"), null);
  assert.equal(socialTurn("Obrigado, quero ver outro lote"), null);
  assert.match(socialReply("farewell"), /Foi um prazer te ajudar/iu);
});

test("runtime usa a voz humanizada, evita handoff automático e chama os wrappers de mídia", () => {
  const runtime = readFileSync(
    new URL("../supabase/functions/enterprise-vitoria-agent/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(runtime, /content:system/);
  assert.match(runtime, /VITORIA_AGENT_SYSTEM_PROMPT/);
  assert.match(runtime, /VITORIA_SUPERVISOR_SYSTEM_PROMPT/);
  assert.match(runtime, /finalize_public_agent_message_v5/);
  assert.match(runtime, /finalize_public_agent_handoff_v1/);
  assert.match(runtime, /commit_public_agent_action_message_v6/);
  assert.match(runtime, /commit_public_agent_lead_handoff_message_v1/);
  assert.match(runtime, /handoff: currentPending\.handoffRequested === true/);
  assert.match(runtime, /p_media_refs: serverMediaRefs/);
  assert.match(runtime, /browserSafeResponse\(input\.response\)/);
  assert.match(runtime, /PRIVATE_MEDIA_RESPONSE_KEYS/);
  assert.match(runtime, /contextWithFreshMedia/);
  assert.match(runtime, /createSignedUrls\(\[\.\.\.paths\], 600\)/);
  assert.match(runtime, /delete metadata\.server_media_refs/);
  assert.match(runtime, /bucket: "erp-documents"/);
  assert.match(runtime, /storageBucket:\s*"vitoria-generated"/);
  assert.match(runtime, /PUBLIC_AGENT_DISPLAY_NAME = "Bia"/);
  assert.match(runtime, /agentName: publicAgentName\(experience\.agentName\)/);
  assert.match(runtime, /metadata\.initial_greeting === true/);
  assert.match(runtime, /data: publicAgentExperience\(/);
  assert.doesNotMatch(runtime, /Você é Vit[oó]ria/);
  assert.match(runtime, /handoffRequested: false/);
  assert.match(runtime, /sessionHoldContext/);
  assert.match(runtime, /continuesAfterHold\(userMessage\)/);
  assert.match(runtime, /journey_state: isActiveHold\(activeHold\)/);
  assert.match(runtime, /contextualHoldReply\(activeHold, currentProfile\)/);
  assert.match(runtime, /holdMatchesUnit\(activeHold, selectedUnit\)/);
  assert.match(runtime, /pausesPendingAction\(userMessage\)/);
  assert.match(runtime, /currentPending && !pausesPendingAction\(userMessage\)/);
  assert.match(runtime, /asksGeneralPaymentConditions\(userMessage\)/);
  assert.match(runtime, /isso não reserva nem bloqueia nada/iu);
  assert.match(runtime, /inventoryNextReplies\(context,finalSelected,userMessage\)/);
  assert.match(runtime, /simulationNextReplies\(context, simulation\.unitCode, userMessage\)/);
  assert.match(runtime, /action==="request_hold"&&!explicitHoldRequest/);
  assert.match(runtime, /if \(!unitCode \|\| rejectsOrDefersHold\(message\)\) return false/);
  assert.doesNotMatch(runtime, /Posso simular as condições ou cuidar do bloqueio temporário/iu);
  assert.match(runtime, /selectedUnitCode: currentProfile\.selected_unit_code \|\| null/);
  assert.doesNotMatch(runtime, /Quero te passar a informação certa/);
  assert.doesNotMatch(runtime, /\["Ver lotes disponíveis","Continuar conversando"\]/);
  assert.doesNotMatch(runtime, /Falar com especialista/);
  assert.doesNotMatch(runtime, /Sua solicitação .* está com status/);
  assert.doesNotMatch(runtime, /Concluindo (?:seu cadastro|o bloqueio) no Enterprise/);
});

test("retomada da conversa preserva as próximas ações contextuais", () => {
  const runtime = readFileSync(
    new URL("../supabase/functions/enterprise-vitoria-agent/index.ts", import.meta.url),
    "utf8",
  );
  const ui = readFileSync(
    new URL("../src/components/public-agent/PublicAgentExperience.tsx", import.meta.url),
    "utf8",
  );
  assert.match(runtime, /quickReplies: removePrematureHoldSuggestions\(\s*cleanStringArray\(latestPublicResponse\.quickReplies, 5, 90\)/);
  assert.match(runtime, /quickReplies: removePrematureHoldSuggestions\(\s*cleanStringArray\(publicResponse\.quickReplies, 5, 90\)/);
  assert.match(runtime, /restoredHoldSuggestionReady\(value, latestPublicResponse\)/);
  assert.match(runtime, /completedSimulations: completedSimulationCount\(context, unitCode\)/);
  assert.doesNotMatch(runtime, /selectedUnitPurchaseRequested\(String\(message\.content/);
  assert.match(ui, /payload\.quickReplies\?\.length/);
  assert.match(ui, /setQuickReplies/);
});

test("cartão de lote inicia simulação sem criar intenção artificial de reserva", () => {
  const ui = readFileSync(
    new URL("../src/components/public-agent/PublicAgentExperience.tsx", import.meta.url),
    "utf8",
  );
  assert.match(ui, /Simular condições do lote \$\{unit\.unitCode\}/);
  assert.match(ui, />\s*Simular condições\s*</);
  assert.doesNotMatch(ui, /Quero reservar o lote \$\{unit\.unitCode\}/);
  assert.doesNotMatch(ui, />\s*Quero reservar\s*</);
});

test("experiência preserva configuração visual e persiste uma saudação natural", () => {
  const sql = readFileSync(
    new URL(
      "../supabase/migrations/20260817154400_vitoria_persist_initial_greeting.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /'greetingText', experience_row\.greeting_text/);
  assert.match(sql, /'avatar', experience_row\.avatar/);
  assert.match(sql, /'capabilities', experience_row\.capabilities/);
  assert.match(sql, /'initial_greeting'/);
  assert.match(sql, /'reconstructed_from_ui', true/);
  assert.match(sql, /insert into public\.crm_messages/);
  assert.match(sql, /record\.record_status = 'arquivada'/);
  assert.doesNotMatch(sql, /Sou a [^,]+, assistente virtual/);
});

test("mídia estável permanece server-side e vinculada ao par correto", () => {
  const sql = readFileSync(
    new URL(
      "../supabase/migrations/20260817154600_vitoria_stable_media_history.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /public_agent_server_media_refs/);
  assert.match(
    sql,
    /'erp-documents', 'vitoria-generated', 'vitoria-knowledge'/,
  );
  assert.match(sql, /storage_path_value ~ '\(\^\|\/\)\\\.\{1,2\}\(\/\|\$\)'/);
  assert.match(sql, /server_media_refs/);
  assert.match(sql, /public_audio_value/);
  assert.match(sql, /PUBLIC_AGENT_MEDIA_SCOPE_INVALID/);
  assert.match(sql, /session_row\.organization_id::text/);
  assert.match(sql, /session_row\.id::text/);
  assert.match(sql, /crm_private\.vitoria_knowledge_sources/);
  assert.match(sql, /source\.public_document/);
  assert.match(sql, /public\.crm_marketing_assets/);
  assert.match(sql, /'vitoria-public' = any\(asset\.tags\)/);
  assert.match(sql, /message\.direction = 'inbound'/);
  assert.match(sql, /message\.occurred_at = assistant_crm_row\.occurred_at - interval '1 millisecond'/);
  assert.match(sql, /public\.finalize_public_agent_message_v4/);
  assert.match(sql, /public\.commit_public_agent_action_message_v5/);
  assert.match(sql, /PUBLIC_AGENT_MEDIA_RESPONSE_INVALID/);
  assert.match(sql, /PUBLIC_AGENT_MEDIA_IDEMPOTENCY_CONFLICT/);
  assert.match(
    sql,
    /grant execute on function public\.finalize_public_agent_message_v5[\s\S]+?to service_role/,
  );
  assert.match(
    sql,
    /grant execute on function public\.commit_public_agent_action_message_v6[\s\S]+?to service_role/,
  );
  assert.doesNotMatch(
    sql,
    /grant execute on function crm_private\.attach_public_agent_message_media_v5/,
  );
});

test("pedido de especialista cria handoff real e idempotente no CRM", () => {
  const sql = readFileSync(
    new URL(
      "../supabase/migrations/20260817154800_vitoria_real_handoff.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /public\.finalize_public_agent_message_v5/);
  assert.match(sql, /status = 'human_required'/);
  assert.doesNotMatch(sql, /ai_enabled = false/);
  assert.match(sql, /insert into public\.crm_actions/);
  assert.match(sql, /insert into public\.crm_alerts/);
  assert.match(sql, /'handoff\.requested'/);
  assert.match(sql, /on conflict \(organization_id, idempotency_key\)/);
  assert.match(
    sql,
    /grant execute on function public\.finalize_public_agent_handoff_v1[\s\S]+?to service_role/,
  );
  assert.doesNotMatch(sql, /to anon|to authenticated/);
});

test("pedido humano sobrevive à captura e converte com handoff atômico", () => {
  const sql = readFileSync(
    new URL(
      "../supabase/migrations/20260817155000_vitoria_handoff_capture_continuity.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /'handoffRequested'/);
  assert.match(sql, /public_agent_pending_transition_is_valid/);
  assert.match(sql, /commit_public_agent_lead_handoff_message_v1/);
  assert.match(sql, /commit_public_agent_action_message_v6/);
  assert.match(sql, /status = 'human_required'/);
  assert.doesNotMatch(sql, /ai_enabled = false/);
  assert.match(sql, /'handoff\.requested'/);
  assert.match(sql, /'action', 'human_handoff'/);
  assert.match(sql, /set response = result_value/);
  assert.match(
    sql,
    /grant execute on function public\.commit_public_agent_lead_handoff_message_v1[\s\S]+?to service_role/,
  );
});

test("contrato v4 contém fencing, serialização e commit atômico", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/20260817031140_vitoria_public_runtime_v4.sql", import.meta.url),
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
    new URL("../supabase/migrations/20260817031143_vitoria_payment_simulation_v4.sql", import.meta.url),
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
      "../supabase/migrations/20260817031147_vitoria_runtime_credentials_vector_store_v4.sql",
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
