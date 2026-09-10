-- All fixtures and queued worker HTTP calls are rolled back. No Meta messages are sent.
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$
declare ch crm_private.bia_whatsapp_channels; actor uuid; rid uuid:=gen_random_uuid(); other_id uuid:=gen_random_uuid();
  result jsonb; again jsonb; args jsonb; event jsonb; tid uuid; inbound jsonb; n integer;
begin
  select * into ch from crm_private.bia_whatsapp_channels limit 1;
  select m.user_id into actor from public.organization_members m join public.organizations o on o.id=m.organization_id
    where m.organization_id=ch.organization_id and m.active and m.role='admin' and o.active limit 1;
  if actor is null then raise exception 'Configured admin and channel required'; end if;
  update crm_private.bia_whatsapp_channels set enabled=true,webhook_verified_at=now() where id=ch.id;
  args:=jsonb_build_object('id',rid,'phone','5534999999876','consent',true,'template','bia_boas_vindas','hash',repeat('a',64),'body','Mensagem de abertura do teste transacional.');
  begin
    perform public.bia_whatsapp_outbound_admin(ch.organization_id,gen_random_uuid(),'start',args);
    raise exception 'Unrelated actor accepted';
  exception when insufficient_privilege then null; end;
  begin
    perform public.bia_whatsapp_outbound_admin(ch.organization_id,actor,'start',args||jsonb_build_object('consent',false));
    raise exception 'Missing consent accepted';
  exception when others then if sqlerrm<>'BIA_REQUEST_INVALID' then raise; end if; end;
  result:=public.bia_whatsapp_outbound_admin(ch.organization_id,actor,'start',args);
  tid:=(result->>'threadId')::uuid;
  if result->>'proceed'<>'true' or tid is null then raise exception 'Start did not reserve'; end if;
  if (select last_inbound_at from crm_private.bia_whatsapp_threads where id=tid) is not null then raise exception 'Outbound opened inbound window'; end if;
  again:=public.bia_whatsapp_outbound_admin(ch.organization_id,actor,'start',args);
  if again->>'proceed'<>'false' then raise exception 'Duplicate could send again'; end if;
  begin
    perform public.bia_whatsapp_outbound_admin(ch.organization_id,actor,'start',args||jsonb_build_object('id',other_id,'phone','553499999876'));
    raise exception 'Phone variant bypassed duplicate guard';
  exception when others then if sqlerrm<>'BIA_CONTACT_RECENTLY_SENT' then raise; end if; end;
  event:=jsonb_build_object('operation_id',rid,'provider_message_id','wamid.outbound-rollback','recipient_phone','553499999876','status','delivered','occurred_at',now());
  if crm_private.bia_outbound_status(gen_random_uuid(),event) then raise exception 'Wrong channel reconciled'; end if;
  if crm_private.bia_outbound_status(ch.id,event||jsonb_build_object('recipient_phone','5534999999875')) then raise exception 'Wrong recipient reconciled'; end if;
  perform public.bia_whatsapp_webhook(ch.organization_id,ch.phone_number_id,jsonb_build_object('messages','[]'::jsonb,'statuses',jsonb_build_array(event)));
  result:=public.bia_whatsapp_outbound_admin(ch.organization_id,actor,'finish',jsonb_build_object('id',rid,'status','accepted','providerMessageId','wamid.outbound-rollback','recipientPhone','553499999876'));
  if result->>'status'<>'delivered' then raise exception 'Late HTTP success downgraded webhook delivery'; end if;
  perform crm_private.bia_outbound_status(ch.id,event||jsonb_build_object('status','failed','error_code','131042'));
  if (select status from crm_private.bia_whatsapp_outbound where id=rid)<>'delivered' then raise exception 'Out of order failure downgraded delivery'; end if;
  select count(*) into n from crm_private.bia_whatsapp_messages where thread_id=tid;
  if n<>1 then raise exception 'Duplicate outbound history'; end if;
  select count(*) into n from crm_private.public_agent_messages m join crm_private.bia_whatsapp_threads t on t.session_id=m.session_id
    where t.id=tid and m.metadata->>'bia_outbound_id'=rid::text;
  if n<>1 then raise exception 'Assistant context not deduplicated'; end if;
  -- A late mismatched-recipient callback must not fall through to generic message updates.
  perform public.bia_whatsapp_webhook(ch.organization_id,ch.phone_number_id,jsonb_build_object('messages','[]'::jsonb,'statuses',
    jsonb_build_array(event||jsonb_build_object('status','read','recipient_phone','5534999999875'))));
  if (select delivery_status from crm_private.bia_whatsapp_messages where thread_id=tid)<>'delivered' then raise exception 'Wrong recipient changed history'; end if;
  inbound:=jsonb_build_object('provider_message_id','wamid.outbound-inbound-rollback','from_phone','553499999876','content','Tenho interesse','message_type','text','occurred_at',now(),'metadata','{}'::jsonb);
  perform public.bia_whatsapp_webhook(ch.organization_id,ch.phone_number_id,jsonb_build_object('messages',jsonb_build_array(inbound),'statuses','[]'::jsonb));
  if (select thread_id from crm_private.bia_whatsapp_messages where provider_message_id='wamid.outbound-inbound-rollback')<>tid then raise exception 'Reply split into another thread'; end if;
  if (select last_inbound_at from crm_private.bia_whatsapp_threads where id=tid) is null then raise exception 'Actual reply did not open window'; end if;
  if not exists(select 1 from crm_private.bia_whatsapp_reply_jobs where thread_id=tid) then raise exception 'No automated reply queued'; end if;
  update crm_private.bia_whatsapp_outbound set created_at=now()-interval '2 days' where id=rid;
  update crm_private.bia_whatsapp_threads set opted_out_at=now() where id=tid;
  begin
    perform public.bia_whatsapp_outbound_admin(ch.organization_id,actor,'start',args||jsonb_build_object('id',other_id));
    raise exception 'Opted out contact accepted';
  exception when others then if sqlerrm<>'BIA_CONTACT_PAUSED' then raise; end if; end;
  if has_function_privilege('authenticated','public.bia_whatsapp_outbound_admin(uuid,uuid,text,jsonb)','EXECUTE')
    or has_function_privilege('anon','public.bia_whatsapp_outbound_admin(uuid,uuid,text,jsonb)','EXECUTE')
    or has_table_privilege('authenticated','crm_private.bia_whatsapp_outbound','SELECT') then raise exception 'Private sender exposed to browser'; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
  result:=public.bia_whatsapp_inbox(ch.organization_id,tid);
  if jsonb_array_length(result->'messages')<>2 then raise exception 'Admin history missing messages'; end if;
  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  begin
    execute 'set local role anon';
    perform public.bia_whatsapp_outbound_admin(ch.organization_id,actor,'status',jsonb_build_object('id',rid));
    raise exception 'Anonymous service role impersonation accepted';
  exception when insufficient_privilege then null; end;
  execute 'reset role';
end $$;
rollback;
