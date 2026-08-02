-- Classificação auditável de criticidade das contas a pagar vencidas.
--
-- Política v1 (100 pontos):
--   obrigação legal/fiscal/trabalhista 25; continuidade 25; vencimento 20;
--   impacto no caixa 15; participação na exposição 10; fornecedor crítico 5.
--
-- A criticidade da obrigação não é uma autorização de pagamento. Títulos com
-- bloqueio documental nunca recebem recomendação de pagar. O snapshot separa
-- a fila de tratamento da ordem de pagamento e permanece gravado no evidence
-- do insight, sem criar nova superfície pública na Data API.

create or replace function private.payable_criticality_snapshot(
  p_organization_id uuid,
  p_as_of timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  with parameters as (
    select
      timezone('America/Sao_Paulo', coalesce(p_as_of, now()))::date as as_of_date,
      coalesce((
        select setting.minimum_cash_buffer
        from public.system_settings setting
        where setting.organization_id = p_organization_id
        limit 1
      ), 0)::numeric as minimum_cash_buffer
  ), trusted_source as (
    select
      entry.id as entry_id,
      entry.description,
      coalesce(contact.trade_name, contact.name, 'Contraparte não informada') as counterparty,
      entry.due_date,
      entry.scheduled_payment_date,
      greatest(coalesce(entry.open_amount, entry.amount, 0), 0)::numeric as open_amount,
      coalesce(entry.cash_risk, false) as cash_risk,
      coalesce(entry.cash_risk_level, '') as cash_risk_level,
      entry.projected_balance,
      entry.risk_reason,
      coalesce(entry.payment_blocked, false)
        or entry.payment_release_status = 'bloqueado_documentos' as payment_blocked,
      coalesce(
        nullif(entry.payment_block_reason, ''),
        case when entry.payment_release_status = 'bloqueado_documentos'
          then 'Pendência documental registrada.' end
      ) as payment_block_reason,
      category.id is not null as has_category,
      contact.id is not null as has_contact,
      cost_center.id is not null or project.id is not null as has_operational_context,
      nullif(btrim(coalesce(entry.notes, '')), '') is not null
        or nullif(btrim(coalesce(entry.risk_reason, '')), '') is not null as has_risk_context,
      parameters.as_of_date,
      parameters.minimum_cash_buffer,
      btrim(regexp_replace(translate(lower(concat_ws(' ',
        entry.description,
        entry.category,
        entry.notes,
        entry.risk_reason,
        entry.payment_block_reason,
        category.code,
        category.name,
        cost_center.code,
        cost_center.name,
        project.code,
        project.name,
        contact.contact_type,
        contact.notes
      )),
        'áàâãäéèêëíìîïóòôõöúùûüçñ',
        'aaaaaeeeeiiiiooooouuuucn'
      ), '[^a-z0-9]+', ' ', 'g')) as context_text
    from public.financial_entries entry
    cross join parameters
    left join public.financial_categories category
      on category.id = entry.category_id
     and category.organization_id = entry.organization_id
    left join public.contacts contact
      on contact.id = entry.contact_id
     and contact.organization_id = entry.organization_id
    left join public.cost_centers cost_center
      on cost_center.id = entry.cost_center_id
     and cost_center.organization_id = entry.organization_id
    left join public.projects project
      on project.id = entry.project_id
     and project.organization_id = entry.organization_id
    where entry.organization_id = p_organization_id
      and entry.type = 'saida'
      and entry.due_date < parameters.as_of_date
      and entry.status in ('pendente', 'vencido', 'rascunho')
      and coalesce(entry.is_provision, false) = false
      and entry.approval_status = 'aprovado'
      and greatest(coalesce(entry.open_amount, entry.amount, 0), 0) > 0
  ), portfolio as (
    select
      count(*)::integer as total_titles,
      coalesce(sum(source.open_amount), 0)::numeric as total_exposure
    from trusted_source source
  ), detected as (
    select
      source.*,
      greatest(0, source.as_of_date - source.due_date)::integer as days_overdue,
      case when portfolio.total_exposure > 0
        then round(source.open_amount * 100 / portfolio.total_exposure, 2)
        else 0 end as exposure_share_pct,
      source.context_text ~ '(^| )(salario|folha de pagamento|ferias|decimo terceiro|rescisao|verba rescisoria|fgts|inss|beneficio trabalhista|vale transporte|vale alimentacao|pensao alimenticia|obrigacao trabalhista)( |$)' as labor_risk,
      source.context_text ~ '(^| )(imposto|tributo|obrigacao fiscal|guia fiscal|darf|das|iss|icms|irpj|csll|cofins|pis|taxa municipal|taxa estadual|receita federal|fazenda estadual|prefeitura)( |$)' as fiscal_risk,
      source.context_text ~ '(^| )(processo judicial|acao judicial|acordo judicial|decisao judicial|custas processuais|deposito judicial|honorarios juridicos|protesto|cartorio|multa|licenca|alvara|outorga|compensacao ambiental|obrigacao legal|regularizacao fundiaria|registro de imoveis)( |$)' as legal_risk,
      source.context_text ~ '(^| )(obra|infraestrutura|drenagem|pavimentacao|terraplanagem|rede de agua|rede de esgoto|energia|seguranca|portaria|combustivel|maquina|equipamento|locacao de equipamento|material de obra|concreto|manilha|empreiteira|medicao|mobilizacao|risco de paralisacao|continuidade operacional)( |$)' as continuity_risk,
      source.context_text ~ '(^| )(fornecedor critico|fornecedor essencial|fornecedor exclusivo|parceiro estrategico|insumo critico|servico essencial|nao interromper|risco de paralisacao|sem substituto)( |$)' as critical_supplier,
      source.scheduled_payment_date is not null
        and source.scheduled_payment_date < source.as_of_date as missed_schedule
    from trusted_source source
    cross join portfolio
  ), factored as (
    select
      detected.*,
      case when labor_risk or fiscal_risk or legal_risk then 25 else 0 end as legal_score,
      case when continuity_risk then 25 else 0 end as continuity_score,
      case
        when days_overdue >= 60 then 20
        when days_overdue >= 30 then 16
        when days_overdue >= 15 then 12
        when days_overdue >= 5 then 8
        else 4
      end as overdue_score,
      greatest(
        case
          when detected.projected_balance < 0 then 15
          when detected.projected_balance < detected.minimum_cash_buffer then 10
          else 0
        end,
        case
          when not detected.cash_risk then 0
          when detected.cash_risk_level = 'critico' then 15
          when detected.cash_risk_level = 'alto' then 12
          when detected.cash_risk_level = 'medio' then 8
          when detected.cash_risk_level = 'baixo' then 4
          when detected.cash_risk then 10
          else 0
        end
      ) as cash_score,
      case
        when exposure_share_pct >= 25 then 10
        when exposure_share_pct >= 10 then 8
        when exposure_share_pct >= 5 then 6
        when exposure_share_pct >= 1 then 4
        else 2
      end as exposure_score,
      case when critical_supplier then 5 else 0 end as supplier_score,
      least(100, 40
        + case when has_category then 15 else 0 end
        + case when has_contact then 15 else 0 end
        + case when has_operational_context then 10 else 0 end
        + case when has_risk_context then 10 else 0 end
        + case when cash_risk or projected_balance is not null then 10 else 0 end
      )::integer as confidence_pct
    from detected
  ), scored as (
    select
      factored.*,
      (legal_score + continuity_score + overdue_score + cash_score
        + exposure_score + supplier_score)::integer as score,
      case
        when payment_blocked then 'blocked'
        when not has_category or not has_contact then 'needs_validation'
        else 'ready'
      end as readiness,
      case
        when payment_blocked then 'blocked'
        when cash_score > 0 then 'cash_approval_required'
        when not has_category or not has_contact then 'validation_required'
        else 'eligible'
      end as payment_gate_status
    from factored
  ), banded as (
    select
      scored.*,
      case
        when score >= 70 then 'critical'
        when score >= 50 then 'high'
        when score >= 30 then 'medium'
        else 'low'
      end as band,
      case
        when score >= 70 then 'urgent'
        when score >= 50 then 'high'
        when score >= 30 then 'medium'
        else 'low'
      end as priority,
      case
        when payment_blocked then 'unblock'
        when cash_score > 0 then 'negotiate_or_reprogram'
        when not has_category or not has_contact then 'validate_before_scheduling'
        when legal_score > 0 then 'prioritize_payment'
        when continuity_score > 0 or supplier_score > 0 then 'protect_continuity'
        else 'schedule'
      end as action_code
    from scored
  ), ranked as (
    select
      banded.*,
      row_number() over (
        order by score desc, legal_score desc, continuity_score desc,
          days_overdue desc, open_amount desc, entry_id
      )::integer as treatment_rank,
      case when payment_gate_status = 'eligible' then row_number() over (
        partition by payment_gate_status
        order by legal_score desc, continuity_score desc, score desc,
          days_overdue desc, open_amount desc, entry_id
      )::integer end as recommended_payment_order
    from banded
  ), queue as (
    select
      ranked.*,
      jsonb_build_object(
        'entry_id', ranked.entry_id,
        'treatment_rank', ranked.treatment_rank,
        'recommended_payment_order', ranked.recommended_payment_order,
        'description', ranked.description,
        'counterparty', ranked.counterparty,
        'due_date', ranked.due_date,
        'scheduled_payment_date', ranked.scheduled_payment_date,
        'days_overdue', ranked.days_overdue,
        'amount', round(ranked.open_amount, 2),
        'exposure_share_pct', ranked.exposure_share_pct,
        'score', ranked.score,
        'band', ranked.band,
        'priority', ranked.priority,
        'readiness', ranked.readiness,
        'confidence_pct', ranked.confidence_pct,
        'classification', to_jsonb(array_remove(array[
          case when ranked.labor_risk then 'labor' end,
          case when ranked.fiscal_risk then 'fiscal' end,
          case when ranked.legal_risk then 'legal_regulatory' end,
          case when ranked.continuity_risk then 'operational_continuity' end,
          case when ranked.critical_supplier then 'critical_supplier' end,
          case when not (ranked.labor_risk or ranked.fiscal_risk or ranked.legal_risk
            or ranked.continuity_risk or ranked.critical_supplier) then 'general_payable' end
        ]::text[], null)),
        'factors', jsonb_build_object(
          'legal_fiscal_labor', jsonb_build_object(
            'score', ranked.legal_score, 'max_score', 25,
            'triggered', ranked.legal_score > 0,
            'reason', case when ranked.legal_score > 0
              then 'Natureza legal, fiscal ou trabalhista identificada nos dados cadastrados.'
              else 'Nenhum marcador legal, fiscal ou trabalhista foi identificado.' end
          ),
          'operational_continuity', jsonb_build_object(
            'score', ranked.continuity_score, 'max_score', 25,
            'triggered', ranked.continuity_score > 0,
            'reason', case when ranked.continuity_score > 0
              then 'O título está relacionado à continuidade de obra ou operação.'
              else 'Nenhum risco de continuidade foi identificado.' end
          ),
          'overdue_age', jsonb_build_object(
            'score', ranked.overdue_score, 'max_score', 20,
            'days', ranked.days_overdue,
            'reason', format('%s dia(s) transcorridos desde o vencimento.', ranked.days_overdue)
          ),
          'cash_impact', jsonb_build_object(
            'score', ranked.cash_score, 'max_score', 15,
            'triggered', ranked.cash_score > 0,
            'projected_balance', ranked.projected_balance,
            'reason', coalesce(ranked.risk_reason,
              case when ranked.cash_score > 0 then 'Há risco de caixa registrado ou saldo abaixo da reserva mínima.'
              else 'Não há sinal de insuficiência de caixa neste título.' end)
          ),
          'financial_exposure', jsonb_build_object(
            'score', ranked.exposure_score, 'max_score', 10,
            'share_pct', ranked.exposure_share_pct,
            'reason', 'Participação do título na exposição vencida confiável.'
          ),
          'critical_supplier', jsonb_build_object(
            'score', ranked.supplier_score, 'max_score', 5,
            'triggered', ranked.critical_supplier,
            'reason', case when ranked.critical_supplier
              then 'Há indicação explícita de fornecedor, insumo ou serviço essencial.'
              else 'Nenhuma marcação explícita de fornecedor crítico foi localizada.' end
          )
        ),
        'action', jsonb_build_object(
          'code', ranked.action_code,
          'label', case ranked.action_code
            when 'unblock' then 'Desbloquear e validar antes de pagar'
            when 'negotiate_or_reprogram' then 'Deliberar caixa, negociar ou reprogramar'
            when 'validate_before_scheduling' then 'Completar e validar o cadastro'
            when 'prioritize_payment' then 'Priorizar regularização da obrigação'
            when 'protect_continuity' then 'Preservar a continuidade da operação'
            else 'Programar na sequência financeira' end,
          'recommendation', case ranked.action_code
            when 'unblock' then 'Sanar documentos e alçada; o bloqueio impede qualquer recomendação de pagamento.'
            when 'negotiate_or_reprogram' then 'Validar o impacto, reservar o caixa possível e formalizar nova data ou pagamento parcial antes da aprovação.'
            when 'validate_before_scheduling' then 'Confirmar contraparte e classificação financeira antes de incluir o título em uma ordem de pagamento.'
            when 'prioritize_payment' then 'Conferir encargos e obrigação, aprovar e programar no primeiro ciclo financeiro disponível.'
            when 'protect_continuity' then 'Confirmar a dependência operacional e negociar condições que evitem paralisação.'
            else 'Validar a documentação e incluir o título na sequência aprovada de pagamentos.' end
        ),
        'payment_gate', jsonb_build_object(
          'status', ranked.payment_gate_status,
          'can_recommend_payment', ranked.payment_gate_status = 'eligible',
          'reason', case ranked.payment_gate_status
            when 'blocked' then coalesce(ranked.payment_block_reason,
              'Pagamento bloqueado por pendência documental ou operacional.')
            when 'cash_approval_required' then 'Exige deliberação de caixa; criticidade não equivale a autorização de pagamento.'
            when 'validation_required' then 'Cadastro incompleto; validar contraparte e classificação antes de recomendar pagamento.'
            else 'Elegível para compor uma ordem de pagamento, sujeita à aprovação da equipe.' end
        ),
        'postponement_impact', jsonb_build_object(
          'level', ranked.band,
          'missed_schedule', ranked.missed_schedule,
          'description', case
            when ranked.legal_score > 0 then 'O adiamento pode ampliar encargos, sanções ou exposição legal, fiscal ou trabalhista.'
            when ranked.continuity_score > 0 or ranked.supplier_score > 0 then 'O adiamento pode interromper obra, equipamento, insumo ou serviço essencial.'
            when ranked.days_overdue >= 60 then 'O atraso prolongado agrava custo de negociação e relacionamento com a contraparte.'
            else 'O adiamento aumenta a idade da obrigação e deve ser formalmente negociado.' end
        )
      ) as item
    from ranked
  ), totals as (
    select
      count(*)::integer as total_titles,
      coalesce(sum(open_amount), 0)::numeric as total_exposure,
      count(*) filter (where band = 'critical')::integer as critical_count,
      coalesce(sum(open_amount) filter (where band = 'critical'), 0)::numeric as critical_amount,
      count(*) filter (where band = 'high')::integer as high_count,
      coalesce(sum(open_amount) filter (where band = 'high'), 0)::numeric as high_amount,
      count(*) filter (where band = 'medium')::integer as medium_count,
      coalesce(sum(open_amount) filter (where band = 'medium'), 0)::numeric as medium_amount,
      count(*) filter (where band = 'low')::integer as low_count,
      coalesce(sum(open_amount) filter (where band = 'low'), 0)::numeric as low_amount,
      count(*) filter (where cash_score > 0)::integer as cash_risk_titles,
      count(*) filter (where payment_gate_status = 'blocked')::integer as blocked_titles,
      count(*) filter (where readiness = 'ready')::integer as ready_titles,
      coalesce(round(sum(confidence_pct * open_amount)
        / nullif(sum(open_amount), 0), 2), 0)::numeric as confidence_pct
    from queue
  )
  select jsonb_build_object(
    'policy_version', 'payable-criticality-v1',
    'generated_at', coalesce(p_as_of, now()),
    'as_of', parameters.as_of_date,
    'scope', jsonb_build_object(
      'type', 'saida',
      'due_before', parameters.as_of_date,
      'statuses', jsonb_build_array('pendente', 'vencido', 'rascunho'),
      'approval_status', 'aprovado',
      'exclude_provisions', true,
      'positive_open_amount_only', true
    ),
    'portfolio', jsonb_build_object(
      'total_titles', totals.total_titles,
      'total_exposure', round(totals.total_exposure, 2),
      'cash_risk_titles', totals.cash_risk_titles,
      'blocked_titles', totals.blocked_titles,
      'ready_titles', totals.ready_titles,
      'confidence_pct', totals.confidence_pct,
      'bands', jsonb_build_object(
        'critical', jsonb_build_object('count', totals.critical_count, 'amount', round(totals.critical_amount, 2)),
        'high', jsonb_build_object('count', totals.high_count, 'amount', round(totals.high_amount, 2)),
        'medium', jsonb_build_object('count', totals.medium_count, 'amount', round(totals.medium_amount, 2)),
        'low', jsonb_build_object('count', totals.low_count, 'amount', round(totals.low_amount, 2))
      )
    ),
    'queue', coalesce((
      select jsonb_agg(queue.item order by queue.treatment_rank)
      from queue
    ), '[]'::jsonb),
    'top_queue_entry_ids', coalesce((
      select jsonb_agg(queue.entry_id order by queue.treatment_rank)
      from queue
      where queue.treatment_rank <= 12
    ), '[]'::jsonb),
    'methodology', jsonb_build_object(
      'maximum_score', 100,
      'weights', jsonb_build_object(
        'legal_fiscal_labor', 25,
        'operational_continuity', 25,
        'overdue_age', 20,
        'cash_impact', 15,
        'financial_exposure', 10,
        'critical_supplier', 5
      ),
      'bands', jsonb_build_object(
        'critical', '70-100', 'high', '50-69',
        'medium', '30-49', 'low', '0-29'
      ),
      'separation_rule', 'Criticidade orienta tratamento; payment_gate e recommended_payment_order orientam eventual pagamento.'
    )
  )
  from parameters
  cross join totals;
$$;

revoke all on function private.payable_criticality_snapshot(uuid, timestamptz)
  from public, anon, authenticated;

-- Corrige a métrica financeira sem reescrever toda a orquestração multiárea.
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
  v_numeric_value numeric := coalesce(p_numeric_value, 0);
  v_snapshot jsonb;
begin
  if p_area = 'financeiro' and p_metric_key = 'overdue_payables' then
    v_snapshot := private.payable_criticality_snapshot(
      p_organization_id, coalesce(p_period_end, now())
    );
    v_numeric_value := coalesce(
      (v_snapshot #>> '{portfolio,total_exposure}')::numeric, 0
    );
  end if;

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
      jsonb_build_object('at', prior.created_at, 'value', prior.numeric_value) as point
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
      jsonb_build_object('at', p_period_end, 'value', v_numeric_value)
  ) points;

  insert into public.insight_metrics (
    id, organization_id, run_id, area, metric_key, label,
    numeric_value, unit, comparison_value, variation_pct,
    period_start, period_end, trend_points
  ) values (
    v_id, p_organization_id, p_run_id, p_area, p_metric_key, p_label,
    v_numeric_value, p_unit, v_previous,
    case
      when v_previous is null or v_previous = 0 then null
      else round(((v_numeric_value - v_previous) / abs(v_previous)) * 100, 2)
    end,
    p_period_start, p_period_end, v_trend
  );

  return v_id;
end;
$$;

revoke all on function private.record_insight_metric(
  uuid, uuid, text, text, text, numeric, text, timestamptz, timestamptz
) from public, anon, authenticated;

-- Enriquece apenas o insight de pagamentos vencidos. As demais áreas mantêm
-- exatamente o contrato anterior do helper.
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
  v_summary text := p_summary;
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
  v_impact jsonb := coalesce(p_impact, '{}'::jsonb);
  v_recommendation text := p_recommendation;
  v_severity text := p_severity;
  v_priority text := p_priority;
  v_confidence numeric := p_confidence_pct;
  v_snapshot jsonb;
  v_as_of timestamptz;
  v_total numeric;
  v_titles integer;
  v_critical integer;
  v_high integer;
begin
  if p_area = 'financeiro'
    and p_title = 'Pagamentos vencidos exigem plano de regularização' then
    v_as_of := case
      when coalesce(p_evidence ->> 'as_of', '')
        ~ '^\d{4}-\d{2}-\d{2}(T| |$)'
        then (p_evidence ->> 'as_of')::timestamptz
      else coalesce(p_due_at, now())
    end;
    v_snapshot := private.payable_criticality_snapshot(p_organization_id, v_as_of);
    v_total := coalesce((v_snapshot #>> '{portfolio,total_exposure}')::numeric, 0);
    v_titles := coalesce((v_snapshot #>> '{portfolio,total_titles}')::integer, 0);
    v_critical := coalesce((v_snapshot #>> '{portfolio,bands,critical,count}')::integer, 0);
    v_high := coalesce((v_snapshot #>> '{portfolio,bands,high,count}')::integer, 0);

    -- Não grava falso positivo quando o conjunto confiável está vazio.
    if v_titles = 0 then return null; end if;

    v_summary := format(
      'Há %s em %s obrigação(ões) vencida(s), aprovada(s) e não liquidada(s).',
      to_char(v_total, 'FM999G999G999G990D00'), v_titles
    );
    v_evidence := (v_evidence - 'overdue_amount' - 'cash_risk_entries')
      || jsonb_build_object(
        'overdue_amount', v_total,
        'cash_risk_entries', coalesce(
          (v_snapshot #>> '{portfolio,cash_risk_titles}')::integer, 0
        ),
        'payment_criticality', v_snapshot
      );
    v_impact := (v_impact - 'financial_exposure')
      || jsonb_build_object(
        'financial_exposure', v_total,
        'critical_titles', v_critical,
        'high_titles', v_high,
        'decision', 'validar_fila_de_tratamento_e_ordem_de_pagamento'
      );
    v_recommendation :=
      'Validar a matriz por título, tratar bloqueios antes de qualquer desembolso e aprovar separadamente a ordem de pagamentos elegíveis e as negociações exigidas pelo caixa.';
    v_severity := case when v_critical > 0 then 'critical'
      when v_high > 0 then 'high' else 'warning' end;
    v_priority := case when v_critical > 0 then 'urgent'
      when v_high > 0 then 'high' else 'medium' end;
    v_confidence := coalesce(
      (v_snapshot #>> '{portfolio,confidence_pct}')::numeric,
      p_confidence_pct
    );
  end if;

  insert into public.insights (
    id, organization_id, run_id, area, title, summary, evidence,
    impact, recommendation, severity, priority, status, due_at,
    confidence_pct, responsible_user_id, related_view,
    related_entity_type, related_entity_id
  ) values (
    v_id, p_organization_id, p_run_id, p_area, p_title, v_summary,
    v_evidence, v_impact, v_recommendation, v_severity, v_priority,
    'novo', p_due_at, greatest(0, least(100, coalesce(v_confidence, 0))),
    p_responsible_user_id, p_related_view, p_related_entity_type,
    p_related_entity_id
  );
  return v_id;
end;
$$;

revoke all on function private.record_executive_insight(
  uuid, uuid, text, text, text, jsonb, jsonb, text, text, text,
  timestamptz, numeric, text, text, uuid, uuid
) from public, anon, authenticated;

-- Backfill append-only. O conteúdo analítico legado não é reescrito: um novo
-- insight corrigido é criado no mesmo run_id e registra de qual insight ele
-- deriva. A política e o vínculo tornam a operação idempotente.
with ranked_legacy as materialized (
  select
    legacy.*,
    row_number() over (
      partition by legacy.organization_id
      order by legacy.created_at desc, legacy.id desc
    ) as candidate_rank
  from public.insights legacy
  where legacy.area = 'financeiro'
    and legacy.title = 'Pagamentos vencidos exigem plano de regularização'
    and legacy.status in ('novo', 'reconhecido', 'em_tratamento')
    and coalesce(legacy.evidence #>> '{payment_criticality,policy_version}', '')
      <> 'payable-criticality-v1'
), candidates as materialized (
  select
    legacy.*,
    private.payable_criticality_snapshot(
      legacy.organization_id,
      case
        when coalesce(legacy.evidence ->> 'as_of', '')
          ~ '^\d{4}-\d{2}-\d{2}(T| |$)'
          then (legacy.evidence ->> 'as_of')::timestamptz
        else legacy.created_at
      end
    ) as snapshot
  from ranked_legacy legacy
  where legacy.candidate_rank = 1
), prepared as (
  select
    candidate.*,
    coalesce((candidate.snapshot #>> '{portfolio,total_exposure}')::numeric, 0) as total_exposure,
    coalesce((candidate.snapshot #>> '{portfolio,total_titles}')::integer, 0) as total_titles,
    coalesce((candidate.snapshot #>> '{portfolio,bands,critical,count}')::integer, 0) as critical_count,
    coalesce((candidate.snapshot #>> '{portfolio,bands,high,count}')::integer, 0) as high_count,
    coalesce((candidate.snapshot #>> '{portfolio,confidence_pct}')::numeric, 0) as snapshot_confidence
  from candidates candidate
)
insert into public.insights (
  id, organization_id, run_id, area, title, summary, evidence, impact,
  recommendation, severity, priority, status, due_at, confidence_pct,
  responsible_user_id, related_view, related_entity_type, related_entity_id,
  acknowledged_at, acknowledged_by, created_at
)
select
  gen_random_uuid(),
  prepared.organization_id,
  prepared.run_id,
  prepared.area,
  prepared.title,
  case when prepared.total_titles > 0 then format(
    'Há %s em %s obrigação(ões) vencida(s), aprovada(s) e não liquidada(s).',
    to_char(prepared.total_exposure, 'FM999G999G999G990D00'),
    prepared.total_titles
  ) else 'A reavaliação não encontrou obrigações vencidas aprovadas no conjunto confiável.' end,
  (coalesce(prepared.evidence, '{}'::jsonb)
      - 'overdue_amount' - 'cash_risk_entries' - 'payment_criticality')
    || jsonb_build_object(
      'overdue_amount', prepared.total_exposure,
      'cash_risk_entries', coalesce(
        (prepared.snapshot #>> '{portfolio,cash_risk_titles}')::integer, 0
      ),
      'supersedes_insight_id', prepared.id,
      'backfill_mode', 'append_only',
      'payment_criticality', prepared.snapshot
    ),
  (coalesce(prepared.impact, '{}'::jsonb) - 'financial_exposure')
    || jsonb_build_object(
      'financial_exposure', prepared.total_exposure,
      'critical_titles', prepared.critical_count,
      'high_titles', prepared.high_count,
      'decision', 'validar_fila_de_tratamento_e_ordem_de_pagamento'
    ),
  case when prepared.total_titles > 0 then
    'Validar a matriz por título, tratar bloqueios antes de qualquer desembolso e aprovar separadamente a ordem de pagamentos elegíveis e as negociações exigidas pelo caixa.'
  else
    'Revisar o cadastro que originou o alerta; rascunhos, provisões e títulos sem aprovação não integram a fila de pagamentos vencidos.'
  end,
  case when prepared.critical_count > 0 then 'critical'
    when prepared.high_count > 0 then 'high'
    when prepared.total_titles > 0 then 'warning' else 'info' end,
  case when prepared.critical_count > 0 then 'urgent'
    when prepared.high_count > 0 then 'high'
    when prepared.total_titles > 0 then 'medium' else 'low' end,
  prepared.status,
  prepared.due_at,
  greatest(0, least(100, prepared.snapshot_confidence)),
  prepared.responsible_user_id,
  prepared.related_view,
  prepared.related_entity_type,
  prepared.related_entity_id,
  prepared.acknowledged_at,
  prepared.acknowledged_by,
  now()
from prepared
where not exists (
  select 1
  from public.insights replacement
  where replacement.run_id = prepared.run_id
    and replacement.organization_id = prepared.organization_id
    and replacement.evidence ->> 'supersedes_insight_id' = prepared.id::text
    and replacement.evidence #>> '{payment_criticality,policy_version}'
      = 'payable-criticality-v1'
);

-- A métrica antiga também é imutável. O backfill acrescenta uma métrica com
-- chave metodológica própria no mesmo run_id, sem comparação com a série
-- anterior contaminada e sem colidir com a unicidade da chave original.
insert into public.insight_metrics (
  id, organization_id, run_id, area, metric_key, label, numeric_value,
  unit, comparison_value, variation_pct, period_start, period_end,
  trend_points, created_at
)
select
  gen_random_uuid(),
  legacy.organization_id,
  legacy.run_id,
  'financeiro',
  'overdue_payables_trusted_v1',
  'Pagamentos vencidos classificados — política v1',
  coalesce((replacement.evidence
    #>> '{payment_criticality,portfolio,total_exposure}')::numeric, 0),
  'BRL',
  null,
  null,
  source_metric.period_start,
  source_metric.period_end,
  jsonb_build_array(jsonb_build_object(
    'at', coalesce(source_metric.period_end, source_metric.created_at),
    'value', coalesce((replacement.evidence
      #>> '{payment_criticality,portfolio,total_exposure}')::numeric, 0),
    'policy_version', 'payable-criticality-v1'
  )),
  now()
from public.insights legacy
join public.insights replacement
  on replacement.run_id = legacy.run_id
 and replacement.organization_id = legacy.organization_id
 and replacement.evidence ->> 'supersedes_insight_id' = legacy.id::text
 and replacement.evidence #>> '{payment_criticality,policy_version}'
   = 'payable-criticality-v1'
join lateral (
  select metric.period_start, metric.period_end, metric.created_at
  from public.insight_metrics metric
  where metric.run_id = legacy.run_id
    and metric.organization_id = legacy.organization_id
    and metric.area = 'financeiro'
    and metric.metric_key = 'overdue_payables'
  order by metric.created_at desc
  limit 1
) source_metric on true
where legacy.area = 'financeiro'
  and legacy.title = 'Pagamentos vencidos exigem plano de regularização'
  and legacy.status in ('novo', 'reconhecido', 'em_tratamento')
  and not exists (
    select 1
    from public.insight_metrics corrected_metric
    where corrected_metric.run_id = legacy.run_id
      and corrected_metric.organization_id = legacy.organization_id
      and corrected_metric.area = 'financeiro'
      and corrected_metric.metric_key = 'overdue_payables_trusted_v1'
  );

-- Apenas o estado do insight legado é alterado, operação explicitamente
-- admitida pelo trigger de imutabilidade. A trilha é acrescentada no mesmo
-- comando transacional.
with targets as materialized (
  select
    legacy.id,
    legacy.organization_id,
    legacy.status as previous_status
  from public.insights legacy
  where legacy.area = 'financeiro'
    and legacy.title = 'Pagamentos vencidos exigem plano de regularização'
    and legacy.status in ('novo', 'reconhecido', 'em_tratamento')
    and coalesce(legacy.evidence #>> '{payment_criticality,policy_version}', '')
      <> 'payable-criticality-v1'
    and exists (
      select 1
      from public.insights replacement
      where replacement.organization_id = legacy.organization_id
        and replacement.evidence ->> 'backfill_mode' = 'append_only'
        and replacement.evidence #>> '{payment_criticality,policy_version}'
          = 'payable-criticality-v1'
    )
), discarded as (
  update public.insights legacy
  set status = 'descartado'
  from targets target
  where legacy.id = target.id
  returning legacy.id, legacy.organization_id,
    target.previous_status, legacy.status as new_status
)
insert into public.insight_status_history (
  organization_id, insight_id, previous_status, new_status, note, changed_by
)
select
  discarded.organization_id,
  discarded.id,
  discarded.previous_status,
  discarded.new_status,
  'Insight substituído por snapshot append-only da política payable-criticality-v1.',
  null
from discarded;

comment on function private.payable_criticality_snapshot(uuid, timestamptz) is
  'Gera snapshot auditável da criticidade de contas a pagar aprovadas e vencidas; não autoriza pagamentos.';
