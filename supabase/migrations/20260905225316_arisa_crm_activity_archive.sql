begin;
set local statement_timeout='120s';
-- Calls, meetings and manual contact records complement message-based channels.
create function private.arisa_archive_activity(r jsonb) returns void language plpgsql security definer set search_path='' as $$
declare org uuid:=(r->>'organization_id')::uuid; label text; body text;
begin
  select person_name into label from public.crm_records where id=(r->>'crm_record_id')::uuid and organization_id=org;
  body:=coalesce(r->>'subject','')||E'\n'||coalesce(r->>'notes','');
  perform private.arisa_archive_put(org,null,'crm_actions',r->>'id',coalesce(r->>'channel','crm'),'activity','crm_team','crm:'||(r->>'crm_record_id'),coalesce(label,'Contato'),'Atendimento · '||coalesce(label,'CRM'),body,r,coalesce((r->>'completed_at')::timestamptz,(r->>'created_at')::timestamptz),r->>'action_status'='concluida' and length(coalesce(r->>'notes',''))>=10);
end $$;
create function private.arisa_capture_activity() returns trigger language plpgsql security definer set search_path='' as $$
begin perform private.arisa_archive_activity(to_jsonb(new)); return new; end $$;
create trigger arisa_activity_archive after insert or update on public.crm_actions for each row execute function private.arisa_capture_activity();
do $$ declare r jsonb; begin
  for r in select to_jsonb(a) from public.crm_actions a loop perform private.arisa_archive_activity(r); end loop;
end $$;
revoke all on function private.arisa_archive_activity(jsonb),private.arisa_capture_activity() from public,anon,authenticated,service_role;
commit;
