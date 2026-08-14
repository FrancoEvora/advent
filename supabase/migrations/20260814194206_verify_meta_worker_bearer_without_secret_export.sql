-- Valida a credencial do worker dentro do banco, sem devolver o segredo do Vault
-- ao runtime da Vercel. A função só confirma igualdade criptográfica e URL.

create or replace function public.verify_meta_worker_bearer(
  p_candidate text,
  p_request_url text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  worker_url text;
  worker_secret text;
begin
  if p_candidate is null
     or p_candidate <> btrim(p_candidate)
     or char_length(p_candidate) not between 32 and 512
     or p_candidate ~ '[[:space:]]'
     or p_request_url is null
     or p_request_url <> btrim(p_request_url)
     or char_length(p_request_url) > 2048
     or p_request_url !~ '^https://([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9])/api/integrations/meta/leads/process$' then
    return false;
  end if;

  select secret.decrypted_secret
  into worker_url
  from vault.decrypted_secrets secret
  where secret.name = 'evora_meta_worker_url'
  order by secret.created_at desc
  limit 1;

  select secret.decrypted_secret
  into worker_secret
  from vault.decrypted_secrets secret
  where secret.name = 'evora_meta_worker_secret'
  order by secret.created_at desc
  limit 1;

  if worker_url is null or worker_secret is null then
    return false;
  end if;

  return worker_url = p_request_url
    and extensions.digest(convert_to(worker_secret, 'UTF8'), 'sha256')
        = extensions.digest(convert_to(p_candidate, 'UTF8'), 'sha256');
end
$function$;

revoke all on function public.verify_meta_worker_bearer(text,text) from public;
grant execute on function public.verify_meta_worker_bearer(text,text)
  to anon, authenticated, service_role;
