export type AssistantId = "arisa" | "bia";
export const assistantProfiles = {
  arisa: {
    name: "Arisa", subtitle: "Administradora da plataforma", path: "/arisa",
    avatar: "/arisa-profile-ed010d3ade95.webp",
    welcome: "Oi! Eu sou a Arisa, gestora da plataforma Évora. Posso consultar informações, analisar o financeiro, organizar o CRM e executar suas tarefas administrativas. Você também pode me enviar boletos, notas fiscais e outros documentos. O que vamos resolver?",
  },
  bia: {
    name: "Bia", subtitle: "Gestora comercial da Évora", path: "/bia",
    avatar: "/bia/icon-512-v1.png",
    welcome: "Oi! Eu sou a Bia, sua gestora comercial da Évora. Posso consultar seus leads, acompanhar o funil e os atendimentos, organizar a equipe, preparar simulações e executar suas solicitações no CRM. Peça também para iniciar um contato pelo meu WhatsApp. Você pode conversar comigo por texto, áudio e anexos. O que vamos resolver?",
  },
} as const;
