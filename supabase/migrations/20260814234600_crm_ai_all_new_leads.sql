begin;

create or replace function crm_private.enqueue_vitoria_after_crm_record_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  runtime_ready boolean := false;
  was_inserted boolean := false;
  created_job_id uuid;
begin
  -- Meta Lead Ads remains on the attribution trigger so the agent receives
  -- campaign/ad/form context before analysis. All other CRM opportunities
  -- enter the same canonical AI queue immediately after creation.
  if coalesce(new.source_channel, '') = 'meta_lead_ads'
     or coalesce(new.source, '') ilike 'Meta Lead Ads%' then
    return new;
  end if;

  if new.record_status <> 'aberta' then
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

  begin
    select result.job_id, result.inserted
      into created_job_id, was_inserted
      from public.enqueue_crm_ai_job(
        new.organization_id,
        new.id,
        new.contact_id,
        'lead_created',
        'lead-created:' || new.id::text,
        'shadow'
      ) result;
  exception
    when others then
      raise warning 'CRM AI enqueue fail-open; crm_record=%, sqlstate=%', new.id, sqlstate;
      return new;
  end;

  if was_inserted then
    begin
      perform crm_private.dispatch_crm_ai_worker();
    exception
      when others then
        raise warning 'CRM AI immediate dispatch fail-open; job=%, sqlstate=%', created_job_id, sqlstate;
    end;
  end if;

  return new;
end
$function$;

revoke all on function crm_private.enqueue_vitoria_after_crm_record_insert() from public;
revoke all on function crm_private.enqueue_vitoria_after_crm_record_insert() from anon;
revoke all on function crm_private.enqueue_vitoria_after_crm_record_insert() from authenticated;
grant execute on function crm_private.enqueue_vitoria_after_crm_record_insert() to service_role;

-- Idempotent replacement: the Meta-specific trigger is intentionally kept.
drop trigger if exists crm_records_vitoria_enqueue on public.crm_records;
create trigger crm_records_vitoria_enqueue
after insert on public.crm_records
for each row
execute function crm_private.enqueue_vitoria_after_crm_record_insert();

comment on function crm_private.enqueue_vitoria_after_crm_record_insert() is
  'Enqueues every newly-created open CRM opportunity for Vitoria, except Meta Lead Ads records which wait for canonical Meta attribution.';

commit;
