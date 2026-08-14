-- Evora Enterprise - fundacao segura do agente comercial IA em modo sombra.
--
-- Objetivos desta etapa:
--   * nunca enviar mensagens externas automaticamente;
--   * separar o ciclo de vida da IA do ingress Meta;
--   * garantir idempotencia, lease, retry e auditoria;
--   * manter crm_records/contacts como fontes canonicas;
--   * registrar somente resultados e decisoes, nunca raciocinio privado do modelo.
--
-- Esta migration e deliberadamente aditiva. O recurso permanece inerte enquanto
-- CRM_AI_SHADOW_ENABLED nao estiver habilitado no backend.

set lock_timeout = '5s';
set statement_timeout = '120s';

create schema if not exists private;

do $migration$
begin
  if to_regclass('public.organizations') is null
     or to_regclass('public.contacts') is null
     or to_regclass('public.crm_records') is null
     or to_regclass('public.crm_opportunity_events') is null then
    raise exception
      'Pre-requisitos canonicos de organizacao, contato, oportunidade ou eventos nao encontrados.';
  end if;
end
$migration$;

create table public.crm_ai_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  crm_record_id uuid not null,
  contact_id uuid,
  job_type text not null,
  trigger_key text not null,
  mode text not null default 'shadow',
  status text not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  lock_token uuid,
  worker_id text,
  completed_at timestamptz,
  last_error_code text,
  last_error_message text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_ai_jobs_record_fk
    foreign key (organization_id, crm_record_id)
    references public.crm_records(organization_id, id) on delete cascade,
  constraint crm_ai_jobs_contact_fk
    foreign key (organization_id, contact_id)
    references public.contacts(organization_id, id) on delete set null (contact_id),
  constraint crm_ai_jobs_job_type_check
    check (job_type in (
      'lead_created', 'message_received', 'follow_up', 'manual_review'
    )),
  constraint crm_ai_jobs_trigger_key_check
    check (char_length(trim(trigger_key)) between 8 and 240),
  constraint crm_ai_jobs_mode_check
    check (mode in ('shadow', 'supervised', 'autonomous')),
  constraint crm_ai_jobs_status_check
    check (status in (
      'pending', 'processing', 'retry', 'completed', 'failed', 'cancelled'
    )),
  constraint crm_ai_jobs_attempt_count_check
    check (attempt_count between 0 and 100),
  constraint crm_ai_jobs_max_attempts_check
    check (max_attempts between 1 and 20),
  constraint crm_ai_jobs_result_object_check
    check (result is null or jsonb_typeof(result) = 'object'),
  constraint crm_ai_jobs_result_size_check
    check (result is null or pg_column_size(result) <= 65536),
  constraint crm_ai_jobs_org_trigger_key
    unique (organization_id, trigger_key),
  constraint crm_ai_jobs_org_id_key
    unique (organization_id, id)
);

create index crm_ai_jobs_claim_idx
  on public.crm_ai_jobs (status, available_at, created_at)
  where status in ('pending', 'retry', 'processing');
create index crm_ai_jobs_record_idx
  on public.crm_ai_jobs (organization_id, crm_record_id, created_at desc);

create table public.crm_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  crm_record_id uuid not null,
  contact_id uuid,
  channel text not null,
  status text not null default 'shadow',
  ai_enabled boolean not null default true,
  assigned_user_id uuid,
  started_at timestamptz not null default now(),
  last_message_at timestamptz,
  human_takeover_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_conversations_record_fk
    foreign key (organization_id, crm_record_id)
    references public.crm_records(organization_id, id) on delete cascade,
  constraint crm_conversations_contact_fk
    foreign key (organization_id, contact_id)
    references public.contacts(organization_id, id) on delete set null (contact_id),
  constraint crm_conversations_assigned_membership_fk
    foreign key (organization_id, assigned_user_id)
    references public.organization_members(organization_id, user_id)
    on delete set null (assigned_user_id),
  constraint crm_conversations_channel_check
    check (channel in (
      'internal', 'whatsapp', 'instagram', 'facebook', 'email', 'site'
    )),
  constraint crm_conversations_status_check
    check (status in (
      'shadow', 'ai_active', 'waiting_lead', 'human_required',
      'human_active', 'paused', 'closed'
    )),
  constraint crm_conversations_org_record_channel_key
    unique (organization_id, crm_record_id, channel),
  constraint crm_conversations_org_id_key
    unique (organization_id, id)
);

create index crm_conversations_record_idx
  on public.crm_conversations (organization_id, crm_record_id, updated_at desc);
create index crm_conversations_status_idx
  on public.crm_conversations (organization_id, status, updated_at desc);

