begin;

create or replace function public.claim_whatsapp_prepared_message(
  p_organization_id uuid,
  p_message_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare m public.crm_messages%rowtype; r public.crm_records%rowtype; phone_value text;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'RPC restrita ao backend WhatsApp.' using errcode='42501'; end if;
  if not exists(select 1 from public.organization_members om where om.organization_id=p_organization_id and om.user_id=p_actor_user_id and om.active) then raise exception 'Revisor nao pertence a organizacao.' using errcode='42501'; end if;
  select * into m from public.crm_messages where organization_id=p_organization_id and id=p_message_id for update;
  if not found or m.channel<>'whatsapp' or m.direction<>'outbound' or m.actor_type<>'ai' then raise exception 'Mensagem WhatsApp supervisionada nao encontrada.'; end if;
  if m.provider_message_id is not null then return jsonb_build_object('claimed',false,'already_sent',true,'provider_message_id',m.provider_message_id,'message_id',m.id); end if;
  if m.delivery_status<>'prepared' then raise exception 'Mensagem nao esta preparada para envio.';
  select * into r from public.crm_records where organization_id=p_organization_id and id=m.crm_record_id for update;
  if not found or r.record_status<>'aberta' then raise exception 'Oportunidade indisponivel para envio.';
  select c.phone into phone_value from public.contacts c where c.organization_id=p_organization_id and c.id=r.contact_id;
  if regexp_replace(coalesce(phone_value,''),'[^0-9]','','g') !~ '^[0-9]{8,20}$' then raise exception 'Contato sem telefone WhatsApp valido.';
  if exists(select 1 from public.contacts c where c.organization_id=p_organization_id and c.id=r.contact_id and (c.do_not_contact_at is not null or lower(coalesce(c.marketing_consent_status,'')) in ('denied','revoked'))) then raise exception 'Contato bloqueado para comunicacao.' using errcode='42501'; end if;
  update public.crm_messages set delivery_status='queued',metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('cloud_send_claimed_at',now(),'cloud_send_claimed_by',p_actor_user_id) where id=m.id;
  return jsonb_build_object('claimed',true,'message_id',m.id,'crm_record_id',m.crm_record_id,'content',m.content,'to_phone',regexp_replace(phone_value,'[^0-9]','','g'));
end
$function$;

create or replace function public.release_whatsapp_send_claim(
  p_organization_id uuid,p_message_id uuid,p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path=''
as $function$
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'RPC restrita ao backend WhatsApp.' using errcode='42501'; end if;
  update public.crm_messages set delivery_status='prepared',metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('cloud_send_last_error',left(trim(coalesce(p_error_code,'WHATSAPP_SEND_FAILED')),128),'cloud_send_failed_at',now())
  where organization_id=p_organization_id and id=p_message_id and channel='whatsapp' and delivery_status='queued' and provider_message_id is null;
  return found;
end
$function$;

revoke all on function public.claim_whatsapp_prepared_message(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_whatsapp_prepared_message(uuid,uuid,uuid) to service_role;
revoke all on function public.release_whatsapp_send_claim(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.release_whatsapp_send_claim(uuid,uuid,text) to service_role;

commit;
