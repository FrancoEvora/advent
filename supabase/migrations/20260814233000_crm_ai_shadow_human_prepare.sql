-- Évora Enterprise — preparação humana auditável de rascunhos da Vitória.
--
-- Esta etapa continua SEM envio externo. A função apenas:
--   * valida o estado canônico e os bloqueios de contato;
--   * registra a revisão humana;
--   * muda o rascunho de draft para prepared;
--   * transfere a conversa para atendimento humano;
--   * grava evento de auditoria sem armazenar o conteúdo no evento.

set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.prepare_crm_ai_shadow_message(
  p_organization_id uuid,
  p_crm_record_id uuid,
  p_message_id uuid,
  p_actor_user_id uuid,
  p_content text
)
returns table(
  message_id uuid,
  content text,
  delivery_status text,
  prepared_at timestamptz,
  event_id uuid
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  selected_message public.crm_messages%rowtype;
  selected_conversation public.crm_conversations%rowtype;
  selected_record public.crm_records%rowtype;
  final_content text;
  prepared_timestamp timestamptz;
  audit_event_id uuid;
  was_edited boolean;
  contact_blocked boolean := false;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception 'RPC restrita ao backend supervisionado da Vitoria.'
      using errcode = '42501';
  end if;

  if p_organization_id is null
     or p_crm_record_id is null
     or p_message_id is null
     or p_actor_user_id is null then
    raise exception 'Identificadores obrigatorios ausentes.';
  end if;

  final_content := btrim(coalesce(p_content, ''));
  if char_length(final_content) not between 1 and 1200
     or pg_column_size(final_content) > 8192 then
    raise exception 'Conteudo preparado fora do limite seguro.';
  end if;

  if not exists (
    select 1
      from public.organization_members member
     where member.organization_id = p_organization_id
       and member.user_id = p_actor_user_id
       and member.active = true
  ) then
    raise exception 'Revisor nao pertence ativamente a organizacao.'
      using errcode = '42501';
  end if;

  select message.*
    into selected_message
    from public.crm_messages message
   where message.organization_id = p_organization_id
     and message.id = p_message_id
     and message.crm_record_id = p_crm_record_id
     and message.direction = 'outbound'
     and message.actor_type = 'ai'
     and message.channel = 'whatsapp'
   for update;

  if not found then
    raise exception 'Rascunho da Vitoria nao encontrado.';
  end if;

  select conversation.*
    into selected_conversation
    from public.crm_conversations conversation
   where conversation.organization_id = p_organization_id
     and conversation.id = selected_message.conversation_id
     and conversation.crm_record_id = p_crm_record_id
     and conversation.channel = 'whatsapp'
   for update;

  if not found then
    raise exception 'Conversa canonica da Vitoria nao encontrada.';
  end if;

  select record.*
    into selected_record
    from public.crm_records record
   where record.organization_id = p_organization_id
     and record.id = p_crm_record_id
   for update;

  if not found or selected_record.record_status <> 'aberta' then
    raise exception 'Oportunidade indisponivel para nova abordagem.';
  end if;

  if selected_record.contact_id is not null then
    select (
      contact.do_not_contact_at is not null
      or lower(coalesce(contact.marketing_consent_status, '')) in ('denied', 'revoked')
    )
      into contact_blocked
      from public.contacts contact
     where contact.organization_id = p_organization_id
       and contact.id = selected_record.contact_id;
  end if;

  if coalesce(contact_blocked, false) then
    raise exception 'Contato bloqueado para comunicacao.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
      from crm_private.ai_runtime_settings runtime
     where runtime.organization_id = p_organization_id
       and runtime.enabled = true
       and runtime.mode = 'shadow'
       and runtime.openai_api_key_vault_id is not null
  ) then
    raise exception 'Runtime da Vitoria nao esta pronto.';
  end if;

  if selected_message.delivery_status = 'prepared' then
    select event.id
      into audit_event_id
      from public.crm_opportunity_events event
     where event.organization_id = p_organization_id
       and event.idempotency_key = 'ai-shadow-prepared:' || selected_message.id::text
     limit 1;

    return query
      select selected_message.id,
             selected_message.content,
             selected_message.delivery_status,
             nullif(selected_message.metadata->>'human_reviewed_at', '')::timestamptz,
             audit_event_id;
    return;
  end if;

  if selected_message.delivery_status <> 'draft'
     or selected_conversation.status not in ('shadow', 'human_required')
     or selected_conversation.ai_enabled is distinct from true then
    raise exception 'Rascunho nao esta mais disponivel para preparacao.';
  end if;

  prepared_timestamp := now();
  was_edited := selected_message.content is distinct from final_content;

  update public.crm_messages message
     set content = final_content,
         delivery_status = 'prepared',
         metadata = coalesce(message.metadata, '{}'::jsonb) || jsonb_build_object(
           'human_review_status', 'prepared',
           'human_reviewed_by', p_actor_user_id,
           'human_reviewed_at', prepared_timestamp,
           'human_edited', was_edited
         )
   where message.id = selected_message.id;

  update public.crm_conversations conversation
     set status = 'human_active',
         ai_enabled = false,
         assigned_user_id = p_actor_user_id,
         human_takeover_at = coalesce(conversation.human_takeover_at, prepared_timestamp),
         updated_at = prepared_timestamp
   where conversation.id = selected_conversation.id;

  insert into public.crm_opportunity_events (
    organization_id,
    crm_record_id,
    opportunity_key,
    contact_id,
    project_id,
    product_id,
    lead_source_id,
    actor_type,
    actor_user_id,
    event_type,
    event_source,
    channel,
    occurred_at,
    idempotency_key,
    data
  )
  values (
    p_organization_id,
    selected_record.id,
    selected_record.id,
    selected_record.contact_id,
    selected_record.project_id,
    selected_record.product_id,
    selected_record.lead_source_id,
    'human',
    p_actor_user_id,
    'ai_shadow_draft_prepared',
    'vitoria',
    'whatsapp',
    prepared_timestamp,
    'ai-shadow-prepared:' || selected_message.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'message_id', selected_message.id,
      'source_job_id', selected_message.source_job_id,
      'human_edited', was_edited,
      'delivery_status', 'prepared',
      'external_delivery', false
    ))
  )
  on conflict (organization_id, idempotency_key)
    where idempotency_key is not null
  do nothing
  returning id into audit_event_id;

  if audit_event_id is null then
    select event.id
      into audit_event_id
      from public.crm_opportunity_events event
     where event.organization_id = p_organization_id
       and event.idempotency_key = 'ai-shadow-prepared:' || selected_message.id::text
     limit 1;
  end if;

  return query
    select selected_message.id,
           final_content,
           'prepared'::text,
           prepared_timestamp,
           audit_event_id;
end
$function$;

revoke all on function public.prepare_crm_ai_shadow_message(
  uuid, uuid, uuid, uuid, text
) from public, anon, authenticated;

grant execute on function public.prepare_crm_ai_shadow_message(
  uuid, uuid, uuid, uuid, text
) to service_role;

comment on function public.prepare_crm_ai_shadow_message(
  uuid, uuid, uuid, uuid, text
) is
  'Registra aprovacao humana de rascunho da Vitoria e o deixa preparado; nunca envia mensagem externamente.';
