-- Evora Enterprise - gatilho canonico Meta -> Vitoria e dispatch resiliente.
--
-- Qualquer caminho que crie a primeira atribuicao Meta canonica passa por este
-- trigger. Falhas da camada IA sao isoladas e nunca fazem o ingest Meta falhar.
-- O dispatch imediato usa pg_net e um cron de 1 minuto funciona como recovery.

set lock_timeout = '5s';
set statement_timeout = '120s';

create schema if not exists crm_private;

create or replace function crm_private.configure_crm_ai_worker_runtime(
  p_worker_url text,
  p_rotate_secret boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  worker_url_id uuid;
  worker_secret_id uuid;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception
      'RPC restrita a configuracao interna do worker IA.'
      using errcode = '42501';
  end if;

  if p_worker_url is null
     or p_worker_url <> btrim(p_worker_url)
     or char_length(p_worker_url) > 2048
     or p_worker_url !~
       '^https://[A-Za-z0-9-]+[.]supabase[.]co/functions/v1/enterprise-ai-worker$'
     or p_worker_url ~ '[[:space:]@#?]' then
    raise exception 'URL HTTPS do worker IA invalida.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('evora-crm-ai-worker-runtime', 0)
  );

  select secret.id
    into worker_url_id
    from vault.secrets secret
   where secret.name = 'evora_crm_ai_worker_url'
   order by secret.created_at desc
   limit 1;

  if worker_url_id is null then
    perform vault.create_secret(
      new_secret := p_worker_url,
      new_name := 'evora_crm_ai_worker_url',
      new_description := 'Evora internal endpoint; kind=crm_ai_worker_url',
      new_key_id := null
    );
  else
    perform vault.update_secret(
      secret_id := worker_url_id,
      new_secret := p_worker_url,
      new_name := null,
      new_description := 'Evora internal endpoint; kind=crm_ai_worker_url',
      new_key_id := null
    );
  end if;

  select secret.id
    into worker_secret_id
    from vault.secrets secret
   where secret.name = 'evora_crm_ai_worker_secret'
   order by secret.created_at desc
   limit 1;

  if worker_secret_id is null then
    perform vault.create_secret(
      new_secret := encode(extensions.gen_random_bytes(32), 'hex'),
      new_name := 'evora_crm_ai_worker_secret',
      new_description := 'Evora internal credential; kind=crm_ai_worker_secret',
      new_key_id := null
    );
  elsif coalesce(p_rotate_secret, false) then
    perform vault.update_secret(
      secret_id := worker_secret_id,
      new_secret := encode(extensions.gen_random_bytes(32), 'hex'),
      new_name := null,
      new_description := 'Evora internal credential; kind=crm_ai_worker_secret',
      new_key_id := null
    );
  end if;

  return jsonb_build_object(
    'worker_url_configured', true,
    'worker_secret_configured', true,
    'worker_secret_rotated', coalesce(p_rotate_secret, false)
  );
end
$function$;

