create function public.arisa_my_whatsapp_notifications(p_organization_id uuid,p_phone text default null,p_enabled boolean default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();v_phone text;r crm_private.arisa_whatsapp_recipients;
begin
 if actor is null or not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=actor and active) then raise exception 'MEMBER_REQUIRED' using errcode='42501';end if;
 if p_phone is not null then
  v_phone=regexp_replace(p_phone,'[^0-9]','','g');
  if v_phone!~'^[1-9][0-9]{7,14}$' or p_enabled is null then raise exception 'WHATSAPP_PHONE_INVALID';end if;
  if exists(select 1 from crm_private.arisa_whatsapp_recipients where organization_id=p_organization_id and user_id<>actor and phone=any(crm_private.whatsapp_phone_variants(v_phone))) then raise exception 'WHATSAPP_PHONE_ALREADY_LINKED';end if;
  insert into crm_private.arisa_whatsapp_recipients(organization_id,user_id,phone,enabled,updated_by) values(p_organization_id,actor,v_phone,p_enabled,actor)
   on conflict(organization_id,user_id) do update set phone=excluded.phone,enabled=excluded.enabled,updated_by=actor,updated_at=now();
  update crm_private.arisa_whatsapp_notice_jobs set available_at=now() where organization_id=p_organization_id and recipient_user_id=actor and status='awaiting_contact';
  perform private.arisa_dispatch_whatsapp_notices();
 end if;
 select * into r from crm_private.arisa_whatsapp_recipients where organization_id=p_organization_id and user_id=actor;
 return jsonb_build_object('phone',r.phone,'enabled',coalesce(r.enabled,false));
end $$;
revoke all on function public.arisa_my_whatsapp_notifications(uuid,text,boolean) from public,anon;
grant execute on function public.arisa_my_whatsapp_notifications(uuid,text,boolean) to authenticated,service_role;

