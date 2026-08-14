-- Evora Enterprise - hardening da fila IA apos revisao supervisora.
--
-- Corrige dois riscos que nao sao detectaveis pelo build da aplicacao:
--   1. job em processamento na ultima tentativa poderia ficar orfao para sempre;
--   2. colisao de trigger_key poderia mascarar um uso indevido da mesma chave
--      de idempotencia para outra oportunidade ou outro tipo de job.

set lock_timeout = '5s';
set statement_timeout = '120s';

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
  existing_job public.crm_ai_jobs%rowtype;
  normalized_trigger_key text;
begin
  if p_job_type not in (
    'lead_created', 'message_received', 'follow_up', 'manual_review'
  ) then
    raise exception 'Tipo de job IA invalido.';
  end if;
  if p_mode not in ('shadow', 'supervised', 'autonomous') then
    raise exception 'Modo de job IA invalido.';
  end if;

  normalized_trigger_key := trim(coalesce(p_trigger_key, ''));
  if char_length(normalized_trigger_key) not between 8 and 240 then
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
    normalized_trigger_key,
    p_mode
  )
  on conflict (organization_id, trigger_key) do nothing
  returning id into created_job_id;

  if created_job_id is not null then
    return query select created_job_id, true;
    return;
  end if;

  select existing.*
    into existing_job
    from public.crm_ai_jobs existing
   where existing.organization_id = p_organization_id
     and existing.trigger_key = normalized_trigger_key
   limit 1;

  if not found then
    raise exception 'Colisao de idempotencia sem job canonico correspondente.';
  end if;

  if existing_job.crm_record_id <> p_crm_record_id
     or existing_job.contact_id is distinct from coalesce(p_contact_id, canonical_contact_id)
     or existing_job.job_type <> p_job_type
     or existing_job.mode <> p_mode then
    raise exception 'Colisao de chave de idempotencia IA entre contextos distintos.';
  end if;

  return query select existing_job.id, false;
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
language plpgsql
security definer
set search_path = ''
as $function$
declare
  safe_limit integer := least(25, greatest(1, coalesce(p_limit, 10)));
  safe_lease_seconds integer := least(600, greatest(30, coalesce(p_lease_seconds, 120)));
  safe_worker_id text := left(trim(coalesce(p_worker_id, 'crm-ai-worker')), 160);
begin
  -- Jobs que chegaram ao limite sem lease ativo sao encerrados de forma
  -- deterministica, em vez de permanecerem elegiveis indefinidamente.
  update public.crm_ai_jobs job
     set status = 'failed',
         locked_at = null,
         lock_token = null,
         worker_id = null,
         last_error_code = coalesce(job.last_error_code, 'AI_JOB_ATTEMPTS_EXHAUSTED'),
         last_error_message = coalesce(
           job.last_error_message,
           'O job IA atingiu o limite maximo de tentativas.'
         ),
         updated_at = now()
   where job.status in ('pending', 'retry')
     and job.attempt_count >= job.max_attempts;

  -- Se o worker caiu depois de consumir a ultima tentativa, um lease ausente
  -- ou expirado encerra o job como falha. Assim nenhum registro fica preso em
  -- processing por corrupcao parcial ou queda do worker.
  update public.crm_ai_jobs job
     set status = 'failed',
         locked_at = null,
         lock_token = null,
         worker_id = null,
         last_error_code = 'AI_JOB_LEASE_EXHAUSTED',
         last_error_message =
           'O worker IA perdeu o lease apos consumir a ultima tentativa.',
         updated_at = now()
   where job.status = 'processing'
     and job.attempt_count >= job.max_attempts
     and (
       job.locked_at is null
       or job.locked_at < now() - make_interval(secs => safe_lease_seconds)
     );

  return query
    with candidates as (
      select job.id
        from public.crm_ai_jobs job
       where job.attempt_count < job.max_attempts
         and (
           (job.status in ('pending', 'retry') and job.available_at <= now())
           or (
             job.status = 'processing'
             and (
               job.locked_at is null
               or job.locked_at < now() - make_interval(secs => safe_lease_seconds)
             )
           )
         )
       order by job.available_at, job.created_at, job.id
       for update skip locked
       limit safe_limit
    ), claimed as (
      update public.crm_ai_jobs job
         set status = 'processing',
             attempt_count = job.attempt_count + 1,
             locked_at = now(),
             lock_token = gen_random_uuid(),
             worker_id = safe_worker_id,
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
end
$function$;

revoke all on function public.enqueue_crm_ai_job(uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.claim_crm_ai_jobs(text, integer, integer)
  from public, anon, authenticated;

grant execute on function public.enqueue_crm_ai_job(uuid, uuid, uuid, text, text, text)
  to service_role;
grant execute on function public.claim_crm_ai_jobs(text, integer, integer)
  to service_role;
