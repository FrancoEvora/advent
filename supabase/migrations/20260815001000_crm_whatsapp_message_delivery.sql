begin;

create or replace function public.mark_whatsapp_message_sent(
  p_organization_id uuid,
  p_message_id uuid,
  p_provider_message_id text,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare m public.crm_messages%rowtype;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'RPC restrita ao backend WhatsApp.' using errcode='42501'; end if;
  select * into m from public.crm_messages where organization_id=p_organization_id and id=p_message_id for update;
  if not found or m.channel<>'whatsapp' or m.direction<>'outbound' then raise exception 'Mensagem WhatsApp outbound nao encontrada.'; end if;
  if m.delivery_status not in ('prepared','queued','sent','delivered','read') then raise exception 'Mensagem nao esta pronta para envio.'; end if;
  if m.provider_message_id is not null then
    if m.provider_message_id<>trim(p_provider_message_id) then raise exception 'Mensagem ja vinculada a outro provider ID.'; end if;
    return jsonb_build_object('message_id',m.id,'provider_message_id',m.provider_message_id,'delivery_status',m.delivery_status,'idempotent',true);
  end if;
  update public.crm_messages set provider_message_id=trim(p_provider_message_id),delivery_status='sent',metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('cloud_sent_at',now(),'cloud_sent_by',p_actor_user_id) where id=m.id;
  insert into public.crm_opportunity_events(organization_id,crm_record_id,opportunity_key,actor_type,actor_user_id,event_type,event_source,channel,occurred_at,idempotency_key,data)
  values(p_organization_id,m.crm_record_id,m.crm_record_id,'human',p_actor_user_id,'whatsapp_message_sent','whatsapp_cloud','whatsapp',now(),'whatsapp-sent:'||m.id::text,jsonb_build_object('message_id',m.id,'provider_message_id',trim(p_provider_message_id),'external_delivery',true))
  on conflict(organization_id,idempotency_key) where idempotency_key is not null do nothing;
  return jsonb_build_object('message_id',m.id,'provider_message_id',trim(p_provider_message_id),'delivery_status','sent','idempotent',false);
end
$function$;

create or replace function public.apply_whatsapp_message_status(
  p_organization_id uuid,
  p_provider_message_id text,
  p_status text,
  p_occurred_at timestamptz default null,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare m public.crm_messages%rowtype; normalized text; rank_current int; rank_new int;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'RPC restrita ao webhook WhatsApp.' using errcode='42501'; end if;
  normalized:=lower(trim(coalesce(p_status,'')));
  if normalized not in ('sent','delivered','read','failed') then return jsonb_build_object('updated',false,'ignored',true); end if;
  select * into m from public.crm_messages where organization_id=p_organization_id and channel='whatsapp' and provider_message_id=trim(p_provider_message_id) limit 1 for update;
  if not found then return jsonb_build_object('updated',false,'missing',true); end if;
  if normalized='failed' then
    update public.crm_messages set delivery_status='failed',metadata=coalesce(metadata,'{}'::jsonb)||jsonb_strip_nulls(jsonb_build_object('provider_failed_at',coalesce(p_occurred_at,now()),'provider_error_code',left(p_error_code,128))) where id=m.id;
    return jsonb_build_object('updated',true,'message_id',m.id,'status','failed');
  end if;
  rank_current:=case m.delivery_status when 'read' then 4 when 'delivered' then 3 when 'sent' then 2 else 1 end;
  rank_new:=case normalized when 'read' then 4 when 'delivered' then 3 when 'sent' then 2 else 1 end;
  if rank_new>rank_current then
    update public.crm_messages set delivery_status=normalized,metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('provider_status_at',coalesce(p_occurred_at,now())) where id=m.id;
    return jsonb_build_object('updated',true,'message_id',m.id,'status',normalized);
  end if;
  return jsonb_build_object('updated',false,'message_id',m.id,'status',m.delivery_status,'idempotent',true);
end
$function$;

revoke all on function public.mark_whatsapp_message_sent(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.mark_whatsapp_message_sent(uuid,uuid,text,uuid) to service_role;
revoke all on function public.apply_whatsapp_message_status(uuid,text,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.apply_whatsapp_message_status(uuid,text,text,timestamptz,text) to service_role;

commit;
