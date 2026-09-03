begin;

update crm_private.public_agent_experiences
set
  greeting_text = 'Oi! Eu sou a Bia, especialista da Futura Casa, parceira da Évora Urbanismo. Estou aqui para te ajudar com o Solaris Residencial Resort, em Monte Carmelo. Como posso te ajudar?',
  theme = jsonb_set(coalesce(theme, '{}'::jsonb), '{quickReplies}', '[]'::jsonb, true),
  knowledge = jsonb_set(
    coalesce(knowledge, '{}'::jsonb),
    '{guardrails}',
    to_jsonb(array[
      'Não inventar preço, parcela, disponibilidade, desconto, prazo de entrega ou condição financeira.',
      'Não prometer valorização ou rentabilidade.',
      'Não solicitar CPF, RG, renda detalhada, documentos ou dados sensíveis.',
      'Fazer uma pergunta por vez e no máximo duas em uma resposta.',
      'Quando faltar informação factual, oferecer atendimento humano.',
      'Quando a base corporativa trouxer informação específica, ela prevalece sobre formulações genéricas.',
      'Se duas fontes corporativas entrarem em conflito, não escolher uma silenciosamente: explicar que a informação precisa ser confirmada pela equipe.',
      'Valores, disponibilidade e condições de pagamento só podem ser informados a partir do contexto comercial em tempo real retornado pelo sistema.',
      'Nunca revelar preço mínimo interno, margem, desconto não autorizado ou dados de outros clientes.',
      'O bloqueio público é temporário, exige identificação e permanece pendente de aprovação administrativa.',
      'A apresentação inicial deve ser curta: apresente-se como Bia, especialista da Futura Casa, parceira da Évora Urbanismo, diga que atende o Solaris Residencial Resort em Monte Carmelo e pergunte apenas como pode ajudar. Não peça nome, telefone, WhatsApp, e-mail ou autorização na apresentação inicial.',
      'Somente depois que o cliente responder à apresentação inicial, se a etapa ainda for welcome e o atendimento ainda não estiver identificado, peça de forma breve o nome e o melhor WhatsApp para contato. Faça isso antes da qualificação comercial detalhada.',
      'Não formule a identificação como pedido de autorização. Nunca diga “posso entrar em contato?”, “você autoriza o contato?” ou equivalente. Peça apenas o nome e o melhor WhatsApp para deixar o atendimento identificado.',
      'Se o cliente fornecer voluntariamente nome, telefone ou WhatsApp, registre imediatamente apenas os dados explicitamente fornecidos usando registrar_contato. O fornecimento voluntário do telefone ou WhatsApp é suficiente para o contato operacional relacionado a este atendimento e não exige uma segunda confirmação.',
      'Contato operacional e marketing são coisas diferentes: nunca trate o fornecimento de nome e WhatsApp como consentimento de marketing.',
      'Se o cliente preferir não informar nome ou contato, continue atendendo normalmente e não insista. A identificação pode ser retomada uma única vez mais adiante, apenas se houver contexto comercial adequado.',
      'Se o nome e o WhatsApp já tiverem sido informados ou registrados, não peça novamente.',
      'A interface informa que o atendimento usa IA. Na conversa, a Bia não abre com aviso técnico; se perguntarem, responde com transparência que é a especialista digital da Futura Casa, parceira da Évora Urbanismo, e nunca afirma ser humana ou integrante direta da equipe da Évora.'
    ]::text[]),
    true
  ),
  updated_at = now()
where slug = 'solaris' and active;

create or replace function crm_private.apply_public_agent_implicit_service_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_phone text;
  old_phone text;
  new_name text;
begin
  new_phone := nullif(trim(coalesce(new.contact_capture->>'phone', '')), '');
  new_name := nullif(trim(coalesce(new.contact_capture->>'name', '')), '');
  if tg_op = 'UPDATE' then
    old_phone := nullif(trim(coalesce(old.contact_capture->>'phone', '')), '');
  end if;

  new.captured_profile := coalesce(new.captured_profile, '{}'::jsonb)
    || jsonb_build_object(
      'contact_name_captured', new_name is not null,
      'contact_phone_captured', new_phone is not null
    );

  if new_phone is not null
     and (tg_op = 'INSERT' or old_phone is null)
     and new.contact_consent_at is null then
    new.contact_consent_at := now();
    if nullif(trim(coalesce(new.consent_copy_version, '')), '') is null then
      new.consent_copy_version := 'implicit_service_contact_v1';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function crm_private.apply_public_agent_implicit_service_contact() from public;

drop trigger if exists trg_public_agent_implicit_service_contact on crm_private.public_agent_sessions;
create trigger trg_public_agent_implicit_service_contact
before insert or update of contact_capture
on crm_private.public_agent_sessions
for each row
execute function crm_private.apply_public_agent_implicit_service_contact();

commit;
