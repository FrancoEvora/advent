-- Evora Enterprise - Stage 3: credenciais Meta gerenciadas pela plataforma.
--
-- Principios desta fronteira:
--   * nenhum segredo e armazenado em tabelas publicas;
--   * valores ficam cifrados pelo Supabase Vault;
--   * o browser recebe somente estado, versao e timestamps;
--   * implementacoes administrativas privilegiadas vivem em crm_private;
--   * somente RPCs runtime estritamente service_role devolvem plaintext ao
--     servidor Next.js;
--   * Page ID pertence a uma unica organizacao, mesmo antes de haver Form ID.

set lock_timeout = '5s';
set statement_timeout = '120s';

do $preflight$
begin
  if to_regclass('public.organizations') is null
     or to_regclass('public.crm_meta_lead_routes') is null
     or to_regnamespace('crm_private') is null
     or to_regnamespace('crm_integration_private') is null
     or to_regprocedure('public.has_app_permission(uuid,text)') is null
     or to_regprocedure(
          'vault.create_secret(text,text,text,uuid)'
        ) is null
     or to_regprocedure(
          'vault.update_secret(uuid,text,text,text,uuid)'
        ) is null
     or to_regprocedure(
          'extensions.gen_random_bytes(integer)'
        ) is null
     or to_regclass('vault.secrets') is null
     or to_regclass('vault.decrypted_secrets') is null then
    raise exception
      'Stage 2 Meta, crm_private e Supabase Vault sao obrigatorios.';
  end if;

  if exists (
    select 1
    from public.crm_meta_lead_routes route
    group by route.page_id
    having count(distinct route.organization_id) > 1
  ) then
    raise exception
      'Um Page ID Meta existente esta vinculado a mais de uma organizacao.';
  end if;

  if to_regclass(
       'crm_integration_private.meta_app_credential_bindings'
     ) is not null
     or to_regclass(
       'crm_integration_private.meta_page_credential_bindings'
     ) is not null
     or to_regclass(
       'crm_integration_private.meta_credential_audit'
     ) is not null
     or to_regprocedure(
       'public.get_meta_lead_credential_status(uuid)'
     ) is not null
     or to_regprocedure(
       'public.configure_meta_lead_credentials(uuid,text,text,text,text)'
     ) is not null
     or to_regprocedure(
       'public.revoke_meta_lead_credential(uuid,text,text)'
     ) is not null
     or to_regprocedure(
       'public.get_meta_webhook_runtime_credentials(text[])'
     ) is not null
     or to_regprocedure(
       'public.get_meta_graph_runtime_credentials(uuid,text)'
     ) is not null
     or to_regprocedure(
       'public.get_meta_worker_runtime_credentials()'
     ) is not null then
    raise exception 'A fronteira de credenciais Meta ja existe.';
  end if;
end
$preflight$;

create table crm_integration_private.meta_app_credential_bindings (
  organization_id uuid primary key
    references public.organizations(id) on delete cascade,
  app_secret_vault_id uuid unique
    references vault.secrets(id) on delete restrict,
  app_secret_version integer not null default 0,
  app_secret_configured_at timestamptz,
  app_secret_changed_at timestamptz,
  verify_token_vault_id uuid unique
    references vault.secrets(id) on delete restrict,
  verify_token_version integer not null default 0,
  verify_token_configured_at timestamptz,
  verify_token_changed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meta_app_credentials_distinct_vault_ids_check
    check (
      app_secret_vault_id is null
      or verify_token_vault_id is null
      or app_secret_vault_id <> verify_token_vault_id
    ),
  constraint meta_app_credentials_app_state_check
    check (
      (app_secret_vault_id is null) =
        (app_secret_configured_at is null)
      and (
        (app_secret_version = 0 and app_secret_changed_at is null)
        or (app_secret_version > 0 and app_secret_changed_at is not null)
      )
    ),
  constraint meta_app_credentials_verify_state_check
    check (
      (verify_token_vault_id is null) =
        (verify_token_configured_at is null)
      and (
        (verify_token_version = 0 and verify_token_changed_at is null)
        or (verify_token_version > 0 and verify_token_changed_at is not null)
      )
    ),
  constraint meta_app_credentials_version_check
    check (
      app_secret_version between 0 and 2147483646
      and verify_token_version between 0 and 2147483646
    )
);

create table crm_integration_private.meta_page_credential_bindings (
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  page_id text not null,
  access_token_vault_id uuid unique
    references vault.secrets(id) on delete restrict,
  access_token_version integer not null default 0,
  access_token_configured_at timestamptz,
  access_token_changed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, page_id),
  constraint meta_page_credentials_page_id_key unique (page_id),
  constraint meta_page_credentials_page_id_check
    check (
      page_id = trim(page_id)
      and page_id ~ '^[0-9]{1,64}$'
    ),
  constraint meta_page_credentials_token_state_check
    check (
      (access_token_vault_id is null) =
        (access_token_configured_at is null)
      and (
        (access_token_version = 0 and access_token_changed_at is null)
        or (access_token_version > 0 and access_token_changed_at is not null)
      )
    ),
  constraint meta_page_credentials_version_check
    check (access_token_version between 0 and 2147483646)
);

-- Ledger privado deliberadamente sem colunas JSON livres. Assim, nem mesmo
-- metadados de auditoria podem receber acidentalmente token, secret ou hash.
create table crm_integration_private.meta_credential_audit (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  page_id text,
  credential_kind text not null,
  action text not null,
  credential_version integer not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  occurred_at timestamptz not null default now(),
  constraint meta_credential_audit_page_check
    check (
      page_id is null
      or (
        page_id = trim(page_id)
        and page_id ~ '^[0-9]{1,64}$'
      )
    ),
  constraint meta_credential_audit_kind_check
    check (credential_kind in (
      'app_secret',
      'verify_token',
      'access_token',
      'page_registration'
    )),
  constraint meta_credential_audit_action_check
    check (action in (
      'configured',
      'rotated',
      'revoked',
      'registered',
      'unregistered'
    )),
  constraint meta_credential_audit_version_check
    check (credential_version between 0 and 2147483647),
  constraint meta_credential_audit_scope_check
    check (
      (credential_kind in ('app_secret', 'verify_token') and page_id is null)
      or (credential_kind in ('access_token', 'page_registration')
          and page_id is not null)
    )
);

create index meta_app_credentials_created_by_fk_idx
  on crm_integration_private.meta_app_credential_bindings (created_by)
  where created_by is not null;
create index meta_app_credentials_updated_by_fk_idx
  on crm_integration_private.meta_app_credential_bindings (updated_by)
  where updated_by is not null;
create index meta_page_credentials_created_by_fk_idx
  on crm_integration_private.meta_page_credential_bindings (created_by)
  where created_by is not null;
create index meta_page_credentials_updated_by_fk_idx
  on crm_integration_private.meta_page_credential_bindings (updated_by)
  where updated_by is not null;
create index meta_credential_audit_org_time_idx
  on crm_integration_private.meta_credential_audit (
    organization_id, occurred_at desc, id
  );
create index meta_credential_audit_actor_fk_idx
  on crm_integration_private.meta_credential_audit (actor_user_id)
  where actor_user_id is not null;

alter table crm_integration_private.meta_app_credential_bindings
  enable row level security;
alter table crm_integration_private.meta_page_credential_bindings
  enable row level security;
alter table crm_integration_private.meta_credential_audit
  enable row level security;

create policy meta_app_credentials_internal_deny
on crm_integration_private.meta_app_credential_bindings
for all to anon, authenticated, service_role
using (false)
with check (false);

