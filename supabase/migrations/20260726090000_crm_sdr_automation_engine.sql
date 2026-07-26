-- Connect the configured CRM rules to the existing 10-minute automation cron.
-- External channels remain human-reviewed: send_template only creates a task.

create schema if not exists private;

do $migration$
begin
  if to_regprocedure('private.process_evora_core_automations(uuid)') is null
     and to_regprocedure('private.process_evora_automations(uuid)') is not null then
    alter function private.process_evora_automations(uuid)
      rename to process_evora_core_automations;
  end if;
end
$migration$;

do $migration$
begin
  if to_regprocedure('private.process_evora_core_automations(uuid)') is null then
    execute $definition$
      create function private.process_evora_core_automations(
        p_organization_id uuid default null
      )
      returns jsonb
      language sql
      security definer
      set search_path = ''
      as $core$
        select jsonb_build_object(
          'expired_reservations', 0,
          'expired_proposals', 0,
          'notifications_created', 0,
          'processed_at', now(),
          'fallback_core', true
        )
      $core$
    $definition$;
  end if;
end
$migration$;

create index if not exists idx_crm_automation_runs_event
  on public.crm_automation_runs (
    automation_id,
    crm_record_id,
    ((result ->> 'event_marker'))
  );

create or replace function private.process_crm_automations(
  p_organization_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  automation record;
  lead record;
  configured_action jsonb;
  source_action_id uuid;
  source_outcome text;
  run_marker text;
  matched boolean;
  assigned_user uuid;
  alert_recipient uuid;
  target_stage record;
  delay_minutes integer;
  task_time timestamptz;
  action_results jsonb;
  processed integer := 0;
  failed integer := 0;
  automation_processed integer;
begin
  if not pg_try_advisory_xact_lock(
    hashtext('evora-crm-automations')
  ) then
    return jsonb_build_object(
      'processed', 0,
      'failed', 0,
      'skipped', 'already_running',
      'processed_at', now()
    );
  end if;

  for automation in
    select rule.*
      from public.crm_automations rule
     where rule.active
       and (
         p_organization_id is null
         or rule.organization_id = p_organization_id
       )
     order by rule.organization_id, rule.priority, rule.id
  loop
    automation_processed := 0;

    for lead in
      select record.*
        from public.crm_records record
       where record.organization_id = automation.organization_id
         and record.record_status = 'aberta'
       order by record.created_at
    loop
      begin
        matched := false;
        source_action_id := null;
        source_outcome := null;
        run_marker := null;
        assigned_user := lead.sdr_user_id;
        action_results := '[]'::jsonb;

        if automation.conditions ? 'source'
           and coalesce(lead.source, '') <>
               coalesce(automation.conditions ->> 'source', '') then
          continue;
        end if;
        if automation.conditions ? 'temperature'
           and coalesce(lead.temperature, '') <>
               coalesce(automation.conditions ->> 'temperature', '') then
          continue;
        end if;
        if automation.conditions ? 'stage_id'
           and coalesce(lead.stage_id::text, '') <>
               coalesce(automation.conditions ->> 'stage_id', '') then
          continue;
        end if;
        if automation.conditions ? 'campaign_id'
           and coalesce(lead.campaign_id::text, '') <>
               coalesce(automation.conditions ->> 'campaign_id', '') then
          continue;
        end if;

        case automation.trigger_event
          when 'lead_created' then
            run_marker := 'lead-created:' || lead.created_at::text;
            matched := not exists (
              select 1
                from public.crm_automation_runs prior_run
               where prior_run.automation_id = automation.id
                 and prior_run.crm_record_id = lead.id
                 and prior_run.status = 'executada'
                 and prior_run.result ->> 'event_marker' = run_marker
            );

          when 'sla_expired' then
            run_marker := 'sla:' || coalesce(lead.sla_due_at::text, 'none');
            matched :=
              lead.sla_due_at is not null
              and lead.sla_due_at <= now()
              and (
                not coalesce(
                  (automation.conditions ->> 'first_response_missing')::boolean,
                  false
                )
                or lead.first_response_at is null
              )
              and not exists (
                select 1
                  from public.crm_automation_runs prior_run
                 where prior_run.automation_id = automation.id
                   and prior_run.crm_record_id = lead.id
                   and prior_run.status = 'executada'
                   and prior_run.result ->> 'event_marker' = run_marker
              );

          when 'lead_stagnant' then
            run_marker :=
              'stagnant:' ||
              coalesce(
                lead.stagnation_at::text,
                lead.updated_at::text,
                lead.created_at::text
              );
            matched :=
              coalesce(
                lead.stagnation_at,
                lead.updated_at,
                lead.created_at
              ) <= now() - make_interval(
                hours => greatest(
                  1,
                  coalesce((automation.conditions ->> 'hours')::integer, 48)
                )
              )
              and not exists (
                select 1
                  from public.crm_automation_runs prior_run
                 where prior_run.automation_id = automation.id
                   and prior_run.crm_record_id = lead.id
                   and prior_run.status = 'executada'
                   and prior_run.result ->> 'event_marker' = run_marker
              );

          when 'stage_changed' then
            run_marker :=
              'stage:' ||
              coalesce(lead.stage_id::text, lead.stage, 'none') ||
              ':temperature:' ||
              coalesce(lead.temperature, 'none');
            matched := not exists (
              select 1
                from public.crm_automation_runs prior_run
               where prior_run.automation_id = automation.id
                 and prior_run.crm_record_id = lead.id
                 and prior_run.status = 'executada'
                 and prior_run.result ->> 'event_marker' = run_marker
            );

          when 'campaign_lead' then
            run_marker :=
              'campaign:' || coalesce(lead.campaign_id::text, 'none');
            matched :=
              lead.campaign_id is not null
              and not exists (
                select 1
                  from public.crm_automation_runs prior_run
                 where prior_run.automation_id = automation.id
                   and prior_run.crm_record_id = lead.id
                   and prior_run.status = 'executada'
                   and prior_run.result ->> 'event_marker' = run_marker
              );

          when 'activity_completed' then
            select activity.id, activity.outcome
              into source_action_id, source_outcome
              from public.crm_actions activity
             where activity.organization_id = automation.organization_id
               and activity.crm_record_id = lead.id
               and activity.action_status = 'concluida'
               and activity.completed_at is not null
               and (
                 not (automation.conditions ? 'outcome')
                 or coalesce(automation.conditions -> 'outcome', '[]'::jsonb)
                    ? coalesce(activity.outcome, '')
               )
               and not exists (
                 select 1
                   from public.crm_automation_runs prior_run
                  where prior_run.automation_id = automation.id
                    and prior_run.crm_record_id = lead.id
                    and prior_run.status = 'executada'
                    and prior_run.result ->> 'source_action_id' =
                        activity.id::text
               )
             order by activity.completed_at
             limit 1;
            matched := source_action_id is not null;
            run_marker :=
              case
                when source_action_id is null then null
                else 'activity:' || source_action_id::text
              end;

          else
            matched := false;
        end case;

        if not matched then
          continue;
        end if;

        for configured_action in
          select action_item.value
            from jsonb_array_elements(automation.actions) action_item(value)
        loop
          case configured_action ->> 'type'
            when 'assign_sdr' then
              if assigned_user is null then
                select team_member.user_id
                  into assigned_user
                  from public.crm_team_members team_member
                  join public.crm_teams team
                    on team.id = team_member.team_id
                   and team.organization_id = team_member.organization_id
                  join public.organization_members member
                    on member.organization_id = team_member.organization_id
                   and member.user_id = team_member.user_id
                   and member.active
                  left join lateral (
                    select count(*)::integer as open_leads
                      from public.crm_records assigned_lead
                     where assigned_lead.organization_id =
                           automation.organization_id
                       and assigned_lead.record_status = 'aberta'
                       and assigned_lead.sdr_user_id = team_member.user_id
                  ) workload on true
                 where team_member.organization_id =
                       automation.organization_id
                   and team_member.active
                   and team.active
                   and lower(team.team_type) in (
                     'sdr',
                     'pre_vendas',
                     'pre-vendas'
                   )
                   and (
                     team_member.capacity <= 0
                     or workload.open_leads < team_member.capacity
                   )
                 order by
                   workload.open_leads /
                     greatest(team_member.weight, 1)::numeric,
                   team_member.last_assigned_at nulls first,
                   team_member.user_id
                 limit 1;
              end if;

              if assigned_user is null then
                select member.user_id
                  into assigned_user
                  from public.organization_members member
                 where member.organization_id = automation.organization_id
                   and member.active
                   and lower(member.role) in ('sdr', 'gestor_crm')
                 order by
                   case when lower(member.role) = 'sdr' then 0 else 1 end,
                   (
                     select count(*)
                       from public.crm_records assigned_lead
                      where assigned_lead.organization_id =
                            automation.organization_id
                        and assigned_lead.record_status = 'aberta'
                        and assigned_lead.sdr_user_id = member.user_id
                   ),
                   member.created_at,
                   member.user_id
                 limit 1;
              end if;

              if assigned_user is null then
                select member.user_id
                  into assigned_user
                  from public.organization_members member
                 where member.organization_id = automation.organization_id
                   and member.active
                   and member.user_id in (
                     automation.created_by,
                     lead.created_by
                   )
                 order by
                   case
                     when member.user_id = automation.created_by then 0
                     else 1
                   end
                 limit 1;
              end if;

              if assigned_user is not null then
                update public.crm_records
                   set sdr_user_id = assigned_user,
                       owner_user_id = coalesce(owner_user_id, assigned_user),
                       updated_at = now()
                 where id = lead.id
                   and organization_id = automation.organization_id
                   and sdr_user_id is null;
                if not found then
                  select record.sdr_user_id
                    into assigned_user
                    from public.crm_records record
                   where record.id = lead.id;
                end if;
              end if;

              if assigned_user is not null then
                update public.crm_team_members team_member
                   set last_assigned_at = now()
                  from public.crm_teams team
                 where team.id = team_member.team_id
                   and team_member.organization_id =
                       automation.organization_id
                   and team_member.user_id = assigned_user
                   and team_member.active
                   and team.active
                   and lower(team.team_type) in (
                     'sdr',
                     'pre_vendas',
                     'pre-vendas'
                   );
              end if;
              action_results := action_results || jsonb_build_array(
                jsonb_build_object(
                  'type', 'assign_sdr',
                  'assigned_to', assigned_user
                )
              );

            when 'create_task' then
              delay_minutes :=
                greatest(
                  0,
                  coalesce(
                    (configured_action ->> 'delay_minutes')::integer,
                    0
                  )
                );
              task_time := now() + make_interval(mins => delay_minutes);

              if not exists (
                select 1
                  from public.crm_actions existing_task
                 where existing_task.organization_id =
                       automation.organization_id
                   and existing_task.crm_record_id = lead.id
                   and existing_task.action_status = 'pendente'
              ) then
                insert into public.crm_actions (
                  organization_id,
                  crm_record_id,
                  action_type,
                  channel,
                  subject,
                  scheduled_at,
                  action_status,
                  assigned_to,
                  automation_id,
                  metadata
                )
                values (
                  automation.organization_id,
                  lead.id,
                  'tarefa',
                  coalesce(configured_action ->> 'channel', 'interno'),
                  coalesce(
                    nullif(configured_action ->> 'subject', ''),
                    'Próxima ação do SDR'
                  ),
                  task_time,
                  'pendente',
                  coalesce(
                    assigned_user,
                    lead.sdr_user_id,
                    lead.owner_user_id,
                    lead.created_by
                  ),
                  automation.id,
                  jsonb_build_object(
                    'sdr_cadence', true,
                    'automation_safe_draft', true,
                    'no_external_delivery', true,
                    'event_marker', run_marker
                  )
                );

                update public.crm_records
                   set next_action_at = task_time,
                       updated_at = now()
                 where id = lead.id
                   and organization_id = automation.organization_id;
              end if;
              action_results := action_results || jsonb_build_array(
                jsonb_build_object(
                  'type', 'create_task',
                  'scheduled_at', task_time
                )
              );

            when 'create_alert' then
              alert_recipient := null;
              if (
                automation.trigger_event = 'stage_changed'
                and automation.conditions ->> 'temperature' = 'quente'
              ) or configured_action ->> 'target' = 'manager' then
                select team.manager_user_id
                  into alert_recipient
                  from public.crm_teams team
                  join public.organization_members manager
                    on manager.organization_id = team.organization_id
                   and manager.user_id = team.manager_user_id
                   and manager.active
                 where team.organization_id = automation.organization_id
                   and team.active
                   and team.manager_user_id is not null
                   and (
                     team.id = lead.team_id
                     or lower(team.team_type) in (
                       'sdr',
                       'pre_vendas',
                       'pre-vendas'
                     )
                   )
                 order by
                   case when team.id = lead.team_id then 0 else 1 end,
                   team.id
                 limit 1;
              end if;

              if not exists (
                select 1
                  from public.crm_alerts existing_alert
                 where existing_alert.organization_id =
                       automation.organization_id
                   and existing_alert.crm_record_id = lead.id
                   and existing_alert.alert_type =
                       'automation:' || automation.id::text
                   and existing_alert.status = 'aberto'
              ) then
                insert into public.crm_alerts (
                  organization_id,
                  crm_record_id,
                  alert_type,
                  severity,
                  title,
                  message,
                  assigned_to,
                  due_at,
                  status
                )
                values (
                  automation.organization_id,
                  lead.id,
                  'automation:' || automation.id::text,
                  coalesce(
                    nullif(configured_action ->> 'severity', ''),
                    'media'
                  ),
                  automation.name,
                  lead.person_name || ' · ' ||
                    coalesce(lead.stage, 'sem etapa'),
                  coalesce(
                    alert_recipient,
                    assigned_user,
                    lead.sdr_user_id,
                    lead.owner_user_id
                  ),
                  coalesce(lead.sla_due_at, now()),
                  'aberto'
                );
              end if;
              action_results := action_results || jsonb_build_array(
                jsonb_build_object('type', 'create_alert')
              );

            when 'set_priority' then
              if configured_action ->> 'value'
                 in ('baixa', 'normal', 'alta', 'urgente') then
                update public.crm_records
                   set priority = configured_action ->> 'value',
                       updated_at = now()
                 where id = lead.id
                   and organization_id = automation.organization_id;
              end if;
              action_results := action_results || jsonb_build_array(
                jsonb_build_object(
                  'type', 'set_priority',
                  'value', configured_action ->> 'value'
                )
              );

            when 'add_tag' then
              if nullif(configured_action ->> 'value', '') is not null then
                update public.crm_records
                   set tags = case
                     when coalesce(tags, '{}'::text[]) @>
                          array[configured_action ->> 'value']
                       then coalesce(tags, '{}'::text[])
                     else array_append(
                       coalesce(tags, '{}'::text[]),
                       configured_action ->> 'value'
                     )
                   end,
                   updated_at = now()
                 where id = lead.id
                   and organization_id = automation.organization_id;
              end if;
              action_results := action_results || jsonb_build_array(
                jsonb_build_object(
                  'type', 'add_tag',
                  'value', configured_action ->> 'value'
                )
              );

            when 'move_stage' then
              select stage.*
                into target_stage
                from public.crm_stages stage
               where stage.organization_id = automation.organization_id
                 and stage.active
                 and (
                   stage.id::text = configured_action ->> 'value'
                   or stage.id::text = configured_action ->> 'stage_id'
                   or stage.code = configured_action ->> 'value'
                 )
               limit 1;

              if target_stage.id is not null then
                update public.crm_records
                   set stage_id = target_stage.id,
                       stage = target_stage.code,
                       probability = target_stage.probability,
                       record_status = case
                         when target_stage.is_won then 'ganha'
                         when target_stage.is_lost then 'perdida'
                         else 'aberta'
                       end,
                       stagnation_at = now(),
                       updated_at = now()
                 where id = lead.id
                   and organization_id = automation.organization_id;
              end if;
              action_results := action_results || jsonb_build_array(
                jsonb_build_object(
                  'type', 'move_stage',
                  'stage_id', target_stage.id
                )
              );

            when 'send_template' then
              -- Safety boundary: prepare a review task; never dispatch externally.
              if not exists (
                select 1
                  from public.crm_actions review_task
                 where review_task.organization_id =
                       automation.organization_id
                   and review_task.crm_record_id = lead.id
                   and review_task.automation_id = automation.id
                   and review_task.action_status = 'pendente'
              ) then
                insert into public.crm_actions (
                  organization_id,
                  crm_record_id,
                  action_type,
                  channel,
                  subject,
                  scheduled_at,
                  action_status,
                  assigned_to,
                  automation_id,
                  template_id,
                  metadata
                )
                values (
                  automation.organization_id,
                  lead.id,
                  'tarefa',
                  coalesce(configured_action ->> 'channel', 'whatsapp'),
                  'Revisar e enviar mensagem ao lead',
                  now(),
                  'pendente',
                  coalesce(
                    assigned_user,
                    lead.sdr_user_id,
                    lead.owner_user_id,
                    lead.created_by
                  ),
                  automation.id,
                  case
                    when coalesce(configured_action ->> 'template_id', '')
                         ~ '^[0-9a-fA-F-]{36}$'
                      then (configured_action ->> 'template_id')::uuid
                    else null
                  end,
                  jsonb_build_object(
                    'automation_safe_draft', true,
                    'requires_human_review', true,
                    'no_external_delivery', true,
                    'event_marker', run_marker
                  )
                );
              end if;
              action_results := action_results || jsonb_build_array(
                jsonb_build_object(
                  'type', 'send_template',
                  'result', 'review_task_created'
                )
              );

            else
              action_results := action_results || jsonb_build_array(
                jsonb_build_object(
                  'type', configured_action ->> 'type',
                  'result', 'unsupported_action_skipped'
                )
              );
          end case;
        end loop;

        insert into public.crm_automation_runs (
          organization_id,
          automation_id,
          crm_record_id,
          status,
          result
        )
        values (
          automation.organization_id,
          automation.id,
          lead.id,
          'executada',
          jsonb_build_object(
            'trigger_event', automation.trigger_event,
            'event_marker', run_marker,
            'source_action_id', source_action_id,
            'source_outcome', source_outcome,
            'actions', action_results,
            'external_delivery', false
          )
        );

        processed := processed + 1;
        automation_processed := automation_processed + 1;
      exception
        when others then
          failed := failed + 1;
          insert into public.crm_automation_runs (
            organization_id,
            automation_id,
            crm_record_id,
            status,
            result
          )
          values (
            automation.organization_id,
            automation.id,
            lead.id,
            'falha',
            jsonb_build_object(
              'trigger_event', automation.trigger_event,
              'event_marker', run_marker,
              'error', sqlerrm,
              'external_delivery', false
            )
          );
      end;
    end loop;

    update public.crm_automations
       set last_run_at = now(),
           execution_count = execution_count + automation_processed,
           updated_at = now()
     where id = automation.id;
  end loop;

  return jsonb_build_object(
    'processed', processed,
    'failed', failed,
    'external_deliveries', 0,
    'processed_at', now()
  );
end
$function$;

create or replace function private.process_evora_automations(
  p_organization_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  core_result jsonb;
  crm_result jsonb;
begin
  core_result :=
    private.process_evora_core_automations(p_organization_id);
  crm_result :=
    private.process_crm_automations(p_organization_id);

  return coalesce(core_result, '{}'::jsonb) ||
    jsonb_build_object('crm_automations', crm_result);
end
$function$;

create or replace function public.run_my_automations(
  p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not public.is_org_member(p_organization_id) then
    raise exception 'Acesso negado';
  end if;
  return private.process_evora_automations(p_organization_id);
end
$function$;

revoke all on function private.process_crm_automations(uuid)
  from public, anon, authenticated;
revoke all on function private.process_evora_core_automations(uuid)
  from public, anon, authenticated;
revoke all on function private.process_evora_automations(uuid)
  from public, anon, authenticated;
revoke all on function public.run_my_automations(uuid)
  from public, anon;
grant execute on function public.run_my_automations(uuid)
  to authenticated;

comment on function private.process_crm_automations(uuid) is
  'Executes active CRM rules with event deduplication. External templates become human-review tasks.';
comment on function private.process_evora_automations(uuid) is
  'Stable cron entrypoint that runs core platform jobs and CRM automation rules.';
