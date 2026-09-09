-- Resolve the persisted client request ID for speech and document bindings.
create or replace function public.bia_customer_tools_v1(p_slug text,p_session_token_hash text,p_fingerprint_hash text,p_conversation_id uuid,p_operation text,p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare s crm_private.public_agent_sessions%rowtype; f crm_private.bia_customer_files%rowtype;
  result jsonb; count_unread integer; reply crm_private.public_agent_messages%rowtype; used integer; file_id uuid;
begin
  s:=crm_private.bia_customer_session(p_slug,p_session_token_hash,p_fingerprint_hash,p_conversation_id);
  if p_args is null or jsonb_typeof(p_args)<>'object' or pg_column_size(p_args)>16384 then raise exception 'PUBLIC_AGENT_INPUT_INVALID'; end if;
  if p_operation='files_prepare' then
    if coalesce(p_args->>'name','')='' or char_length(p_args->>'name')>250
      or coalesce(p_args->>'mime','') not in ('application/pdf','image/png','image/jpeg','image/webp','text/plain','text/csv','application/xml','application/x-ofx')
      or coalesce(p_args->>'sha256','') !~ '^[a-f0-9]{64}$'
      or coalesce(p_args->>'size','') !~ '^[0-9]{1,7}$' or (p_args->>'size')::integer not between 1 and 8388608
      or coalesce(p_args->>'clientId','') !~ '^[a-f0-9-]{36}$' then raise exception 'PUBLIC_AGENT_FILE_INVALID'; end if;
    perform pg_advisory_xact_lock(hashtextextended('bia-files:'||s.fingerprint_hash,0));
    select * into f from crm_private.bia_customer_files where session_id=s.id and client_id=(p_args->>'clientId')::uuid;
    if found then
      if f.sha256<>p_args->>'sha256' or f.size_bytes<>(p_args->>'size')::integer or f.mime<>p_args->>'mime' or f.name<>p_args->>'name' then raise exception 'PUBLIC_AGENT_FILE_CONFLICT'; end if;
    else
      if (select count(*) from crm_private.bia_customer_files x join crm_private.public_agent_sessions xs on xs.id=x.session_id
        where xs.fingerprint_hash=s.fingerprint_hash and x.created_at>now()-interval '24 hours')>=24 then raise exception 'PUBLIC_AGENT_FILE_LIMIT'; end if;
      file_id:=gen_random_uuid();
      insert into crm_private.bia_customer_files(id,session_id,client_id,name,mime,size_bytes,sha256,storage_path)
      values(file_id,s.id,(p_args->>'clientId')::uuid,p_args->>'name',p_args->>'mime',(p_args->>'size')::integer,p_args->>'sha256',s.organization_id||'/'||s.id||'/'||file_id) returning * into f;
    end if;
    return to_jsonb(f);
  elsif p_operation in ('files_get','files_ready') then
    select * into f from crm_private.bia_customer_files where session_id=s.id and id=(p_args->>'fileId')::uuid for update;
    if not found then raise exception 'PUBLIC_AGENT_FILE_NOT_FOUND'; end if;
    if p_operation='files_ready' then
      update crm_private.bia_customer_files set ready=true where id=f.id returning * into f;
    end if;
    return to_jsonb(f);
  elsif p_operation='files_list' then
    select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'mime',mime,'size',size_bytes,'messageId',message_id::text) order by created_at),'[]') into result
    from crm_private.bia_customer_files where session_id=s.id and ready and message_id is not null;
    return result;
  elsif p_operation='notices_read' then
    if jsonb_typeof(p_args->'ids') is distinct from 'array' or jsonb_array_length(p_args->'ids')>50
      or exists(select 1 from jsonb_array_elements_text(p_args->'ids') x where x !~ '^[0-9]{1,18}$') then raise exception 'PUBLIC_AGENT_INPUT_INVALID'; end if;
    insert into crm_private.bia_customer_notice_reads(message_id)
    select m.id from crm_private.public_agent_messages m join crm_private.public_agent_sessions x on x.id=m.session_id
    where x.experience_id=s.experience_id and x.fingerprint_hash=s.fingerprint_hash and x.expires_at>now() and x.status not in ('closed','blocked')
      and m.direction='assistant' and coalesce((m.metadata->>'initial_greeting')::boolean,false)=false
      and m.id in(select value::bigint from jsonb_array_elements_text(p_args->'ids'))
      and not exists(select 1 from crm_private.bia_whatsapp_threads w where w.session_id=x.id)
    on conflict do nothing;
    return jsonb_build_object('ok',true);
  elsif p_operation='notices' then
    select count(*) filter(where r.message_id is null) into count_unread
    from crm_private.public_agent_messages m join crm_private.public_agent_sessions x on x.id=m.session_id
    left join crm_private.bia_customer_notice_reads r on r.message_id=m.id
    where x.experience_id=s.experience_id and x.fingerprint_hash=s.fingerprint_hash and x.expires_at>now() and x.status not in ('closed','blocked')
      and m.direction='assistant' and coalesce((m.metadata->>'initial_greeting')::boolean,false)=false
      and not exists(select 1 from crm_private.bia_whatsapp_threads w where w.session_id=x.id);
    select coalesce(jsonb_agg(to_jsonb(n) order by n.created_at desc),'[]') into result from (
      select m.id::text as id,x.id as "conversationId",r.read_at,m.created_at,left(m.content,300) as message,
        case when m.metadata->'public_response' ? 'simulation' then 'Simulação disponível'
          when m.metadata->'public_response' ? 'visit' then 'Atualização da visita'
          when jsonb_array_length(coalesce(m.metadata#>'{public_response,attachments}','[]'))>0 then 'Materiais disponíveis'
          else 'Bia respondeu' end as title
      from crm_private.public_agent_messages m join crm_private.public_agent_sessions x on x.id=m.session_id
      left join crm_private.bia_customer_notice_reads r on r.message_id=m.id
      where x.experience_id=s.experience_id and x.fingerprint_hash=s.fingerprint_hash and x.expires_at>now() and x.status not in ('closed','blocked')
        and m.direction='assistant' and coalesce((m.metadata->>'initial_greeting')::boolean,false)=false
        and not exists(select 1 from crm_private.bia_whatsapp_threads w where w.session_id=x.id)
      order by m.created_at desc limit 30
    ) n;
    return jsonb_build_object('items',result,'unread_count',count_unread);
  elsif p_operation='speech_reply' then
    select * into reply from crm_private.public_agent_messages m where m.session_id=s.id and m.direction='assistant'
      and (m.id::text=p_args->>'messageId' or 'assistant-'||(coalesce(m.metadata->>'client_request_id',m.metadata->>'bia_request_id'))=p_args->>'messageId') order by m.id desc limit 1;
    if not found then raise exception 'PUBLIC_AGENT_MESSAGE_NOT_FOUND'; end if;
    return jsonb_build_object('id',reply.id::text,'content',reply.content,'role','assistant','status','completed','parent_id',null,'organizationId',s.organization_id);
  elsif p_operation='speech_consume' then
    used:=(p_args->>'characters')::integer;
    if used is null or used not between 1 and 5000 then raise exception 'PUBLIC_AGENT_INPUT_INVALID'; end if;
    perform pg_advisory_xact_lock(hashtextextended('bia-speech:'||s.organization_id,0));
    if (select coalesce(sum(characters),0) from crm_private.bia_customer_speech_usage where organization_id=s.organization_id and day=current_date)+used>1000000 then return 'false'; end if;
    insert into crm_private.bia_customer_speech_usage(organization_id,fingerprint_hash) values(s.organization_id,s.fingerprint_hash) on conflict do nothing;
    update crm_private.bia_customer_speech_usage set characters=characters+used,requests=requests+1
    where organization_id=s.organization_id and fingerprint_hash=s.fingerprint_hash and day=current_date and characters+used<=30000 and requests<300;
    return to_jsonb(found);
  end if;
  raise exception 'PUBLIC_AGENT_INPUT_INVALID';
end $$;

create or replace function public.finish_bia_turn_with_files_v1(p_slug text,p_session_token_hash text,p_fingerprint_hash text,p_client_request_id uuid,p_lease_token uuid,p_payload jsonb,p_response jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s crm_private.public_agent_sessions%rowtype; result jsonb; a bigint; u bigint; ids uuid[];
begin
  s:=crm_private.bia_customer_session(p_slug,p_session_token_hash,p_fingerprint_hash);
  if jsonb_typeof(p_payload->'fileIds') is distinct from 'array' or jsonb_array_length(p_payload->'fileIds') not between 1 and 3 then raise exception 'PUBLIC_AGENT_FILE_INVALID'; end if;
  select array_agg(value::uuid order by value) into ids from jsonb_array_elements_text(p_payload->'fileIds');
  if cardinality(ids)<>(select count(*) from crm_private.bia_customer_files where session_id=s.id and id=any(ids) and ready)
    or (select sum(size_bytes) from crm_private.bia_customer_files where id=any(ids))>16777216 then raise exception 'PUBLIC_AGENT_FILE_NOT_FOUND'; end if;
  result:=public.finish_bia_turn_v1(p_slug,p_session_token_hash,p_fingerprint_hash,p_client_request_id,p_lease_token,p_payload,p_response);
  select id into a from crm_private.public_agent_messages where session_id=s.id and direction='assistant' and coalesce(metadata->>'client_request_id',metadata->>'bia_request_id')=p_client_request_id::text order by id desc limit 1;
  select id into u from crm_private.public_agent_messages where session_id=s.id and direction='user' and id<a order by id desc limit 1;
  if u is null then raise exception 'PUBLIC_AGENT_MESSAGE_NOT_FOUND'; end if;
  if exists(select 1 from crm_private.bia_customer_files where id=any(ids) and message_id is not null and message_id<>u) then raise exception 'PUBLIC_AGENT_FILE_CONFLICT'; end if;
  update crm_private.bia_customer_files set message_id=u where session_id=s.id and id=any(ids);
  return result;
end $$;