create policy meta_page_credentials_internal_deny
on crm_integration_private.meta_page_credential_bindings
for all to anon, authenticated, service_role
using (false)
with check (false);

create policy meta_credential_audit_internal_deny
on crm_integration_private.meta_credential_audit
for all to anon, authenticated, service_role
using (false)
with check (false);

revoke all on table
  crm_integration_private.meta_app_credential_bindings,
  crm_integration_private.meta_page_credential_bindings,
  crm_integration_private.meta_credential_audit
  from public, anon, authenticated, service_role;

-- Auditoria e descarte fisico dos valores cifrados sao executados no mesmo
-- commit que altera o binding. Uma falha reverte tanto o Vault quanto o
-- ledger, evitando credencial orfa ou revogacao apenas aparente.
create function crm_integration_private.audit_meta_app_credentials()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_id uuid;
begin
  actor_id := case
    when tg_op = 'DELETE' then old.updated_by
    else new.updated_by
  end;

  if tg_op = 'INSERT' then
    if new.app_secret_vault_id is not null then
      insert into crm_integration_private.meta_credential_audit (
        organization_id, credential_kind, action,
        credential_version, actor_user_id
      ) values (
        new.organization_id, 'app_secret', 'configured',
        new.app_secret_version, actor_id
      );
    end if;
    if new.verify_token_vault_id is not null then
      insert into crm_integration_private.meta_credential_audit (
        organization_id, credential_kind, action,
        credential_version, actor_user_id
      ) values (
        new.organization_id, 'verify_token', 'configured',
        new.verify_token_version, actor_id
      );
    end if;
    return null;
  end if;

  if tg_op = 'UPDATE' then
    if new.app_secret_version is distinct from old.app_secret_version then
      insert into crm_integration_private.meta_credential_audit (
        organization_id, credential_kind, action,
        credential_version, actor_user_id
      ) values (
        new.organization_id,
        'app_secret',
        case
          when old.app_secret_vault_id is null
               and new.app_secret_vault_id is not null then 'configured'
          when old.app_secret_vault_id is not null
               and new.app_secret_vault_id is null then 'revoked'
          else 'rotated'
        end,
        new.app_secret_version,
        actor_id
      );
    end if;

    if new.verify_token_version is distinct from old.verify_token_version then
      insert into crm_integration_private.meta_credential_audit (
        organization_id, credential_kind, action,
        credential_version, actor_user_id
      ) values (
        new.organization_id,
        'verify_token',
        case
          when old.verify_token_vault_id is null
               and new.verify_token_vault_id is not null then 'configured'
          when old.verify_token_vault_id is not null
               and new.verify_token_vault_id is null then 'revoked'
          else 'rotated'
        end,
        new.verify_token_version,
        actor_id
      );
    end if;

    if old.app_secret_vault_id is not null
       and old.app_secret_vault_id is distinct from
         new.app_secret_vault_id then
      delete from vault.secrets secret
      where secret.id = old.app_secret_vault_id
        and not exists (
          select 1
          from crm_integration_private.meta_app_credential_bindings binding
          where binding.app_secret_vault_id = secret.id
             or binding.verify_token_vault_id = secret.id
        )
        and not exists (
          select 1
          from crm_integration_private.meta_page_credential_bindings binding
          where binding.access_token_vault_id = secret.id
        );
    end if;

    if old.verify_token_vault_id is not null
       and old.verify_token_vault_id is distinct from
         new.verify_token_vault_id then
      delete from vault.secrets secret
      where secret.id = old.verify_token_vault_id
        and not exists (
          select 1
          from crm_integration_private.meta_app_credential_bindings binding
          where binding.app_secret_vault_id = secret.id
             or binding.verify_token_vault_id = secret.id
        )
        and not exists (
          select 1
          from crm_integration_private.meta_page_credential_bindings binding
          where binding.access_token_vault_id = secret.id
        );
    end if;
    return null;
  end if;

  if old.app_secret_vault_id is not null then
    insert into crm_integration_private.meta_credential_audit (
      organization_id, credential_kind, action,
      credential_version, actor_user_id
    ) values (
      old.organization_id, 'app_secret', 'revoked',
      old.app_secret_version + 1, actor_id
    );
  end if;
  if old.verify_token_vault_id is not null then
    insert into crm_integration_private.meta_credential_audit (
      organization_id, credential_kind, action,
      credential_version, actor_user_id
    ) values (
      old.organization_id, 'verify_token', 'revoked',
      old.verify_token_version + 1, actor_id
    );
  end if;

  delete from vault.secrets secret
  where secret.id in (
      old.app_secret_vault_id,
      old.verify_token_vault_id
    )
    and not exists (
      select 1
      from crm_integration_private.meta_app_credential_bindings binding
      where binding.app_secret_vault_id = secret.id
         or binding.verify_token_vault_id = secret.id
    )
    and not exists (
      select 1
      from crm_integration_private.meta_page_credential_bindings binding
      where binding.access_token_vault_id = secret.id
    );
  return null;
end
$function$;

create function crm_integration_private.audit_meta_page_credentials()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_id uuid;
begin
  actor_id := case
    when tg_op = 'DELETE' then old.updated_by
    else new.updated_by
  end;

  if tg_op = 'INSERT' then
    insert into crm_integration_private.meta_credential_audit (
      organization_id, page_id, credential_kind, action,
      credential_version, actor_user_id
    ) values (
      new.organization_id, new.page_id, 'page_registration', 'registered',
      0, actor_id
    );
    if new.access_token_vault_id is not null then
      insert into crm_integration_private.meta_credential_audit (
        organization_id, page_id, credential_kind, action,
        credential_version, actor_user_id
      ) values (
        new.organization_id, new.page_id, 'access_token', 'configured',
        new.access_token_version, actor_id
      );
    end if;
    return null;
  end if;

  if tg_op = 'UPDATE' then
    if new.access_token_version is distinct from old.access_token_version then
      insert into crm_integration_private.meta_credential_audit (
        organization_id, page_id, credential_kind, action,
        credential_version, actor_user_id
      ) values (
        new.organization_id,
        new.page_id,
        'access_token',
        case
          when old.access_token_vault_id is null
               and new.access_token_vault_id is not null then 'configured'
          when old.access_token_vault_id is not null
               and new.access_token_vault_id is null then 'revoked'
          else 'rotated'
        end,
        new.access_token_version,
        actor_id
      );
    end if;

    if old.access_token_vault_id is not null
       and old.access_token_vault_id is distinct from
         new.access_token_vault_id then
      delete from vault.secrets secret
      where secret.id = old.access_token_vault_id
        and not exists (
          select 1
          from crm_integration_private.meta_app_credential_bindings binding
          where binding.app_secret_vault_id = secret.id
             or binding.verify_token_vault_id = secret.id
        )
        and not exists (
          select 1
          from crm_integration_private.meta_page_credential_bindings binding
          where binding.access_token_vault_id = secret.id
        );
    end if;
    return null;
  end if;

  if old.access_token_vault_id is not null then
    insert into crm_integration_private.meta_credential_audit (
      organization_id, page_id, credential_kind, action,
      credential_version, actor_user_id
    ) values (
      old.organization_id, old.page_id, 'access_token', 'revoked',
      old.access_token_version + 1, actor_id
    );
  end if;
  insert into crm_integration_private.meta_credential_audit (
    organization_id, page_id, credential_kind, action,
    credential_version, actor_user_id
  ) values (
    old.organization_id, old.page_id, 'page_registration', 'unregistered',
    0, actor_id
  );

  delete from vault.secrets secret
  where secret.id = old.access_token_vault_id
    and not exists (
      select 1
      from crm_integration_private.meta_app_credential_bindings binding
      where binding.app_secret_vault_id = secret.id
         or binding.verify_token_vault_id = secret.id
    )
    and not exists (
      select 1
      from crm_integration_private.meta_page_credential_bindings binding
      where binding.access_token_vault_id = secret.id
    );
  return null;