create table public.crm_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  conversation_id uuid not null,
  crm_record_id uuid not null,
  source_job_id uuid,
  direction text not null,
  actor_type text not null,
  channel text not null,
  content text not null,
  delivery_status text not null default 'draft',
  provider_message_id text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint crm_messages_conversation_fk
    foreign key (organization_id, conversation_id)
    references public.crm_conversations(organization_id, id) on delete cascade,
  constraint crm_messages_record_fk
    foreign key (organization_id, crm_record_id)
    references public.crm_records(organization_id, id) on delete cascade,
  constraint crm_messages_source_job_fk
    foreign key (organization_id, source_job_id)
    references public.crm_ai_jobs(organization_id, id) on delete set null (source_job_id),
  constraint crm_messages_direction_check
    check (direction in ('inbound', 'outbound', 'internal')),
  constraint crm_messages_actor_type_check
    check (actor_type in ('lead', 'ai', 'human', 'system')),
  constraint crm_messages_channel_check
    check (channel in (
      'internal', 'whatsapp', 'instagram', 'facebook', 'email', 'site'
    )),
  constraint crm_messages_delivery_status_check
    check (delivery_status in (
      'draft', 'prepared', 'queued', 'sent', 'delivered', 'read', 'failed', 'blocked'
    )),
  constraint crm_messages_content_check
    check (char_length(content) between 1 and 12000),
  constraint crm_messages_metadata_object_check
    check (jsonb_typeof(metadata) = 'object'),
  constraint crm_messages_metadata_size_check
    check (pg_column_size(metadata) <= 65536),
  constraint crm_messages_org_source_job_key
    unique (organization_id, source_job_id),
  constraint crm_messages_org_id_key
    unique (organization_id, id)
);

create index crm_messages_conversation_idx
  on public.crm_messages (organization_id, conversation_id, occurred_at, id);
create index crm_messages_record_idx
  on public.crm_messages (organization_id, crm_record_id, occurred_at desc);

alter table public.crm_ai_jobs enable row level security;
alter table public.crm_conversations enable row level security;
alter table public.crm_messages enable row level security;

-- As tabelas da fundacao ficam server-only nesta etapa. A UI recebera uma
-- superficie de leitura explicitamente autorizada em migration posterior.
revoke all on table public.crm_ai_jobs from public, anon, authenticated;
revoke all on table public.crm_conversations from public, anon, authenticated;
revoke all on table public.crm_messages from public, anon, authenticated;
grant select, insert, update, delete on table public.crm_ai_jobs to service_role;
grant select, insert, update, delete on table public.crm_conversations to service_role;
grant select, insert, update, delete on table public.crm_messages to service_role;

create or replace function public.enqueue_crm_ai_job(
  p_organization_id uuid,
  p_crm_record_id uuid,
  p_contact_id uuid,
  p_job_type text,
  p_trigger_key text,
  p_mode text default 'shadow'
)
returns table(job_id uuid, inserted boolean)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  canonical_contact_id uuid;
  created_job_id uuid;
begin
  if p_job_type not in (
    'lead_created', 'message_received', 'follow_up', 'manual_review'
  ) then
    raise exception 'Tipo de job IA invalido.';
  end if;
  if p_mode not in ('shadow', 'supervised', 'autonomous') then
    raise exception 'Modo de job IA invalido.';
  end if;
  if char_length(trim(coalesce(p_trigger_key, ''))) not between 8 and 240 then
    raise exception 'Chave de idempotencia IA invalida.';
  end if;

  select record.contact_id
    into canonical_contact_id
    from public.crm_records record
   where record.organization_id = p_organization_id
     and record.id = p_crm_record_id;

  if not found then
    raise exception 'Oportunidade canonica nao encontrada para o job IA.';
  end if;
  if p_contact_id is not null
     and canonical_contact_id is distinct from p_contact_id then
    raise exception 'Contato do job IA diverge da oportunidade canonica.';
  end if;

  insert into public.crm_ai_jobs (
    organization_id,
    crm_record_id,
    contact_id,
    job_type,
    trigger_key,
    mode
  )
  values (
    p_organization_id,
    p_crm_record_id,
    coalesce(p_contact_id, canonical_contact_id),
    p_job_type,
    trim(p_trigger_key),
    p_mode
  )
  on conflict (organization_id, trigger_key) do nothing
  returning id into created_job_id;

  if created_job_id is not null then
    return query select created_job_id, true;
    return;
  end if;

  return query
    select existing.id, false
      from public.crm_ai_jobs existing
     where existing.organization_id = p_organization_id
       and existing.trigger_key = trim(p_trigger_key)
     limit 1;
