begin;

create or replace function crm_private.capture_whatsapp_inbound_context()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  if new.channel<>'whatsapp' or new.direction<>'inbound' or new.actor_type<>'lead' then return new; end if;
  update public.crm_records
  set first_response_at=coalesce(first_response_at,new.occurred_at),
      last_contact_at=greatest(coalesce(last_contact_at,'epoch'::timestamptz),new.occurred_at),
      source_channel=case when source_channel is null or source_channel='' then 'whatsapp_inbound' else source_channel end,
      updated_at=now()
  where organization_id=new.organization_id and id=new.crm_record_id;

  insert into public.crm_actions(
    organization_id,crm_record_id,action_type,subject,completed_at,action_status,channel,outcome,metadata
  ) values (
    new.organization_id,new.crm_record_id,'mensagem_recebida',
    left('Mensagem recebida no WhatsApp: '||new.content,1200),new.occurred_at,'concluida','whatsapp','cliente_respondeu',
    jsonb_build_object('provider_message_id',new.provider_message_id,'crm_message_id',new.id,'actor','lead')
  );
  return new;
end
$function$;

revoke all on function crm_private.capture_whatsapp_inbound_context() from public,anon,authenticated;
grant execute on function crm_private.capture_whatsapp_inbound_context() to service_role;

drop trigger if exists crm_messages_whatsapp_inbound_context on public.crm_messages;
create trigger crm_messages_whatsapp_inbound_context
after insert on public.crm_messages
for each row execute function crm_private.capture_whatsapp_inbound_context();

commit;
