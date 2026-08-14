-- Amplia a janela de resposta do dispatch da Vitória para cobrir os dois passes
-- supervisionados da OpenAI. A execução permanece assíncrona, queue-aware e
-- sem qualquer capacidade de envio externo ao lead.

set lock_timeout = '5s';
set statement_timeout = '120s';

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
  if not exists (
    select 1
      from public.crm_ai_jobs job
     where job.attempt_count < job.max_attempts
       and (
         (job.status in ('pending', 'retry') and job.available_at <= now())
         or (
           job.status = 'processing'
           and (
             job.locked_at is null
             or job.locked_at < now() - interval '180 seconds'
           )
         )
       )
  ) then
    return null;
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

  worker_url := nullif(trim(worker_url), '');
  worker_secret := nullif(trim(worker_secret), '');

  if worker_url is null
     or worker_secret is null
     or worker_url !~ '^https://[A-Za-z0-9-]+[.]supabase[.]co/functions/v1/enterprise-ai-worker$'
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
    timeout_milliseconds := 60000
  )
  into request_id;

  return request_id;
end
$function$;

revoke all on function crm_private.dispatch_crm_ai_worker()
  from public, anon, authenticated;
grant execute on function crm_private.dispatch_crm_ai_worker()
  to service_role;

comment on function crm_private.dispatch_crm_ai_worker() is
  'Despacha o Edge worker da Vitoria somente quando ha fila elegivel; timeout cobre os dois passes supervisionados da OpenAI.';
