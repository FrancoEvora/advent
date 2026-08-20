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

edit("src/components/public-agent/PublicAgentExperience.tsx", (text) => {
  text = exact(text,
    'const PUBLIC_AGENT_DISPLAY_NAME = "Bia";',
    'const PUBLIC_AGENT_DISPLAY_NAME = "Bia";\nconst PUBLIC_AGENT_BRAND_LINE = "Especialista da Futura Casa · Parceira da Évora Urbanismo";\nconst PUBLIC_AGENT_ACCESSIBLE_IDENTITY = "especialista da Futura Casa, parceira da Évora Urbanismo";',
    "constantes");
  text = regex(text,
    /return `Oi! Tudo bem\? Sou a \$\{publicAgentName\(experience\.agentName\)\}, da Évora\. Me conta: você está procurando um lote para morar, investir\$\{destination\}\?`;/u,
    'return `Oi! Tudo bem? Eu sou a ${publicAgentName(experience.agentName)}, especialista da Futura Casa, parceira da Évora Urbanismo. Estou aqui especialmente para te ajudar com o Solaris Residencial Resort, em Monte Carmelo. Você está pensando em morar, investir ou quer comparar as condições?`;',
    "saudação");
  text = exact(text,
    '<h1 className="public-agent-sr-only">Conversa com a {agentName}, atendimento digital da Évora Urbanismo</h1>',
    '<h1 className="public-agent-sr-only">Conversa com a {agentName}, {PUBLIC_AGENT_ACCESSIBLE_IDENTITY}, para atendimento do Solaris Residencial Resort em Monte Carmelo</h1>',
    "h1");
  text = exact(text,
    '<span>Atendimento digital · Évora Urbanismo</span>',
    '<span>{PUBLIC_AGENT_BRAND_LINE}</span>',
    "cabeçalho");
  text = regex(text,
    /Atendimento comercial com IA\. Esta conversa e os dados enviados\s+ficam registrados para atendimento, segurança e histórico\s+comercial\. Valores e disponibilidade são consultados na plataforma\s+da Évora\.\{" "\}/u,
    'Atendimento comercial com IA da Futura Casa, parceira da Évora Urbanismo. Esta conversa e os dados enviados\n            ficam registrados para atendimento, segurança e histórico\n            comercial. Valores e disponibilidade são consultados na plataforma\n            da Évora Urbanismo.{" "}',
    "aviso");
  text = exact(text,
    'href="mailto:relacionamento@evoraurbanismo.com.br?subject=Privacidade%20-%20Atendimento%20Vit%C3%B3ria"',
    'href="mailto:relacionamento@evoraurbanismo.com.br?subject=Privacidade%20-%20Atendimento%20Bia%20Futura%20Casa"',
    "privacidade");
  return text;
});

edit("src/app/atendimento/[slug]/page.tsx", (text) => {
  text = exact(text, 'title: "Atendimento não encontrado — Évora Urbanismo",', 'title: "Atendimento não encontrado — Futura Casa",', "404");
  text = exact(text, 'title: `${experience.name} — Atendimento com a Bia`,', 'title: `${experience.name} — Atendimento com a Bia | Futura Casa`,', "title");
  text = exact(text, 'applicationName: "Atendimento Inteligente Évora",', 'applicationName: "Bia — Futura Casa",', "app");
  text = text.replaceAll('title: `${experience.name} — Atendimento inteligente`,', 'title: `${experience.name} — Futura Casa`,');
  text = exact(text, 'siteName: "Évora Urbanismo",', 'siteName: "Futura Casa · Parceira da Évora Urbanismo",', "site");
  return text;
});

edit("src/app/atendimento/manifest.webmanifest/route.ts", (text) => {
  text = exact(text, 'name: "Bia — Atendimento Évora",', 'name: "Bia — Futura Casa",', "manifest name");
  text = exact(text, 'short_name: "Bia Évora",', 'short_name: "Bia Futura Casa",', "manifest short");
  text = exact(text, 'description: "Atendimento comercial digital da Évora Urbanismo.",', 'description: "Especialista da Futura Casa, parceira da Évora Urbanismo, para o Solaris Residencial Resort em Monte Carmelo.",', "manifest desc");
  return text;
});

edit("src/components/erp/crm-v5/ai-runtime-settings.tsx", (text) => {
  text = exact(text, '<h3>Bia · Agente Comercial IA</h3>', '<h3>Bia · Especialista Comercial IA da Futura Casa</h3>', "runtime title");
  text = regex(text,
    /Atendimento com IA integrado ao CRM\. A Bia conversa diretamente com o cliente e consulta\s+o ERP por ferramentas controladas quando precisa de dados ou executar uma ação\./u,
    'Atendimento da Futura Casa, parceira da Évora Urbanismo, integrado ao CRM. A Bia conversa diretamente com o cliente e consulta\n            o ERP por ferramentas controladas quando precisa de dados ou executar uma ação.',
    "runtime desc");
  return text;
});
