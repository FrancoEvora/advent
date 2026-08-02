-- Restringe a Central de Insights aos dias úteis, preservando horários,
-- áreas, limites e demais configurações já definidas por organização.

create or replace function private.next_insight_run(
  p_run_times text[],
  p_timezone text,
  p_after timestamptz default now()
)
returns timestamptz
language sql
stable
set search_path = pg_catalog, public, private
as $$
  select min(candidate_at)
  from (
    select (
      ((timezone(p_timezone, p_after)::date + day_offset)::date
        + run_time::time)
      at time zone p_timezone
    ) as candidate_at
    from generate_series(0, 7) as day_offset
    cross join unnest(p_run_times) as run_time
    where extract(
      isodow from (timezone(p_timezone, p_after)::date + day_offset)::date
    ) between 1 and 5
  ) candidates
  where candidate_at > p_after;
$$;

comment on function private.next_insight_run(text[], text, timestamptz) is
  'Calcula a próxima rotina de insights em dia útil, no fuso configurado.';

revoke all on function private.next_insight_run(text[], text, timestamptz)
  from public, anon, authenticated;

-- A validação é feita no servidor para abranger o botão da interface e
-- qualquer outro cliente autenticado que invoque a mesma RPC.
create or replace function public.generate_management_insights(
  p_organization_id uuid,
  p_period_start timestamptz default null,
  p_period_end timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_user_id uuid := auth.uid();
  v_end timestamptz := coalesce(p_period_end, now());
begin
  if v_user_id is null
    or not public.is_org_member(p_organization_id)
    or not (
      public.has_app_permission(p_organization_id, 'insights.run')
      or public.has_app_permission(p_organization_id, 'insights.manage')
    ) then
    raise exception 'Sem permissão para gerar insights desta organização.';
  end if;

  if extract(
    isodow from timezone('America/Sao_Paulo', now())
  ) not between 1 and 5 then
    raise exception
      'A geração de insights está disponível apenas de segunda a sexta-feira (horário de São Paulo).';
  end if;

  return private.run_insights_cycle(
    p_organization_id,
    'manual:' || v_user_id::text || ':' || gen_random_uuid()::text,
    'manual',
    v_end,
    v_user_id,
    p_period_start,
    v_end
  );
end;
$$;

revoke all on function public.generate_management_insights(
  uuid, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.generate_management_insights(
  uuid, timestamptz, timestamptz
) to authenticated;

-- A própria rotina agendada também recusa fins de semana, mesmo se for
-- chamada diretamente por uma função privilegiada fora do pg_cron.
create or replace function private.run_scheduled_insights(p_local_slot text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_setting public.insight_settings%rowtype;
  v_scheduled_for timestamptz;
  v_count integer := 0;
begin
  if p_local_slot not in ('06:30', '13:00', '19:00') then
    raise exception 'Horário de execução inválido.';
  end if;

  if extract(
    isodow from timezone('America/Sao_Paulo', now())
  ) not between 1 and 5 then
    return 0;
  end if;

  for v_setting in
    select * from public.insight_settings setting
    where setting.enabled and p_local_slot = any(setting.run_times)
    order by setting.organization_id
  loop
    v_scheduled_for := (
      timezone(v_setting.timezone, now())::date + p_local_slot::time
    ) at time zone v_setting.timezone;

    perform private.run_insights_cycle(
      v_setting.organization_id,
      'scheduled:' || timezone(v_setting.timezone, v_scheduled_for)::date::text
        || ':' || p_local_slot,
      'scheduled', v_scheduled_for, null,
      v_scheduled_for - interval '30 days', v_scheduled_for
    );
    update public.insight_settings
    set next_run_at = private.next_insight_run(
        run_times, timezone, greatest(now(), v_scheduled_for) + interval '1 minute'
      ),
      updated_at = now()
    where organization_id = v_setting.organization_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function private.run_scheduled_insights(text)
  from public, anon, authenticated;

-- Corrige previsões já gravadas sem alterar horários, áreas, limites,
-- responsáveis ou qualquer outra preferência existente.
with recalculated as (
  select setting.organization_id,
    case
      when setting.enabled then private.next_insight_run(
        setting.run_times, setting.timezone, now()
      )
      else null
    end as next_run_at
  from public.insight_settings setting
)
update public.insight_settings setting
set next_run_at = recalculated.next_run_at,
  updated_at = now()
from recalculated
where recalculated.organization_id = setting.organization_id
  and setting.next_run_at is distinct from recalculated.next_run_at;

create extension if not exists pg_cron;

do $$
declare
  v_job record;
begin
  for v_job in
    select jobid from cron.job
    where jobname in (
      'evora-insights-0630-sp',
      'evora-insights-1300-sp',
      'evora-insights-1900-sp'
    )
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

-- O pg_cron opera em UTC neste projeto. Os horários abaixo correspondem a
-- 06:30, 13:00 e 19:00 em America/Sao_Paulo (UTC-03), de segunda a sexta.
select cron.schedule(
  'evora-insights-0630-sp',
  '30 9 * * 1-5',
  $cron$select private.run_scheduled_insights('06:30');$cron$
);
select cron.schedule(
  'evora-insights-1300-sp',
  '0 16 * * 1-5',
  $cron$select private.run_scheduled_insights('13:00');$cron$
);
select cron.schedule(
  'evora-insights-1900-sp',
  '0 22 * * 1-5',
  $cron$select private.run_scheduled_insights('19:00');$cron$
);
