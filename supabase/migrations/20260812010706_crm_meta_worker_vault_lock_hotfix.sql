-- Hotfix de compatibilidade com o ACL real do Supabase Vault.
--
-- O papel owner da funcao pode ler vault.secrets e executar as funcoes
-- oficiais do Vault, mas nao possui UPDATE direto na tabela. SELECT ... FOR
-- UPDATE exige esse privilegio mesmo quando nenhuma coluna e atualizada.
-- O advisory lock abaixo ja serializa toda criacao/rotacao do par do worker;
-- portanto o lock de linha era redundante e impedia a configuracao em producao.

do $preflight$
begin
  if to_regprocedure(
       'crm_integration_private.configure_meta_worker_runtime(text,boolean)'
     ) is null
     or to_regclass('vault.secrets') is null
     or to_regprocedure('vault.create_secret(text,text,text,uuid)') is null
     or to_regprocedure(
       'vault.update_secret(uuid,text,text,text,uuid)'
     ) is null then
    raise exception 'Pre-requisitos do worker Meta/Vault nao encontrados.';
  end if;
end
$preflight$;

create or replace function crm_integration_private.configure_meta_worker_runtime(
  p_worker_url text,
  p_rotate_secret boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  worker_url_id uuid;
  worker_secret_id uuid;
begin
  if p_worker_url is null
     or p_worker_url <> btrim(p_worker_url)
     or char_length(p_worker_url) > 2048
     or p_worker_url !~
       '^https://([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9])/api/integrations/meta/leads/process$'
     or p_worker_url ~ '[[:space:]@#]' then
    raise exception 'URL HTTPS do worker Meta invalida.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('evora-meta-worker-runtime', 0)
  );

  select secret.id
  into worker_url_id
  from vault.secrets secret
  where secret.name = 'evora_meta_worker_url'
  order by secret.created_at desc
  limit 1;

  if worker_url_id is null then
    perform vault.create_secret(
      new_secret := p_worker_url,
      new_name := 'evora_meta_worker_url',
      new_description := 'Evora internal endpoint; kind=meta_worker_url',
      new_key_id := null
    );
  else
    perform vault.update_secret(
      secret_id := worker_url_id,
      new_secret := p_worker_url,
      new_name := null,
      new_description := 'Evora internal endpoint; kind=meta_worker_url',
      new_key_id := null
    );
  end if;

  select secret.id
  into worker_secret_id
  from vault.secrets secret
  where secret.name = 'evora_meta_worker_secret'
  order by secret.created_at desc
  limit 1;

  if worker_secret_id is null then
    perform vault.create_secret(
      new_secret := encode(extensions.gen_random_bytes(32), 'hex'),
      new_name := 'evora_meta_worker_secret',
      new_description :=
        'Evora internal credential; kind=meta_worker_secret',
      new_key_id := null
    );
  elsif coalesce(p_rotate_secret, false) then
    perform vault.update_secret(
      secret_id := worker_secret_id,
      new_secret := encode(extensions.gen_random_bytes(32), 'hex'),
      new_name := null,
      new_description :=
        'Evora internal credential; kind=meta_worker_secret',
      new_key_id := null
    );
  end if;

  return jsonb_build_object(
    'worker_url_configured', true,
    'worker_secret_configured', true,
    'worker_secret_rotated', coalesce(p_rotate_secret, false)
  );
end
$function$;

revoke all on function
  crm_integration_private.configure_meta_worker_runtime(text, boolean)
  from public, anon, authenticated, service_role;

do $postflight$
declare
  operator_worker oid := to_regprocedure(
    'crm_integration_private.configure_meta_worker_runtime(text,boolean)'
  );
  operator_definition text;
begin
  select lower(pg_get_functiondef(operator_worker))
  into operator_definition;

  if operator_worker is null
     or not (select procedure_row.prosecdef
             from pg_proc procedure_row
             where procedure_row.oid = operator_worker)
     or not coalesce(
       (select procedure_row.proconfig
        from pg_proc procedure_row
        where procedure_row.oid = operator_worker),
       '{}'::text[]
     ) @> array['search_path=""']::text[]
     or pg_get_userbyid(
       (select procedure_row.proowner
        from pg_proc procedure_row
        where procedure_row.oid = operator_worker)
     ) <> 'postgres'
     or position('pg_advisory_xact_lock' in operator_definition) = 0
     or position('for update' in operator_definition) <> 0
     or has_function_privilege(
       'anon', operator_worker, 'EXECUTE'
     )
     or has_function_privilege(
       'authenticated', operator_worker, 'EXECUTE'
     )
     or has_function_privilege(
       'service_role', operator_worker, 'EXECUTE'
     ) then
    raise exception 'Hotfix do worker Meta perdeu lock logico, owner ou ACL.';
  end if;
end
$postflight$;
