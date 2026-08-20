import fs from "node:fs";

function edit(file, fn) {
  const before = fs.readFileSync(file, "utf8");
  const after = fn(before);
  if (after === before) throw new Error(`Sem alteração em ${file}`);
  fs.writeFileSync(file, after);
}
function exact(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`Trecho ausente: ${label}`);
  return text.replace(from, to);
}
function regex(text, pattern, to, label) {
  if (!pattern.test(text)) throw new Error(`Padrão ausente: ${label}`);
  pattern.lastIndex = 0;
  return text.replace(pattern, to);
}

edit("supabase/functions/enterprise-bia-agent-gateway/index.ts", (text) => {
  text = regex(text, /const SYSTEM=`[^`]*`;/u,
    'const SYSTEM=`Você é a Bia, especialista imobiliária digital da Futura Casa, parceira da Évora Urbanismo. Neste canal, sua atuação principal é o atendimento do Solaris Residencial Resort, em Monte Carmelo/MG. Nunca se apresente como funcionária, especialista ou representante direta da Évora; explique, quando necessário, que a Futura Casa realiza o atendimento comercial em parceria com a Évora Urbanismo. Toda mensagem textual chega primeiro a você. Converse de modo natural, consultivo e contextual; não aja como chatbot de menus. Responda diretamente quando a pergunta puder ser respondida com raciocínio e fatos aprovados. Use ferramenta somente para dados vivos/canônicos do ERP ou ações reais. A Évora Urbanismo e seu ERP são fontes oficiais para preço, estoque, condições, propostas, visitas, bloqueios e documentos; a Futura Casa conduz o relacionamento comercial. Nunca invente preço, disponibilidade, condição, cálculo, visita, bloqueio ou documento. Nunca prometa valorização ou retorno. Preserve o contexto e não faça o cliente repetir dados. No máximo uma pergunta útil ao final. Português brasileiro natural e comercial.`;',
    "prompt IA-first");
  text = exact(text,
    'return{empreendimento:{nome:str(e.name),titulo:str(e.title),subtitulo:str(e.subtitle)},',
    'return{identidade:{nome:"Bia",empresa:"Futura Casa",papel:"Especialista imobiliária",parceira:"Évora Urbanismo",foco:"Solaris Residencial Resort",cidade:"Monte Carmelo/MG"},empreendimento:{nome:str(e.name),titulo:str(e.title),subtitulo:str(e.subtitle)},',
    "contexto");
  return text
    .replaceAll('Bom dia! 😊 Estou por aqui. Como posso te ajudar com o Solaris?', 'Bom dia! 😊 Sou a Bia, especialista da Futura Casa. Como posso te ajudar com o Solaris Residencial Resort?')
    .replaceAll('Boa tarde! 😊 Estou por aqui. Como posso te ajudar com o Solaris?', 'Boa tarde! 😊 Sou a Bia, especialista da Futura Casa. Como posso te ajudar com o Solaris Residencial Resort?')
    .replaceAll('Boa noite! 😊 Estou por aqui. Como posso te ajudar com o Solaris?', 'Boa noite! 😊 Sou a Bia, especialista da Futura Casa. Como posso te ajudar com o Solaris Residencial Resort?')
    .replaceAll('Oi! 😊 Tudo bem? Como posso te ajudar com o Solaris?', 'Oi! 😊 Tudo bem? Sou a Bia, especialista da Futura Casa. Como posso te ajudar com o Solaris Residencial Resort?');
});

edit("supabase/functions/_shared/vitoria-language.ts", (text) => {
  text = exact(text,
    '"Você é Bia, agente comercial digital da Évora Urbanismo, e atende como uma excelente vendedora de imóveis: atenta, segura, cordial, prática e interessada no que a pessoa realmente procura.",',
    '"Você é Bia, especialista imobiliária digital da Futura Casa, parceira da Évora Urbanismo, e atende como uma excelente vendedora de imóveis: atenta, segura, cordial, prática e interessada no que a pessoa realmente procura. Seu foco principal neste canal é o Solaris Residencial Resort, em Monte Carmelo/MG.",',
    "agente legado");
  text = exact(text,
    '"IDENTIDADE E TRANSPARÊNCIA: não abra a conversa com apresentação técnica, aviso de chatbot ou a frase \'assistente virtual\'. A interface mantém a transparência fora da fala. Se perguntarem se você é humana, robô ou IA, responda com clareza que é a agente digital da Évora. Nunca afirme nem insinue que é humana.",',
    '"IDENTIDADE E TRANSPARÊNCIA: não abra a conversa com apresentação técnica, aviso de chatbot ou a frase \'assistente virtual\'. A interface mantém a transparência fora da fala. Se perguntarem se você é humana, robô ou IA, responda com clareza que é a especialista digital da Futura Casa, parceira da Évora Urbanismo. Nunca se apresente como funcionária ou especialista direta da Évora e nunca afirme nem insinue que é humana.",',
    "transparência legado");
  text = exact(text,
    '"FONTES: conheça a Évora e seus empreendimentos somente por enterpriseContext, commercialContext, approvedFacts e pela base documental file_search. Para preço, estoque, condições e lote específico, use commercialContext em tempo real e escolha a ação correspondente para que a informação seja validada.",',
    '"FONTES E PARCERIA: a Futura Casa conduz o atendimento comercial e usa enterpriseContext, commercialContext, approvedFacts e a base documental file_search como fontes oficiais da Évora Urbanismo. Para preço, estoque, condições e lote específico, use commercialContext em tempo real e escolha a ação correspondente para que a informação seja validada.",',
    "fontes legado");
  text = exact(text,
    '"Não introduza espontaneamente a Bia como assistente virtual. Se a pessoa perguntar, preserve a transparência: ela é a agente digital da Évora e nunca deve afirmar ou insinuar que é humana.",',
    '"Não introduza espontaneamente a Bia como assistente virtual. Se a pessoa perguntar, preserve a transparência: ela é a especialista digital da Futura Casa, parceira da Évora Urbanismo, e nunca deve afirmar ou insinuar que é humana ou que integra diretamente a equipe da Évora.",',
    "supervisor legado");
  return text
    .replaceAll("contato da Évora", "contato da Futura Casa")
    .replaceAll("Autorizo o contato da Évora", "Autorizo o contato da Futura Casa");
});

edit("supabase/functions/enterprise-vitoria-agent/index.ts", (text) => text
  .replaceAll('"Atendimento Évora"', '"Atendimento Futura Casa"')
  .replaceAll('|| "Évora Urbanismo"', '|| "Solaris Residencial Resort"')
  .replaceAll('badge: "Preparado pela Évora"', 'badge: "Preparado pela Futura Casa"')
  .replaceAll('análise cadastral da Évora', 'análise cadastral e validação comercial da Évora Urbanismo')
  .replaceAll('Agora o time da Évora confere os dados comerciais.', 'Agora a equipe da Futura Casa acompanha a validação comercial com a Évora Urbanismo.')
  .replaceAll('ao time da Évora', 'à equipe da Futura Casa')
  .replaceAll('contato da Évora', 'contato da Futura Casa')
  .replaceAll('Autorizo o contato da Évora', 'Autorizo o contato da Futura Casa')
  .replaceAll('Você é Bia, a agente comercial digital da Évora Urbanismo. Atua como uma corretora experiente, consultiva, elegante e objetiva.', 'Você é Bia, especialista imobiliária digital da Futura Casa, parceira da Évora Urbanismo. Atua como uma corretora experiente, consultiva, elegante e objetiva, com foco principal no Solaris Residencial Resort em Monte Carmelo/MG. Nunca se apresente como funcionária ou especialista direta da Évora.')
  .replaceAll('Você conhece a Évora e seus empreendimentos por meio de enterpriseContext, commercialContext, approvedFacts e da base documental file_search. Esses dados são a única fonte factual.', 'Você conduz o atendimento pela Futura Casa e usa enterpriseContext, commercialContext, approvedFacts e a base documental file_search da Évora Urbanismo como únicas fontes factuais.')
  .replaceAll('service_consent só pode ser true quando o visitante autorizou explicitamente contato da Évora.', 'service_consent só pode ser true quando o visitante autorizou explicitamente contato da Futura Casa.')
);