end
$function$;

create or replace function public.claim_crm_ai_jobs(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table(
  job_id uuid,
  lock_token uuid,
  organization_id uuid,
  crm_record_id uuid,
  contact_id uuid,
  job_type text,
  mode text,
  attempt_count integer
)
language sql
security definer
set search_path = ''
as $function$
  with candidates as (
    select job.id
      from public.crm_ai_jobs job
     where job.attempt_count < job.max_attempts
       and (
         (job.status in ('pending', 'retry') and job.available_at <= now())
         or (
           job.status = 'processing'
           and job.locked_at < now() - make_interval(
             secs => least(600, greatest(30, coalesce(p_lease_seconds, 120)))
           )
         )
       )
     order by job.available_at, job.created_at, job.id
     for update skip locked
     limit least(25, greatest(1, coalesce(p_limit, 10)))
  ), claimed as (
    update public.crm_ai_jobs job
       set status = 'processing',
           attempt_count = job.attempt_count + 1,
           locked_at = now(),
           lock_token = gen_random_uuid(),
           worker_id = left(trim(coalesce(p_worker_id, 'crm-ai-worker')), 160),
           last_error_code = null,
           last_error_message = null,
           updated_at = now()
      from candidates
     where job.id = candidates.id
     returning job.*
  )
  select claimed.id,
         claimed.lock_token,
         claimed.organization_id,
         claimed.crm_record_id,
         claimed.contact_id,
         claimed.job_type,
         claimed.mode,
         claimed.attempt_count
    from claimed
   order by claimed.available_at, claimed.created_at, claimed.id;
$function$;

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
    last_message_at = coalesce(excluded.last_message_at, public.crm_conversations.last_message_at),
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
    select
      job.organization_id,
      job.crm_record_id,
      job.contact_id,
      'ai',
      null,
      event_type,
      'vitoria_supervisor',
      'whatsapp',
      now(),
      'ai-shadow:' || job.id::text,
      jsonb_strip_nulls(jsonb_build_object(
        'job_id', job.id,
        'mode', job.mode,
        'decision', decision,
        'quality_score', p_result -> 'quality_score',
        'objective', p_result -> 'objective',
        'recommended_next_step', p_result -> 'recommended_next_step'
      ))
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

create or replace function public.fail_crm_ai_job(
  p_job_id uuid,
  p_lock_token uuid,
  p_error_code text,
  p_error_message text,
  p_retryable boolean default true
)
returns table(job_id uuid, status text, available_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  job public.crm_ai_jobs%rowtype;
  next_status text;
  next_available_at timestamptz;
  delay_minutes integer;
begin
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

  if coalesce(p_retryable, true) and job.attempt_count < job.max_attempts then
    next_status := 'retry';
    delay_minutes := least(
      60,
      case
        when job.attempt_count <= 1 then 1
        when job.attempt_count = 2 then 5
        when job.attempt_count = 3 then 15
        else 60
      end
    );
    next_available_at := now() + make_interval(mins => delay_minutes);
  else
    next_status := 'failed';
    next_available_at := job.available_at;
  end if;

  update public.crm_ai_jobs current_job
     set status = next_status,
         available_at = next_available_at,
         locked_at = null,
         lock_token = null,
         worker_id = null,
         last_error_code = left(trim(coalesce(p_error_code, 'AI_JOB_FAILED')), 128),
         last_error_message = left(trim(coalesce(p_error_message, 'Falha nao classificada do agente IA.')), 1024),
         updated_at = now()
   where current_job.id = job.id;

  return query select job.id, next_status, next_available_at;
end
$function$;

revoke all on function public.enqueue_crm_ai_job(uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.claim_crm_ai_jobs(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.complete_crm_ai_shadow_job(uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.fail_crm_ai_job(uuid, uuid, text, text, boolean)
  from public, anon, authenticated;

grant execute on function public.enqueue_crm_ai_job(uuid, uuid, uuid, text, text, text)
  to service_role;
grant execute on function public.claim_crm_ai_jobs(text, integer, integer)
  to service_role;
grant execute on function public.complete_crm_ai_shadow_job(uuid, uuid, jsonb)
  to service_role;
grant execute on function public.fail_crm_ai_job(uuid, uuid, text, text, boolean)
  to service_role;

comment on table public.crm_ai_jobs is
  'Fila server-side do agente comercial IA. Nenhum job implica entrega externa automatica.';
comment on table public.crm_conversations is
  'Estado canonico das conversas comerciais; modo sombra nao envia ao lead.';
comment on table public.crm_messages is
  'Mensagens e rascunhos do atendimento. delivery_status=draft e obrigatorio no modo sombra.';
