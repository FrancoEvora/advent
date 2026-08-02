-- Central de Insights Executivos multiárea.
--
-- A rotina é inteiramente executada no Postgres, sem chave service_role e sem
-- chamadas externas. O banco permanece em UTC. Os três jobs abaixo convertem
-- os horários de São Paulo (UTC-03 em 2026) da seguinte forma:
--   06:30 America/Sao_Paulo = 09:30 UTC
--   13:00 America/Sao_Paulo = 16:00 UTC
--   19:00 America/Sao_Paulo = 22:00 UTC
--
-- Métricas e conteúdo analítico são históricos. Alterações de tratamento de
-- um insight são registradas em uma trilha append-only própria.

do $$
begin
  if to_regclass('public.organizations') is null
    or to_regclass('public.organization_members') is null
    or to_regclass('public.role_permissions') is null
    or to_regclass('public.financial_entries') is null
    or to_regclass('public.crm_records') is null
    or to_regclass('public.crm_contracts') is null
    or to_regclass('public.crm_inventory_units') is null
    or to_regclass('public.construction_work_packages') is null
    or to_regclass('public.operational_contracts') is null
    or to_regclass('public.purchase_requests') is null
    or to_regclass('public.fuel_requests') is null
    or to_regclass('public.hr_employees') is null
    or to_regclass('public.post_sale_tickets') is null
    or to_regclass('public.user_activities') is null
    or to_regclass('public.approval_requests') is null
    or to_regclass('public.audit_logs') is null
    or to_regclass('public.backup_runs') is null
    or to_regprocedure('public.is_org_member(uuid)') is null
    or to_regprocedure('public.has_app_permission(uuid,text)') is null then
    raise exception
      'Pré-requisitos da Central de Insights não foram encontrados.';
  end if;
end;
$$;

create schema if not exists private;

create table public.insight_settings (
  organization_id uuid primary key
    references public.organizations(id) on delete cascade,
  enabled boolean not null default true,
  run_times text[] not null
    default array['06:30', '13:00', '19:00']::text[],
  timezone text not null default 'America/Sao_Paulo',
  next_run_at timestamptz,
  areas text[] not null default array[
    'financeiro',
    'vendas_crm_sdr',
    'obras',
    'contratos',
    'compras',
    'combustiveis',
    'rh',
    'pos_venda_agenda',
    'governanca'
  ]::text[],
  thresholds jsonb not null default jsonb_build_object(
    'crm_sla_hours', 2,
    'crm_stagnation_hours', 48,
    'construction_delay_days', 0,
    'contract_expiry_days', 30,
    'minimum_coverage_pct', 70
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint insight_settings_timezone_check
    check (timezone = 'America/Sao_Paulo'),
  constraint insight_settings_run_times_count_check
    check (cardinality(run_times) between 2 and 3),
  constraint insight_settings_run_times_check
    check (
      run_times <@ array['06:30', '13:00', '19:00']::text[]
      and cardinality(run_times) =
        (case when '06:30' = any(run_times) then 1 else 0 end)
        + (case when '13:00' = any(run_times) then 1 else 0 end)
        + (case when '19:00' = any(run_times) then 1 else 0 end)
    ),
  constraint insight_settings_areas_check
    check (
      cardinality(areas) between 1 and 9
      and areas <@ array[
        'financeiro', 'vendas_crm_sdr', 'obras', 'contratos',
        'compras', 'combustiveis', 'rh', 'pos_venda_agenda',
        'governanca'
      ]::text[]
    ),
  constraint insight_settings_thresholds_object_check
    check (jsonb_typeof(thresholds) = 'object')
);

create table public.insight_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  idempotency_key text not null,
  status text not null default 'started',
  trigger_source text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  period_start timestamptz not null,
  period_end timestamptz not null,
  areas_analyzed text[] not null default '{}'::text[],
  data_coverage_pct numeric(5,2) not null default 0,
  generated_by uuid,
  executive_summary jsonb not null default '{}'::jsonb,
  error_message text,
  engine_version text not null default 'executive-rules-v1',
  created_at timestamptz not null default now(),
  constraint insight_runs_status_check
    check (status in ('started', 'completed', 'failed')),
  constraint insight_runs_source_check
    check (trigger_source in ('scheduled', 'manual', 'implantacao')),
  constraint insight_runs_period_check check (period_end >= period_start),
  constraint insight_runs_coverage_check
    check (data_coverage_pct between 0 and 100),
  constraint insight_runs_summary_object_check
    check (jsonb_typeof(executive_summary) = 'object'),
  unique (organization_id, idempotency_key)
);

create table public.insight_metrics (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  run_id uuid not null
    references public.insight_runs(id) on delete cascade,
  area text not null,
  metric_key text not null,
  label text not null,
  numeric_value numeric not null,
  unit text not null default 'numero',
  comparison_value numeric,
  variation_pct numeric,
  period_start timestamptz not null,
  period_end timestamptz not null,
  trend_points jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint insight_metrics_area_check check (area in (
    'financeiro', 'vendas_crm_sdr', 'obras', 'contratos',
    'compras', 'combustiveis', 'rh', 'pos_venda_agenda',
    'governanca'
  )),
  constraint insight_metrics_period_check check (period_end >= period_start),
  constraint insight_metrics_trend_array_check
    check (jsonb_typeof(trend_points) = 'array'),
  unique (run_id, area, metric_key)
);

create table public.insights (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  run_id uuid not null
    references public.insight_runs(id) on delete cascade,
  area text not null,
  title text not null,
  summary text not null,
  evidence jsonb not null default '{}'::jsonb,
  impact jsonb not null default '{}'::jsonb,
  recommendation text not null,
  severity text not null,
  priority text not null,
  status text not null default 'novo',
  due_at timestamptz,
  confidence_pct numeric(5,2) not null,
  responsible_user_id uuid,
  related_view text,
  related_entity_type text,
  related_entity_id uuid,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz not null default now(),
  constraint insights_area_check check (area in (
    'financeiro', 'vendas_crm_sdr', 'obras', 'contratos',
    'compras', 'combustiveis', 'rh', 'pos_venda_agenda',
    'governanca'
  )),
  constraint insights_severity_check
    check (severity in ('info', 'warning', 'high', 'critical')),
  constraint insights_priority_check
    check (priority in ('low', 'medium', 'high', 'urgent')),
  constraint insights_status_check
    check (status in ('novo', 'reconhecido', 'em_tratamento', 'resolvido', 'descartado')),
  constraint insights_confidence_check
    check (confidence_pct between 0 and 100),
  constraint insights_evidence_object_check check (jsonb_typeof(evidence) = 'object'),
  constraint insights_impact_object_check check (jsonb_typeof(impact) = 'object'),
  constraint insights_resolution_check check (
    (status = 'resolvido' and resolved_at is not null and resolved_by is not null)
    or status <> 'resolvido'
  )
);

create table public.insight_status_history (
  id bigint generated always as identity primary key,
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  insight_id uuid not null
    references public.insights(id) on delete cascade,
  previous_status text,
  new_status text not null,
  note text,
  changed_by uuid,
  changed_at timestamptz not null default now(),
  constraint insight_status_history_status_check
    check (new_status in ('novo', 'reconhecido', 'em_tratamento', 'resolvido', 'descartado'))
);

create index insight_runs_org_started_idx
  on public.insight_runs (organization_id, started_at desc);
create index insight_runs_org_status_idx
  on public.insight_runs (organization_id, status, started_at desc);
create index insight_metrics_org_area_key_idx
  on public.insight_metrics (organization_id, area, metric_key, created_at desc);
create index insight_metrics_run_idx on public.insight_metrics (run_id);
create index insights_org_status_idx
  on public.insights (organization_id, status, severity, created_at desc);
create index insights_run_idx on public.insights (run_id);
create index insights_due_open_idx
  on public.insights (organization_id, due_at)
  where status in ('novo', 'reconhecido', 'em_tratamento');
