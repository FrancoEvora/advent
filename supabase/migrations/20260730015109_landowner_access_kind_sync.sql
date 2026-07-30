-- Évora Gestão 6.17 — mantém a categoria do acesso público coerente
-- com o cadastro do terrenista e preserva os links já distribuídos.

do $migration$
begin
  if to_regclass('public.contacts') is null
    or to_regclass('public.partner_portal_links') is null
    or to_regclass('public.audit_logs') is null
    or to_regprocedure(
      'public.create_partner_portal_link(uuid,uuid,text,text,timestamptz)'
    ) is null then
    raise exception
      'Dependências do portal de parceiros ausentes para sincronizar terrenistas.';
  end if;
end
$migration$;

create or replace function public.create_partner_portal_link(
  p_organization_id uuid,
  p_contact_id uuid,
  p_partner_kind text default 'fornecedor',
  p_label text default null,
  p_expires_at timestamptz default (now() + interval '60 days')
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_raw_token text;
  v_link public.partner_portal_links%rowtype;
  v_document_digits text;
  v_contact_type text;
  v_requested_partner_kind text :=
    lower(btrim(coalesce(p_partner_kind, '')));
  v_effective_partner_kind text;
begin
  if v_user_id is null
    or not public.has_app_permission(
      p_organization_id,
      'partners.access.manage'
    ) then
    raise exception 'Acesso não autorizado.';
  end if;

  if v_requested_partner_kind not in (
    'fornecedor',
    'credor_financeiro',
    'terrenista',
    'parceiro',
    'colaborador',
    'beneficiario'
  ) then
    raise exception 'Tipo de parceiro inválido.';
  end if;

  select
    regexp_replace(coalesce(contact.document, ''), '\D', '', 'g'),
    lower(btrim(coalesce(contact.contact_type, '')))
    into v_document_digits, v_contact_type
    from public.contacts contact
   where contact.id = p_contact_id
     and contact.organization_id = p_organization_id
     and contact.active = true;

  if not found then
    raise exception 'Parceiro não localizado.';
  end if;

  if v_requested_partner_kind = 'terrenista'
    and v_contact_type <> 'terrenista' then
    raise exception
      'Classifique o contato como terrenista antes de gerar este acesso.';
  end if;

  v_effective_partner_kind := case
    when v_contact_type = 'terrenista' then 'terrenista'
    else v_requested_partner_kind
  end;

  if char_length(v_document_digits) < 4 then
    raise exception 'Cadastre o CPF ou CNPJ do parceiro antes de gerar o acesso.';
  end if;

  if p_expires_at <= now()
    or p_expires_at > now() + interval '365 days' then
    raise exception 'A validade deve estar entre amanhã e 365 dias.';
  end if;

  update public.partner_portal_links
     set active = false,
         revoked_by = v_user_id,
         revoked_at = now(),
         revoke_reason = 'Acesso substituído por um novo link.'
   where organization_id = p_organization_id
     and contact_id = p_contact_id
     and active = true;

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.partner_portal_links (
    organization_id,
    contact_id,
    partner_kind,
    token_hash,
    token_hint,
    label,
    expires_at,
    created_by
  )
  values (
    p_organization_id,
    p_contact_id,
    v_effective_partner_kind,
    extensions.digest(
      convert_to(v_raw_token, 'UTF8'),
      'sha256'
    ),
    right(v_raw_token, 6),
    nullif(btrim(p_label), ''),
    p_expires_at,
    v_user_id
  )
  returning * into v_link;

  insert into public.audit_logs (
    organization_id,
    user_id,
    action,
    entity,
    entity_id,
    new_data
  )
  values (
    p_organization_id,
    v_user_id,
    'partner_portal_link_created',
    'partner_portal_link',
    v_link.id::text,
    jsonb_build_object(
      'contact_id', p_contact_id,
      'requested_partner_kind', v_requested_partner_kind,
      'partner_kind', v_effective_partner_kind,
      'expires_at', p_expires_at,
      'token_hint', v_link.token_hint
    )
  );

  return jsonb_build_object(
    'id', v_link.id,
    'token', v_raw_token,
    'token_hint', v_link.token_hint,
    'partner_kind', v_effective_partner_kind,
    'expires_at', v_link.expires_at
  );
end
$function$;

revoke all on function public.create_partner_portal_link(
  uuid,
  uuid,
  text,
  text,
  timestamptz
) from public, anon;

grant execute on function public.create_partner_portal_link(
  uuid,
  uuid,
  text,
  text,
  timestamptz
) to authenticated;

with targets as (
  select
    link.id,
    link.organization_id,
    link.contact_id,
    link.created_by,
    link.partner_kind as previous_partner_kind
  from public.partner_portal_links link
  join public.contacts contact
    on contact.id = link.contact_id
   and contact.organization_id = link.organization_id
  where link.active = true
    and link.partner_kind <> 'terrenista'
    and lower(btrim(coalesce(contact.contact_type, ''))) = 'terrenista'
),
corrected as (
  update public.partner_portal_links link
     set partner_kind = 'terrenista'
    from targets target
   where link.id = target.id
  returning link.id
)
insert into public.audit_logs (
  organization_id,
  user_id,
  action,
  entity,
  entity_id,
  old_data,
  new_data
)
select
  target.organization_id,
  target.created_by,
  'partner_portal_link_kind_reconciled',
  'partner_portal_link',
  target.id::text,
  jsonb_build_object(
    'partner_kind',
    target.previous_partner_kind
  ),
  jsonb_build_object(
    'partner_kind',
    'terrenista',
    'contact_id',
    target.contact_id,
    'reason',
    'Categoria sincronizada com o cadastro ativo do terrenista.'
  )
from targets target
join corrected on corrected.id = target.id;

comment on function public.create_partner_portal_link(
  uuid,
  uuid,
  text,
  text,
  timestamptz
) is
  'Cria acesso protegido e força a categoria terrenista quando definida no cadastro do contato.';
