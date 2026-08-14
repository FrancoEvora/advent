-- Permite ao Évora Enterprise usar exatamente a credencial do Campaign Control
-- para leitura autenticada da Meta Graph API sem tornar o App Secret obrigatório.
--
-- Segurança: webhook/hybrid continua exigindo App Secret + Verify Token +
-- Page Access Token. Quando o App Secret não existe, a rota ativa opera em
-- modo polling e o webhook permanece incapaz de validar assinatura.

create or replace function crm_integration_private.claim_meta_page_for_route()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_page_id text;
  claimed_organization_id uuid;
  has_page_token boolean := false;
  has_full_webhook_credentials boolean := false;
  ingress_mode text;
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
    raise exception 'Este Page ID Meta ja pertence a outra organizacao.';
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

  if new.active then
    select
      page.access_token_vault_id is not null,
      page.access_token_vault_id is not null
        and app_binding.app_secret_vault_id is not null
        and app_binding.verify_token_vault_id is not null
    into has_page_token, has_full_webhook_credentials
    from crm_integration_private.meta_page_credential_bindings page
    left join crm_integration_private.meta_app_credential_bindings app_binding
      on app_binding.organization_id = page.organization_id
    where page.organization_id = new.organization_id
      and page.page_id = normalized_page_id;

    if not coalesce(has_page_token, false) then
      raise exception 'Rota Meta ativa exige Page Access Token.';
    end if;

    ingress_mode := lower(coalesce(
      nullif(trim(coalesce(new.metadata, '{}'::jsonb) ->> 'ingress_mode'), ''),
      case when has_full_webhook_credentials then 'hybrid' else 'polling' end
    ));

    if ingress_mode not in ('polling', 'webhook', 'hybrid') then
      raise exception 'Modo de entrada Meta invalido.';
    end if;

    if ingress_mode in ('webhook', 'hybrid')
       and not coalesce(has_full_webhook_credentials, false) then
      ingress_mode := 'polling';
    end if;

    new.metadata := coalesce(new.metadata, '{}'::jsonb)
      || jsonb_build_object(
        'ingress_mode', ingress_mode,
        'campaign_control_connector', true
      );
  end if;

  return new;
end
$function$;

revoke all on function crm_integration_private.claim_meta_page_for_route()
  from public, anon, authenticated, service_role;
