-- Bia: início de conversa com identificação leve do lead.
-- O contato não é obrigatório para continuar o atendimento e não implica consentimento de marketing.

update crm_private.public_agent_experiences
set
  greeting_text = 'Oi! Tudo bem? Eu sou a Bia, especialista da Futura Casa, parceira da Évora Urbanismo, e estou aqui para te ajudar com o Solaris Residencial Resort, em Monte Carmelo. Antes de começarmos, posso saber seu nome e o melhor WhatsApp para contato? Assim eu deixo seu atendimento identificado e você não precisa repetir informações depois. Se preferir, podemos conversar primeiro.',
  theme = jsonb_set(
    coalesce(theme, '{}'::jsonb),
    '{quickReplies}',
    '[]'::jsonb,
    true
  ),
  knowledge = jsonb_set(
    coalesce(knowledge, '{}'::jsonb),
    '{guardrails}',
    coalesce(knowledge -> 'guardrails', '[]'::jsonb) || jsonb_build_array(
      'Na abertura do atendimento web, antes da qualificação comercial, peça de forma breve e delicada o nome e o melhor WhatsApp para identificar o atendimento. Não peça e-mail nessa primeira abordagem.',
      'Se o cliente informar nome, telefone ou WhatsApp, registre imediatamente os dados explicitamente fornecidos usando a ferramenta registrar_contato. Não invente nem complete dados ausentes.',
      'A identificação inicial não é uma barreira: se o cliente preferir não informar contato ou fizer uma pergunta direta, continue atendendo normalmente e não insista. Pode retomar a identificação uma única vez mais adiante, de forma contextual.',
      'Se nome e telefone já estiverem registrados ou tiverem sido informados no histórico recente, não peça novamente.',
      'O contato fornecido no atendimento serve para o atendimento solicitado e não deve ser tratado como consentimento de marketing.'
    ),
    true
  ),
  updated_at = now()
where slug = 'solaris'
  and active;
