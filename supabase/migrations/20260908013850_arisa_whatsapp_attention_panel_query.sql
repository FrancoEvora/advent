create or replace function public.arisa_whatsapp_attention_admin(p_action text,p_org uuid,p_actor uuid,p_args jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare req crm_private.arisa_whatsapp_authorizations;t public.arisa_whatsapp_threads;rows jsonb;phone text;recipient uuid;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' or not private.arisa_actor_admin(p_org,p_actor) then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
 if p_action='attention' then
  return jsonb_build_object(
   'recipients',(select coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'name',p.full_name,'phone',r.phone,'enabled',coalesce(r.enabled,false)) order by p.full_name),'[]') from public.organization_members m join public.profiles p on p.id=m.user_id left join crm_private.arisa_whatsapp_recipients r on r.organization_id=m.organization_id and r.user_id=m.user_id where m.organization_id=p_org and m.active),
   'requests',(select coalesce(jsonb_agg(to_jsonb(q)),'[]') from(select a.id,a.summary,a.status,a.approved_content,a.created_at,conversation.phone,conversation.contact_name from crm_private.arisa_whatsapp_authorizations a join public.arisa_whatsapp_threads conversation on conversation.id=a.thread_id where a.organization_id=p_org order by a.created_at desc limit 20)q),
   'notices',(select coalesce(jsonb_agg(to_jsonb(q)),'[]') from(select n.title,n.message,p.full_name recipient_name,j.status,j.error_code,m.delivery_status,j.created_at from crm_private.arisa_whatsapp_notice_jobs j join public.activity_notifications n on n.id=j.id join public.profiles p on p.id=j.recipient_user_id left join public.arisa_whatsapp_messages m on m.id=nullif(j.result->>'message_id','')::uuid where j.organization_id=p_org order by j.created_at desc limit 20)q));
 elsif p_action='save_recipient' then
  recipient=(p_args->>'user_id')::uuid;phone=regexp_replace(coalesce(p_args->>'phone',''),'[^0-9]','','g');
  if not exists(select 1 from public.organization_members where organization_id=p_org and user_id=recipient and active) or phone!~'^[1-9][0-9]{7,14}$' or jsonb_typeof(p_args->'enabled') is distinct from 'boolean' then raise exception 'WHATSAPP_RECIPIENT_INVALID';end if;
  insert into crm_private.arisa_whatsapp_recipients(organization_id,user_id,phone,enabled,updated_by) values(p_org,recipient,phone,(p_args->>'enabled')::boolean,p_actor) on conflict(organization_id,user_id) do update set phone=excluded.phone,enabled=excluded.enabled,updated_by=p_actor,updated_at=now();
  update crm_private.arisa_whatsapp_notice_jobs set available_at=now() where organization_id=p_org and recipient_user_id=recipient and status='awaiting_contact';
  perform private.arisa_dispatch_whatsapp_notices();return jsonb_build_object('ok',true);
 end if;
 select * into req from crm_private.arisa_whatsapp_authorizations where id=(p_args->>'id')::uuid and organization_id=p_org for update;
 if req.id is null then raise exception 'WHATSAPP_AUTHORIZATION_NOT_FOUND';end if;
 select * into t from public.arisa_whatsapp_threads where id=req.thread_id and organization_id=p_org;
 if p_action='authorize' then
  if length(trim(coalesce(p_args->>'content',''))) not between 1 and 4096 then raise exception 'WHATSAPP_INVALID';end if;
  if req.status='pending' then
   if t.last_inbound_at is null or t.last_inbound_at<=now()-interval '24 hours' then raise exception 'WHATSAPP_TEMPLATE_REQUIRED';end if;
   update crm_private.arisa_whatsapp_authorizations set status='approved',approved_content=trim(p_args->>'content'),approved_by=p_actor,approved_at=now() where id=req.id returning * into req;
  elsif req.status not in('approved','sent','unknown','failed') or req.approved_by is distinct from p_actor or req.approved_content is distinct from trim(p_args->>'content') then raise exception 'WHATSAPP_AUTHORIZATION_CHANGED';end if;
  return jsonb_build_object('id',req.id,'phone',t.phone,'contact_id',t.contact_id,'content',req.approved_content);
 elsif p_action='deny' and req.status='pending' then
  update crm_private.arisa_whatsapp_authorizations set status='denied',approved_by=p_actor,approved_at=now() where id=req.id;return jsonb_build_object('ok',true);
 elsif p_action='authorization_result' and req.approved_by=p_actor then
  update crm_private.arisa_whatsapp_authorizations set status=case when p_args->'result'->>'accepted_by_meta'='true' then 'sent' else 'unknown' end,result=p_args->'result' where id=req.id;return jsonb_build_object('ok',true);
 end if;
 raise exception 'WHATSAPP_AUTHORIZATION_INVALID';
end $$;
