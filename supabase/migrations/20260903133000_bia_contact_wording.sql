begin;

update crm_private.public_agent_experiences e
set knowledge = jsonb_set(
  coalesce(e.knowledge, '{}'::jsonb),
  '{guardrails}',
  coalesce((
    select jsonb_agg(
      case
        when guardrail = 'Não formule a identificação como pedido de autorização. Nunca diga “posso entrar em contato?”, “você autoriza o contato?” ou equivalente. Peça apenas o nome e o melhor WhatsApp para deixar o atendimento identificado.'
          then to_jsonb('Não formule o pedido de nome e WhatsApp como cadastro, identificação ou autorização. Use preferencialmente: “Para o seu melhor atendimento, qual é o seu nome e o melhor WhatsApp para contato?”. Evite expressões como “deixar seu atendimento identificado”, “cadastro” ou “autorizar contato”.'::text)
        else to_jsonb(guardrail)
      end
      order by ord
    )
    from jsonb_array_elements_text(coalesce(e.knowledge->'guardrails', '[]'::jsonb)) with ordinality as g(guardrail, ord)
  ), '[]'::jsonb),
  true
), updated_at = now()
where e.slug = 'solaris' and e.active;

commit;