create or replace function public.configure_crm_ai_worker_runtime(
  p_worker_url text,
  p_rotate_secret boolean default false
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select crm_private.configure_crm_ai_worker_runtime(
    p_worker_url,
    p_rotate_secret
  );
$function$;

create or replace function public.verify_crm_ai_worker_bearer(
  p_candidate text,
  p_request_url text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  worker_url text;
  worker_secret text;
  internal_worker_url text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception
      'RPC restrita ao runtime da Vitoria.'
      using errcode = '42501';
  end if;

  if p_candidate is null
     or p_candidate <> btrim(p_candidate)
     or char_length(p_candidate) not between 32 and 512
     or p_candidate ~ '[[:space:]]'
     or p_request_url is null
     or p_request_url <> btrim(p_request_url)
     or char_length(p_request_url) > 2048
     or p_request_url ~ '[[:space:]@#?]' then
    return false;
  end if;

  select secret.decrypted_secret
    into worker_url
    from vault.decrypted_secrets secret
   where secret.name = 'evora_crm_ai_worker_url'
   order by secret.created_at desc
   limit 1;

  select secret.decrypted_secret
    into worker_secret
    from vault.decrypted_secrets secret
   where secret.name = 'evora_crm_ai_worker_secret'
   order by secret.created_at desc
   limit 1;

  if worker_url is null or worker_secret is null then
    return false;
  end if;

  internal_worker_url := regexp_replace(
    worker_url,
    '^https://([^/]+)/functions/v1/(.+)$',
    'http://\\1/\\2'
  );

  return (worker_url = p_request_url or internal_worker_url = p_request_url)
    and extensions.digest(convert_to(worker_secret, 'UTF8'), 'sha256')
        = extensions.digest(convert_to(p_candidate, 'UTF8'), 'sha256');
end
$function$;

create or replace function crm_private.dispatch_crm_ai_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  worker_url text;
  worker_secret text;
  request_id bigint;
begin
  select secret.decrypted_secret
    into worker_url
    from vault.decrypted_secrets secret
   where secret.name = 'evora_crm_ai_worker_url'
   order by secret.created_at desc
   limit 1;

  select secret.decrypted_secret
    into worker_secret
    from vault.decrypted_secrets secret
   where secret.name = 'evora_crm_ai_worker_secret'
   order by secret.created_at desc
   limit 1;

  worker_url := nullif(trim(worker_url), '');
  worker_secret := nullif(trim(worker_secret), '');
  if worker_url is null
     or worker_secret is null
     or worker_url !~
       '^https://[A-Za-z0-9-]+[.]supabase[.]co/functions/v1/enterprise-ai-worker$'
     or char_length(worker_url) > 2048
     or char_length(worker_secret) not between 32 and 512 then
    return null;
  end if;

  select net.http_post(
    url := worker_url,
    body := jsonb_build_object(
      'source', 'crm_ai_dispatch',
      'requested_at', now()
    ),
    params := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || worker_secret
    ),
    timeout_milliseconds := 5000
  ) into request_id;

  return request_id;
end
$function$;

create or replace function crm_private.enqueue_vitoria_after_meta_attribution()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  runtime_ready boolean := false;
  canonical_contact_id uuid;
  was_inserted boolean := false;
  created_job_id uuid;
begin
  if new.provider <> 'meta' or new.crm_record_id is null then
    return new;
  end if;

  select (
    settings.enabled
    and settings.mode = 'shadow'
    and settings.openai_api_key_vault_id is not null
  )
  into runtime_ready
  from crm_private.ai_runtime_settings settings
  where settings.organization_id = new.organization_id;

  if not coalesce(runtime_ready, false) then
    return new;
  end if;

  select record.contact_id
    into canonical_contact_id
    from public.crm_records record
   where record.organization_id = new.organization_id
     and record.id = new.crm_record_id;

  begin
    select result.job_id, result.inserted
      into created_job_id, was_inserted
      from public.enqueue_crm_ai_job(
        new.organization_id,
        new.crm_record_id,
        canonical_contact_id,
        'lead_created',
        'lead-created:' || new.crm_record_id::text,
        'shadow'
      ) result;
  exception when others then
    raise warning
      'CRM AI enqueue fail-open; attribution=%, sqlstate=%',
      new.id,
      sqlstate;
    return new;
  end;

  if was_inserted then
    begin
      perform crm_private.dispatch_crm_ai_worker();
    exception when others then
      raise warning
        'CRM AI immediate dispatch fail-open; job=%, sqlstate=%',
        created_job_id,
        sqlstate;
    end;
  end if;

  return new;
end
$function$;

drop trigger if exists crm_opportunity_attributions_vitoria_enqueue
  on public.crm_opportunity_attributions;
create trigger crm_opportunity_attributions_vitoria_enqueue
  after insert on public.crm_opportunity_attributions
  for each row
  execute function crm_private.enqueue_vitoria_after_meta_attribution();

revoke all on function crm_private.configure_crm_ai_worker_runtime(text, boolean)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.dispatch_crm_ai_worker()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.enqueue_vitoria_after_meta_attribution()
  from public, anon, authenticated, service_role;

revoke all on function public.configure_crm_ai_worker_runtime(text, boolean)
  from public, anon, authenticated;
revoke all on function public.verify_crm_ai_worker_bearer(text, text)
  from public, anon, authenticated;

grant execute on function public.configure_crm_ai_worker_runtime(text, boolean)
  to service_role;
grant execute on function public.verify_crm_ai_worker_bearer(text, text)
  to service_role;

-- Recovery: a chamada e um no-op quando o worker ainda nao foi configurado.
do $cron$
declare
  existing_job bigint;
begin
  select jobid into existing_job
  from cron.job
  where jobname = 'evora-crm-ai-dispatch-1m'
  limit 1;

  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;

  perform cron.schedule(
    'evora-crm-ai-dispatch-1m',
    '* * * * *',
    'select crm_private.dispatch_crm_ai_worker()'
  );
end
$cron$;

comment on function crm_private.enqueue_vitoria_after_meta_attribution() is
  'Gatilho fail-open que enfileira a Vitoria uma unica vez apos a primeira atribuicao Meta canonica.';
