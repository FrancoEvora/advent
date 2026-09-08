create or replace function public.arisa_whatsapp_reply_worker(p_action text,p_args jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare j crm_private.arisa_whatsapp_reply_jobs;t public.arisa_whatsapp_threads;c public.contacts;m public.arisa_whatsapp_messages;history jsonb;reason text;v_result jsonb;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'SERVICE_REQUIRED' using errcode='42501';end if;
  if p_action='claim' then
    update crm_private.arisa_whatsapp_reply_jobs set status='unknown',error_code='WHATSAPP_REPLY_SEND_INTERRUPTED',updated_at=now() where status='sending' and lease_until<now();
    update crm_private.arisa_whatsapp_reply_jobs set status=case when attempts<3 then 'pending' else 'failed' end,available_at=now(),lease=null,lease_until=null,updated_at=now() where status='processing' and lease_until<now();
    for j in select q.* from crm_private.arisa_whatsapp_reply_jobs q where q.status='pending' and q.available_at<=now()
      and not exists(select 1 from crm_private.arisa_whatsapp_reply_jobs other where other.thread_id=q.thread_id and other.status in('processing','sending') and other.lease_until>=now())
      order by q.created_at,q.id limit 30 for update skip locked loop
      -- Serialize claims per conversation even when two different jobs are claimed concurrently.
      if not pg_try_advisory_xact_lock(hashtextextended('arisa-whatsapp-reply:'||j.thread_id::text,0)) then continue;end if;
      if exists(select 1 from crm_private.arisa_whatsapp_reply_jobs other where other.thread_id=j.thread_id and other.id<>j.id and other.status in('processing','sending') and other.lease_until>=now()) then continue;end if;
      select * into t from public.arisa_whatsapp_threads where id=j.thread_id and organization_id=j.organization_id;
      select * into c from public.contacts where id=t.contact_id and organization_id=j.organization_id;
      select * into m from public.arisa_whatsapp_messages where id=j.id;
      reason=null;
      if not exists(select 1 from crm_private.arisa_whatsapp_channel ch join crm_private.whatsapp_runtime_settings rt using(organization_id) where ch.organization_id=j.organization_id and ch.enabled and ch.auto_reply_enabled and not rt.enabled and rt.phone_number_id=t.phone_number_id) or not private.arisa_actor_admin(j.organization_id,j.actor_user_id) then reason='WHATSAPP_REPLY_DISABLED';
      elsif t.opted_out_at is not null or (t.contact_id is not null and (c.id is null or not c.active)) or c.do_not_contact_at is not null or lower(coalesce(c.marketing_consent_status,'')) in('denied','revoked') then reason='WHATSAPP_CONTACT_BLOCKED';
      elsif m.occurred_at<=now()-interval '24 hours' then reason='WHATSAPP_REPLY_EXPIRED';
      elsif exists(select 1 from public.arisa_whatsapp_messages newer where newer.thread_id=j.thread_id and newer.direction='inbound' and (newer.occurred_at,newer.created_at,newer.id)>(m.occurred_at,m.created_at,m.id)) then reason='WHATSAPP_REPLY_SUPERSEDED';end if;
      if reason is not null then update crm_private.arisa_whatsapp_reply_jobs set status='skipped',error_code=reason,updated_at=now() where id=j.id;continue;end if;
      update crm_private.arisa_whatsapp_reply_jobs set status='processing',attempts=attempts+1,lease=gen_random_uuid(),lease_until=now()+interval '3 minutes',updated_at=now() where id=j.id returning * into j;
      select coalesce(jsonb_agg(jsonb_build_object('id',h.id,'direction',h.direction,'content',h.content,'occurred_at',h.occurred_at) order by h.occurred_at,h.created_at,h.id),'[]') into history from (
        select h.id,h.direction,h.content,h.occurred_at,h.created_at from public.arisa_whatsapp_messages h
        where h.organization_id=j.organization_id and h.thread_id=j.thread_id and (h.direction='inbound' or h.delivery_status in('accepted','sent','delivered','read'))
        order by h.occurred_at desc,h.created_at desc,h.id desc limit 20
      ) h;
      return jsonb_build_object('id',j.id,'lease',j.lease,'organization_id',j.organization_id,'actor_user_id',j.actor_user_id,'phone',t.phone,'contact_id',t.contact_id,'history',history);
    end loop;
    return '{}'::jsonb;
  end if;
  select * into j from crm_private.arisa_whatsapp_reply_jobs where id=(p_args->>'id')::uuid for update;
  if j.id is null or j.lease is distinct from (p_args->>'lease')::uuid or j.lease_until<=now() then raise exception 'WHATSAPP_REPLY_LEASE_CHANGED';end if;
  if p_action='send' then
    if j.status<>'processing' then return jsonb_build_object('proceed',false);end if;
    select * into t from public.arisa_whatsapp_threads where id=j.thread_id;
    select * into m from public.arisa_whatsapp_messages where id=j.id;
    if t.opted_out_at is not null or m.occurred_at<=now()-interval '24 hours' or not exists(select 1 from crm_private.arisa_whatsapp_channel ch join crm_private.whatsapp_runtime_settings rt using(organization_id) where ch.organization_id=j.organization_id and ch.enabled and ch.auto_reply_enabled and not rt.enabled and rt.phone_number_id=t.phone_number_id)
      or exists(select 1 from public.arisa_whatsapp_messages newer where newer.thread_id=j.thread_id and newer.direction='inbound' and (newer.occurred_at,newer.created_at,newer.id)>(m.occurred_at,m.created_at,m.id)) then
      update crm_private.arisa_whatsapp_reply_jobs set status='skipped',error_code='WHATSAPP_REPLY_CONTEXT_CHANGED',updated_at=now() where id=j.id;return jsonb_build_object('proceed',false);
    end if;
    if exists(select 1 from crm_private.arisa_whatsapp_finance_events where message_id=j.id and disclosed) and not private.arisa_finance_valid(j.thread_id,j.organization_id) then
      update crm_private.arisa_whatsapp_reply_jobs set status='skipped',error_code='WHATSAPP_FINANCE_IDENTITY_CHANGED',updated_at=now() where id=j.id;return jsonb_build_object('proceed',false);
    end if;
    if length(trim(coalesce(p_args->>'content',''))) not between 1 and 4096 or pg_column_size(p_args)>32768 then raise exception 'WHATSAPP_REPLY_INVALID';end if;
    update crm_private.arisa_whatsapp_reply_jobs set status='sending',generated_content=p_args->>'content',response_id=left(p_args->>'response_id',200),model=left(p_args->>'model',100),usage=p_args->'usage',updated_at=now() where id=j.id;
    return jsonb_build_object('proceed',true);
  elsif p_action='finish' and j.status='sending' then
    v_result=p_args->'result';
    update crm_private.arisa_whatsapp_reply_jobs set status=case when v_result->>'accepted_by_meta'='true' then 'sent' when v_result->>'status'='failed' then 'failed' else 'unknown' end,result=v_result,updated_at=now() where id=j.id;
    update public.arisa_whatsapp_messages set metadata=metadata||jsonb_build_object('auto_reply',true,'reply_to_message_id',j.id) where id=nullif(v_result->>'message_id','')::uuid and organization_id=j.organization_id and thread_id=j.thread_id;
    return jsonb_build_object('ok',true);
  elsif p_action='fail' and j.status in('processing','sending') then
    update crm_private.arisa_whatsapp_reply_jobs set status=case when j.status='sending' then 'unknown' when attempts>=3 then 'failed' else 'pending' end,available_at=now()+interval '1 minute'*greatest(attempts,1),error_code=left(p_args->>'error',128),updated_at=now() where id=j.id;
    return jsonb_build_object('ok',true);
  end if;
  raise exception 'WHATSAPP_REPLY_INVALID';
end $$;
