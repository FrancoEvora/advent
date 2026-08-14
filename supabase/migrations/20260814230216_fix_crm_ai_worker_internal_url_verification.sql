-- Corrige a validação da URL interna usada pelo Supabase Edge Runtime.
-- A implementação anterior sobre-escapava backreferences em regexp_replace,
-- produzindo uma URL literal inválida e recusando o bearer legítimo.

set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.verify_crm_ai_worker_bearer(
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
  internal_worker_url text;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'RPC restrita ao runtime da Vitoria.' using errcode = '42501';
  end if;

  if p_candidate is null
     or p_candidate <> btrim(p_candidate)
     or char_length(p_candidate) not between 32 and 512
     or p_candidate ~ '[[:space:]]'
     or p_request_url is null
     or p_request_url <> btrim(p_request_url)
     or char_length(p_request_url) > 2048
     or p_request_url ~ '[[:space:]@#?]' then
    return false;
  end if;

  select secret.decrypted_secret
    into worker_url
    from vault.decrypted_secrets secret
   where secret.name = 'evora_crm_ai_worker_url'
   order by secret.created_at desc
   limit 1;

  select secret.decrypted_secret
    into worker_secret
    from vault.decrypted_secrets secret
   where secret.name = 'evora_crm_ai_worker_secret'
   order by secret.created_at desc
   limit 1;

  if worker_url is null or worker_secret is null then
    return false;
  end if;

  internal_worker_url :=
    'http://' || split_part(worker_url, '/', 3) || '/' ||
    split_part(worker_url, '/functions/v1/', 2);

  return (
    worker_url = p_request_url
    or internal_worker_url = p_request_url
  )
  and extensions.digest(convert_to(worker_secret, 'UTF8'), 'sha256') =
      extensions.digest(convert_to(p_candidate, 'UTF8'), 'sha256');
end
$function$;

revoke all on function public.verify_crm_ai_worker_bearer(text, text)
  from public, anon, authenticated;
grant execute on function public.verify_crm_ai_worker_bearer(text, text)
  to service_role;

comment on function public.verify_crm_ai_worker_bearer(text, text) is
  'Valida bearer e URL publica/interna do Edge worker da Vitoria sem exportar o segredo do Vault.';
