alter table public.arisa_chat_files
  drop constraint if exists arisa_chat_files_size_bytes_check;
alter table public.arisa_chat_files
  add constraint arisa_chat_files_size_bytes_check
  check (size_bytes between 1 and 31457280);

alter table public.arisa_operation_items
  drop constraint if exists arisa_operation_items_size_bytes_check;
alter table public.arisa_operation_items
  add constraint arisa_operation_items_size_bytes_check
  check (size_bytes between 1 and 31457280);

alter table crm_private.bia_customer_files
  drop constraint if exists bia_customer_files_size_bytes_check;
alter table crm_private.bia_customer_files
  add constraint bia_customer_files_size_bytes_check
  check (size_bytes between 1 and 31457280);

do $$
declare
  ddl text;
begin
  select pg_get_functiondef(
    'public.bia_customer_tools_v1(text,text,text,uuid,text,jsonb)'::regprocedure
  )
  into ddl;
  ddl := replace(ddl, '8388608', '31457280');
  execute ddl;
end
$$;