create index insight_status_history_insight_idx
  on public.insight_status_history (insight_id, changed_at desc);

comment on table public.insight_settings is
  'Configuração da rotina executiva de insights por organização.';
comment on table public.insight_runs is
  'Execuções automáticas, manuais e de implantação com data, hora e resumo executivo.';
comment on table public.insight_metrics is
  'Snapshots históricos e imutáveis de KPIs usados pelo BI.';
comment on table public.insights is
  'Achados executivos multiárea; conteúdo analítico é imutável e tratamento é auditado.';
comment on column public.insight_runs.executive_summary is
  'Resumo completo da execução, produzido exclusivamente com métricas observadas.';

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
    from generate_series(0, 2) as day_offset
    cross join unnest(p_run_times) as run_time
  ) candidates
  where candidate_at > p_after;
$$;

create or replace function private.record_insight_metric(
  p_run_id uuid,
  p_organization_id uuid,
  p_area text,
  p_metric_key text,
  p_label text,
  p_numeric_value numeric,
  p_unit text,
  p_period_start timestamptz,
  p_period_end timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_id uuid := gen_random_uuid();
  v_previous numeric;
  v_trend jsonb;
begin
  select metric.numeric_value
    into v_previous
  from public.insight_metrics metric
  join public.insight_runs run on run.id = metric.run_id
  where metric.organization_id = p_organization_id
    and metric.area = p_area
    and metric.metric_key = p_metric_key
    and run.status = 'completed'
  order by metric.created_at desc
  limit 1;

  select coalesce(jsonb_agg(point order by point_at), '[]'::jsonb)
    into v_trend
  from (
    select prior.created_at as point_at,
      jsonb_build_object(
        'at', prior.created_at,
        'value', prior.numeric_value
      ) as point
    from (
      select metric.created_at, metric.numeric_value
      from public.insight_metrics metric
      join public.insight_runs run on run.id = metric.run_id
      where metric.organization_id = p_organization_id
        and metric.area = p_area
        and metric.metric_key = p_metric_key
        and run.status = 'completed'
      order by metric.created_at desc
      limit 7
    ) prior
    union all
    select p_period_end,
      jsonb_build_object('at', p_period_end, 'value', p_numeric_value)
  ) points;

  insert into public.insight_metrics (
    id, organization_id, run_id, area, metric_key, label,
    numeric_value, unit, comparison_value, variation_pct,
    period_start, period_end, trend_points
  ) values (
    v_id, p_organization_id, p_run_id, p_area, p_metric_key, p_label,
    coalesce(p_numeric_value, 0), p_unit, v_previous,
    case
      when v_previous is null or v_previous = 0 then null
      else round(((p_numeric_value - v_previous) / abs(v_previous)) * 100, 2)
    end,
    p_period_start, p_period_end, v_trend
  );

  return v_id;
end;
$$;

create or replace function private.record_executive_insight(
  p_run_id uuid,
  p_organization_id uuid,
  p_area text,
  p_title text,
  p_summary text,
  p_evidence jsonb,
  p_impact jsonb,
  p_recommendation text,
  p_severity text,
  p_priority text,
  p_due_at timestamptz,
  p_confidence_pct numeric,
  p_related_view text default null,
  p_related_entity_type text default null,
  p_related_entity_id uuid default null,
  p_responsible_user_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into public.insights (
    id, organization_id, run_id, area, title, summary, evidence,
    impact, recommendation, severity, priority, status, due_at,
    confidence_pct, responsible_user_id, related_view,
    related_entity_type, related_entity_id
  ) values (
    v_id, p_organization_id, p_run_id, p_area, p_title, p_summary,
    coalesce(p_evidence, '{}'::jsonb), coalesce(p_impact, '{}'::jsonb),
    p_recommendation, p_severity, p_priority, 'novo', p_due_at,
    greatest(0, least(100, coalesce(p_confidence_pct, 0))),
    p_responsible_user_id, p_related_view, p_related_entity_type,
    p_related_entity_id
  );
  return v_id;
end;
$$;

revoke all on function private.next_insight_run(text[], text, timestamptz)
  from public, anon, authenticated;
revoke all on function private.record_insight_metric(
  uuid, uuid, text, text, text, numeric, text, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function private.record_executive_insight(
  uuid, uuid, text, text, text, jsonb, jsonb, text, text, text,
  timestamptz, numeric, text, text, uuid, uuid
) from public, anon, authenticated;

create or replace function private.run_insights_cycle(
  p_organization_id uuid,
  p_idempotency_key text,
  p_trigger_source text,
  p_scheduled_for timestamptz,
  p_generated_by uuid default null,
  p_period_start timestamptz default null,
  p_period_end timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_run_id uuid;
  v_areas text[];
  v_period_end timestamptz := coalesce(p_period_end, p_scheduled_for, now());
  v_period_start timestamptz;
  v_thresholds jsonb;
  v_coverage numeric := 0;
  v_coverage_total numeric := 0;
  v_area_count integer := 0;
  v_total bigint := 0;
  v_complete bigint := 0;
  v_count bigint := 0;
  v_count2 bigint := 0;
  v_count3 bigint := 0;
  v_amount numeric := 0;
  v_amount2 numeric := 0;
  v_amount3 numeric := 0;
  v_value numeric := 0;
  v_value2 numeric := 0;
  v_value3 numeric := 0;
  v_confidence numeric := 0;
  v_min_coverage numeric := 70;
  v_crm_sla_hours numeric := 2;
  v_crm_stagnation_hours numeric := 48;
  v_contract_expiry_days integer := 30;
  v_critical integer := 0;
  v_high integer := 0;
  v_warning integer := 0;
begin
  if p_trigger_source not in ('scheduled', 'manual', 'implantacao') then
    raise exception 'Origem de execução inválida.';
  end if;
  if p_organization_id is null or nullif(trim(p_idempotency_key), '') is null then
    raise exception 'Organização e chave idempotente são obrigatórias.';
  end if;

  v_period_start := coalesce(p_period_start, v_period_end - interval '30 days');
  if v_period_end < v_period_start
    or v_period_end - v_period_start > interval '366 days' then
    raise exception 'Período de análise inválido.';
  end if;

  if not pg_try_advisory_xact_lock(
    hashtext(p_organization_id::text), hashtext(p_idempotency_key)
  ) then
    select id into v_run_id
    from public.insight_runs
    where organization_id = p_organization_id
      and idempotency_key = p_idempotency_key;
    return v_run_id;
  end if;

  select setting.areas, setting.thresholds
    into v_areas, v_thresholds
  from public.insight_settings setting
  where setting.organization_id = p_organization_id;

  v_areas := coalesce(v_areas, array[
    'financeiro', 'vendas_crm_sdr', 'obras', 'contratos',
    'compras', 'combustiveis', 'rh', 'pos_venda_agenda',
    'governanca'
  ]::text[]);
  v_thresholds := coalesce(v_thresholds, '{}'::jsonb);
  v_min_coverage := coalesce((v_thresholds ->> 'minimum_coverage_pct')::numeric, 70);
  v_crm_sla_hours := coalesce((v_thresholds ->> 'crm_sla_hours')::numeric, 2);
  v_crm_stagnation_hours :=
    coalesce((v_thresholds ->> 'crm_stagnation_hours')::numeric, 48);
  v_contract_expiry_days :=
    coalesce((v_thresholds ->> 'contract_expiry_days')::integer, 30);

  insert into public.insight_runs (
    organization_id, idempotency_key, status, trigger_source,
    started_at, period_start, period_end, generated_by
  ) values (
    p_organization_id, p_idempotency_key, 'started', p_trigger_source,
    now(), v_period_start, v_period_end, p_generated_by
  )
  on conflict (organization_id, idempotency_key) do nothing
  returning id into v_run_id;

  if v_run_id is null then
    select id into v_run_id
    from public.insight_runs
    where organization_id = p_organization_id
      and idempotency_key = p_idempotency_key;
    return v_run_id;
  end if;

  begin
    -- FINANCEIRO ------------------------------------------------------------
    if 'financeiro' = any(v_areas) then
      select count(*), count(*) filter (
        where entry.type in ('entrada', 'saida')
          and entry.amount is not null
          and entry.due_date is not null
          and entry.status is not null
      )
        into v_total, v_complete
      from public.financial_entries entry
      where entry.organization_id = p_organization_id;

      v_coverage := case when v_total = 0 then 0
        else round(v_complete::numeric * 100 / v_total, 2) end;
      v_coverage_total := v_coverage_total + v_coverage;
      v_area_count := v_area_count + 1;

      select
        coalesce(sum(coalesce(entry.open_amount, entry.amount, 0)) filter (
          where entry.type = 'saida'
            and entry.status in ('pendente', 'vencido', 'rascunho')
        ), 0),
        coalesce(sum(coalesce(entry.open_amount, entry.amount, 0)) filter (
          where entry.type = 'entrada'
            and entry.status in ('pendente', 'vencido', 'rascunho')
        ), 0),
        coalesce(sum(coalesce(entry.open_amount, entry.amount, 0)) filter (
          where entry.type = 'saida'
            and entry.due_date < timezone('America/Sao_Paulo', v_period_end)::date
            and entry.status in ('pendente', 'vencido', 'rascunho')
        ), 0),
        coalesce(sum(coalesce(entry.open_amount, entry.amount, 0)) filter (
          where entry.type = 'entrada'
            and entry.due_date < timezone('America/Sao_Paulo', v_period_end)::date
            and entry.status in ('pendente', 'vencido', 'rascunho')
        ), 0),
        count(*) filter (
          where entry.cash_risk
            and entry.status in ('pendente', 'vencido', 'rascunho')
        )
        into v_amount, v_amount2, v_value, v_value2, v_count
      from public.financial_entries entry
      where entry.organization_id = p_organization_id;

      select
        coalesce(sum(entry.amount) filter (
          where entry.type = 'entrada' and entry.status = 'recebido'
        ), 0),
        coalesce(sum(entry.amount) filter (
          where entry.type = 'saida' and entry.status = 'pago'
        ), 0)
        into v_amount3, v_value3
      from public.financial_entries entry
      where entry.organization_id = p_organization_id
        and entry.settlement_date >= timezone('America/Sao_Paulo', v_period_start)::date
        and entry.settlement_date <= timezone('America/Sao_Paulo', v_period_end)::date;

      perform private.record_insight_metric(v_run_id, p_organization_id,
        'financeiro', 'data_coverage_pct', 'Cobertura financeira',
        v_coverage, 'percentual', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'financeiro', 'open_payables', 'Contas a pagar em aberto',
        v_amount, 'BRL', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'financeiro', 'open_receivables', 'Contas a receber em aberto',
        v_amount2, 'BRL', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'financeiro', 'overdue_payables', 'Pagamentos vencidos',
        v_value, 'BRL', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'financeiro', 'overdue_receivables', 'Recebíveis vencidos',
        v_value2, 'BRL', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'financeiro', 'period_receipts', 'Recebimentos no período',
        v_amount3, 'BRL', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'financeiro', 'period_payments', 'Pagamentos no período',
        v_value3, 'BRL', v_period_start, v_period_end);

      v_confidence := greatest(55, least(98, v_coverage));
      if v_value > 0 then
        perform private.record_executive_insight(v_run_id, p_organization_id,
          'financeiro', 'Pagamentos vencidos exigem plano de regularização',
          format('Há %s em obrigações vencidas ainda não liquidadas.',
            to_char(v_value, 'FM999G999G999G990D00')),
          jsonb_build_object('overdue_amount', v_value,
            'cash_risk_entries', v_count, 'as_of', v_period_end),
          jsonb_build_object('financial_exposure', v_value,
            'decision', 'priorizar_caixa_e_negociacao'),
          'Classificar por criticidade operacional, negociar datas e aprovar uma sequência de pagamentos compatível com o caixa.',
          case when v_count > 0 then 'critical' else 'high' end,
          case when v_count > 0 then 'urgent' else 'high' end,
          v_period_end + interval '1 day', v_confidence, 'financeiro');
      end if;
      if v_value2 > 0 then
        perform private.record_executive_insight(v_run_id, p_organization_id,
          'financeiro', 'Recebíveis vencidos reduzem a previsibilidade de caixa',
          format('A carteira vencida soma %s e requer cadência de cobrança.',
            to_char(v_value2, 'FM999G999G999G990D00')),
          jsonb_build_object('overdue_receivables', v_value2,
            'open_receivables', v_amount2, 'as_of', v_period_end),
          jsonb_build_object('cash_conversion_risk', v_value2),
          'Segmentar a carteira por idade e valor, definir responsáveis e registrar promessa de pagamento para cada exposição relevante.',
          'high', 'high', v_period_end + interval '2 days',
          v_confidence, 'financeiro');
      end if;
    end if;

    -- VENDAS, CRM E SDR ------------------------------------------------------
    if 'vendas_crm_sdr' = any(v_areas) then
      select count(*), count(*) filter (
        where nullif(trim(record.person_name), '') is not null
          and nullif(trim(record.stage), '') is not null
          and coalesce(record.sdr_user_id, record.owner_user_id) is not null
      )
        into v_total, v_complete
      from public.crm_records record
      where record.organization_id = p_organization_id;
      v_coverage := case when v_total = 0 then 0
        else round(v_complete::numeric * 100 / v_total, 2) end;
      v_coverage_total := v_coverage_total + v_coverage;
      v_area_count := v_area_count + 1;

      select
        count(*) filter (where record.record_status not in ('ganha', 'perdida', 'cancelada')),
        count(*) filter (
          where record.first_response_at is null
            and coalesce(record.sla_due_at,
              record.created_at + make_interval(hours => v_crm_sla_hours::integer)) < v_period_end
            and record.record_status not in ('ganha', 'perdida', 'cancelada')
        ),
        count(*) filter (
          where record.converted_at is null
            and coalesce(record.last_contact_at, record.created_at)
              < v_period_end - make_interval(hours => v_crm_stagnation_hours::integer)
            and record.record_status not in ('ganha', 'perdida', 'cancelada')
        )
        into v_count, v_count2, v_count3
      from public.crm_records record
      where record.organization_id = p_organization_id;

      select count(*), coalesce(sum(proposal.sale_price), 0)
        into v_total, v_amount
      from public.crm_contracts contract
      join public.crm_proposals proposal on proposal.id = contract.proposal_id
      where contract.organization_id = p_organization_id
        and contract.signed_at >= v_period_start
        and contract.signed_at <= v_period_end
        and contract.status = 'assinado';

      select count(*) filter (where unit.status = 'disponivel'),
        coalesce(sum(unit.list_price) filter (where unit.status = 'disponivel'), 0)
        into v_complete, v_amount2
      from public.crm_inventory_units unit
      where unit.organization_id = p_organization_id and unit.active;

      perform private.record_insight_metric(v_run_id, p_organization_id,
        'vendas_crm_sdr', 'data_coverage_pct', 'Cobertura de CRM',
        v_coverage, 'percentual', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'vendas_crm_sdr', 'open_leads', 'Leads em aberto',
        v_count, 'numero', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'vendas_crm_sdr', 'sla_overdue_leads', 'Leads com SLA vencido',
        v_count2, 'numero', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'vendas_crm_sdr', 'stagnant_leads', 'Leads sem evolução',
        v_count3, 'numero', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'vendas_crm_sdr', 'signed_sales_count', 'Vendas assinadas no período',
        v_total, 'numero', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'vendas_crm_sdr', 'signed_vgv', 'VGV assinado no período',
        v_amount, 'BRL', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'vendas_crm_sdr', 'available_inventory_vgv', 'VGV disponível',
        v_amount2, 'BRL', v_period_start, v_period_end);

      v_confidence := greatest(50, least(98, v_coverage));
      if v_count2 > 0 then
        perform private.record_executive_insight(v_run_id, p_organization_id,
          'vendas_crm_sdr', 'Velocidade de atendimento abaixo do SLA',
          format('%s lead(s) aguardam primeira resposta após o limite configurado.', v_count2),
          jsonb_build_object('sla_overdue', v_count2,
            'open_leads', v_count, 'sla_hours', v_crm_sla_hours),
          jsonb_build_object('conversion_risk_leads', v_count2),
          'Redistribuir imediatamente os leads vencidos, iniciar contato e acompanhar primeira resposta por SDR e origem.',
          case when v_count2 >= 10 then 'critical' else 'high' end,
          'urgent', v_period_end + interval '4 hours',
          v_confidence, 'crm');
      end if;
      if v_count3 > 0 then
        perform private.record_executive_insight(v_run_id, p_organization_id,
          'vendas_crm_sdr', 'Leads sem evolução precisam de próxima ação',
          format('%s lead(s) ultrapassaram a janela de estagnação.', v_count3),
          jsonb_build_object('stagnant_leads', v_count3,
            'stagnation_hours', v_crm_stagnation_hours),
          jsonb_build_object('pipeline_at_risk', v_count3),
          'Aplicar cadência multicanal, registrar resultado da tentativa e encerrar somente com motivo comercial estruturado.',
          'warning', 'high', v_period_end + interval '1 day',
          v_confidence, 'crm');
      end if;
    end if;

    -- OBRAS -----------------------------------------------------------------
    if 'obras' = any(v_areas) then
      select count(*), count(*) filter (
        where package.planned_progress is not null
          and package.actual_progress is not null
          and package.budget_amount is not null
          and package.planned_start is not null
          and package.planned_end is not null
      )
        into v_total, v_complete
      from public.construction_work_packages package
      where package.organization_id = p_organization_id
        and not package.is_summary;
      v_coverage := case when v_total = 0 then 0
        else round(v_complete::numeric * 100 / v_total, 2) end;
      v_coverage_total := v_coverage_total + v_coverage;
      v_area_count := v_area_count + 1;

      select
        coalesce(sum(package.planned_progress * package.weight_pct)
          / nullif(sum(package.weight_pct), 0), 0),
        coalesce(sum(package.actual_progress * package.weight_pct)
          / nullif(sum(package.weight_pct), 0), 0),
        count(*) filter (
          where package.planned_end < timezone('America/Sao_Paulo', v_period_end)::date
            and package.actual_progress < 100
            and package.status <> 'concluido'
        ),
        coalesce(sum(greatest(package.forecast_amount - package.budget_amount, 0)), 0)
        into v_value, v_value2, v_count, v_amount
      from public.construction_work_packages package
      where package.organization_id = p_organization_id
        and not package.is_summary;

      select count(*) into v_count2
      from public.construction_risks risk
      where risk.organization_id = p_organization_id
        and coalesce(risk.status, 'aberto') not in ('encerrado', 'mitigado', 'cancelado')
        and coalesce(risk.score, risk.probability * risk.impact) >= 12;

      perform private.record_insight_metric(v_run_id, p_organization_id,
        'obras', 'data_coverage_pct', 'Cobertura de obras',
        v_coverage, 'percentual', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'obras', 'planned_progress_pct', 'Avanço físico previsto',
        v_value, 'percentual', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'obras', 'actual_progress_pct', 'Avanço físico realizado',
        v_value2, 'percentual', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'obras', 'delayed_work_packages', 'Etapas atrasadas',
        v_count, 'numero', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'obras', 'forecast_overrun', 'Previsão acima do orçamento',
        v_amount, 'BRL', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'obras', 'high_open_risks', 'Riscos relevantes abertos',
        v_count2, 'numero', v_period_start, v_period_end);

      v_confidence := greatest(50, least(98, v_coverage));
      if v_count > 0 or v_value2 < v_value then
        perform private.record_executive_insight(v_run_id, p_organization_id,
          'obras', 'Ritmo físico abaixo do planejamento',
          format('Avanço realizado de %s%% frente a %s%% previsto; %s etapa(s) vencida(s).',
            round(v_value2, 1), round(v_value, 1), v_count),
          jsonb_build_object('planned_pct', v_value, 'actual_pct', v_value2,
            'variance_pct', v_value2 - v_value, 'delayed_packages', v_count),
          jsonb_build_object('schedule_variance_pct', v_value2 - v_value),
          'Reprogramar o caminho crítico, remover restrições das etapas atrasadas e registrar responsáveis e datas de recuperação.',
          case when v_value - v_value2 >= 10 then 'critical' else 'high' end,
          'urgent', v_period_end + interval '1 day',
          v_confidence, 'obras');
      end if;
      if v_amount > 0 then
        perform private.record_executive_insight(v_run_id, p_organization_id,
          'obras', 'Previsão de custo excede o orçamento das etapas',
          format('A exposição agregada de estouro projetado é %s.',
            to_char(v_amount, 'FM999G999G999G990D00')),
          jsonb_build_object('forecast_overrun', v_amount, 'as_of', v_period_end),
          jsonb_build_object('cost_exposure', v_amount),
          'Revisar escopo, produtividade, medições e compromissos antes de novas contratações vinculadas às etapas expostas.',
          'high', 'high', v_period_end + interval '3 days',
          v_confidence, 'obras');
      end if;
    end if;

    -- CONTRATOS -------------------------------------------------------------
    if 'contratos' = any(v_areas) then
      select count(*), count(*) filter (
        where contract.current_amount is not null
          and contract.status is not null
          and contract.start_date is not null
      ), coalesce(sum(contract.current_amount), 0),
        count(*) filter (
          where contract.end_date between
            timezone('America/Sao_Paulo', v_period_end)::date
            and timezone('America/Sao_Paulo', v_period_end)::date
              + v_contract_expiry_days
          and contract.status not in ('encerrado', 'cancelado', 'rescindido')
        )
        into v_total, v_complete, v_amount, v_count
      from public.operational_contracts contract
      where contract.organization_id = p_organization_id;

      select count(*) filter (
        where contract.signed_at is null
          and contract.status not in ('cancelado', 'rescindido')
      ) into v_count2
      from public.crm_contracts contract
      where contract.organization_id = p_organization_id;

      select count(*) into v_count3
      from public.contract_measurements measurement
      where measurement.organization_id = p_organization_id
        and measurement.status not in ('aprovada', 'paga', 'cancelada', 'rejeitada')
        and measurement.submitted_at <= v_period_end;

      v_coverage := case when v_total = 0 then 0
        else round(v_complete::numeric * 100 / v_total, 2) end;
      v_coverage_total := v_coverage_total + v_coverage;
      v_area_count := v_area_count + 1;
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'contratos', 'data_coverage_pct', 'Cobertura contratual',
        v_coverage, 'percentual', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'contratos', 'operational_contract_value', 'Carteira contratual operacional',
        v_amount, 'BRL', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'contratos', 'expiring_contracts', 'Contratos próximos do vencimento',
        v_count, 'numero', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'contratos', 'unsigned_sales_contracts', 'Contratos de venda sem assinatura',
        v_count2, 'numero', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'contratos', 'pending_measurements', 'Medições pendentes',
        v_count3, 'numero', v_period_start, v_period_end);

      v_confidence := greatest(50, least(98, v_coverage));
      if v_count > 0 then
        perform private.record_executive_insight(v_run_id, p_organization_id,
          'contratos', 'Contratos operacionais próximos do vencimento',
          format('%s contrato(s) vencem nos próximos %s dias.',
            v_count, v_contract_expiry_days),
          jsonb_build_object('expiring_contracts', v_count,
            'window_days', v_contract_expiry_days),
          jsonb_build_object('continuity_risk_contracts', v_count),
          'Definir renovação, encerramento ou nova contratação antes do vencimento e revisar saldo, medição e obrigações pendentes.',
          'warning', 'high', v_period_end + interval '5 days',
          v_confidence, 'contratos_operacionais');
      end if;
      if v_count3 > 0 then
        perform private.record_executive_insight(v_run_id, p_organization_id,
          'contratos', 'Medições aguardam tratamento',
          format('%s medição(ões) permanecem fora dos estados finais.', v_count3),
          jsonb_build_object('pending_measurements', v_count3),
          jsonb_build_object('payment_and_execution_risk', v_count3),
          'Conferir documentação, avanço físico, glosas, retenções e alçada para concluir a decisão sobre cada medição.',
          'high', 'high', v_period_end + interval '2 days',
          v_confidence, 'contratos_operacionais');
      end if;
    end if;

    -- COMPRAS ---------------------------------------------------------------
    if 'compras' = any(v_areas) then
      select count(*), count(*) filter (
        where request.status is not null
          and request.estimated_total is not null
          and nullif(trim(request.title), '') is not null
      ), coalesce(sum(request.estimated_total), 0),
        count(*) filter (
          where request.approval_required and request.approved_at is null
            and request.status not in ('rejeitada', 'cancelada', 'concluida')
        ),
        count(*) filter (
          where request.needed_by < timezone('America/Sao_Paulo', v_period_end)::date
            and request.status not in ('rejeitada', 'cancelada', 'concluida', 'recebida')
        ),
        count(*) filter (
          where request.cash_risk
            and request.status not in ('rejeitada', 'cancelada', 'concluida')
        )
        into v_total, v_complete, v_amount, v_count, v_count2, v_count3
      from public.purchase_requests request
      where request.organization_id = p_organization_id;

      v_coverage := case when v_total = 0 then 0
        else round(v_complete::numeric * 100 / v_total, 2) end;
      v_coverage_total := v_coverage_total + v_coverage;
      v_area_count := v_area_count + 1;
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'compras', 'data_coverage_pct', 'Cobertura de compras',
        v_coverage, 'percentual', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'compras', 'request_value', 'Valor das solicitações',
        v_amount, 'BRL', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'compras', 'pending_approvals', 'Compras aguardando aprovação',
        v_count, 'numero', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'compras', 'overdue_needs', 'Necessidades vencidas',
        v_count2, 'numero', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'compras', 'cash_risk_requests', 'Compras com risco de caixa',
        v_count3, 'numero', v_period_start, v_period_end);

      v_confidence := greatest(50, least(98, v_coverage));
      if v_count > 0 or v_count2 > 0 then
        perform private.record_executive_insight(v_run_id, p_organization_id,
          'compras', 'Fila de compras ameaça o atendimento das necessidades',
          format('%s solicitação(ões) aguardam aprovação e %s necessidade(s) estão vencidas.',
            v_count, v_count2),
          jsonb_build_object('pending_approvals', v_count,
            'overdue_needs', v_count2, 'cash_risk', v_count3),
          jsonb_build_object('operational_delay_requests', v_count2),
          'Priorizar itens do caminho crítico, validar três referências quando aplicável e concluir alçadas com data de entrega confirmada.',
          case when v_count2 > 0 then 'high' else 'warning' end,
          'high', v_period_end + interval '1 day',
          v_confidence, 'compras');
      end if;
    end if;

    -- COMBUSTÍVEIS ----------------------------------------------------------
    if 'combustiveis' = any(v_areas) then
      select count(*), count(*) filter (
        where request.status is not null
          and nullif(trim(request.fuel_type), '') is not null
          and request.requested_liters > 0
          and nullif(trim(coalesce(request.vehicle_identifier,
            request.equipment_identifier)), '') is not null
      ), count(*) filter (
        where request.document_workflow_status not in ('concluido', 'dispensado')
          and request.status not in ('cancelada', 'rejeitada')
      )
        into v_total, v_complete, v_count
      from public.fuel_requests request
      where request.organization_id = p_organization_id;

      select coalesce(sum(dispense.liters), 0),
        coalesce(sum(dispense.total_amount), 0),
        count(*) filter (where dispense.receipt_attachment_id is null)
        into v_amount, v_amount2, v_count2
      from public.fuel_dispenses dispense
      where dispense.organization_id = p_organization_id
        and dispense.dispensed_at >= v_period_start
        and dispense.dispensed_at <= v_period_end;

      v_coverage := case when v_total = 0 then 0
        else round(v_complete::numeric * 100 / v_total, 2) end;
      v_coverage_total := v_coverage_total + v_coverage;
      v_area_count := v_area_count + 1;
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'combustiveis', 'data_coverage_pct', 'Cobertura de combustíveis',
        v_coverage, 'percentual', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'combustiveis', 'dispensed_liters', 'Litros abastecidos no período',
        v_amount, 'litros', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'combustiveis', 'fuel_cost', 'Custo de combustível no período',
        v_amount2, 'BRL', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'combustiveis', 'missing_receipts', 'Abastecimentos sem comprovante',
        v_count2, 'numero', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'combustiveis', 'pending_document_workflows', 'Documentos pendentes',
        v_count, 'numero', v_period_start, v_period_end);

      v_confidence := greatest(50, least(98, v_coverage));
      if v_count2 > 0 then
        perform private.record_executive_insight(v_run_id, p_organization_id,
          'combustiveis', 'Abastecimentos sem nota ou comprovante',
          format('%s abastecimento(s) do período não possuem anexo fiscal.', v_count2),
          jsonb_build_object('missing_receipts', v_count2,
            'period_fuel_cost', v_amount2),
          jsonb_build_object('document_and_reconciliation_risk', v_count2),
          'Anexar nota fiscal ou foto legível, conferir litros, valor unitário, equipamento e horímetro antes da conciliação financeira.',
          'high', 'high', v_period_end + interval '1 day',
          v_confidence, 'compras', 'fuel_dispense');
      end if;
    end if;

    -- RH --------------------------------------------------------------------
    if 'rh' = any(v_areas) then
      select count(*), count(*) filter (
        where nullif(trim(employee.full_name), '') is not null
          and nullif(trim(employee.job_title), '') is not null
          and nullif(trim(employee.department), '') is not null
          and employee.base_salary is not null
      ), count(*) filter (where employee.active)
        into v_total, v_complete, v_count
      from public.hr_employees employee
      where employee.organization_id = p_organization_id;

      select coalesce(sum(run.net_total + run.charges_total + run.benefits_total), 0),
        count(*) filter (where run.cash_risk and run.status not in ('paga', 'cancelada'))
        into v_amount, v_count2
      from public.hr_payroll_runs run
      where run.organization_id = p_organization_id
        and run.payment_date >= timezone('America/Sao_Paulo', v_period_start)::date
        and run.payment_date <= timezone('America/Sao_Paulo', v_period_end)::date;

      select count(*) into v_count3
      from public.hr_events event
      where event.organization_id = p_organization_id
        and event.due_date < timezone('America/Sao_Paulo', v_period_end)::date
        and event.status not in ('pago', 'concluido', 'cancelado');

      v_coverage := case when v_total = 0 then 0
        else round(v_complete::numeric * 100 / v_total, 2) end;
      v_coverage_total := v_coverage_total + v_coverage;
      v_area_count := v_area_count + 1;
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'rh', 'data_coverage_pct', 'Cobertura de RH',
        v_coverage, 'percentual', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'rh', 'active_employees', 'Colaboradores ativos',
        v_count, 'numero', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'rh', 'period_payroll_cost', 'Custo de folha no período',
        v_amount, 'BRL', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'rh', 'cash_risk_payrolls', 'Folhas com risco de caixa',
        v_count2, 'numero', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'rh', 'overdue_hr_events', 'Eventos de RH vencidos',
        v_count3, 'numero', v_period_start, v_period_end);

      v_confidence := greatest(50, least(98, v_coverage));
      if v_count2 > 0 or v_count3 > 0 then
        perform private.record_executive_insight(v_run_id, p_organization_id,
          'rh', 'Obrigações de pessoas exigem tratamento financeiro',
          format('%s folha(s) com risco de caixa e %s evento(s) de RH vencido(s).',
            v_count2, v_count3),
          jsonb_build_object('cash_risk_payrolls', v_count2,
            'overdue_events', v_count3, 'period_cost', v_amount),
          jsonb_build_object('labor_and_cash_risk', v_count2 + v_count3),
          'Validar vencimentos legais, responsáveis, aprovações e cobertura financeira antes da data de pagamento.',
          case when v_count3 > 0 then 'high' else 'warning' end,
          'high', v_period_end + interval '1 day',
          v_confidence, 'rh');
      end if;
    end if;

    -- PÓS-VENDA E AGENDA ----------------------------------------------------
    if 'pos_venda_agenda' = any(v_areas) then
      select
        (select count(*) from public.post_sale_tickets ticket
          where ticket.organization_id = p_organization_id)
        + (select count(*) from public.post_sale_journeys journey
          where journey.organization_id = p_organization_id)
        + (select count(*) from public.user_activities activity
          where activity.organization_id = p_organization_id),
        (select count(*) from public.post_sale_tickets ticket
          where ticket.organization_id = p_organization_id
            and ticket.status is not null and ticket.priority is not null)
        + (select count(*) from public.post_sale_journeys journey
          where journey.organization_id = p_organization_id
            and journey.current_stage is not null and journey.risk_level is not null)
        + (select count(*) from public.user_activities activity
          where activity.organization_id = p_organization_id
            and activity.status is not null and activity.owner_user_id is not null)
        into v_total, v_complete;

      select count(*) into v_count
      from public.post_sale_tickets ticket
      where ticket.organization_id = p_organization_id
        and ticket.sla_due_at < v_period_end
        and ticket.status not in ('resolvido', 'fechado', 'cancelado');
      select count(*) into v_count2
      from public.post_sale_journeys journey
      where journey.organization_id = p_organization_id
        and journey.next_action_at < v_period_end
        and journey.current_stage not in ('quitado', 'pos_entrega', 'cancelado');
      select count(*) into v_count3
      from public.user_activities activity
      where activity.organization_id = p_organization_id
        and activity.due_at < v_period_end
        and activity.status not in ('concluida', 'cancelada', 'arquivada');

      v_coverage := case when v_total = 0 then 0
        else round(v_complete::numeric * 100 / v_total, 2) end;
      v_coverage_total := v_coverage_total + v_coverage;
      v_area_count := v_area_count + 1;
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'pos_venda_agenda', 'data_coverage_pct', 'Cobertura de pós-venda e agenda',
        v_coverage, 'percentual', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'pos_venda_agenda', 'overdue_ticket_sla', 'Chamados com SLA vencido',
        v_count, 'numero', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'pos_venda_agenda', 'overdue_journey_actions', 'Jornadas sem próxima ação',
        v_count2, 'numero', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'pos_venda_agenda', 'overdue_activities', 'Atividades vencidas',
        v_count3, 'numero', v_period_start, v_period_end);

      v_confidence := greatest(50, least(98, v_coverage));
      if v_count + v_count2 + v_count3 > 0 then
        perform private.record_executive_insight(v_run_id, p_organization_id,
          'pos_venda_agenda', 'Compromissos vencidos prejudicam a experiência e a execução',
          format('%s chamado(s), %s jornada(s) e %s atividade(s) exigem ação.',
            v_count, v_count2, v_count3),
          jsonb_build_object('tickets_sla_overdue', v_count,
            'journey_actions_overdue', v_count2,
            'activities_overdue', v_count3),
          jsonb_build_object('unhandled_commitments', v_count + v_count2 + v_count3),
          'Repriorizar por cliente, risco e impacto financeiro; atribuir responsável e usar acesso direto ao item de origem.',
          case when v_count > 0 then 'high' else 'warning' end,
          'high', v_period_end + interval '1 day',
          v_confidence, 'agenda');
      end if;
    end if;

    -- GOVERNANÇA ------------------------------------------------------------
    if 'governanca' = any(v_areas) then
      select
        (select count(*) from public.approval_requests approval
          where approval.organization_id = p_organization_id)
        + (select count(*) from public.role_permissions permission
          where permission.organization_id = p_organization_id),
        (select count(*) from public.approval_requests approval
          where approval.organization_id = p_organization_id
            and approval.status is not null)
        + (select count(*) from public.role_permissions permission
          where permission.organization_id = p_organization_id
            and permission.permission_key is not null)
        into v_total, v_complete;

      select count(*) into v_count
      from public.approval_requests approval
      where approval.organization_id = p_organization_id
        and approval.status not in ('aprovado', 'rejeitado', 'cancelado')
        and approval.created_at < v_period_end - interval '24 hours';
      select count(*) into v_count2
      from public.audit_logs audit
      where audit.organization_id = p_organization_id
        and audit.created_at >= v_period_start
        and audit.created_at <= v_period_end;
      select count(*) filter (where backup.status not in ('concluido', 'verified', 'verificado')),
        count(*)
        into v_count3, v_value
      from public.backup_runs backup
      where backup.organization_id = p_organization_id
        and backup.created_at >= v_period_end - interval '48 hours';

      v_coverage := case when v_total = 0 then 0
        else round(v_complete::numeric * 100 / v_total, 2) end;
      v_coverage_total := v_coverage_total + v_coverage;
      v_area_count := v_area_count + 1;
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'governanca', 'data_coverage_pct', 'Cobertura de governança',
        v_coverage, 'percentual', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'governanca', 'overdue_approvals', 'Aprovações acima de 24 horas',
        v_count, 'numero', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'governanca', 'audit_events', 'Eventos de auditoria no período',
        v_count2, 'numero', v_period_start, v_period_end);
      perform private.record_insight_metric(v_run_id, p_organization_id,
        'governanca', 'recent_backup_failures', 'Backups recentes não concluídos',
        v_count3, 'numero', v_period_start, v_period_end);

      v_confidence := greatest(50, least(98, v_coverage));
      if v_count > 0 then
        perform private.record_executive_insight(v_run_id, p_organization_id,
          'governanca', 'Decisões aguardam aprovação há mais de 24 horas',
          format('%s solicitação(ões) ultrapassaram a janela de decisão.', v_count),
          jsonb_build_object('overdue_approvals', v_count,
            'threshold_hours', 24),
          jsonb_build_object('governance_bottleneck', v_count),
          'Ordenar por risco e valor, notificar a alçada competente e registrar decisão ou justificativa de pendência.',
          'high', 'high', v_period_end + interval '8 hours',
          v_confidence, 'aprovacoes');
      end if;
      if v_count3 > 0 then
        perform private.record_executive_insight(v_run_id, p_organization_id,
          'governanca', 'Rotinas recentes de backup requerem verificação',
          format('%s execução(ões) recentes não estão concluídas ou verificadas.', v_count3),
          jsonb_build_object('recent_backup_failures', v_count3,
            'window_hours', 48),
          jsonb_build_object('continuity_risk_runs', v_count3),
          'Verificar a causa, repetir a rotina quando necessário e confirmar integridade e restauração do arquivo.',
          'high', 'high', v_period_end + interval '1 day',
          v_confidence, 'configuracoes');
      end if;
    end if;

    -- Em vez de inventar recomendações quando uma área não tem dados,
    -- registramos explicitamente a lacuna de cobertura.
    insert into public.insights (
      organization_id, run_id, area, title, summary, evidence, impact,
      recommendation, severity, priority, status, due_at, confidence_pct,
      related_view
    )
    select p_organization_id, v_run_id, metric.area,
      'Cobertura de dados insuficiente para análise conclusiva',
      format('A cobertura observada foi de %s%%; o relatório não estimou indicadores ausentes.',
        round(metric.numeric_value, 1)),
      jsonb_build_object('coverage_pct', metric.numeric_value,
        'minimum_expected_pct', v_min_coverage,
        'metric_key', metric.metric_key),
      jsonb_build_object('decision_quality', 'limitada_por_dados'),
      'Completar os cadastros e rotinas operacionais da área antes de usar estes indicadores para decisões definitivas.',
      case when metric.numeric_value = 0 then 'warning' else 'info' end,
      case when metric.numeric_value = 0 then 'high' else 'medium' end,
      'novo', v_period_end + interval '7 days', 100,
      case metric.area
        when 'financeiro' then 'financeiro'
        when 'vendas_crm_sdr' then 'crm'
        when 'obras' then 'obras'
        when 'contratos' then 'contratos_operacionais'
        when 'compras' then 'compras'
        when 'combustiveis' then 'compras'
        when 'rh' then 'rh'
        when 'pos_venda_agenda' then 'agenda'
        else 'configuracoes'
      end
    from public.insight_metrics metric
    where metric.run_id = v_run_id
      and metric.metric_key = 'data_coverage_pct'
      and metric.numeric_value < v_min_coverage;

    select count(*) filter (where severity = 'critical'),
      count(*) filter (where severity = 'high'),
      count(*) filter (where severity = 'warning')
      into v_critical, v_high, v_warning
    from public.insights
    where run_id = v_run_id;

    update public.insight_runs
    set status = 'completed',
      completed_at = now(),
      areas_analyzed = v_areas,
      data_coverage_pct = case when v_area_count = 0 then 0
        else round(v_coverage_total / v_area_count, 2) end,
      executive_summary = jsonb_build_object(
        'headline', case
          when v_critical > 0 then 'Há decisões críticas que exigem ação imediata.'
          when v_high > 0 then 'Há exposições relevantes para tratamento gerencial.'
          when v_warning > 0 then 'A operação requer atenção preventiva.'
          else 'Nenhuma exceção material foi detectada com os dados disponíveis.'
        end,
        'generated_at', now(),
        'period_start', v_period_start,
        'period_end', v_period_end,
        'areas', v_areas,
        'coverage_pct', case when v_area_count = 0 then 0
          else round(v_coverage_total / v_area_count, 2) end,
        'insights', jsonb_build_object(
          'critical', v_critical,
          'high', v_high,
          'warning', v_warning,
          'total', (select count(*) from public.insights where run_id = v_run_id)
        ),
        'method', 'Regras executivas determinísticas sobre dados observados; sem projeção de valores ausentes.'
      )
    where id = v_run_id;
  exception
    when others then
      update public.insight_runs
      set status = 'failed', completed_at = now(),
        error_message = left(sqlerrm, 2000),
        executive_summary = jsonb_build_object(
          'headline', 'A execução não foi concluída.',
          'generated_at', now(),
          'error_code', sqlstate
        )
      where id = v_run_id;
  end;

  return v_run_id;
