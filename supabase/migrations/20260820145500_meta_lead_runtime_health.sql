-- Mantem a integração Meta operacional e torna o estado de sincronização observável.
-- A conexão só deve ser considerada saudável quando o worker periódico estiver ativo
-- e as rotas de polling tiverem checkpoint recente.

do $$
declare
  v_job_id bigint;
begin
  select jobid
    into v_job_id
  from cron.job
  where jobname = 'evora-meta-lead-dispatch-5m'
  limit 1;

  if v_job_id is null then
    raise exception 'META_LEAD_DISPATCH_JOB_NOT_FOUND';
  end if;

  perform cron.alter_job(
    job_id := v_job_id,
    active := true
  );
end
$$;

create or replace function public.get_meta_lead_runtime_health(
  p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active_routes integer := 0;
  v_polling_routes integer := 0;
  v_oldest_poll_at timestamptz;
  v_newest_poll_at timestamptz;
  v_scheduler_active boolean := false;
  v_scheduler_schedule text;
  v_last_received_at timestamptz;
  v_last_processed_at timestamptz;
  v_pending integer := 0;
  v_dead_letter integer := 0;
  v_healthy boolean := false;
begin
  if auth.uid() is null
     or p_organization_id is null
     or not public.has_app_permission(
       p_organization_id,
       'crm.integrations.manage'
     ) then
    raise exception 'Seu perfil nao pode consultar a saude da integracao Meta.'
      using errcode = '42501';
  end if;

  select
    count(*) filter (where route.active)::integer,
    count(*) filter (
      where route.active
        and lower(coalesce(route.metadata ->> 'ingress_mode', '')) in ('polling', 'hybrid')
    )::integer,
    min(
      case
        when route.metadata ? 'last_poll_at'
          then (route.metadata ->> 'last_poll_at')::timestamptz
        else null
      end
    ) filter (
      where route.active
        and lower(coalesce(route.metadata ->> 'ingress_mode', '')) in ('polling', 'hybrid')
    ),
    max(
      case
        when route.metadata ? 'last_poll_at'
          then (route.metadata ->> 'last_poll_at')::timestamptz
        else null
      end
    ) filter (
      where route.active
        and lower(coalesce(route.metadata ->> 'ingress_mode', '')) in ('polling', 'hybrid')
    )
  into
    v_active_routes,
    v_polling_routes,
    v_oldest_poll_at,
    v_newest_poll_at
  from public.crm_meta_lead_routes route
  where route.organization_id = p_organization_id;

  select job.active, job.schedule
    into v_scheduler_active, v_scheduler_schedule
  from cron.job job
  where job.jobname = 'evora-meta-lead-dispatch-5m'
  limit 1;

  select
    max(inbox.last_received_at),
    max(inbox.processed_at),
    count(*) filter (where inbox.status in ('pending', 'processing', 'retry'))::integer,
    count(*) filter (where inbox.status = 'dead_letter')::integer
  into
    v_last_received_at,
    v_last_processed_at,
    v_pending,
    v_dead_letter
  from crm_integration_private.integration_inbox_events inbox
  where inbox.provider = 'meta'
    and inbox.organization_id = p_organization_id;

  v_healthy := coalesce(v_scheduler_active, false)
    and v_polling_routes > 0
    and v_oldest_poll_at is not null
    and v_oldest_poll_at >= now() - interval '15 minutes';

  return jsonb_build_object(
    'healthy', v_healthy,
    'scheduler', jsonb_build_object(
      'active', coalesce(v_scheduler_active, false),
      'schedule', v_scheduler_schedule
    ),
    'polling', jsonb_build_object(
      'activeRoutes', v_active_routes,
      'routes', v_polling_routes,
      'oldestLastPollAt', v_oldest_poll_at,
      'newestLastPollAt', v_newest_poll_at
    ),
    'events', jsonb_build_object(
      'lastReceivedAt', v_last_received_at,
      'lastProcessedAt', v_last_processed_at,
      'pending', v_pending,
      'deadLetter', v_dead_letter
    )
  );
end
$$;

revoke all on function public.get_meta_lead_runtime_health(uuid) from public;
grant execute on function public.get_meta_lead_runtime_health(uuid) to authenticated;
