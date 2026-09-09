-- Isolated fixtures; never sends a message or changes a live customer's session.
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$
declare
  slug text; a text:=encode(extensions.gen_random_bytes(32),'hex'); b text:=encode(extensions.gen_random_bytes(32),'hex');
  other_token text:=encode(extensions.gen_random_bytes(32),'hex'); rotated text:=encode(extensions.gen_random_bytes(32),'hex');
  device text:=encode(extensions.gen_random_bytes(32),'hex'); other_device text:=encode(extensions.gen_random_bytes(32),'hex');
  first_id uuid; second_id uuid; other_id uuid; result jsonb; cursor_id bigint;
begin
  select e.slug into slug from crm_private.public_agent_experiences e where e.active order by e.slug limit 1;
  if slug is null then raise exception 'An active experience is required'; end if;
  result:=public.open_bia_conversation_v1(slug,a,device);
  first_id:=(result->>'sessionId')::uuid;
  if jsonb_array_length(result->'messages')<>1 then raise exception 'Initial greeting not restored'; end if;
  insert into crm_private.public_agent_messages(session_id,direction,content,metadata)
    values(first_id,'user','Simulação de teste transacional','{}'),
    (first_id,'assistant','Cálculo salvo',jsonb_build_object('private_diagnostic','must not be exposed','public_response',
      jsonb_build_object('simulation',jsonb_build_object('unitCode','TEST-1'),'attachments',jsonb_build_array(jsonb_build_object('type','document','title','Teste','url','https://example.com/test.pdf')))));
  insert into crm_private.public_agent_messages(session_id,direction,content)
    select first_id,'user','Mensagem de paginação '||n from generate_series(1,105) n;
  result:=public.open_bia_conversation_v1(slug,a,device);
  if jsonb_array_length(result->'messages')<>100 or result->>'hasOlderMessages'<>'true' then raise exception 'Pagination boundary failed'; end if;
  if result#>>'{resources,0,simulation,unitCode}'<>'TEST-1' then raise exception 'Old simulation disappeared'; end if;
  cursor_id:=(result#>>'{messages,0,id}')::bigint;
  result:=public.get_bia_conversation_workspace_v1(slug,a,device,cursor_id);
  if jsonb_array_length(result->'messages')<>8 or result->>'hasOlderMessages'<>'false' then raise exception 'Older page lost messages'; end if;
  if result::text like '%must not be exposed%' or result::text like '%'||a||'%' or result::text like '%'||device||'%' then raise exception 'Private metadata or credentials leaked'; end if;
  if result#>>'{messages,2,metadata,public_response,simulation,unitCode}'<>'TEST-1' then raise exception 'Rich message restoration failed'; end if;
  result:=public.switch_bia_conversation_v1(slug,a,device,b);
  second_id:=(result->>'sessionId')::uuid;
  if second_id=first_id or jsonb_array_length(result->'conversations')<>2 then raise exception 'New conversation lost history'; end if;
  result:=public.open_bia_conversation_v1(slug,other_token,other_device);
  other_id:=(result->>'sessionId')::uuid;
  if jsonb_array_length(result->'conversations')<>1 then raise exception 'Cross-device history leak'; end if;
  begin
    perform public.switch_bia_conversation_v1(slug,b,device,rotated,other_id);
    raise exception 'Cross-device switch accepted';
  exception when others then if sqlerrm<>'PUBLIC_AGENT_CONVERSATION_NOT_FOUND' then raise; end if; end;
  begin
    perform public.open_bia_conversation_v1(slug,a,other_device);
    raise exception 'Mismatched device accepted';
  exception when others then if sqlerrm<>'PUBLIC_AGENT_SESSION_INACTIVE' then raise; end if; end;
  result:=public.switch_bia_conversation_v1(slug,b,device,rotated,first_id);
  if result->>'sessionId'<>first_id::text or result#>>'{resources,0,simulation,unitCode}'<>'TEST-1' then raise exception 'Resume failed'; end if;
  begin
    perform public.get_bia_conversation_workspace_v1(slug,a,device);
    raise exception 'Rotated credential still active';
  exception when others then if sqlerrm<>'PUBLIC_AGENT_SESSION_INACTIVE' then raise; end if; end;
  update crm_private.public_agent_sessions set expires_at=now()-interval '1 second' where id=second_id;
  begin
    perform public.switch_bia_conversation_v1(slug,rotated,device,a,second_id);
    raise exception 'Expired conversation resumed';
  exception when others then if sqlerrm<>'PUBLIC_AGENT_CONVERSATION_NOT_FOUND' then raise; end if; end;
  if has_function_privilege('anon','public.get_bia_conversation_workspace_v1(text,text,text,bigint)','EXECUTE')
    or has_function_privilege('authenticated','public.switch_bia_conversation_v1(text,text,text,text,uuid)','EXECUTE') then raise exception 'Public role can bypass gateway'; end if;
end $$;
rollback;
