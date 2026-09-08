create or replace function public.arisa_whatsapp_notice_worker(p_action text,p_args jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare j crm_private.arisa_whatsapp_notice_jobs;r crm_private.arisa_whatsapp_recipients;v_result jsonb;window_open boolean;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'SERVICE_REQUIRED' using errcode='42501';end if;
 if p_action='claim' then
  update crm_private.arisa_whatsapp_notice_jobs set status='unknown',error_code='WHATSAPP_NOTICE_SEND_INTERRUPTED',updated_at=now() where status='sending' and lease_until<now();
  update crm_private.arisa_whatsapp_notice_jobs set status='pending',available_at=now(),updated_at=now() where status='processing' and lease_until<now();
  for j in select * from crm_private.arisa_whatsapp_notice_jobs where status in('pending','awaiting_contact','awaiting_template') and available_at<=now() order by created_at limit 30 for update skip locked loop
   if not exists(select 1 from public.organization_members where organization_id=j.organization_id and user_id=j.recipient_user_id and active) or not private.arisa_actor_admin(j.organization_id,j.actor_user_id) then
    update crm_private.arisa_whatsapp_notice_jobs set status='skipped',error_code='USER_INACTIVE',updated_at=now() where id=j.id;continue;end if;
   if not exists(select 1 from crm_private.arisa_whatsapp_channel where organization_id=j.organization_id and enabled) then continue;end if;
   select * into r from crm_private.arisa_whatsapp_recipients where organization_id=j.organization_id and user_id=j.recipient_user_id and enabled;
   if r.phone is null then
    update crm_private.arisa_whatsapp_notice_jobs set status='awaiting_contact',available_at=now()+interval '5 minutes',updated_at=now() where id=j.id;
    update public.activity_notifications set metadata=metadata||jsonb_build_object('whatsapp_status','awaiting_contact') where id=j.id;continue;end if;
   select exists(select 1 from public.arisa_whatsapp_threads t join crm_private.whatsapp_runtime_settings rt on rt.organization_id=t.organization_id and rt.phone_number_id=t.phone_number_id where t.organization_id=j.organization_id and t.phone=r.phone and t.last_inbound_at>now()-interval '24 hours') into window_open;
   update crm_private.arisa_whatsapp_notice_jobs set status='processing',phone=r.phone,lease=gen_random_uuid(),lease_until=now()+interval '3 minutes',attempts=attempts+1,updated_at=now() where id=j.id returning * into j;
   return to_jsonb(j)-'result'||jsonb_build_object('window_open',window_open);
  end loop;return '{}';
 end if;
 select * into j from crm_private.arisa_whatsapp_notice_jobs where id=(p_args->>'id')::uuid for update;
 if j.id is null or j.lease is distinct from (p_args->>'lease')::uuid or j.lease_until<=now() then raise exception 'WHATSAPP_NOTICE_LEASE_CHANGED';end if;
 if p_action='send' and j.status='processing' then
  if not exists(select 1 from crm_private.arisa_whatsapp_recipients bound join public.organization_members member using(organization_id,user_id) where bound.organization_id=j.organization_id and bound.user_id=j.recipient_user_id and bound.enabled and bound.phone=j.phone and member.active) then
   update crm_private.arisa_whatsapp_notice_jobs set status='awaiting_contact',available_at=now()+interval '5 minutes' where id=j.id;return jsonb_build_object('proceed',false);end if;
  update crm_private.arisa_whatsapp_notice_jobs set status='sending',updated_at=now() where id=j.id;return jsonb_build_object('proceed',true,'phone',j.phone);
 elsif p_action='defer' and j.status='processing' then
  update crm_private.arisa_whatsapp_notice_jobs set status='awaiting_template',available_at=now()+interval '5 minutes',updated_at=now() where id=j.id;
 elsif p_action='finish' and j.status='sending' then
  v_result=p_args->'result';update crm_private.arisa_whatsapp_notice_jobs set status=case when v_result->>'accepted_by_meta'='true' then 'sent' else 'unknown' end,result=v_result,updated_at=now() where id=j.id;
 elsif p_action='fail' and j.status in('processing','sending') then
  update crm_private.arisa_whatsapp_notice_jobs set status=case when j.status='sending' then 'unknown' when attempts>=3 then 'failed' else 'pending' end,available_at=now()+interval '5 minutes',error_code=left(p_args->>'error',128),updated_at=now() where id=j.id;
 else raise exception 'WHATSAPP_NOTICE_INVALID';end if;
 update public.activity_notifications n set metadata=n.metadata||jsonb_build_object('whatsapp_status',q.status,'whatsapp_operation_id',q.result->>'operation_id') from crm_private.arisa_whatsapp_notice_jobs q where n.id=j.id and q.id=j.id;
 return jsonb_build_object('ok',true);
end $$;