end;
$$;

revoke all on function private.run_insights_cycle(
  uuid, text, text, timestamptz, uuid, timestamptz, timestamptz
) from public, anon, authenticated;

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

create or replace function public.run_insights_now(
  p_organization_id uuid,
  p_period_start timestamptz default null,
  p_period_end timestamptz default null
)
returns uuid
language sql
security definer
set search_path = pg_catalog, public, private
as $$
  select public.generate_management_insights(
    p_organization_id, p_period_start, p_period_end
  );
$$;

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

  if cardinality(p_run_times) not between 2 and 3
    or not p_run_times <@ array['06:30', '13:00', '19:00']::text[]
    or cardinality(p_run_times) <>
      (case when '06:30' = any(p_run_times) then 1 else 0 end)
      + (case when '13:00' = any(p_run_times) then 1 else 0 end)
      + (case when '19:00' = any(p_run_times) then 1 else 0 end) then
    raise exception 'Selecione dois ou três horários válidos e não repetidos.';
  end if;

  if cardinality(p_areas) not between 1 and 9
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
    p_organization_id, p_enabled, p_run_times, 'America/Sao_Paulo',
    case when p_enabled then
      private.next_insight_run(p_run_times, 'America/Sao_Paulo', now())
    else null end,
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

create or replace function public.set_insight_status(
  p_insight_id uuid,
  p_status text,
  p_note text default null,
  p_due_at timestamptz default null,
  p_responsible_user_id uuid default null
)
returns public.insights
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_previous text;
  v_result public.insights%rowtype;
