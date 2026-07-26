-- Keep the buyer portal tied to the same physical source used by Work Management.
-- The token only exposes customer-safe, aggregated EAP progress for its contract project.

create or replace function public.get_post_sale_portal_v2(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  base jsonb;
  t public.post_sale_portal_tokens%rowtype;
  v_project_id uuid;
  v_construction jsonb;
begin
  base := public.get_post_sale_portal(p_token);
  if base is null then
    return null;
  end if;

  select *
    into t
    from public.post_sale_portal_tokens
   where token = p_token
     and active = true
     and expires_at > now()
   limit 1;

  select project_id
    into v_project_id
    from public.crm_contracts
   where id = t.contract_id;

  with recursive
  project_packages as (
    select
      work_package.id,
      work_package.parent_id,
      coalesce(
        work_package.wbs_code,
        work_package.package_code,
        work_package.code
      ) as code,
      work_package.name,
      work_package.is_summary,
      work_package.sort_order,
      greatest(0, coalesce(work_package.weight_pct, 0))::numeric as weight_pct,
      greatest(
        0,
        least(100, coalesce(work_package.actual_progress, 0))
      )::numeric as actual_pct,
      greatest(
        0,
        least(100, coalesce(work_package.planned_progress, 0))
      )::numeric as planned_pct,
      work_package.updated_at
    from public.construction_work_packages work_package
    where work_package.project_id = v_project_id
      and work_package.organization_id = t.organization_id
      and lower(coalesce(work_package.status, '')) not in ('cancelado', 'cancelada')
  ),
  roots as (
    select package.*
    from project_packages package
    where package.parent_id is null
       or not exists (
         select 1
         from project_packages parent
         where parent.id = package.parent_id
       )
  ),
  root_context as (
    select count(*)::integer as root_count
    from roots
  ),
  package_tree as (
    select
      root.*,
      0 as depth,
      case
        when context.root_count = 1 and root.is_summary then null::uuid
        else root.id
      end as stage_id
    from roots root
    cross join root_context context

    union all

    select
      child.*,
      parent.depth + 1,
      coalesce(parent.stage_id, child.id) as stage_id
    from project_packages child
    join package_tree parent
      on parent.id = child.parent_id
  ),
  leaf_packages as (
    select *
    from package_tree
    where not coalesce(is_summary, false)
  ),
  totals as (
    select
      count(*)::integer as package_count,
      count(*) filter (where actual_pct >= 100)::integer as completed_count,
      coalesce(sum(weight_pct), 0)::numeric as total_weight,
      coalesce(avg(actual_pct), 0)::numeric as average_actual,
      coalesce(avg(planned_pct), 0)::numeric as average_planned,
      coalesce(sum(actual_pct * weight_pct), 0)::numeric as weighted_actual,
      coalesce(sum(planned_pct * weight_pct), 0)::numeric as weighted_planned,
      max(updated_at) as last_updated
    from leaf_packages
  ),
  project_metrics as (
    select
      package_count,
      completed_count,
      case
        when package_count = 0 then 0
        when total_weight > 0 then weighted_actual / total_weight
        else average_actual
      end as actual_pct,
      case
        when package_count = 0 then 0
        when total_weight > 0 then weighted_planned / total_weight
        else average_planned
      end as planned_pct,
      last_updated
    from totals
  ),
  stage_totals as (
    select
      leaf.stage_id,
      stage.code,
      stage.name,
      min(leaf.sort_order) as first_sort,
      count(*)::integer as package_count,
      coalesce(sum(leaf.weight_pct), 0)::numeric as total_weight,
      coalesce(avg(leaf.actual_pct), 0)::numeric as average_actual,
      coalesce(avg(leaf.planned_pct), 0)::numeric as average_planned,
      coalesce(sum(leaf.actual_pct * leaf.weight_pct), 0)::numeric as weighted_actual,
      coalesce(sum(leaf.planned_pct * leaf.weight_pct), 0)::numeric as weighted_planned
    from leaf_packages leaf
    join project_packages stage
      on stage.id = leaf.stage_id
    group by leaf.stage_id, stage.code, stage.name
  ),
  stage_metrics as (
    select
      stage_id,
      code,
      name,
      first_sort,
      case
        when package_count = 0 then 0
        when total_weight > 0 then weighted_actual / total_weight
        else average_actual
      end as actual_pct,
      case
        when package_count = 0 then 0
        when total_weight > 0 then weighted_planned / total_weight
        else average_planned
      end as planned_pct
    from stage_totals
  ),
  customer_stages as (
    select *
    from stage_metrics
    order by first_sort
    limit 5
  )
  select jsonb_build_object(
    'actual_pct', round(metrics.actual_pct, 2),
    'planned_pct', round(metrics.planned_pct, 2),
    'variance_pp', round(metrics.actual_pct - metrics.planned_pct, 2),
    'has_baseline', metrics.planned_pct > 0,
    'package_count', metrics.package_count,
    'completed_count', metrics.completed_count,
    'last_updated', metrics.last_updated,
    'stages', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', stage.stage_id,
            'code', stage.code,
            'name', stage.name,
            'actual_pct', round(stage.actual_pct, 2),
            'planned_pct', round(stage.planned_pct, 2),
            'status', case
              when stage.actual_pct >= 100 then 'concluida'
              when stage.actual_pct > 0 then 'em_andamento'
              else 'planejada'
            end
          )
          order by stage.first_sort
        )
        from customer_stages stage
      ),
      '[]'::jsonb
    )
  )
    into v_construction
    from project_metrics metrics;

  return base || jsonb_build_object(
    'content',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', item.id,
            'type', item.content_type,
            'title', item.title,
            'subtitle', item.subtitle,
            'body', item.body,
            'media_url', item.media_url,
            'storage_path', item.storage_path,
            'cta_label', item.cta_label,
            'cta_url', item.cta_url,
            'featured', item.featured,
            'created_at', item.created_at
          )
          order by item.featured desc, item.sort_order, item.created_at desc
        )
        from public.portal_content_items item
        where item.organization_id = t.organization_id
          and item.active = true
          and (
            item.contract_id = t.contract_id
            or (
              item.contract_id is null
              and (item.project_id is null or item.project_id = v_project_id)
            )
          )
          and (item.publish_at is null or item.publish_at <= now())
          and (item.expires_at is null or item.expires_at > now())
      ),
      '[]'::jsonb
    ),
    'messages',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', message.id,
            'direction', message.direction,
            'sender_type', message.sender_type,
            'sender_name', message.sender_name,
            'subject', message.subject,
            'message', message.message,
            'attachments', message.attachments,
            'created_at', message.created_at
          )
          order by message.created_at
        )
        from public.portal_messages message
        where message.contract_id = t.contract_id
      ),
      '[]'::jsonb
    ),
    'construction',
    coalesce(
      v_construction,
      jsonb_build_object(
        'actual_pct', 0,
        'planned_pct', 0,
        'variance_pp', 0,
        'has_baseline', false,
        'package_count', 0,
        'completed_count', 0,
        'last_updated', null,
        'stages', '[]'::jsonb
      )
    )
  );
end
$function$;

comment on function public.get_post_sale_portal_v2(uuid) is
  'Returns the customer portal payload plus token-scoped, customer-safe physical progress from the Work Management EAP.';
