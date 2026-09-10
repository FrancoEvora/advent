begin;
create or replace function public.arisa_chat_send(p_thread_id uuid,p_message_id uuid,p_content text,p_file_ids uuid[] default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare thread public.arisa_chat_threads; result public.arisa_chat_messages;
begin
  p_file_ids:=coalesce(p_file_ids,'{}');
  select * into thread from public.arisa_chat_threads where id=p_thread_id and owner_user_id=auth.uid() for update;
  if not found or not private.arisa_is_admin(thread.organization_id) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  if char_length(coalesce(p_content,''))>6000 or (nullif(btrim(p_content),'') is null and cardinality(p_file_ids)=0) or cardinality(p_file_ids)>5 then raise exception 'Envie uma mensagem de até 6.000 caracteres e até 5 anexos.'; end if;
  if exists(select 1 from unnest(p_file_ids) f(id) where not exists(select 1 from public.arisa_chat_files a where a.id=f.id and a.thread_id=thread.id and a.owner_user_id=auth.uid())) then raise exception 'Anexo não pertence à conversa.' using errcode='42501'; end if;
  select * into result from public.arisa_chat_messages where id=p_message_id;
  if found then
    if result.thread_id<>thread.id or result.owner_user_id<>auth.uid() or result.role<>'user' or result.content<>coalesce(p_content,'') or result.file_ids<>p_file_ids then raise exception 'MESSAGE_ID_CONFLICT'; end if;
    return to_jsonb(result);
  end if;
  insert into public.arisa_chat_messages(id,organization_id,owner_user_id,thread_id,role,content,file_ids)
  values(p_message_id,thread.organization_id,auth.uid(),thread.id,'user',coalesce(p_content,''),p_file_ids) returning * into result;
  update public.arisa_chat_threads set updated_at=now(),title=case when title in ('Conversa com a Arisa','Conversa com a Bia') then left(coalesce(nullif(btrim(p_content),''),'Documentos enviados'),100) else title end where id=thread.id;
  return to_jsonb(result);
end $$;
commit;
