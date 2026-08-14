-- Preflight alignment found by the supervisory review against the live canonical
-- crm_opportunity_events contract. The opportunity key is the crm_record id and
-- event_source must use the existing canonical 'vitoria' source.

set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.complete_crm_ai_shadow_job(
  p_job_id uuid,
  p_lock_token uuid,
  p_result jsonb
)
returns table(
  job_id uuid,
  conversation_id uuid,
  message_id uuid,
  event_id uuid
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  job public.crm_ai_jobs%rowtype;
  conversation_key uuid;
  message_key uuid;
  event_key uuid;
  decision text;
  final_message text;
  event_type text;
begin
  if p_result is null or jsonb_typeof(p_result) <> 'object' then
    raise exception 'Resultado do agente IA deve ser um objeto JSON.';
  end if;

  select current_job.*
    into job
    from public.crm_ai_jobs current_job
   where current_job.id = p_job_id
     and current_job.status = 'processing'
     and current_job.lock_token = p_lock_token
   for update;

  if not found then
    raise exception 'Lease do job IA ausente, expirado ou divergente.';
  end if;
  if job.mode <> 'shadow' then
    raise exception 'Esta rotina conclui apenas jobs IA em modo sombra.';
  end if;

  decision := lower(trim(coalesce(p_result ->> 'decision', '')));
  final_message := trim(coalesce(p_result ->> 'final_message', ''));

  if decision not in ('approve', 'revise', 'block') then
    raise exception 'Decisao do supervisor IA invalida.';
  end if;
  if decision <> 'block'
     and char_length(final_message) not between 1 and 1200 then
    raise exception 'Mensagem final do agente IA fora do limite seguro.';
  end if;
  if decision = 'block' and char_length(final_message) > 1200 then
    raise exception 'Mensagem bloqueada do agente IA excede limite seguro.';
  end if;

  insert into public.crm_conversations (
    organization_id,
    crm_record_id,
    contact_id,
    channel,
    status,
    ai_enabled,
    last_message_at
  )
  values (
    job.organization_id,
    job.crm_record_id,
    job.contact_id,
    'whatsapp',
    'shadow',
    true,
    case when decision = 'block' then null else now() end
  )
  on conflict (organization_id, crm_record_id, channel)
  do update set
    contact_id = coalesce(excluded.contact_id, public.crm_conversations.contact_id),
    status = 'shadow',
    ai_enabled = true,
    last_message_at = coalesce(
      excluded.last_message_at,
      public.crm_conversations.last_message_at
    ),
    updated_at = now()
  returning id into conversation_key;

  if decision <> 'block' then
    insert into public.crm_messages (
      organization_id,
      conversation_id,
      crm_record_id,
      source_job_id,
      direction,
      actor_type,
      channel,
      content,
      delivery_status,
      metadata
    )
    values (
      job.organization_id,
      conversation_key,
      job.crm_record_id,
      job.id,
      'outbound',
      'ai',
      'whatsapp',
      final_message,
      'draft',
      jsonb_strip_nulls(jsonb_build_object(
        'agent', 'vitoria',
        'mode', 'shadow',
        'supervisor_decision', decision,
        'quality_score', p_result -> 'quality_score',
        'objective', p_result -> 'objective',
        'recommended_next_step', p_result -> 'recommended_next_step',
        'issues', p_result -> 'issues'
      ))
    )
    on conflict (organization_id, source_job_id)
    do update set
      content = excluded.content,
      delivery_status = 'draft',
      metadata = excluded.metadata
    returning id into message_key;
  end if;

  event_type := case
    when decision = 'block' then 'ai_shadow_draft_blocked'
    else 'ai_shadow_draft_generated'
  end;

  select existing.id
    into event_key
    from public.crm_opportunity_events existing
   where existing.organization_id = job.organization_id
     and existing.idempotency_key = 'ai-shadow:' || job.id::text
   limit 1;

  if event_key is null then
    insert into public.crm_opportunity_events (
      organization_id,
      crm_record_id,
      opportunity_key,
      contact_id,
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
      job.organization_id,
      job.crm_record_id,
      job.crm_record_id,
      job.contact_id,
      'ai',
      null,
      event_type,
      'vitoria',
      'whatsapp',
      now(),
      'ai-shadow:' || job.id::text,
      jsonb_strip_nulls(jsonb_build_object(
        'job_id', job.id,
        'mode', job.mode,
        'decision', decision,
        'supervisor', true,
        'quality_score', p_result -> 'quality_score',
        'objective', p_result -> 'objective',
        'recommended_next_step', p_result -> 'recommended_next_step'
      ))
    )
    returning id into event_key;
  end if;

  update public.crm_ai_jobs current_job
     set status = 'completed',
         completed_at = now(),
         locked_at = null,
         lock_token = null,
         worker_id = null,
         result = p_result,
         updated_at = now()
   where current_job.id = job.id;

  return query select job.id, conversation_key, message_key, event_key;
end
$function$;

revoke all on function public.complete_crm_ai_shadow_job(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_crm_ai_shadow_job(uuid, uuid, jsonb)
  to service_role;
