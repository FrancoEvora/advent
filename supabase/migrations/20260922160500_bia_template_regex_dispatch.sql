alter table crm_private.bia_campaign_outreach_jobs
  drop constraint if exists bia_campaign_outreach_jobs_template_name_check;

alter table crm_private.bia_campaign_outreach_jobs
  add constraint bia_campaign_outreach_jobs_template_name_check
  check (
    template_name is null
    or (
      char_length(template_name) between 1 and 512
      and template_name ~ '^[a-z0-9_]+$'
    )
  );

do $$
declare
  ddl text;
begin
  select pg_get_functiondef('public.bia_strategy_queue_admin(uuid,text,jsonb)'::regprocedure)
  into ddl;

  if position('^[a-z0-9_]{1,512}$' in ddl)>0 then
    ddl := replace(
      ddl,
      'if v_template_name !~ ''^[a-z0-9_]{1,512}$'' then',
      'if char_length(v_template_name) not between 1 and 512 or v_template_name !~ ''^[a-z0-9_]+$'' then'
    );
    execute ddl;
  end if;
end
$$;
