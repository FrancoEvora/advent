begin;

-- Before this release the first bubble was rendered only by the browser.  Its
-- text was deterministic, so legacy sessions can be completed without
-- rewriting history with the new greeting introduced below.
with reconstructed as (
  insert into crm_private.public_agent_messages (
    session_id,
    direction,
    content,
    metadata,
    created_at
  )
  select
    session.id,
    'assistant',
    'Olá, sou a '
      || coalesce(nullif(trim(experience.agent_name), ''), 'Vitória')
      || ', assistente virtual da Évora Urbanismo. Posso te ajudar a conhecer o Solaris e encontrar uma opção adequada para morar ou investir. O que você procura?',
    jsonb_build_object(
      'runtime_contract', 'legacy-ui',
      'initial_greeting', true,
      'reconstructed_from_ui', true
    ),
    session.created_at
  from crm_private.public_agent_sessions session
  join crm_private.public_agent_experiences experience
    on experience.id = session.experience_id
  where exists (
      select 1
      from crm_private.public_agent_messages existing
      where existing.session_id = session.id
    )
    and not exists (
      select 1
      from crm_private.public_agent_messages existing
      where existing.session_id = session.id
        and existing.metadata ->> 'initial_greeting' = 'true'
    )
  returning session_id
)
update crm_private.public_agent_sessions session
set message_count = least(200, session.message_count + 1),
    updated_at = now()
from reconstructed
where session.id = reconstructed.session_id
  and not exists (
    select 1
    from public.crm_records record
    where record.organization_id = session.organization_id
      and record.id = session.crm_record_id
      and record.record_status = 'arquivada'
  );

insert into public.crm_messages (
  organization_id,
  conversation_id,
  crm_record_id,
  direction,
  actor_type,
  channel,
  content,
  delivery_status,
  metadata,
  occurred_at
)
select
  session.organization_id,
  conversation.id,
  session.crm_record_id,
  'outbound',
  'ai',
  'site',
  message.content,
  'delivered',
  jsonb_build_object('public_agent_session_id', session.id)
    || message.metadata,
  message.created_at
from crm_private.public_agent_sessions session
join public.crm_conversations conversation
  on conversation.organization_id = session.organization_id
 and conversation.id = session.conversation_id
 and conversation.crm_record_id = session.crm_record_id
join crm_private.public_agent_messages message
  on message.session_id = session.id
 and message.metadata ->> 'initial_greeting' = 'true'
 and message.metadata ->> 'reconstructed_from_ui' = 'true'
where session.crm_record_id is not null
  and session.conversation_id is not null
  and not exists (
    select 1
    from public.crm_messages existing
    where existing.organization_id = session.organization_id
      and existing.conversation_id = session.conversation_id
      and existing.crm_record_id = session.crm_record_id
      and existing.metadata ->> 'public_agent_session_id' = session.id::text
      and existing.metadata ->> 'initial_greeting' = 'true'
  );

update crm_private.public_agent_experiences experience
set greeting_text =
      'Oi! Tudo bem? Sou a Vitória, da Évora. Me conta: você está procurando um lote para morar, investir ou ainda conhecendo o Solaris Residencial?',
    knowledge = jsonb_set(
      coalesce(experience.knowledge, '{}'::jsonb),
      '{guardrails}',
      coalesce(
        (
          select jsonb_agg(to_jsonb(guardrail.value) order by guardrail.ordinality)
          from jsonb_array_elements_text(
            case
              when jsonb_typeof(experience.knowledge -> 'guardrails') = 'array'
                then experience.knowledge -> 'guardrails'
              else '[]'::jsonb
            end
          ) with ordinality as guardrail(value, ordinality)
          where guardrail.value !~* '(assistente[[:space:]]+virtual|chatbot)'
        ),
        '[]'::jsonb
      ) || jsonb_build_array(
        'A interface informa que o atendimento usa IA. Na conversa, a Vitória não abre com aviso técnico; se perguntarem, responde com transparência que é a agente digital da Évora e nunca afirma ser humana.'
      ),
      true
    ),
    updated_at = now()