end
$function$;

revoke all on function
  crm_integration_private.audit_meta_app_credentials()
  from public, anon, authenticated, service_role;
revoke all on function
  crm_integration_private.audit_meta_page_credentials()
  from public, anon, authenticated, service_role;

create trigger meta_app_credentials_audit
after insert or update or delete
on crm_integration_private.meta_app_credential_bindings
for each row execute function
  crm_integration_private.audit_meta_app_credentials();

create trigger meta_page_credentials_audit
after insert or update or delete
on crm_integration_private.meta_page_credential_bindings
for each row execute function
  crm_integration_private.audit_meta_page_credentials();

-- Toda rota existente ou futura reivindica o Page ID para seu tenant. A
-- reivindicacao nao exige Form ID adicional nem token, mas impede que outro
-- tenant selecione um segredo usando um Page ID controlado pelo atacante.
create function crm_integration_private.claim_meta_page_for_route()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_page_id text;
  claimed_organization_id uuid;
begin
  normalized_page_id := trim(new.page_id);
  if normalized_page_id is null
     or normalized_page_id !~ '^[0-9]{1,64}$' then
    raise exception 'Page ID Meta invalido.';
  end if;
  new.page_id := normalized_page_id;

  perform pg_advisory_xact_lock(
    hashtextextended('evora-meta-page:' || normalized_page_id, 0)
  );

  select binding.organization_id
  into claimed_organization_id
  from crm_integration_private.meta_page_credential_bindings binding
  where binding.page_id = normalized_page_id
  for update;

  if found and claimed_organization_id <> new.organization_id then
    raise exception
      'Este Page ID Meta ja pertence a outra organizacao.';
  end if;

  if not found then
    insert into crm_integration_private.meta_page_credential_bindings (
      organization_id, page_id, created_by, updated_by
    ) values (
      new.organization_id,
      normalized_page_id,
      coalesce(auth.uid(), new.created_by),
      coalesce(auth.uid(), new.updated_by, new.created_by)
    );
  end if;

  if new.active and not exists (
    select 1
    from crm_integration_private.meta_page_credential_bindings page
    join crm_integration_private.meta_app_credential_bindings app_binding
      on app_binding.organization_id = page.organization_id
    where page.organization_id = new.organization_id
      and page.page_id = normalized_page_id
      and page.access_token_vault_id is not null
      and app_binding.app_secret_vault_id is not null
      and app_binding.verify_token_vault_id is not null
  ) then
    raise exception
      'Rota ativa exige App Secret, Verify Token e Page Access Token.';
  end if;
  return new;
end
$function$;

revoke all on function
  crm_integration_private.claim_meta_page_for_route()
  from public, anon, authenticated, service_role;

create trigger crm_meta_lead_routes_claim_page
before insert or update of organization_id, page_id, active
on public.crm_meta_lead_routes
for each row execute function
  crm_integration_private.claim_meta_page_for_route();

insert into crm_integration_private.meta_page_credential_bindings (
  organization_id, page_id, created_by, updated_by, created_at, updated_at
)
select distinct on (route.page_id)
  route.organization_id,
  route.page_id,
  route.created_by,
  coalesce(route.updated_by, route.created_by),
  route.created_at,
  route.updated_at
from public.crm_meta_lead_routes route
order by route.page_id, route.created_at, route.id
on conflict (page_id) do nothing;

-- Seed nao secreto do piloto. Em ambientes que possuem exatamente um projeto
-- SOL, registra a pagina antes do Form ID. Em branch/dev sem esse catalogo, a
-- migration permanece portavel e a configuracao podera ser feita pela UI.
do $register_solaris_page$
declare
  solaris_organizations uuid[];
  solaris_organization_id uuid;
  claimed_organization_id uuid;
begin
  select array_agg(distinct project.organization_id)
  into solaris_organizations
  from public.projects project
  where project.code = 'SOL';

  if coalesce(cardinality(solaris_organizations), 0) > 1 then
    raise exception
      'projects.code=SOL resolve para mais de uma organizacao.';
  end if;

  if coalesce(cardinality(solaris_organizations), 0) = 1 then
    solaris_organization_id := solaris_organizations[1];
    perform pg_advisory_xact_lock(
      hashtextextended('evora-meta-page:1296933085661158', 0)
    );

    select binding.organization_id
    into claimed_organization_id
    from crm_integration_private.meta_page_credential_bindings binding
    where binding.page_id = '1296933085661158'
    for update;

    if found and claimed_organization_id <> solaris_organization_id then
      raise exception
        'Page ID Solaris ja pertence a outra organizacao.';
    end if;

    if not found then
      insert into crm_integration_private.meta_page_credential_bindings (
        organization_id, page_id
      ) values (
        solaris_organization_id, '1296933085661158'
      );
    end if;
  end if;
end
$register_solaris_page$;

-- Fail-safe de upgrade: qualquer rota previamente ativa via configuracao por
-- ambiente e pausada ate que as tres credenciais sejam gravadas no Vault.
update public.crm_meta_lead_routes route
set active = false,
    updated_at = now()
where route.active
  and not exists (
    select 1
    from crm_integration_private.meta_page_credential_bindings page
    join crm_integration_private.meta_app_credential_bindings app_binding
      on app_binding.organization_id = page.organization_id
    where page.organization_id = route.organization_id
      and page.page_id = route.page_id
      and page.access_token_vault_id is not null
      and app_binding.app_secret_vault_id is not null
      and app_binding.verify_token_vault_id is not null
  );

-- Snapshot administrativo. Esta funcao nunca consulta decrypted_secrets nem
-- retorna UUID/nome de Vault; configurado e derivado apenas do binding.
create function crm_private.get_meta_lead_credential_status_internal(
  p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  app_row crm_integration_private.meta_app_credential_bindings%rowtype;
  pages_value jsonb;
  registered_page_count integer := 0;
  graph_page_count integer := 0;
begin
  if auth.uid() is null
     or p_organization_id is null
     or not public.has_app_permission(
       p_organization_id,
       'crm.integrations.manage'
     ) then
    raise exception
      'Seu perfil nao pode gerenciar credenciais Meta.'
      using errcode = '42501';
  end if;

  select binding.*
  into app_row
  from crm_integration_private.meta_app_credential_bindings binding
  where binding.organization_id = p_organization_id;

  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'page_id', page.page_id,
        'registered_at', page.created_at,
        'updated_at', page.updated_at,
        'access_token', jsonb_build_object(
          'configured', page.access_token_vault_id is not null,
          'version', page.access_token_version,
          'configured_at', page.access_token_configured_at,
          'updated_at', page.access_token_changed_at
        ),
        'route_count', route_status.route_count,
        'active_route_count', route_status.active_route_count
      ) order by page.page_id
    ), '[]'::jsonb),
    count(*)::integer,
    count(*) filter (
      where page.access_token_vault_id is not null
        and route_status.active_route_count > 0
    )::integer
  into pages_value, registered_page_count, graph_page_count
  from crm_integration_private.meta_page_credential_bindings page
  cross join lateral (
    select
      count(*)::integer as route_count,
      count(*) filter (where route.active)::integer as active_route_count
    from public.crm_meta_lead_routes route
    where route.organization_id = page.organization_id
      and route.page_id = page.page_id
  ) route_status
  where page.organization_id = p_organization_id;

  return jsonb_build_object(
    'organization_id', p_organization_id,
    'app_secret', jsonb_build_object(
      'configured', app_row.app_secret_vault_id is not null,
      'version', coalesce(app_row.app_secret_version, 0),
      'configured_at', app_row.app_secret_configured_at,
      'updated_at', app_row.app_secret_changed_at
    ),
    'verify_token', jsonb_build_object(
      'configured', app_row.verify_token_vault_id is not null,
      'version', coalesce(app_row.verify_token_version, 0),
      'configured_at', app_row.verify_token_configured_at,
      'updated_at', app_row.verify_token_changed_at
    ),
    'pages', coalesce(pages_value, '[]'::jsonb),
    'ready', jsonb_build_object(
      'webhook_verification',
        app_row.verify_token_vault_id is not null
        and registered_page_count > 0,
      'signature_validation',
        app_row.app_secret_vault_id is not null
        and registered_page_count > 0,
      'graph_pages', graph_page_count
    )
  );
