create or replace function public.verify_public_agent_v2_bearer(p_candidate text,p_request_url text)
returns boolean
language plpgsql
security definer
set search_path=''
as $function$
declare worker_secret text;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'RPC restrita ao runtime da Vitoria.' using errcode='42501'; end if;
  if p_candidate is null or p_candidate<>btrim(p_candidate) or char_length(p_candidate) not between 32 and 512 or p_candidate~'[[:space:]]' or p_request_url is null or p_request_url<>btrim(p_request_url) or char_length(p_request_url)>2048 or p_request_url~'[[:space:]@#?]' then return false; end if;
  select decrypted_secret into worker_secret from vault.decrypted_secrets where name='evora_crm_ai_worker_secret' order by created_at desc limit 1;
  if worker_secret is null then return false; end if;
  return p_request_url in (
    'https://qsdffayasuzsmngteika.supabase.co/functions/v1/enterprise-public-agent-v2',
    'http://qsdffayasuzsmngteika.supabase.co/enterprise-public-agent-v2'
  ) and extensions.digest(convert_to(worker_secret,'UTF8'),'sha256')=extensions.digest(convert_to(p_candidate,'UTF8'),'sha256');
end
$function$;
revoke all on function public.verify_public_agent_v2_bearer(text,text) from public,anon,authenticated;
grant execute on function public.verify_public_agent_v2_bearer(text,text) to service_role;