begin
  select organization_id, status into v_org_id, v_previous
  from public.insights where id = p_insight_id for update;
  if not found then raise exception 'Insight não localizado.'; end if;

  if v_user_id is null
    or not public.is_org_member(v_org_id)
    or not (
      public.has_app_permission(v_org_id, 'insights.assign')
      or public.has_app_permission(v_org_id, 'insights.manage')
    ) then
    raise exception 'Sem permissão para tratar este insight.';
  end if;
  if p_status not in ('novo', 'reconhecido', 'em_tratamento', 'resolvido', 'descartado') then
    raise exception 'Status de insight inválido.';
  end if;
  if p_responsible_user_id is not null and not exists (
    select 1 from public.organization_members member
    where member.organization_id = v_org_id
      and member.user_id = p_responsible_user_id and member.active
  ) then
    raise exception 'Responsável não pertence à organização.';
  end if;

  update public.insights
  set status = p_status,
    due_at = coalesce(p_due_at, due_at),
    responsible_user_id = coalesce(p_responsible_user_id, responsible_user_id),
    acknowledged_at = case
      when p_status in ('reconhecido', 'em_tratamento', 'resolvido')
        then coalesce(acknowledged_at, now()) else acknowledged_at end,
    acknowledged_by = case
      when p_status in ('reconhecido', 'em_tratamento', 'resolvido')
        then coalesce(acknowledged_by, v_user_id) else acknowledged_by end,
    resolved_at = case when p_status = 'resolvido' then now() else null end,
    resolved_by = case when p_status = 'resolvido' then v_user_id else null end
  where id = p_insight_id
  returning * into v_result;

  if v_previous is distinct from p_status or nullif(trim(p_note), '') is not null then
    insert into public.insight_status_history (
      organization_id, insight_id, previous_status, new_status, note, changed_by
    ) values (
      v_org_id, p_insight_id, v_previous, p_status,
      nullif(trim(p_note), ''), v_user_id
    );
  end if;
  return v_result;