end
$function$;

revoke all on function
  crm_private.get_meta_lead_credential_status_internal(uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  crm_private.get_meta_lead_credential_status_internal(uuid)
  to authenticated;

create function public.get_meta_lead_credential_status(
  p_organization_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select crm_private.get_meta_lead_credential_status_internal(
    p_organization_id
  );
$function$;

revoke all on function
  public.get_meta_lead_credential_status(uuid)
  from public, anon, service_role;
grant execute on function
  public.get_meta_lead_credential_status(uuid)
  to authenticated;

-- NULL significa manter o valor atual. Uma chamada com todos os segredos NULL
-- registra somente o Page ID, permitindo preparar a pagina antes do Form ID.
create function crm_private.configure_meta_lead_credentials_internal(
  p_organization_id uuid,
  p_page_id text,
  p_app_secret text default null,
  p_verify_token text default null,
  p_access_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_id uuid := auth.uid();
  normalized_page_id text;
  claimed_organization_id uuid;
  app_binding crm_integration_private.meta_app_credential_bindings%rowtype;
  page_binding crm_integration_private.meta_page_credential_bindings%rowtype;
  created_secret_id uuid;
  secret_name text;
begin
  if actor_id is null
     or p_organization_id is null
     or not public.has_app_permission(
       p_organization_id,
       'crm.integrations.manage'
     ) then
    raise exception
      'Seu perfil nao pode gerenciar credenciais Meta.'
      using errcode = '42501';
  end if;

  normalized_page_id := trim(p_page_id);
  if normalized_page_id is null
     or normalized_page_id !~ '^[0-9]{1,64}$' then
    raise exception 'Page ID Meta invalido.';
  end if;

  if p_app_secret is not null and (
       p_app_secret <> btrim(p_app_secret)
       or char_length(p_app_secret) not between 24 and 512
       or p_app_secret ~ '[[:space:]]'
     ) then
    raise exception 'App Secret Meta invalido.';
  end if;
  if p_verify_token is not null and (
       p_verify_token <> btrim(p_verify_token)
       or char_length(p_verify_token) not between 24 and 512
       or p_verify_token ~ '[[:space:]]'
     ) then
    raise exception 'Verify Token Meta invalido.';
  end if;
  if p_access_token is not null and (
       p_access_token <> btrim(p_access_token)
       or char_length(p_access_token) not between 32 and 8192
       or p_access_token ~ '[[:space:]]'
     ) then
    raise exception 'Page Access Token Meta invalido.';
  end if;

  -- Serializa alteracoes de app do tenant e, depois, a reivindicacao global
  -- da pagina. A ordem e fixa em todas as chamadas administrativas.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'evora-meta-app:' || p_organization_id::text,
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended('evora-meta-page:' || normalized_page_id, 0)
  );

  select binding.organization_id
  into claimed_organization_id
  from crm_integration_private.meta_page_credential_bindings binding
  where binding.page_id = normalized_page_id
  for update;

  if found and claimed_organization_id <> p_organization_id then
    raise exception
      'Este Page ID Meta ja pertence a outra organizacao.';
  end if;

  if not found then
    insert into crm_integration_private.meta_page_credential_bindings (
      organization_id, page_id, created_by, updated_by
    ) values (
      p_organization_id, normalized_page_id, actor_id, actor_id
    );
  end if;

  insert into crm_integration_private.meta_app_credential_bindings (
    organization_id, created_by, updated_by
  ) values (
    p_organization_id, actor_id, actor_id
  ) on conflict (organization_id) do nothing;

  select binding.*
  into app_binding
  from crm_integration_private.meta_app_credential_bindings binding
  where binding.organization_id = p_organization_id
  for update;

  select binding.*
  into page_binding
  from crm_integration_private.meta_page_credential_bindings binding
  where binding.organization_id = p_organization_id
    and binding.page_id = normalized_page_id
  for update;

  if p_app_secret is not null then
    if app_binding.app_secret_vault_id is null then
      secret_name :=
        'evora_meta_' || replace(p_organization_id::text, '-', '') ||
        '_app_secret_' || encode(extensions.gen_random_bytes(12), 'hex');
      created_secret_id := vault.create_secret(
        new_secret := p_app_secret,
        new_name := secret_name,
        new_description :=
          'Evora Meta credential; organization=' ||
          p_organization_id::text || '; kind=app_secret',
        new_key_id := null
      );
      update crm_integration_private.meta_app_credential_bindings binding
      set app_secret_vault_id = created_secret_id,
          app_secret_version = binding.app_secret_version + 1,
          app_secret_configured_at = now(),
          app_secret_changed_at = now(),
          updated_by = actor_id,
          updated_at = now()
      where binding.organization_id = p_organization_id;
      app_binding.app_secret_vault_id := created_secret_id;
    else
      perform vault.update_secret(
        secret_id := app_binding.app_secret_vault_id,
        new_secret := p_app_secret,
        new_name := null,
        new_description := null,
        new_key_id := null
      );
      update crm_integration_private.meta_app_credential_bindings binding
      set app_secret_version = binding.app_secret_version + 1,
          app_secret_changed_at = now(),
          updated_by = actor_id,
          updated_at = now()
      where binding.organization_id = p_organization_id;
    end if;
  end if;

  if p_verify_token is not null then
    if app_binding.verify_token_vault_id is null then
      secret_name :=
        'evora_meta_' || replace(p_organization_id::text, '-', '') ||
        '_verify_token_' || encode(extensions.gen_random_bytes(12), 'hex');
      created_secret_id := vault.create_secret(
        new_secret := p_verify_token,
        new_name := secret_name,
        new_description :=
          'Evora Meta credential; organization=' ||
          p_organization_id::text || '; kind=verify_token',
        new_key_id := null
      );
      update crm_integration_private.meta_app_credential_bindings binding
      set verify_token_vault_id = created_secret_id,
          verify_token_version = binding.verify_token_version + 1,
          verify_token_configured_at = now(),
          verify_token_changed_at = now(),
          updated_by = actor_id,
          updated_at = now()
      where binding.organization_id = p_organization_id;
      app_binding.verify_token_vault_id := created_secret_id;
    else
      perform vault.update_secret(
        secret_id := app_binding.verify_token_vault_id,
        new_secret := p_verify_token,
        new_name := null,
        new_description := null,
        new_key_id := null
      );
      update crm_integration_private.meta_app_credential_bindings binding
      set verify_token_version = binding.verify_token_version + 1,
          verify_token_changed_at = now(),
          updated_by = actor_id,
          updated_at = now()
      where binding.organization_id = p_organization_id;
    end if;
  end if;

  if p_access_token is not null then
    if page_binding.access_token_vault_id is null then
      secret_name :=
        'evora_meta_' || replace(p_organization_id::text, '-', '') ||
        '_page_' || normalized_page_id || '_access_' ||
        encode(extensions.gen_random_bytes(12), 'hex');
      created_secret_id := vault.create_secret(
        new_secret := p_access_token,
        new_name := secret_name,
        new_description :=
          'Evora Meta credential; organization=' ||
          p_organization_id::text || '; kind=page_access_token',
        new_key_id := null
      );
      update crm_integration_private.meta_page_credential_bindings binding
      set access_token_vault_id = created_secret_id,
          access_token_version = binding.access_token_version + 1,
          access_token_configured_at = now(),
          access_token_changed_at = now(),
          updated_by = actor_id,
          updated_at = now()
      where binding.organization_id = p_organization_id
        and binding.page_id = normalized_page_id;
    else
      perform vault.update_secret(
        secret_id := page_binding.access_token_vault_id,
        new_secret := p_access_token,
        new_name := null,
        new_description := null,
        new_key_id := null
      );
      update crm_integration_private.meta_page_credential_bindings binding
      set access_token_version = binding.access_token_version + 1,
          access_token_changed_at = now(),
          updated_by = actor_id,
          updated_at = now()
      where binding.organization_id = p_organization_id
        and binding.page_id = normalized_page_id;
    end if;
  end if;

  return crm_private.get_meta_lead_credential_status_internal(
    p_organization_id
  );
end
$function$;

revoke all on function
  crm_private.configure_meta_lead_credentials_internal(
    uuid, text, text, text, text
  ) from public, anon, authenticated, service_role;
grant execute on function
  crm_private.configure_meta_lead_credentials_internal(
    uuid, text, text, text, text
  ) to authenticated;

create function public.configure_meta_lead_credentials(
  p_organization_id uuid,
  p_page_id text,
  p_app_secret text default null,
  p_verify_token text default null,
  p_access_token text default null
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select crm_private.configure_meta_lead_credentials_internal(
    p_organization_id,
    p_page_id,
    p_app_secret,
    p_verify_token,
    p_access_token
  );
$function$;

revoke all on function
  public.configure_meta_lead_credentials(uuid, text, text, text, text)
  from public, anon, service_role;
grant execute on function
  public.configure_meta_lead_credentials(uuid, text, text, text, text)
  to authenticated;

create function crm_private.revoke_meta_lead_credential_internal(
  p_organization_id uuid,
  p_credential text,
  p_page_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_id uuid := auth.uid();
  credential_kind text := lower(trim(p_credential));
  normalized_page_id text;
begin
  if actor_id is null
     or p_organization_id is null
     or not public.has_app_permission(
       p_organization_id,
       'crm.integrations.manage'
     ) then
    raise exception
      'Seu perfil nao pode gerenciar credenciais Meta.'
      using errcode = '42501';
  end if;

  if credential_kind is null
     or credential_kind not in (
    'app_secret', 'verify_token', 'access_token', 'page_registration'
  ) then
    raise exception 'Tipo de credencial Meta invalido.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'evora-meta-app:' || p_organization_id::text,
      0
    )
  );

  if credential_kind in ('access_token', 'page_registration') then
    normalized_page_id := trim(p_page_id);
    if normalized_page_id is null
       or normalized_page_id !~ '^[0-9]{1,64}$' then
      raise exception 'Page ID Meta invalido.';
    end if;

    if credential_kind = 'access_token' then
      if not exists (
        select 1
        from crm_integration_private.meta_page_credential_bindings binding
        where binding.organization_id = p_organization_id
          and binding.page_id = normalized_page_id
      ) then
        raise exception 'Page ID Meta nao cadastrado nesta organizacao.';
      end if;

      -- Lock order acompanha UPDATE active da rota: row lock primeiro, depois
      -- advisory Page adquirido pelo trigger. Inverter page->row criaria ciclo
      -- com uma ativacao concorrente, que naturalmente segue row->page.
      update public.crm_meta_lead_routes route
      set active = false,
          updated_by = actor_id,
          updated_at = now()
      where route.organization_id = p_organization_id
        and route.page_id = normalized_page_id
        and route.active;

      -- Quando nao havia rota ativa, o trigger nao executou; toma a mesma
      -- trava depois dos row locks para serializar a rotacao/revogacao do Page.
      perform pg_advisory_xact_lock(
        hashtextextended('evora-meta-page:' || normalized_page_id, 0)
      );

      update crm_integration_private.meta_page_credential_bindings binding
      set access_token_vault_id = null,
          access_token_version = binding.access_token_version + 1,
          access_token_configured_at = null,
          access_token_changed_at = now(),
          updated_by = actor_id,
          updated_at = now()
      where binding.organization_id = p_organization_id
        and binding.page_id = normalized_page_id
        and binding.access_token_vault_id is not null;
    else
      perform pg_advisory_xact_lock(
        hashtextextended('evora-meta-page:' || normalized_page_id, 0)
      );

      if not exists (
        select 1
        from crm_integration_private.meta_page_credential_bindings binding
        where binding.organization_id = p_organization_id
          and binding.page_id = normalized_page_id
      ) then
        raise exception 'Page ID Meta nao cadastrado nesta organizacao.';
      end if;

      if exists (
        select 1
        from public.crm_meta_lead_routes route
        where route.organization_id = p_organization_id
          and route.page_id = normalized_page_id
      ) then
        raise exception
          'Remova as rotas desta Page antes de liberar o vinculo.';
      end if;
      if exists (
        select 1
        from crm_integration_private.meta_page_credential_bindings binding
        where binding.organization_id = p_organization_id
          and binding.page_id = normalized_page_id
          and binding.access_token_vault_id is not null
      ) then
        raise exception
          'Revogue o Page Access Token antes de liberar o vinculo.';
      end if;

      update crm_integration_private.meta_page_credential_bindings binding
      set updated_by = actor_id,
          updated_at = now()
      where binding.organization_id = p_organization_id
        and binding.page_id = normalized_page_id;

      delete from crm_integration_private.meta_page_credential_bindings binding
      where binding.organization_id = p_organization_id
        and binding.page_id = normalized_page_id;
    end if;
  elsif credential_kind = 'app_secret' then
    if p_page_id is not null then
      raise exception 'App Secret e uma credencial da organizacao.';
    end if;
    update public.crm_meta_lead_routes route
    set active = false,
        updated_by = actor_id,
        updated_at = now()
    where route.organization_id = p_organization_id
      and route.active;

    update crm_integration_private.meta_app_credential_bindings binding
    set app_secret_vault_id = null,
        app_secret_version = binding.app_secret_version + 1,
        app_secret_configured_at = null,
        app_secret_changed_at = now(),
        updated_by = actor_id,
        updated_at = now()
    where binding.organization_id = p_organization_id
      and binding.app_secret_vault_id is not null;
  else
    if p_page_id is not null then
      raise exception 'Verify Token e uma credencial da organizacao.';
    end if;
    update public.crm_meta_lead_routes route
    set active = false,
        updated_by = actor_id,
        updated_at = now()
    where route.organization_id = p_organization_id
      and route.active;

    update crm_integration_private.meta_app_credential_bindings binding
    set verify_token_vault_id = null,
        verify_token_version = binding.verify_token_version + 1,
        verify_token_configured_at = null,
        verify_token_changed_at = now(),
        updated_by = actor_id,
        updated_at = now()
    where binding.organization_id = p_organization_id
      and binding.verify_token_vault_id is not null;
  end if;

  return crm_private.get_meta_lead_credential_status_internal(
    p_organization_id
  );
end
$function$;

revoke all on function
  crm_private.revoke_meta_lead_credential_internal(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function
  crm_private.revoke_meta_lead_credential_internal(uuid, text, text)
  to authenticated;

create function public.revoke_meta_lead_credential(
  p_organization_id uuid,
  p_credential text,
  p_page_id text default null
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select crm_private.revoke_meta_lead_credential_internal(
    p_organization_id,
    p_credential,
    p_page_id
  );
$function$;

revoke all on function
  public.revoke_meta_lead_credential(uuid, text, text)
  from public, anon, service_role;
grant execute on function
  public.revoke_meta_lead_credential(uuid, text, text)
  to authenticated;

-- O segredo interno cron -> worker e criado aleatoriamente sem sair do banco.
-- A URL fica deliberadamente ausente na migration: branches/dev jamais podem
-- herdar uma URL de producao e disparar o cron fora do proprio ambiente.
do $provision_meta_worker_secret$
declare
  worker_secret_id uuid;
  worker_secret_value text;
begin
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
  else
    select secret.decrypted_secret
    into worker_secret_value
    from vault.decrypted_secrets secret
    where secret.id = worker_secret_id;

    if worker_secret_value is null
       or char_length(worker_secret_value) not between 32 and 512
       or worker_secret_value ~ '[[:space:]]' then
      perform vault.update_secret(
        secret_id := worker_secret_id,
        new_secret := encode(extensions.gen_random_bytes(32), 'hex'),
        new_name := null,
        new_description :=
          'Evora internal credential; kind=meta_worker_secret',
        new_key_id := null
      );
    end if;
  end if;
end
$provision_meta_worker_secret$;

-- Operacao deliberadamente postgres-only para o release: define a URL do
-- ambiente e opcionalmente gira o segredo sem receber/devolver plaintext.
-- Exemplo pos-deploy (nao versionado):
-- select crm_integration_private.configure_meta_worker_runtime(
--   'https://host-do-ambiente/api/integrations/meta/leads/process', false
-- );
create function crm_integration_private.configure_meta_worker_runtime(
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

  -- Serializa criacao/rotacao do par URL+segredo e evita que configuracoes
  -- concorrentes disputem o mesmo nome protegido pelo indice do Vault.
  perform pg_advisory_xact_lock(
    hashtextextended('evora-meta-worker-runtime', 0)
  );

  select secret.id
  into worker_url_id
  from vault.secrets secret
  where secret.name = 'evora_meta_worker_url'
  order by secret.created_at desc
  limit 1
  for update;

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
  limit 1
  for update;

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

-- O process endpoint usa esta RPC para comparar Authorization em tempo
-- constante com o mesmo segredo que o dispatcher Stage 2 le do Vault.
create function public.get_meta_worker_runtime_credentials()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  worker_url text;
  worker_secret text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'RPC restrita ao runtime da integracao.'
      using errcode = '42501';
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

  if worker_url is null
     or worker_url <> btrim(worker_url)
     or char_length(worker_url) > 2048
     or worker_url !~
       '^https://([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9])/api/integrations/meta/leads/process$'
     or worker_url ~ '[[:space:]@#]'
     or worker_secret is null
     or worker_secret <> btrim(worker_secret)
     or char_length(worker_secret) not between 32 and 512
     or worker_secret ~ '[[:space:]]' then
    return null;
  end if;

  return jsonb_build_object(
    'worker_url', worker_url,
    'worker_secret', worker_secret
  );
end
$function$;

revoke all on function
  public.get_meta_worker_runtime_credentials()
  from public, anon, authenticated;
grant execute on function
  public.get_meta_worker_runtime_credentials()
  to service_role;

-- Callback compartilhado e multi-tenant: o servidor usa os Page IDs apenas
-- para escolher candidatos. Nenhum dado do corpo e confiado ate que um dos
-- App Secrets valide o HMAC SHA-256 dos bytes brutos. Least privilege: no GET
-- (page_ids=NULL) cada candidato contem apenas Verify Token; no POST, apenas
-- App Secret. Page registrada/inativa continua autenticando e persistindo
-- evento unmapped durante pausa, evitando perda e retries agressivos da Meta.
create function public.get_meta_webhook_runtime_credentials(
  p_page_ids text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_page_ids text[];
  candidates_value jsonb;
  unresolved_value jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'RPC restrita ao runtime da integracao.'
      using errcode = '42501';
  end if;

  if p_page_ids is not null then
    if cardinality(p_page_ids) not between 1 and 1000
       or exists (
         select 1
         from unnest(p_page_ids) supplied(page_id)
         where supplied.page_id is null
            or supplied.page_id <> trim(supplied.page_id)
            or supplied.page_id !~ '^[0-9]{1,64}$'
       ) then
      raise exception 'Lista de Page IDs Meta invalida.';
    end if;

    select array_agg(distinct supplied.page_id order by supplied.page_id)
    into normalized_page_ids
    from unnest(p_page_ids) supplied(page_id);
  end if;

  if normalized_page_ids is null then
    with per_organization as (
      select
        page.organization_id,
        array_agg(page.page_id order by page.page_id) as page_ids
      from crm_integration_private.meta_page_credential_bindings page
      group by page.organization_id
    )
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'organization_id', grouped.organization_id,
        'page_ids', to_jsonb(grouped.page_ids),
        'verify_token', verify_secret.decrypted_secret
      ) order by grouped.organization_id
    ), '[]'::jsonb)
    into candidates_value
    from per_organization grouped
    join crm_integration_private.meta_app_credential_bindings app_binding
      on app_binding.organization_id = grouped.organization_id
    join vault.decrypted_secrets verify_secret
      on verify_secret.id = app_binding.verify_token_vault_id
    where verify_secret.decrypted_secret is not null;

    unresolved_value := '[]'::jsonb;
  else
    with selected_pages as (
      select page.organization_id, page.page_id
      from crm_integration_private.meta_page_credential_bindings page
      where page.page_id = any(normalized_page_ids)
    ), per_organization as (
      select
        selected.organization_id,
        array_agg(selected.page_id order by selected.page_id) as page_ids
      from selected_pages selected
      group by selected.organization_id
    )
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'organization_id', grouped.organization_id,
        'page_ids', to_jsonb(grouped.page_ids),
        'app_secret', app_secret.decrypted_secret
      ) order by grouped.organization_id
    ), '[]'::jsonb)
    into candidates_value
    from per_organization grouped
    join crm_integration_private.meta_app_credential_bindings app_binding
      on app_binding.organization_id = grouped.organization_id
    join vault.decrypted_secrets app_secret
      on app_secret.id = app_binding.app_secret_vault_id
    where app_secret.decrypted_secret is not null;

    select coalesce(jsonb_agg(requested.page_id order by requested.page_id),
                    '[]'::jsonb)
    into unresolved_value
    from unnest(normalized_page_ids) requested(page_id)
    where not exists (
      select 1
      from crm_integration_private.meta_page_credential_bindings page
      join crm_integration_private.meta_app_credential_bindings app_binding
        on app_binding.organization_id = page.organization_id
      join vault.decrypted_secrets app_secret
        on app_secret.id = app_binding.app_secret_vault_id
      where page.page_id = requested.page_id
        and app_secret.decrypted_secret is not null
    );
  end if;

  return jsonb_build_object(
    'candidates', coalesce(candidates_value, '[]'::jsonb),
    'unresolved_page_ids', coalesce(unresolved_value, '[]'::jsonb)
  );
