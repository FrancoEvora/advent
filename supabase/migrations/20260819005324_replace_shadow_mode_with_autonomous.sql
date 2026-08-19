alter table crm_private.ai_runtime_settings
  drop constraint if exists ai_runtime_mode_check;

update crm_private.ai_runtime_settings
set mode = 'autonomous', updated_at = now()
where mode = 'shadow';

alter table crm_private.ai_runtime_settings
  alter column mode set default 'autonomous';

alter table crm_private.ai_runtime_settings
  add constraint ai_runtime_mode_check check (mode = 'autonomous');
