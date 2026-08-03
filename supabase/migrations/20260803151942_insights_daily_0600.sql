-- Centraliza a rotina automática de Insights em uma única execução diária:
-- 06:00 em America/Sao_Paulo, de segunda a sexta-feira.
-- O histórico já produzido permanece imutável e não é alterado.

alter table public.insight_settings
  drop constraint if exists insight_settings_run_times_count_check,
  drop constraint if exists insight_settings_run_times_check;

alter table public.insight_settings
  alter column run_times
  set default array['06:00']::text[];

update public.insight_settings
set run_times = array['06:00']::text[],
  next_run_at = case
    when enabled then private.next_insight_run(
      array['06:00']::text[], timezone, now()
    )
    else null
  end,
  updated_at = now()
where run_times is distinct from array['06:00']::text[]
   or (
     enabled
     and next_run_at is distinct from private.next_insight_run(
       array['06:00']::text[], timezone, now()
     )
   )
   or (not enabled and next_run_at is not null);

alter table public.insight_settings
  add constraint insight_settings_run_times_count_check
    check (cardinality(run_times) = 1),
  add constraint insight_settings_run_times_check
    check (run_times = array['06:00']::text[]);

comment on column public.insight_settings.run_times is
  'Horário fixo da rotina automática: 06:00 em America/Sao_Paulo, de segunda a sexta-feira.';

-- Mantém a assinatura pública por compatibilidade, mas impede que clientes
-- configurem múltiplas janelas ou outro horário.
create or replace function public.configure_insights(
  p_organization_id uuid,
  p_enabled boolean,
  p_run_times text[],
  p_areas text[]
)
returns public.insight_settings
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_user_id uuid := auth.uid();
  v_result public.insight_settings%rowtype;
begin
  if v_user_id is null
    or not public.is_org_member(p_organization_id)
    or not public.has_app_permission(p_organization_id, 'insights.manage') then
    raise exception 'Sem permissão para configurar a Central de Insights.';
  end if;

  if p_run_times is null
    or p_run_times <> array['06:00']::text[] then
    raise exception
      'A rotina automática deve ser executada uma vez por dia útil, às 06:00 (horário de São Paulo).';
  end if;

  if p_areas is null
    or cardinality(p_areas) not between 1 and 9
    or not p_areas <@ array[
      'financeiro', 'vendas_crm_sdr', 'obras', 'contratos',
      'compras', 'combustiveis', 'rh', 'pos_venda_agenda',
      'governanca'
    ]::text[] then
    raise exception 'Selecione ao menos uma área válida.';
  end if;

  insert into public.insight_settings (
    organization_id, enabled, run_times, timezone, next_run_at,
    areas, updated_at, updated_by
  ) values (
    p_organization_id, p_enabled, array['06:00']::text[],
    'America/Sao_Paulo',
    case when p_enabled then private.next_insight_run(
      array['06:00']::text[], 'America/Sao_Paulo', now()
    ) else null end,
    p_areas, now(), v_user_id
  )
  on conflict (organization_id) do update
  set enabled = excluded.enabled,
    run_times = excluded.run_times,
    timezone = excluded.timezone,
    next_run_at = excluded.next_run_at,
    areas = excluded.areas,
    updated_at = now(),
    updated_by = v_user_id
  returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.configure_insights(
  uuid, boolean, text[], text[]
) from public, anon, authenticated;
grant execute on function public.configure_insights(
  uuid, boolean, text[], text[]
) to authenticated;

create or replace function private.run_scheduled_insights(p_local_slot text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_setting public.insight_settings%rowtype;
  v_scheduled_for timestamptz;
  v_run_id uuid;
  v_run_status text;
  v_count integer := 0;
begin
  if p_local_slot is distinct from '06:00' then
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

    v_run_id := private.run_insights_cycle(
      v_setting.organization_id,
      'scheduled:' || timezone(
        v_setting.timezone, v_scheduled_for
      )::date::text || ':' || p_local_slot,
      'scheduled', v_scheduled_for, null,
      v_scheduled_for - interval '30 days', v_scheduled_for
    );

    select run.status into v_run_status
    from public.insight_runs run
    where run.id = v_run_id;

    update public.insight_settings
    set next_run_at = private.next_insight_run(
        run_times, timezone,
        greatest(now(), v_scheduled_for) + interval '1 minute'
      ),
      updated_at = now()
    where organization_id = v_setting.organization_id;

    if v_run_status = 'completed' then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

revoke all on function private.run_scheduled_insights(text)
  from public, anon, authenticated;

create extension if not exists pg_cron;

-- Remove qualquer disparador anterior desta rotina, inclusive nomes legados,
-- para que exista exatamente um job automático ativo.
do $$
declare
  v_job record;
begin
  for v_job in
    select jobid
    from cron.job
    where jobname in (
      'evora-insights-0600-sp',
      'evora-insights-0630-sp',
      'evora-insights-1300-sp',
      'evora-insights-1900-sp'
    )
      or command ilike '%private.run_scheduled_insights(%'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

-- O banco permanece em UTC: 09:00 UTC = 06:00 America/Sao_Paulo.
select cron.schedule(
  'evora-insights-0600-sp',
  '0 9 * * 1-5',
  $cron$select private.run_scheduled_insights('06:00');$cron$
);