end
$function$;

revoke all on function
  public.get_meta_webhook_runtime_credentials(text[])
  from public, anon, authenticated;
grant execute on function
  public.get_meta_webhook_runtime_credentials(text[])
  to service_role;

-- Graph API: o token de Page e o App Secret so saem juntos quando o Page ID
-- pertence ao tenant informado e existe rota ativa com a mesma combinacao.
create function public.get_meta_graph_runtime_credentials(
  p_organization_id uuid,
  p_page_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_page_id text;
  result_value jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'RPC restrita ao runtime da integracao.'
      using errcode = '42501';
  end if;

  normalized_page_id := trim(p_page_id);
  if p_organization_id is null
     or normalized_page_id is null
     or normalized_page_id !~ '^[0-9]{1,64}$' then
    raise exception 'Escopo Meta runtime invalido.';
  end if;

  select jsonb_build_object(
    'organization_id', page.organization_id,
    'page_id', page.page_id,
    'app_secret', app_secret.decrypted_secret,
    'access_token', access_secret.decrypted_secret
  )
  into result_value
  from crm_integration_private.meta_page_credential_bindings page
  join crm_integration_private.meta_app_credential_bindings app_binding
    on app_binding.organization_id = page.organization_id
  join vault.decrypted_secrets app_secret
    on app_secret.id = app_binding.app_secret_vault_id
  join vault.decrypted_secrets access_secret
    on access_secret.id = page.access_token_vault_id
  where page.organization_id = p_organization_id
    and page.page_id = normalized_page_id
    and app_secret.decrypted_secret is not null
    and access_secret.decrypted_secret is not null
    and exists (
      select 1
      from public.crm_meta_lead_routes route
      where route.organization_id = page.organization_id
        and route.page_id = page.page_id
        and route.active
    );

  return result_value;
end
$function$;

revoke all on function
  public.get_meta_graph_runtime_credentials(uuid, text)
  from public, anon, authenticated;
grant execute on function
  public.get_meta_graph_runtime_credentials(uuid, text)
  to service_role;

-- Fecha completamente o Vault para browser/Data API autenticada. O papel
-- service_role conserva os grants padrao da extensao, concedidos pelo owner
-- supabase_admin (o papel postgres do projeto nao pode revoga-los). O runtime
-- da aplicacao, contudo, usa somente as RPCs estreitas acima; nenhum segredo
-- e retornado a anon/authenticated nem ao frontend.
revoke all on schema vault
  from public, anon, authenticated;
revoke all on table vault.secrets, vault.decrypted_secrets
  from public, anon, authenticated;
revoke all on function vault.create_secret(text, text, text, uuid)
  from public, anon, authenticated;
revoke all on function vault.update_secret(uuid, text, text, text, uuid)
  from public, anon, authenticated;

comment on table
  crm_integration_private.meta_app_credential_bindings is
  'Private org-scoped Vault bindings; never contains decrypted Meta secrets.';
comment on table
  crm_integration_private.meta_page_credential_bindings is
  'Private one-tenant-per-Page binding; Form ID is deliberately not required.';
comment on table
  crm_integration_private.meta_credential_audit is
  'Secret-free append-only audit ledger for Meta credential lifecycle.';
comment on function public.get_meta_lead_credential_status(uuid) is
  'Invoker facade returning only non-secret Meta credential status.';
comment on function public.configure_meta_lead_credentials(
  uuid, text, text, text, text
) is
  'Invoker facade to register Page ID and set or rotate Vault-backed secrets.';
comment on function public.revoke_meta_lead_credential(
  uuid, text, text
) is
  'Invoker facade to revoke one Vault-backed Meta credential.';
comment on function public.get_meta_webhook_runtime_credentials(text[]) is
  'Service-only webhook candidate resolver; response contains plaintext secrets.';
comment on function public.get_meta_graph_runtime_credentials(uuid, text) is
  'Service-only Graph credential resolver with active route coherence.';
comment on function public.get_meta_worker_runtime_credentials() is
  'Service-only reader for the shared Vault-backed cron/worker credential.';

do $postflight$
declare
  public_status oid := to_regprocedure(
    'public.get_meta_lead_credential_status(uuid)'
  );
  public_configure oid := to_regprocedure(
    'public.configure_meta_lead_credentials(uuid,text,text,text,text)'
  );
  public_revoke oid := to_regprocedure(
    'public.revoke_meta_lead_credential(uuid,text,text)'
  );
  private_status oid := to_regprocedure(
    'crm_private.get_meta_lead_credential_status_internal(uuid)'
  );
  private_configure oid := to_regprocedure(
    'crm_private.configure_meta_lead_credentials_internal(uuid,text,text,text,text)'
  );
  private_revoke oid := to_regprocedure(
    'crm_private.revoke_meta_lead_credential_internal(uuid,text,text)'
  );
  runtime_webhook oid := to_regprocedure(
    'public.get_meta_webhook_runtime_credentials(text[])'
  );
  runtime_graph oid := to_regprocedure(
    'public.get_meta_graph_runtime_credentials(uuid,text)'
  );
  runtime_worker oid := to_regprocedure(
    'public.get_meta_worker_runtime_credentials()'
  );
  operator_worker oid := to_regprocedure(
    'crm_integration_private.configure_meta_worker_runtime(text,boolean)'
  );
begin
  if public_status is null or public_configure is null
     or public_revoke is null or private_status is null
     or private_configure is null or private_revoke is null
     or runtime_webhook is null or runtime_graph is null
     or runtime_worker is null or operator_worker is null then
    raise exception 'Fronteira RPC de credenciais Meta incompleta.';
  end if;

  if exists (
    select 1
    from pg_proc procedure_row
    where procedure_row.oid in (
      public_status, public_configure, public_revoke
    )
      and (
        procedure_row.prosecdef
        or not coalesce(procedure_row.proconfig, '{}'::text[])
          @> array['search_path=""']::text[]
      )
  ) then
    raise exception 'Facade publica Meta perdeu invoker/search_path.';
  end if;

  if exists (
    select 1
    from pg_proc procedure_row
    where procedure_row.oid in (
      private_status, private_configure, private_revoke,
      runtime_webhook, runtime_graph, runtime_worker, operator_worker
    )
      and (
        not procedure_row.prosecdef
        or not coalesce(procedure_row.proconfig, '{}'::text[])
          @> array['search_path=""']::text[]
      )
  ) then
    raise exception 'Implementacao Meta perdeu definer/search_path.';
  end if;

  if not has_function_privilege(
       'authenticated', public_status, 'EXECUTE'
     )
     or not has_function_privilege(
       'authenticated', public_configure, 'EXECUTE'
     )
     or not has_function_privilege(
       'authenticated', public_revoke, 'EXECUTE'
     )
     or not has_function_privilege(
       'authenticated', private_status, 'EXECUTE'
     )
     or not has_function_privilege(
       'authenticated', private_configure, 'EXECUTE'
     )
     or not has_function_privilege(
       'authenticated', private_revoke, 'EXECUTE'
     )
     or has_function_privilege('anon', public_status, 'EXECUTE')
     or has_function_privilege('anon', public_configure, 'EXECUTE')
     or has_function_privilege('anon', public_revoke, 'EXECUTE')
     or has_function_privilege('service_role', public_status, 'EXECUTE')
     or has_function_privilege('service_role', public_configure, 'EXECUTE')
     or has_function_privilege('service_role', public_revoke, 'EXECUTE')
     or not has_function_privilege(
       'service_role', runtime_webhook, 'EXECUTE'
     )
     or not has_function_privilege(
       'service_role', runtime_graph, 'EXECUTE'
     )
     or not has_function_privilege(
       'service_role', runtime_worker, 'EXECUTE'
     )
     or has_function_privilege('anon', runtime_webhook, 'EXECUTE')
     or has_function_privilege('anon', runtime_graph, 'EXECUTE')
     or has_function_privilege('anon', runtime_worker, 'EXECUTE')
     or has_function_privilege(
       'authenticated', runtime_webhook, 'EXECUTE'
     )
     or has_function_privilege(
       'authenticated', runtime_graph, 'EXECUTE'
     )
     or has_function_privilege(
       'authenticated', runtime_worker, 'EXECUTE'
     )
     or has_function_privilege(
       'service_role', operator_worker, 'EXECUTE'
     )
     or has_function_privilege(
       'authenticated', operator_worker, 'EXECUTE'
     )
     or has_function_privilege(
       'anon', operator_worker, 'EXECUTE'
     ) then
    raise exception 'ACL das RPCs Meta e mais ampla que o contrato.';
  end if;

  if has_schema_privilege('authenticated', 'vault', 'USAGE')
     or has_schema_privilege('anon', 'vault', 'USAGE')
     or has_table_privilege(
       'authenticated', 'vault.secrets', 'SELECT,INSERT,UPDATE,DELETE'
     )
     or has_table_privilege(
       'anon', 'vault.secrets', 'SELECT,INSERT,UPDATE,DELETE'
     )
     or has_table_privilege(
       'authenticated', 'vault.decrypted_secrets', 'SELECT,DELETE'
     )
     or has_table_privilege(
       'anon', 'vault.decrypted_secrets', 'SELECT,DELETE'
     )
     or has_function_privilege(
       'authenticated',
       'vault.create_secret(text,text,text,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'vault.create_secret(text,text,text,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'vault.update_secret(uuid,text,text,text,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'vault.update_secret(uuid,text,text,text,uuid)',
       'EXECUTE'
     ) then
    raise exception 'Vault exposto a papeis do browser/Data API.';
  end if;

  if exists (
    select 1
    from pg_class relation
    join pg_namespace namespace_row
      on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'crm_integration_private'
      and relation.relname in (
        'meta_app_credential_bindings',
        'meta_page_credential_bindings',
        'meta_credential_audit'
      )
      and not relation.relrowsecurity
  ) then
    raise exception 'RLS privado das credenciais Meta esta incompleto.';
  end if;

  if has_table_privilege(
       'anon',
       'crm_integration_private.meta_app_credential_bindings',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     or has_table_privilege(
       'authenticated',
       'crm_integration_private.meta_app_credential_bindings',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     or has_table_privilege(
       'service_role',
       'crm_integration_private.meta_app_credential_bindings',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     or has_table_privilege(
       'anon',
       'crm_integration_private.meta_page_credential_bindings',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     or has_table_privilege(
       'authenticated',
       'crm_integration_private.meta_page_credential_bindings',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     or has_table_privilege(
       'service_role',
       'crm_integration_private.meta_page_credential_bindings',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     or has_table_privilege(
       'authenticated',
       'crm_integration_private.meta_credential_audit',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     or has_table_privilege(
       'service_role',
       'crm_integration_private.meta_credential_audit',
       'SELECT,INSERT,UPDATE,DELETE'
     ) then
    raise exception 'Tabela privada Meta possui grant direto indevido.';
  end if;

  if to_regclass(
       'crm_integration_private.meta_app_credentials_created_by_fk_idx'
     ) is null
     or to_regclass(
       'crm_integration_private.meta_app_credentials_updated_by_fk_idx'
     ) is null
     or to_regclass(
       'crm_integration_private.meta_page_credentials_created_by_fk_idx'
     ) is null
     or to_regclass(
       'crm_integration_private.meta_page_credentials_updated_by_fk_idx'
     ) is null
     or to_regclass(
       'crm_integration_private.meta_credential_audit_org_time_idx'
     ) is null
     or to_regclass(
       'crm_integration_private.meta_credential_audit_actor_fk_idx'
     ) is null then
    raise exception 'Indices de credenciais/auditoria Meta incompletos.';
  end if;

  if not exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'public.crm_meta_lead_routes'::regclass
      and trigger_row.tgname = 'crm_meta_lead_routes_claim_page'
      and not trigger_row.tgisinternal
  ) then
    raise exception 'Coerencia tenant/Page ID nao esta protegida.';
  end if;

  if exists (
    select 1
    from public.crm_meta_lead_routes route
    where route.active
      and not exists (
        select 1
        from crm_integration_private.meta_page_credential_bindings page
        join crm_integration_private.meta_app_credential_bindings app_binding
          on app_binding.organization_id = page.organization_id
        where page.organization_id = route.organization_id
          and page.page_id = route.page_id
          and page.access_token_vault_id is not null
          and app_binding.app_secret_vault_id is not null
          and app_binding.verify_token_vault_id is not null
      )
  ) then
    raise exception 'Existe rota Meta ativa sem as tres credenciais.';
  end if;

  if position(
       'char_length(p_app_secret) not between 24 and 512'
       in pg_get_functiondef(private_configure)
     ) = 0
     or position(
       'char_length(p_verify_token) not between 24 and 512'
       in pg_get_functiondef(private_configure)
     ) = 0
     or position(
       'p_app_secret ~ ''[[:space:]]'''
       in pg_get_functiondef(private_configure)
     ) = 0
     or position(
       'p_verify_token ~ ''[[:space:]]'''
       in pg_get_functiondef(private_configure)
     ) = 0
     or position(
       'p_access_token ~ ''[[:space:]]'''
       in pg_get_functiondef(private_configure)
     ) = 0 then
    raise exception 'Validacao SQL e runtime de segredos Meta divergiu.';
  end if;

  if not exists (
    select 1
    from vault.decrypted_secrets secret
    where secret.name = 'evora_meta_worker_secret'
      and char_length(secret.decrypted_secret) between 32 and 512
      and secret.decrypted_secret !~ '[[:space:]]'
  ) then
    raise exception 'Segredo interno do worker nao foi provisionado.';
  end if;

  if (
    select count(*)
    from vault.secrets secret
    where secret.name = 'evora_meta_worker_secret'
  ) <> 1
     or position(
       'pg_advisory_xact_lock'
       in pg_get_functiondef(operator_worker)
     ) = 0 then
    raise exception 'Configuracao concorrente do worker nao esta cercada.';
  end if;

  if (
    select count(distinct project.organization_id)
    from public.projects project
    where project.code = 'SOL'
  ) = 1 and not exists (
    select 1
    from crm_integration_private.meta_page_credential_bindings binding
    join public.projects project
      on project.organization_id = binding.organization_id
     and project.code = 'SOL'
    where binding.page_id = '1296933085661158'
  ) then
    raise exception 'Page ID Solaris nao foi registrado no tenant SOL.';
  end if;
end
$postflight$;
