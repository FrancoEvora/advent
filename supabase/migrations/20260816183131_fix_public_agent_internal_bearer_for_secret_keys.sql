create or replace function public.get_public_agent_internal_bearer()
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  internal_bearer text;
begin
  select secret.decrypted_secret
    into internal_bearer
    from vault.decrypted_secrets secret
   where secret.name = 'evora_crm_ai_worker_secret'
   order by secret.created_at desc
   limit 1;

  if internal_bearer is null
     or char_length(internal_bearer) not between 32 and 512
     or internal_bearer ~ '[[:space:]]' then
    raise exception 'PUBLIC_AGENT_INTERNAL_BEARER_UNAVAILABLE';
  end if;

  return internal_bearer;
end
$function$;

revoke all on function public.get_public_agent_internal_bearer()
  from public, anon, authenticated;
grant execute on function public.get_public_agent_internal_bearer()
  to service_role;