where experience.slug = 'solaris'
  and experience.active;

create or replace function public.get_public_agent_experience(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  experience_row crm_private.public_agent_experiences%rowtype;
begin
  perform crm_private.assert_public_agent_service_role();

  select experience.* into experience_row
  from crm_private.public_agent_experiences experience
  where experience.slug = lower(trim(p_slug))
    and experience.active;

  if not found then
    raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND';
  end if;

  return jsonb_build_object(
    'slug', experience_row.slug,
    'name', experience_row.name,
    'agentName', experience_row.agent_name,
    'greetingText', experience_row.greeting_text,
    'title', experience_row.title,
    'subtitle', experience_row.subtitle,
    'eyebrow', experience_row.eyebrow,
    'heroImageUrl', experience_row.hero_image_url,
    'avatar', experience_row.avatar,
    'capabilities', experience_row.capabilities,
    'theme', experience_row.theme
  );
end
$function$;

revoke all on function public.get_public_agent_experience(text)
from public, anon, authenticated, service_role;

grant execute on function public.get_public_agent_experience(text)
to service_role;

create or replace function public.open_public_agent_session_v4(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_utm jsonb default '{}'::jsonb,
  p_landing_page text default null,
  p_referrer text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  result_value jsonb;
  session_row crm_private.public_agent_sessions%rowtype;
  experience_row crm_private.public_agent_experiences%rowtype;
  agent_name_value text;
  greeting_value text;
begin
  perform crm_private.assert_public_agent_service_role();

  result_value := public.open_public_agent_session(
    p_slug,
    p_session_token_hash,
    p_fingerprint_hash,
    p_utm,
    p_landing_page,
    p_referrer,
    p_user_agent
  );

  select session.* into session_row
  from crm_private.public_agent_sessions session
  where session.id = (result_value ->> 'sessionId')::uuid
  for update;

  if not found then
    raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND';
  end if;

  select experience.* into experience_row
  from crm_private.public_agent_experiences experience
  where experience.id = session_row.experience_id
    and experience.active;

  if not found then
    raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND';
  end if;

  if not exists (
    select 1
    from crm_private.public_agent_messages message
    where message.session_id = session_row.id
  ) then
    agent_name_value := coalesce(nullif(trim(experience_row.agent_name), ''), 'Vitória');
    greeting_value := nullif(trim(experience_row.greeting_text), '');
    if greeting_value is null
       or greeting_value ~* '(assistente[[:space:]]+virtual|chatbot)' then
      greeting_value := 'Oi! Tudo bem? Sou a ' || left(agent_name_value, 80)
        || ', da Évora. Me conta: você está procurando um lote para morar, investir ou ainda conhecendo '
        || case
             when nullif(trim(experience_row.name), '') is not null
               then 'o ' || left(trim(experience_row.name), 180)
             else 'as opções da Évora'
           end
        || '?';
    end if;

    insert into crm_private.public_agent_messages (
      session_id,
      direction,
      content,
      metadata,
      created_at
    ) values (
      session_row.id,
      'assistant',
      greeting_value,
      jsonb_build_object('runtime_contract', 'v4', 'initial_greeting', true),
      now()
    );

    update crm_private.public_agent_sessions
    set message_count = message_count + 1,
        last_activity_at = now(),
        updated_at = now()
    where id = session_row.id;
  end if;

  return result_value;
end
$function$;

comment on function public.open_public_agent_session_v4(
  text, text, text, jsonb, text, text, text
) is
  'Abre a sessao publica e persiste uma unica saudacao inicial para o historico completo do CRM.';

revoke all on function public.open_public_agent_session_v4(
  text, text, text, jsonb, text, text, text
) from public, anon, authenticated, service_role;

grant execute on function public.open_public_agent_session_v4(
  text, text, text, jsonb, text, text, text
) to service_role;

commit;