end;
$$;

revoke all on function public.generate_management_insights(
  uuid, timestamptz, timestamptz
) from public, anon;
revoke all on function public.run_insights_now(
  uuid, timestamptz, timestamptz
) from public, anon;
revoke all on function public.configure_insights(
  uuid, boolean, text[], text[]
) from public, anon;
revoke all on function public.set_insight_status(
  uuid, text, text, timestamptz, uuid
) from public, anon;
grant execute on function public.generate_management_insights(
  uuid, timestamptz, timestamptz
) to authenticated;
grant execute on function public.run_insights_now(
  uuid, timestamptz, timestamptz
) to authenticated;
grant execute on function public.configure_insights(
  uuid, boolean, text[], text[]
) to authenticated;
grant execute on function public.set_insight_status(
  uuid, text, text, timestamptz, uuid
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
  v_count integer := 0;
begin
  if p_local_slot not in ('06:30', '13:00', '19:00') then
    raise exception 'Horário de execução inválido.';
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

create or replace function private.protect_insight_run_history()
returns trigger
language plpgsql
set search_path = pg_catalog, public, private
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'O histórico de execuções de insights é imutável.';
  end if;
  if old.status <> 'started' then
    raise exception 'Uma execução concluída não pode ser alterada.';
  end if;
  if (to_jsonb(new) - array[
      'status', 'completed_at', 'areas_analyzed', 'data_coverage_pct',
      'executive_summary', 'error_message'
    ]::text[])
    is distinct from
    (to_jsonb(old) - array[
      'status', 'completed_at', 'areas_analyzed', 'data_coverage_pct',
      'executive_summary', 'error_message'
    ]::text[]) then
    raise exception 'Os dados de origem da execução são imutáveis.';
  end if;
  if new.status not in ('completed', 'failed') or new.completed_at is null then
    raise exception 'Transição final de execução inválida.';
  end if;
  return new;
end;
$$;

create or replace function private.protect_insight_metric_history()
returns trigger
language plpgsql
set search_path = pg_catalog, public, private
as $$
begin
  raise exception 'O histórico de métricas de insights é imutável.';
end;
$$;

create or replace function private.protect_insight_content()
returns trigger
language plpgsql
set search_path = pg_catalog, public, private
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'O histórico de insights é imutável.';
  end if;
  if (to_jsonb(new) - array[
      'status', 'due_at', 'responsible_user_id', 'acknowledged_at',
      'acknowledged_by', 'resolved_at', 'resolved_by'
    ]::text[])
    is distinct from
    (to_jsonb(old) - array[
      'status', 'due_at', 'responsible_user_id', 'acknowledged_at',
      'acknowledged_by', 'resolved_at', 'resolved_by'
    ]::text[]) then
    raise exception 'O conteúdo analítico do insight é imutável.';
  end if;
  return new;
end;
$$;

create or replace function private.protect_insight_status_history()
returns trigger
language plpgsql
set search_path = pg_catalog, public, private
as $$
begin
  raise exception 'A trilha de tratamento de insights é append-only.';
end;
$$;

create trigger protect_insight_runs_history
before update or delete on public.insight_runs
for each row execute function private.protect_insight_run_history();
create trigger protect_insight_metrics_history
before update or delete on public.insight_metrics
for each row execute function private.protect_insight_metric_history();
create trigger protect_insights_content
before update or delete on public.insights
for each row execute function private.protect_insight_content();
create trigger protect_insight_status_history
before update or delete on public.insight_status_history
for each row execute function private.protect_insight_status_history();

revoke all on function private.protect_insight_run_history()
  from public, anon, authenticated;
revoke all on function private.protect_insight_metric_history()
  from public, anon, authenticated;
revoke all on function private.protect_insight_content()
  from public, anon, authenticated;
revoke all on function private.protect_insight_status_history()
  from public, anon, authenticated;

alter table public.insight_settings enable row level security;
alter table public.insight_runs enable row level security;
alter table public.insight_metrics enable row level security;
alter table public.insights enable row level security;
alter table public.insight_status_history enable row level security;

create policy insight_settings_select on public.insight_settings
for select to authenticated
using (
  public.is_org_member(organization_id)
  and public.has_app_permission(organization_id, 'insights.view')
);
create policy insight_runs_select on public.insight_runs
for select to authenticated
using (
  public.is_org_member(organization_id)
  and public.has_app_permission(organization_id, 'insights.view')
);
create policy insight_metrics_select on public.insight_metrics
for select to authenticated
using (
  public.is_org_member(organization_id)
  and public.has_app_permission(organization_id, 'insights.view')
);
create policy insights_select on public.insights
for select to authenticated
using (
  public.is_org_member(organization_id)
  and public.has_app_permission(organization_id, 'insights.view')
);
create policy insight_status_history_select on public.insight_status_history
for select to authenticated
using (
  public.is_org_member(organization_id)
  and public.has_app_permission(organization_id, 'insights.view')
);

revoke all on table public.insight_settings from public, anon, authenticated;
revoke all on table public.insight_runs from public, anon, authenticated;
revoke all on table public.insight_metrics from public, anon, authenticated;
revoke all on table public.insights from public, anon, authenticated;
revoke all on table public.insight_status_history from public, anon, authenticated;
grant select on table public.insight_settings to authenticated;
grant select on table public.insight_runs to authenticated;
grant select on table public.insight_metrics to authenticated;
grant select on table public.insights to authenticated;
grant select on table public.insight_status_history to authenticated;

create view public.insight_bi_latest
with (security_invoker = true)
as
select distinct on (metric.organization_id, metric.area, metric.metric_key)
  metric.id, metric.organization_id, metric.run_id, metric.area,
  metric.metric_key, metric.label, metric.numeric_value, metric.unit,
  metric.comparison_value, metric.variation_pct, metric.period_start,
  metric.period_end, metric.trend_points, metric.created_at
from public.insight_metrics metric
join public.insight_runs run on run.id = metric.run_id
where run.status = 'completed'
order by metric.organization_id, metric.area, metric.metric_key,
  metric.created_at desc;

-- Alias de leitura para clientes que adotaram o prefixo management durante a
-- evolução da interface. As tabelas canônicas permanecem insight_*.
create view public.management_insight_settings
with (security_invoker = true) as select * from public.insight_settings;
create view public.management_insight_runs
with (security_invoker = true) as select * from public.insight_runs;
create view public.management_insight_metrics
with (security_invoker = true) as select * from public.insight_metrics;
create view public.management_insights
with (security_invoker = true) as select * from public.insights;

revoke all on table public.insight_bi_latest from public, anon, authenticated;
revoke all on table public.management_insight_settings from public, anon, authenticated;
revoke all on table public.management_insight_runs from public, anon, authenticated;
revoke all on table public.management_insight_metrics from public, anon, authenticated;
revoke all on table public.management_insights from public, anon, authenticated;
grant select on table public.insight_bi_latest to authenticated;
grant select on table public.management_insight_settings to authenticated;
grant select on table public.management_insight_runs to authenticated;
grant select on table public.management_insight_metrics to authenticated;
grant select on table public.management_insights to authenticated;

insert into public.role_permissions (
  organization_id, role, permission_key, allowed, updated_by, updated_at
)
select organization.id, role_name.role, permission.permission_key,
  true, null, now()
from public.organizations organization
cross join (values ('admin'), ('diretoria')) as role_name(role)
cross join (values
  ('insights.view'),
  ('insights.run'),
  ('insights.manage'),
  ('insights.assign')
) as permission(permission_key)
where organization.active
on conflict (organization_id, role, permission_key) do nothing;

insert into public.insight_settings (
  organization_id, enabled, run_times, timezone, next_run_at, areas
)
select organization.id, true,
  array['06:30', '13:00', '19:00']::text[],
  'America/Sao_Paulo',
  private.next_insight_run(
    array['06:30', '13:00', '19:00']::text[],
    'America/Sao_Paulo', now()
  ),
  array[
    'financeiro', 'vendas_crm_sdr', 'obras', 'contratos',
    'compras', 'combustiveis', 'rh', 'pos_venda_agenda',
    'governanca'
  ]::text[]
from public.organizations organization
where organization.active
on conflict (organization_id) do nothing;

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

select cron.schedule(
  'evora-insights-0630-sp',
  '30 9 * * *',
  $cron$select private.run_scheduled_insights('06:30');$cron$
);
select cron.schedule(
  'evora-insights-1300-sp',
  '0 16 * * *',
  $cron$select private.run_scheduled_insights('13:00');$cron$
);
select cron.schedule(
  'evora-insights-1900-sp',
  '0 22 * * *',
  $cron$select private.run_scheduled_insights('19:00');$cron$
);

-- Primeira fotografia executiva: cada organização ativa inicia com dados reais
-- ou com uma indicação explícita de falta de cobertura, nunca com estimativas.
do $$
declare
  v_org record;
  v_as_of timestamptz := now();
begin
  for v_org in
    select id from public.organizations where active order by id
  loop
    perform private.run_insights_cycle(
      v_org.id,
      'implantacao:executive-rules-v1',
      'implantacao',
      v_as_of,
      null,
      v_as_of - interval '30 days',
      v_as_of
    );
  end loop;
end;
$$;
