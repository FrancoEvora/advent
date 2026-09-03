begin;

drop trigger if exists trg_public_agent_implicit_service_contact on crm_private.public_agent_sessions;
create trigger trg_public_agent_implicit_service_contact
before insert or update of contact_capture, captured_profile
on crm_private.public_agent_sessions
for each row
execute function crm_private.apply_public_agent_implicit_service_contact();

-- Recalcula os indicadores internos para sessões que já possuem contato capturado.
update crm_private.public_agent_sessions
set captured_profile = coalesce(captured_profile, '{}'::jsonb)
  || jsonb_build_object(
    'contact_name_captured', nullif(trim(coalesce(contact_capture->>'name', '')), '') is not null,
    'contact_phone_captured', nullif(trim(coalesce(contact_capture->>'phone', '')), '') is not null
  )
where contact_capture <> '{}'::jsonb;

commit;
