-- Synthetic fixtures only. Rollback preserves customer sessions and sends nothing.
begin;
do $$
declare
  c crm_private.bia_whatsapp_channels; actor uuid; sid uuid; tid uuid; selected_id uuid;
  token text; fingerprint text; page jsonb; older jsonb; jobs bigint; outbounds bigint;
begin
  select * into c from crm_private.bia_whatsapp_channels limit 1;
  select user_id into actor from public.organization_members where organization_id=c.organization_id and active and role='admin' limit 1;
  if actor is null then raise exception 'Configured channel and active administrator required'; end if;
  select count(*) into jobs from crm_private.bia_whatsapp_reply_jobs;
  select count(*) into outbounds from crm_private.bia_whatsapp_outbound;
  for n in 1..27 loop
    token:=encode(extensions.gen_random_bytes(32),'hex'); fingerprint:=encode(extensions.gen_random_bytes(32),'hex');
    insert into crm_private.public_agent_sessions(experience_id,organization_id,session_token_hash,fingerprint_hash,contact_capture)
      values(c.experience_id,c.organization_id,token,fingerprint,jsonb_build_object('name','CodexMonitorFixture '||n)) returning id into sid;
    insert into crm_private.bia_whatsapp_threads(channel_id,session_id,peer_phone,token_hash,fingerprint_hash,human_requested,opted_out_at)
      values(c.id,sid,'550000000'||lpad(n::text,4,'0'),token,fingerprint,n=2,case when n=3 then now() end) returning id into tid;
    if n=1 then selected_id:=tid; end if;
  end loop;
  insert into crm_private.bia_whatsapp_messages(thread_id,provider_message_id,direction,content,delivery_status,occurred_at,metadata)
    select selected_id,'codex-monitor-fixture-'||n,'outbound','Mensagem '||n,'delivered',now()+n*interval '1 second','{"private_diagnostic":"must not leak"}'::jsonb from generate_series(1,51) n;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  page:=public.bia_whatsapp_monitor(c.organization_id,selected_id,'CodexMonitorFixture');
  if (page->>'total')::integer<>27 or jsonb_array_length(page->'threads')<>25 then raise exception 'Contact first page failed'; end if;
  older:=public.bia_whatsapp_monitor(c.organization_id,selected_id,'CodexMonitorFixture','all',25,50);
  if jsonb_array_length(older->'threads')<>2 or older#>>'{selected,id}'<>selected_id::text then raise exception 'Selection disappeared off the current page'; end if;
  if (page->>'message_total')::integer<>51 or jsonb_array_length(page->'messages')<>50 or page#>>'{messages,0,content}'<>'Mensagem 2' or page#>>'{messages,49,content}'<>'Mensagem 51' then raise exception 'Recent history failed'; end if;
  if jsonb_array_length(older->'messages')<>1 or older#>>'{messages,0,content}'<>'Mensagem 1' then raise exception 'Old history lost'; end if;
  if page::text like '%must not leak%' or page::text like '%'||token||'%' then raise exception 'Private metadata exposed'; end if;
  page:=public.bia_whatsapp_monitor(c.organization_id,null,'CodexMonitorFixture','human');
  if (page->>'total')::integer<>1 then raise exception 'Human filter failed'; end if;
  page:=public.bia_whatsapp_monitor(c.organization_id,null,'CodexMonitorFixture','opted_out');
  if (page->>'total')::integer<>1 then raise exception 'Opt-out filter failed'; end if;
  page:=public.bia_whatsapp_monitor(c.organization_id,null,'CodexMonitorFixture','automatic');
  if (page->>'total')::integer<>25 then raise exception 'Automatic filter failed'; end if;
  page:=public.bia_whatsapp_monitor(c.organization_id,null,'+55 0000000-0027');
  if (page->>'total')::integer<>1 then raise exception 'Formatted phone search failed'; end if;
  begin
    perform public.bia_whatsapp_monitor(gen_random_uuid(),selected_id);
    raise exception 'Cross-organization access allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform public.bia_whatsapp_monitor(c.organization_id,gen_random_uuid());
    raise exception 'Unscoped thread allowed';
  exception when others then if sqlerrm<>'BIA_THREAD_NOT_FOUND' then raise; end if; end;
  begin
    perform public.bia_whatsapp_monitor(c.organization_id,null,'','invalid');
    raise exception 'Invalid filter allowed';
  exception when others then if sqlerrm<>'BIA_MONITOR_INPUT_INVALID' then raise; end if; end;
  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  begin
    perform public.bia_whatsapp_monitor(c.organization_id);
    raise exception 'Anonymous monitor access allowed';
  exception when insufficient_privilege then null; end;
  if has_function_privilege('anon','public.bia_whatsapp_monitor(uuid,uuid,text,text,integer,integer)','EXECUTE') then raise exception 'Anonymous execution granted'; end if;
  if not has_function_privilege('authenticated','public.bia_whatsapp_monitor(uuid,uuid,text,text,integer,integer)','EXECUTE') then raise exception 'Authenticated execution missing'; end if;
  if (select count(*) from crm_private.bia_whatsapp_reply_jobs)<>jobs or (select count(*) from crm_private.bia_whatsapp_outbound)<>outbounds then raise exception 'Monitoring created an outbound job'; end if;
end $$;
rollback;
