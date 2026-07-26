-- Évora Gestão 6.10
-- Portal de Parceiros e Pagamentos.
--
-- financial_entries remains the accounting source of truth. Nothing is exposed
-- until an authorized user creates an explicit publication for a payable.

do $preflight$
begin
  if to_regclass('public.organizations') is null
    or to_regclass('public.contacts') is null
    or to_regclass('public.financial_entries') is null
    or to_regclass('public.organization_members') is null
    or to_regclass('public.role_permissions') is null
    or to_regclass('public.profiles') is null
    or to_regclass('public.projects') is null
    or to_regclass('public.audit_logs') is null then
    raise exception 'Partner portal prerequisites are missing.';
  end if;

  if to_regprocedure('public.has_app_permission(uuid,text)') is null
    or to_regprocedure('public.set_updated_at()') is null then
    raise exception 'Partner portal prerequisite functions are missing.';
  end if;
end
$preflight$;

create table public.partner_portal_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  partner_kind text not null default 'fornecedor'
    check (partner_kind in ('fornecedor', 'credor_financeiro', 'terrenista', 'parceiro')),
  token_hash bytea not null unique,
  token_hint text not null check (char_length(token_hint) = 6),
  label text check (char_length(label) <= 160),
  active boolean not null default true,
  expires_at timestamptz not null,
  last_access_at timestamptz,
  access_count integer not null default 0 check (access_count >= 0),
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  revoke_reason text check (char_length(revoke_reason) <= 500)
);

create unique index partner_portal_links_one_active_contact_idx
  on public.partner_portal_links (organization_id, contact_id)
  where active;

create index partner_portal_links_contact_idx
  on public.partner_portal_links (organization_id, contact_id, created_at desc);

create table public.partner_payment_publications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  financial_entry_id uuid not null unique
    references public.financial_entries(id) on delete cascade,
  public_status text not null default 'em_analise'
    check (
      public_status in (
        'em_analise',
        'previsto',
        'programado',
        'em_processamento',
        'pago',
        'suspenso'
      )
    ),
  forecast_start date,
  forecast_end date,
  scheduled_date date,
  processing_started_at timestamptz,
  paid_at timestamptz,
  public_note text check (char_length(public_note) <= 1200),
  visible boolean not null default true,
  version integer not null default 1 check (version > 0),
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint partner_publication_forecast_window_check check (
    public_status <> 'previsto'
    or (
      forecast_start is not null
      and forecast_end is not null
      and forecast_end >= forecast_start
    )
  ),
  constraint partner_publication_scheduled_date_check check (
    public_status <> 'programado' or scheduled_date is not null
  ),
  constraint partner_publication_processing_check check (
    public_status <> 'em_processamento' or processing_started_at is not null
  ),
  constraint partner_publication_paid_check check (
    public_status <> 'pago' or paid_at is not null
  )
);

create index partner_payment_publications_contact_idx
  on public.partner_payment_publications
  (organization_id, contact_id, visible, updated_at desc);

create index partner_payment_publications_status_idx
  on public.partner_payment_publications
  (organization_id, public_status, scheduled_date);

create table public.partner_negotiations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  portal_link_id uuid references public.partner_portal_links(id) on delete set null,
  financial_entry_id uuid references public.financial_entries(id) on delete set null,
  negotiation_type text not null
    check (
      negotiation_type in (
        'prorrogacao',
        'parcelamento',
        'antecipacao_desconto',
        'compensacao',
        'contestacao',
        'outro'
      )
    ),
  status text not null default 'aberta'
    check (
      status in (
        'aberta',
        'em_analise',
        'contraproposta',
        'aguardando_parceiro',
        'aceita_pelo_parceiro',
        'aprovada',
        'rejeitada',
        'cancelada',
        'encerrada'
      )
    ),
  subject text not null check (char_length(subject) between 3 and 180),
  current_terms jsonb not null default '{}'::jsonb
    check (
      jsonb_typeof(current_terms) = 'object'
      and pg_column_size(current_terms) <= 8192
    ),
  terms_version integer not null default 1 check (terms_version > 0),
  assigned_to uuid references auth.users(id) on delete set null,
  opened_at timestamptz not null default now(),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_notes text check (char_length(decision_notes) <= 2000),
  created_by uuid references auth.users(id) on delete set null,
  created_by_partner boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index partner_negotiations_queue_idx
  on public.partner_negotiations
  (organization_id, status, updated_at desc);

create index partner_negotiations_contact_idx
  on public.partner_negotiations
  (organization_id, contact_id, created_at desc);

create table public.partner_negotiation_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  negotiation_id uuid not null
    references public.partner_negotiations(id) on delete cascade,
  sender_kind text not null
    check (sender_kind in ('parceiro', 'equipe', 'sistema')),
  sender_user_id uuid references auth.users(id) on delete set null,
  sender_name text check (char_length(sender_name) <= 160),
  message_type text not null default 'mensagem'
    check (message_type in ('mensagem', 'proposta', 'contraproposta', 'decisao', 'sistema')),
  body text not null check (char_length(body) between 1 and 4000),
  terms_snapshot jsonb not null default '{}'::jsonb
    check (
      jsonb_typeof(terms_snapshot) = 'object'
      and pg_column_size(terms_snapshot) <= 8192
    ),
  terms_version integer,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index partner_negotiation_messages_thread_idx
  on public.partner_negotiation_messages (negotiation_id, created_at);

create table public.partner_portal_access_logs (
  id bigint generated by default as identity primary key,
  link_id uuid references public.partner_portal_links(id) on delete set null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_type text not null check (char_length(event_type) between 1 and 80),
  succeeded boolean not null default true,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index partner_portal_access_logs_link_idx
  on public.partner_portal_access_logs (link_id, created_at desc);

drop trigger if exists partner_portal_links_set_updated_at
  on public.partner_portal_links;
create trigger partner_portal_links_set_updated_at
before update on public.partner_portal_links
for each row execute function public.set_updated_at();

drop trigger if exists partner_payment_publications_set_updated_at
  on public.partner_payment_publications;
create trigger partner_payment_publications_set_updated_at
before update on public.partner_payment_publications
for each row execute function public.set_updated_at();

drop trigger if exists partner_negotiations_set_updated_at
  on public.partner_negotiations;
create trigger partner_negotiations_set_updated_at
before update on public.partner_negotiations
for each row execute function public.set_updated_at();

alter table public.partner_portal_links enable row level security;
alter table public.partner_payment_publications enable row level security;
alter table public.partner_negotiations enable row level security;
alter table public.partner_negotiation_messages enable row level security;
alter table public.partner_portal_access_logs enable row level security;

create policy partner_portal_links_select
  on public.partner_portal_links
  for select
  to authenticated
  using (
    public.has_app_permission(
      partner_portal_links.organization_id,
      'partners.view'
    )
  );

create policy partner_portal_links_insert
  on public.partner_portal_links
  for insert
  to authenticated
  with check (
    public.has_app_permission(
      partner_portal_links.organization_id,
      'platform.manage'
    )
    and exists (
      select 1
      from public.contacts contact
      where contact.id = partner_portal_links.contact_id
        and contact.organization_id = partner_portal_links.organization_id
    )
  );

create policy partner_portal_links_update
  on public.partner_portal_links
  for update
  to authenticated
  using (
    public.has_app_permission(
      partner_portal_links.organization_id,
      'platform.manage'
    )
  )
  with check (
    public.has_app_permission(
      partner_portal_links.organization_id,
      'platform.manage'
    )
    and exists (
      select 1
      from public.contacts contact
      where contact.id = partner_portal_links.contact_id
        and contact.organization_id = partner_portal_links.organization_id
    )
  );

create policy partner_portal_links_delete
  on public.partner_portal_links
  for delete
  to authenticated
  using (
    public.has_app_permission(
      partner_portal_links.organization_id,
      'platform.manage'
    )
  );

create policy partner_payment_publications_select
  on public.partner_payment_publications
  for select
  to authenticated
  using (
    public.has_app_permission(
      partner_payment_publications.organization_id,
      'partners.view'
    )
  );

create policy partner_payment_publications_insert
  on public.partner_payment_publications
  for insert
  to authenticated
  with check (
    public.has_app_permission(
      partner_payment_publications.organization_id,
      'platform.manage'
    )
    and exists (
      select 1
      from public.financial_entries entry
      where entry.id = partner_payment_publications.financial_entry_id
        and entry.organization_id =
          partner_payment_publications.organization_id
        and entry.contact_id = partner_payment_publications.contact_id
        and entry.type = 'saida'
        and entry.status <> 'cancelado'
    )
  );

create policy partner_payment_publications_update
  on public.partner_payment_publications
  for update
  to authenticated
  using (
    public.has_app_permission(
      partner_payment_publications.organization_id,
      'platform.manage'
    )
  )
  with check (
    public.has_app_permission(
      partner_payment_publications.organization_id,
      'platform.manage'
    )
    and exists (
      select 1
      from public.financial_entries entry
      where entry.id = partner_payment_publications.financial_entry_id
        and entry.organization_id =
          partner_payment_publications.organization_id
        and entry.contact_id = partner_payment_publications.contact_id
        and entry.type = 'saida'
        and entry.status <> 'cancelado'
    )
  );

create policy partner_payment_publications_delete
  on public.partner_payment_publications
  for delete
  to authenticated
  using (
    public.has_app_permission(
      partner_payment_publications.organization_id,
      'platform.manage'
    )
  );

create policy partner_negotiations_select
  on public.partner_negotiations
  for select
  to authenticated
  using (
    public.has_app_permission(
      partner_negotiations.organization_id,
      'partners.negotiations.view'
    )
  );

create policy partner_negotiations_insert
  on public.partner_negotiations
  for insert
  to authenticated
  with check (
    public.has_app_permission(
      partner_negotiations.organization_id,
      'platform.manage'
    )
  );

create policy partner_negotiations_update
  on public.partner_negotiations
  for update
  to authenticated
  using (
    public.has_app_permission(
      partner_negotiations.organization_id,
      'platform.manage'
    )
  )
  with check (
    public.has_app_permission(
      partner_negotiations.organization_id,
      'platform.manage'
    )
  );

create policy partner_negotiations_delete
  on public.partner_negotiations
  for delete
  to authenticated
  using (
    public.has_app_permission(
      partner_negotiations.organization_id,
      'platform.manage'
    )
  );

create policy partner_negotiation_messages_select
  on public.partner_negotiation_messages
  for select
  to authenticated
  using (
    public.has_app_permission(
      partner_negotiation_messages.organization_id,
      'partners.negotiations.view'
    )
  );

create policy partner_negotiation_messages_insert
  on public.partner_negotiation_messages
  for insert
  to authenticated
  with check (
    public.has_app_permission(
      partner_negotiation_messages.organization_id,
      'platform.manage'
    )
    and exists (
      select 1
      from public.partner_negotiations negotiation
      where negotiation.id =
          partner_negotiation_messages.negotiation_id
        and negotiation.organization_id =
          partner_negotiation_messages.organization_id
    )
  );

create policy partner_negotiation_messages_update
  on public.partner_negotiation_messages
  for update
  to authenticated
  using (
    public.has_app_permission(
      partner_negotiation_messages.organization_id,
      'platform.manage'
    )
  )
  with check (
    public.has_app_permission(
      partner_negotiation_messages.organization_id,
      'platform.manage'
    )
  );

create policy partner_negotiation_messages_delete
  on public.partner_negotiation_messages
  for delete
  to authenticated
  using (
    public.has_app_permission(
      partner_negotiation_messages.organization_id,
      'platform.manage'
    )
  );

create policy partner_portal_access_logs_select
  on public.partner_portal_access_logs
  for select
  to authenticated
  using (
    public.has_app_permission(
      partner_portal_access_logs.organization_id,
      'partners.view'
    )
  );

create policy partner_portal_access_logs_delete
  on public.partner_portal_access_logs
  for delete
  to authenticated
  using (
    public.has_app_permission(
      partner_portal_access_logs.organization_id,
      'platform.manage'
    )
  );

revoke all on table public.partner_portal_links from public, anon;
revoke all on table public.partner_payment_publications from public, anon;
revoke all on table public.partner_negotiations from public, anon;
revoke all on table public.partner_negotiation_messages from public, anon;
revoke all on table public.partner_portal_access_logs from public, anon;

revoke all on table public.partner_portal_links from authenticated;
revoke all on table public.partner_payment_publications from authenticated;
revoke all on table public.partner_negotiations from authenticated;
revoke all on table public.partner_negotiation_messages from authenticated;
revoke all on table public.partner_portal_access_logs from authenticated;

grant select (
  id,
  organization_id,
  contact_id,
  partner_kind,
  token_hint,
  label,
  active,
  expires_at,
  last_access_at,
  access_count,
  failed_attempts,
  locked_until,
  created_by,
  created_at,
  updated_at,
  revoked_by,
  revoked_at,
  revoke_reason
) on table public.partner_portal_links to authenticated;
grant select on table public.partner_payment_publications to authenticated;
grant select on table public.partner_negotiations to authenticated;
grant select on table public.partner_negotiation_messages to authenticated;
grant select on table public.partner_portal_access_logs to authenticated;

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
begin
  if v_user_id is null
    or not public.has_app_permission(
      p_organization_id,
      'partners.access.manage'
    ) then
    raise exception 'Acesso não autorizado.';
  end if;

  if p_partner_kind not in (
    'fornecedor',
    'credor_financeiro',
    'terrenista',
    'parceiro'
  ) then
    raise exception 'Tipo de parceiro inválido.';
  end if;

  select regexp_replace(coalesce(contact.document, ''), '\D', '', 'g')
    into v_document_digits
    from public.contacts contact
   where contact.id = p_contact_id
     and contact.organization_id = p_organization_id
     and contact.active = true;

  if not found then
    raise exception 'Parceiro não localizado.';
  end if;

  if char_length(v_document_digits) < 4 then
    raise exception 'Cadastre o CPF ou CNPJ do parceiro antes de gerar o acesso.';
  end if;

  if p_expires_at <= now() or p_expires_at > now() + interval '365 days' then
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
    p_partner_kind,
    extensions.digest(convert_to(v_raw_token, 'UTF8'), 'sha256'),
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
      'partner_kind', p_partner_kind,
      'expires_at', p_expires_at,
      'token_hint', v_link.token_hint
    )
  );

  return jsonb_build_object(
    'id', v_link.id,
    'token', v_raw_token,
    'token_hint', v_link.token_hint,
    'expires_at', v_link.expires_at
  );
end
$function$;

create or replace function public.revoke_partner_portal_link(
  p_organization_id uuid,
  p_link_id uuid,
  p_reason text default 'Acesso revogado pela administração.'
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null
    or not public.has_app_permission(
      p_organization_id,
      'partners.access.manage'
    ) then
    raise exception 'Acesso não autorizado.';
  end if;

  update public.partner_portal_links
     set active = false,
         revoked_by = v_user_id,
         revoked_at = now(),
         revoke_reason = left(coalesce(nullif(btrim(p_reason), ''), 'Acesso revogado.'), 500)
   where id = p_link_id
     and organization_id = p_organization_id;

  if not found then
    raise exception 'Acesso não localizado.';
  end if;

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
    'partner_portal_link_revoked',
    'partner_portal_link',
    p_link_id::text,
    jsonb_build_object('reason', left(coalesce(p_reason, ''), 500))
  );
end
$function$;

create or replace function public.publish_partner_payment(
  p_organization_id uuid,
  p_financial_entry_id uuid,
  p_public_status text,
  p_forecast_start date default null,
  p_forecast_end date default null,
  p_scheduled_date date default null,
  p_public_note text default null,
  p_visible boolean default true
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_contact_id uuid;
  v_entry_status text;
  v_approval_status text;
  v_payment_blocked boolean;
  v_is_provision boolean;
  v_payment_release_status text;
  v_settlement_date date;
  v_publication_id uuid;
  v_requires_process_permission boolean;
begin
  if v_user_id is null
    or not (
      public.has_app_permission(
        p_organization_id,
        'partners.payments.publish'
      )
      or public.has_app_permission(
        p_organization_id,
        'partners.process'
      )
    ) then
    raise exception 'Acesso não autorizado.';
  end if;

  if p_public_status not in (
    'em_analise',
    'previsto',
    'programado',
    'em_processamento',
    'pago',
    'suspenso'
  ) then
    raise exception 'Situação pública inválida.';
  end if;

  select
    entry.contact_id,
    entry.status,
    entry.approval_status,
    entry.payment_blocked,
    entry.is_provision,
    entry.payment_release_status,
    entry.settlement_date
    into
      v_contact_id,
      v_entry_status,
      v_approval_status,
      v_payment_blocked,
      v_is_provision,
      v_payment_release_status,
      v_settlement_date
    from public.financial_entries entry
   where entry.id = p_financial_entry_id
     and entry.organization_id = p_organization_id
     and entry.type = 'saida'
     and entry.status <> 'cancelado'
   for update;

  if not found or v_contact_id is null then
    raise exception 'Vincule um fornecedor válido ao título antes de publicá-lo.';
  end if;

  if v_entry_status = 'pago' then
    p_public_status := 'pago';
  end if;

  v_requires_process_permission :=
    p_public_status in ('em_processamento', 'pago');

  if (
    v_requires_process_permission
    and not public.has_app_permission(
      p_organization_id,
      'partners.process'
    )
  ) or (
    not v_requires_process_permission
    and not public.has_app_permission(
      p_organization_id,
      'partners.payments.publish'
    )
  ) then
    raise exception 'Acesso não autorizado.';
  end if;

  if p_public_status = 'previsto'
    and (
      p_forecast_start is null
      or p_forecast_end is null
      or p_forecast_end < p_forecast_start
    ) then
    raise exception 'Informe uma janela de previsão válida.';
  end if;

  if p_public_status in ('programado', 'em_processamento')
    and p_scheduled_date is null then
    raise exception 'Informe a data programada.';
  end if;

  if p_public_status in ('programado', 'em_processamento')
    and (
      v_approval_status <> 'aprovado'
      or v_payment_blocked
      or (
        v_is_provision
        and v_payment_release_status not in ('liberado', 'reconciliado')
      )
    ) then
    raise exception 'Somente títulos aprovados, liberados e não provisionais podem ser programados ou processados.';
  end if;

  if p_public_status = 'pago'
    and (
      v_entry_status <> 'pago'
      or v_settlement_date is null
    ) then
    raise exception 'A liquidação somente pode ser publicada após a baixa financeira.';
  end if;

  insert into public.partner_payment_publications (
    organization_id,
    contact_id,
    financial_entry_id,
    public_status,
    forecast_start,
    forecast_end,
    scheduled_date,
    processing_started_at,
    paid_at,
    public_note,
    visible,
    published_by,
    published_at
  )
  values (
    p_organization_id,
    v_contact_id,
    p_financial_entry_id,
    p_public_status,
    case when p_public_status = 'previsto' then p_forecast_start end,
    case when p_public_status = 'previsto' then p_forecast_end end,
    case
      when p_public_status in ('programado', 'em_processamento', 'pago')
      then p_scheduled_date
    end,
    case when p_public_status = 'em_processamento' then now() end,
    case
      when p_public_status = 'pago'
      then v_settlement_date::timestamptz
    end,
    left(nullif(btrim(p_public_note), ''), 1200),
    p_visible,
    v_user_id,
    now()
  )
  on conflict (financial_entry_id) do update
    set organization_id = excluded.organization_id,
        contact_id = excluded.contact_id,
        public_status = excluded.public_status,
        forecast_start = excluded.forecast_start,
        forecast_end = excluded.forecast_end,
        scheduled_date = excluded.scheduled_date,
        processing_started_at = case
          when excluded.public_status = 'em_processamento'
          then coalesce(
            public.partner_payment_publications.processing_started_at,
            now()
          )
          else null
        end,
        paid_at = case
          when excluded.public_status = 'pago'
          then excluded.paid_at
          else null
        end,
        public_note = excluded.public_note,
        visible = excluded.visible,
        version = public.partner_payment_publications.version + 1,
        published_by = excluded.published_by,
        published_at = now()
  returning id into v_publication_id;

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
    'partner_payment_published',
    'partner_payment_publication',
    v_publication_id::text,
    jsonb_build_object(
      'financial_entry_id', p_financial_entry_id,
      'public_status', p_public_status,
      'forecast_start', p_forecast_start,
      'forecast_end', p_forecast_end,
      'scheduled_date', p_scheduled_date,
      'visible', p_visible
    )
  );

  return v_publication_id;
end
$function$;

create or replace function public.reply_partner_negotiation(
  p_organization_id uuid,
  p_negotiation_id uuid,
  p_message text,
  p_next_status text default 'em_analise',
  p_terms jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_message_id uuid;
  v_version integer;
begin
  if v_user_id is null
    or not public.has_app_permission(
      p_organization_id,
      'partners.negotiations.manage'
    ) then
    raise exception 'Acesso não autorizado.';
  end if;

  if char_length(btrim(coalesce(p_message, ''))) not between 1 and 4000 then
    raise exception 'A mensagem deve ter entre 1 e 4.000 caracteres.';
  end if;

  if p_next_status not in (
    'em_analise',
    'contraproposta',
    'aguardando_parceiro',
    'encerrada'
  ) then
    raise exception 'Próxima situação inválida.';
  end if;

  if p_terms is not null
    and (
      jsonb_typeof(p_terms) <> 'object'
      or pg_column_size(p_terms) > 8192
    ) then
    raise exception 'Condições propostas inválidas ou muito extensas.';
  end if;

  update public.partner_negotiations
     set status = p_next_status,
         current_terms = coalesce(p_terms, current_terms),
         terms_version = case
           when p_terms is null then terms_version
           else terms_version + 1
         end,
         assigned_to = coalesce(assigned_to, v_user_id)
   where id = p_negotiation_id
     and organization_id = p_organization_id
     and status not in ('aprovada', 'rejeitada', 'cancelada', 'encerrada')
  returning terms_version into v_version;

  if not found then
    raise exception 'Negociação não localizada ou já encerrada.';
  end if;

  insert into public.partner_negotiation_messages (
    organization_id,
    negotiation_id,
    sender_kind,
    sender_user_id,
    sender_name,
    message_type,
    body,
    terms_snapshot,
    terms_version
  )
  select
    p_organization_id,
    p_negotiation_id,
    'equipe',
    v_user_id,
    coalesce(profile.full_name, 'Equipe Évora'),
    case when p_terms is null then 'mensagem' else 'contraproposta' end,
    btrim(p_message),
    coalesce(p_terms, '{}'::jsonb),
    v_version
  from public.profiles profile
  where profile.id = v_user_id
  returning id into v_message_id;

  if v_message_id is null then
    insert into public.partner_negotiation_messages (
      organization_id,
      negotiation_id,
      sender_kind,
      sender_user_id,
      sender_name,
      message_type,
      body,
      terms_snapshot,
      terms_version
    )
    values (
      p_organization_id,
      p_negotiation_id,
      'equipe',
      v_user_id,
      'Equipe Évora',
      case when p_terms is null then 'mensagem' else 'contraproposta' end,
      btrim(p_message),
      coalesce(p_terms, '{}'::jsonb),
      v_version
    )
    returning id into v_message_id;
  end if;

  return v_message_id;
end
$function$;

create or replace function public.decide_partner_negotiation(
  p_organization_id uuid,
  p_negotiation_id uuid,
  p_decision text,
  p_decision_notes text
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_terms jsonb;
  v_terms_version integer;
begin
  if v_user_id is null
    or not public.has_app_permission(
      p_organization_id,
      'partners.negotiations.approve'
    ) then
    raise exception 'Acesso não autorizado.';
  end if;

  if p_decision not in ('aprovada', 'rejeitada') then
    raise exception 'Decisão inválida.';
  end if;

  if char_length(btrim(coalesce(p_decision_notes, ''))) not between 3 and 2000 then
    raise exception 'Registre a fundamentação da decisão.';
  end if;

  update public.partner_negotiations
     set status = p_decision,
         decided_by = v_user_id,
         decided_at = now(),
         decision_notes = btrim(p_decision_notes)
   where id = p_negotiation_id
     and organization_id = p_organization_id
     and assigned_to is distinct from v_user_id
     and created_by is distinct from v_user_id
     and status not in ('aprovada', 'rejeitada', 'cancelada', 'encerrada')
  returning current_terms, terms_version
    into v_terms, v_terms_version;

  if not found then
    raise exception 'Negociação indisponível para esta alçada ou já decidida.';
  end if;

  insert into public.partner_negotiation_messages (
    organization_id,
    negotiation_id,
    sender_kind,
    sender_user_id,
    sender_name,
    message_type,
    body,
    terms_snapshot,
    terms_version
  )
  values (
    p_organization_id,
    p_negotiation_id,
    'sistema',
    v_user_id,
    'Évora Urbanismo',
    'decisao',
    case
      when p_decision = 'aprovada'
      then 'A proposta foi aprovada internamente. A formalização será conduzida pela equipe responsável.'
      else 'A proposta não foi aprovada nas condições apresentadas. O canal permanece registrado para futuras tratativas.'
    end,
    v_terms,
    v_terms_version
  );

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
    'partner_negotiation_decided',
    'partner_negotiation',
    p_negotiation_id::text,
    jsonb_build_object(
      'decision', p_decision,
      'terms_version', v_terms_version,
      'decision_notes', left(p_decision_notes, 500)
    )
  );
end
$function$;

create or replace function public.validate_partner_portal_link(
  p_token text,
  p_document_last4 text,
  p_event_type text
)
returns public.partner_portal_links
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_link public.partner_portal_links%rowtype;
  v_document_digits text;
  v_last4 text := regexp_replace(coalesce(p_document_last4, ''), '\D', '', 'g');
begin
  if char_length(btrim(coalesce(p_token, ''))) <> 64
    or char_length(v_last4) <> 4 then
    return null;
  end if;

  select link.*
    into v_link
    from public.partner_portal_links link
   where link.token_hash = extensions.digest(
       convert_to(lower(btrim(p_token)), 'UTF8'),
       'sha256'
     )
     and link.active = true
   limit 1;

  if not found
    or v_link.expires_at <= now()
    or coalesce(v_link.locked_until, '-infinity'::timestamptz) > now() then
    return null;
  end if;

  select regexp_replace(coalesce(contact.document, ''), '\D', '', 'g')
    into v_document_digits
    from public.contacts contact
   where contact.id = v_link.contact_id
     and contact.organization_id = v_link.organization_id
     and contact.active = true;

  if not found or right(v_document_digits, 4) <> v_last4 then
    update public.partner_portal_links
       set failed_attempts = failed_attempts + 1,
           locked_until = case
             when failed_attempts + 1 >= 5
             then now() + interval '15 minutes'
             else locked_until
           end
     where id = v_link.id;

    insert into public.partner_portal_access_logs (
      link_id,
      organization_id,
      event_type,
      succeeded,
      context
    )
    values (
      v_link.id,
      v_link.organization_id,
      'credential_failed',
      false,
      jsonb_build_object('requested_event', left(coalesce(p_event_type, ''), 80))
    );

    return null;
  end if;

  update public.partner_portal_links
     set last_access_at = now(),
         access_count = access_count + 1,
         failed_attempts = 0,
         locked_until = null
   where id = v_link.id;

  insert into public.partner_portal_access_logs (
    link_id,
    organization_id,
    event_type,
    succeeded
  )
  values (
    v_link.id,
    v_link.organization_id,
    left(coalesce(nullif(p_event_type, ''), 'portal_access'), 80),
    true
  );

  return v_link;
end
$function$;

create or replace function public.get_partner_payment_portal(
  p_token text,
  p_document_last4 text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_link public.partner_portal_links%rowtype;
  v_payload jsonb;
begin
  v_link := public.validate_partner_portal_link(
    p_token,
    p_document_last4,
    'portal_view'
  );

  if v_link.id is null then
    return null;
  end if;

  select jsonb_build_object(
    'organization',
    jsonb_build_object(
      'name', organization.name,
      'trade_name', organization.trade_name
    ),
    'partner',
    jsonb_build_object(
      'name', contact.name,
      'trade_name', contact.trade_name,
      'kind', v_link.partner_kind
    ),
    'access',
    jsonb_build_object(
      'label', v_link.label,
      'expires_at', v_link.expires_at,
      'token_hint', v_link.token_hint
    ),
    'payments',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', entry.id,
            'publication_id', publication.id,
            'description', entry.description,
            'project_name', project.name,
            'document_number', entry.document_number,
            'installment_number', entry.installment_number,
            'installment_total', entry.installment_total,
            'amount', coalesce(nullif(entry.open_amount, 0), entry.amount),
            'contractual_due_date', entry.due_date,
            'public_status', case
              when entry.status = 'pago'
                and entry.settlement_date is not null
              then 'pago'
              else publication.public_status
            end,
            'forecast_start', publication.forecast_start,
            'forecast_end', publication.forecast_end,
            'scheduled_date', publication.scheduled_date,
            'processing_started_at', publication.processing_started_at,
            'paid_on', entry.settlement_date,
            'paid_at', publication.paid_at,
            'public_note', publication.public_note,
            'updated_at', publication.updated_at
          )
          order by
            coalesce(
              publication.scheduled_date,
              publication.forecast_start,
              entry.due_date
            ),
            entry.description
        )
        from public.partner_payment_publications publication
        join public.financial_entries entry
          on entry.id = publication.financial_entry_id
        left join public.projects project
          on project.id = entry.project_id
        where publication.organization_id = v_link.organization_id
          and publication.contact_id = v_link.contact_id
          and publication.visible = true
          and entry.organization_id = v_link.organization_id
          and entry.contact_id = v_link.contact_id
          and entry.type = 'saida'
          and entry.status <> 'cancelado'
      ),
      '[]'::jsonb
    ),
    'negotiations',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', negotiation.id,
            'financial_entry_id', negotiation.financial_entry_id,
            'type', negotiation.negotiation_type,
            'status', negotiation.status,
            'subject', negotiation.subject,
            'current_terms', negotiation.current_terms,
            'terms_version', negotiation.terms_version,
            'opened_at', negotiation.opened_at,
            'updated_at', negotiation.updated_at,
            'messages',
            coalesce(
              (
                select jsonb_agg(
                  jsonb_build_object(
                    'id', message.id,
                    'sender_kind', message.sender_kind,
                    'sender_name', message.sender_name,
                    'message_type', message.message_type,
                    'body', message.body,
                    'terms_snapshot', message.terms_snapshot,
                    'terms_version', message.terms_version,
                    'created_at', message.created_at
                  )
                  order by message.created_at
                )
                from public.partner_negotiation_messages message
                where message.negotiation_id = negotiation.id
              ),
              '[]'::jsonb
            )
          )
          order by negotiation.updated_at desc
        )
        from public.partner_negotiations negotiation
        where negotiation.organization_id = v_link.organization_id
          and negotiation.contact_id = v_link.contact_id
      ),
      '[]'::jsonb
    ),
    'policy',
    jsonb_build_object(
      'forecast', 'Estimativa sujeita à conclusão das aprovações.',
      'scheduled', 'Pagamento aprovado e incluído em uma data financeira.',
      'processing', 'Ordem de pagamento em processamento bancário.',
      'paid', 'Liquidação confirmada pela Évora Urbanismo.'
    ),
    'generated_at', now()
  )
    into v_payload
    from public.organizations organization
    join public.contacts contact
      on contact.id = v_link.contact_id
     and contact.organization_id = organization.id
   where organization.id = v_link.organization_id;

  return v_payload;
end
$function$;

create or replace function public.open_partner_negotiation(
  p_token text,
  p_document_last4 text,
  p_financial_entry_id uuid,
  p_negotiation_type text,
  p_message text,
  p_proposed_due_date date default null,
  p_proposed_installments integer default null,
  p_proposed_discount_pct numeric default null,
  p_proposed_amount numeric default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_link public.partner_portal_links%rowtype;
  v_negotiation_id uuid;
  v_subject text;
  v_terms jsonb;
begin
  v_link := public.validate_partner_portal_link(
    p_token,
    p_document_last4,
    'negotiation_open'
  );

  if v_link.id is null then
    return null;
  end if;

  if p_negotiation_type not in (
    'prorrogacao',
    'parcelamento',
    'antecipacao_desconto',
    'compensacao',
    'contestacao',
    'outro'
  ) then
    raise exception 'Tipo de negociação inválido.';
  end if;

  if char_length(btrim(coalesce(p_message, ''))) not between 10 and 4000 then
    raise exception 'Descreva a solicitação com pelo menos 10 caracteres.';
  end if;

  if p_proposed_installments is not null
    and p_proposed_installments not between 1 and 120 then
    raise exception 'Quantidade de parcelas inválida.';
  end if;

  if p_proposed_discount_pct is not null
    and p_proposed_discount_pct not between 0 and 100 then
    raise exception 'Percentual de desconto inválido.';
  end if;

  if p_proposed_amount is not null and p_proposed_amount <= 0 then
    raise exception 'Valor proposto inválido.';
  end if;

  if p_financial_entry_id is not null
    and not exists (
      select 1
      from public.partner_payment_publications publication
      join public.financial_entries entry
        on entry.id = publication.financial_entry_id
      where publication.financial_entry_id = p_financial_entry_id
        and publication.organization_id = v_link.organization_id
        and publication.contact_id = v_link.contact_id
        and publication.visible = true
        and entry.organization_id = v_link.organization_id
        and entry.contact_id = v_link.contact_id
        and entry.type = 'saida'
        and entry.status <> 'cancelado'
    ) then
    raise exception 'Título indisponível para negociação.';
  end if;

  if (
    select count(*)
    from public.partner_negotiations negotiation
    where negotiation.portal_link_id = v_link.id
      and negotiation.created_at > now() - interval '10 minutes'
  ) >= 5 then
    raise exception 'Limite temporário de solicitações atingido. Tente novamente em alguns minutos.';
  end if;

  v_subject := case p_negotiation_type
    when 'prorrogacao' then 'Solicitação de alteração de vencimento'
    when 'parcelamento' then 'Proposta de parcelamento'
    when 'antecipacao_desconto' then 'Proposta de antecipação com desconto'
    when 'compensacao' then 'Proposta de compensação'
    when 'contestacao' then 'Contestação de valor ou condição'
    else 'Solicitação de negociação'
  end;

  v_terms := jsonb_strip_nulls(
    jsonb_build_object(
      'proposed_due_date', p_proposed_due_date,
      'proposed_installments', p_proposed_installments,
      'proposed_discount_pct', p_proposed_discount_pct,
      'proposed_amount', p_proposed_amount
    )
  );

  insert into public.partner_negotiations (
    organization_id,
    contact_id,
    portal_link_id,
    financial_entry_id,
    negotiation_type,
    subject,
    current_terms,
    created_by_partner
  )
  values (
    v_link.organization_id,
    v_link.contact_id,
    v_link.id,
    p_financial_entry_id,
    p_negotiation_type,
    v_subject,
    v_terms,
    true
  )
  returning id into v_negotiation_id;

  insert into public.partner_negotiation_messages (
    organization_id,
    negotiation_id,
    sender_kind,
    sender_name,
    message_type,
    body,
    terms_snapshot,
    terms_version
  )
  values (
    v_link.organization_id,
    v_negotiation_id,
    'parceiro',
    'Parceiro',
    'proposta',
    btrim(p_message),
    v_terms,
    1
  );

  insert into public.audit_logs (
    organization_id,
    user_id,
    action,
    entity,
    entity_id,
    new_data
  )
  values (
    v_link.organization_id,
    null,
    'partner_negotiation_opened',
    'partner_negotiation',
    v_negotiation_id::text,
    jsonb_build_object(
      'contact_id', v_link.contact_id,
      'financial_entry_id', p_financial_entry_id,
      'type', p_negotiation_type
    )
  );

  return v_negotiation_id;
end
$function$;

create or replace function public.post_partner_negotiation_message(
  p_token text,
  p_document_last4 text,
  p_negotiation_id uuid,
  p_message text
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_link public.partner_portal_links%rowtype;
  v_message_id uuid;
begin
  v_link := public.validate_partner_portal_link(
    p_token,
    p_document_last4,
    'negotiation_message'
  );

  if v_link.id is null then
    return null;
  end if;

  if char_length(btrim(coalesce(p_message, ''))) not between 1 and 4000 then
    raise exception 'A mensagem deve ter entre 1 e 4.000 caracteres.';
  end if;

  perform 1
    from public.partner_negotiations negotiation
    where negotiation.id = p_negotiation_id
      and negotiation.organization_id = v_link.organization_id
      and negotiation.contact_id = v_link.contact_id
      and negotiation.status not in (
        'aprovada',
        'rejeitada',
        'cancelada',
        'encerrada'
      )
    for update;

  if not found then
    raise exception 'Negociação indisponível.';
  end if;

  if (
    select count(*)
    from public.partner_negotiation_messages message
    join public.partner_negotiations negotiation
      on negotiation.id = message.negotiation_id
    where negotiation.portal_link_id = v_link.id
      and message.sender_kind = 'parceiro'
      and message.created_at > now() - interval '5 minutes'
  ) >= 10 then
    raise exception 'Limite temporário de mensagens atingido. Aguarde alguns minutos.';
  end if;

  if (
    select count(*)
    from public.partner_negotiation_messages message
    join public.partner_negotiations negotiation
      on negotiation.id = message.negotiation_id
    where negotiation.portal_link_id = v_link.id
      and message.sender_kind = 'parceiro'
      and message.created_at > now() - interval '24 hours'
  ) >= 100 then
    raise exception 'Limite diário de mensagens atingido.';
  end if;

  insert into public.partner_negotiation_messages (
    organization_id,
    negotiation_id,
    sender_kind,
    sender_name,
    body
  )
  values (
    v_link.organization_id,
    p_negotiation_id,
    'parceiro',
    'Parceiro',
    btrim(p_message)
  )
  returning id into v_message_id;

  update public.partner_negotiations
     set status = 'em_analise'
   where id = p_negotiation_id
     and organization_id = v_link.organization_id
     and contact_id = v_link.contact_id
     and status not in (
       'aprovada',
       'rejeitada',
       'cancelada',
       'encerrada'
     );

  return v_message_id;
end
$function$;

create or replace function public.sync_partner_payment_public_status()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if new.type <> 'saida' then
    return new;
  end if;

  if new.status = 'pago'
    and new.settlement_date is not null
    and (
      old.status is distinct from new.status
      or old.settlement_date is distinct from new.settlement_date
    ) then
    update public.partner_payment_publications
       set public_status = 'pago',
           paid_at = new.settlement_date::timestamptz,
           visible = true,
           version = version + 1,
           published_at = now()
     where financial_entry_id = new.id;
  elsif (
    new.status = 'pago'
    and new.settlement_date is null
  ) or (
    old.status = 'pago'
    and new.status <> 'pago'
  ) or (
    new.status = 'cancelado'
    and old.status is distinct from new.status
  ) then
    update public.partner_payment_publications
       set public_status = 'suspenso',
           visible = false,
           processing_started_at = null,
           paid_at = null,
           version = version + 1,
           published_at = now()
     where financial_entry_id = new.id;
  end if;

  return new;
end
$function$;

drop trigger if exists financial_entry_partner_public_status
  on public.financial_entries;
create trigger financial_entry_partner_public_status
after update of status, settlement_date on public.financial_entries
for each row execute function public.sync_partner_payment_public_status();

revoke all on function public.sync_partner_payment_public_status()
  from public, anon, authenticated;

create or replace function public.reset_partner_portal_data(
  p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_counts jsonb;
begin
  if v_user_id is null
    or not public.has_app_permission(
      p_organization_id,
      'platform.manage'
    ) then
    raise exception 'Acesso não autorizado.';
  end if;

  select jsonb_build_object(
    'links', count(*) filter (where source = 'links'),
    'publications', count(*) filter (where source = 'publications'),
    'negotiations', count(*) filter (where source = 'negotiations'),
    'messages', count(*) filter (where source = 'messages'),
    'access_logs', count(*) filter (where source = 'access_logs')
  )
    into v_counts
    from (
      select 'links' source
        from public.partner_portal_links
       where organization_id = p_organization_id
      union all
      select 'publications'
        from public.partner_payment_publications
       where organization_id = p_organization_id
      union all
      select 'negotiations'
        from public.partner_negotiations
       where organization_id = p_organization_id
      union all
      select 'messages'
        from public.partner_negotiation_messages
       where organization_id = p_organization_id
      union all
      select 'access_logs'
        from public.partner_portal_access_logs
       where organization_id = p_organization_id
    ) scoped_rows;

  delete from public.partner_portal_access_logs
   where organization_id = p_organization_id;
  delete from public.partner_negotiation_messages
   where organization_id = p_organization_id;
  delete from public.partner_negotiations
   where organization_id = p_organization_id;
  delete from public.partner_payment_publications
   where organization_id = p_organization_id;
  delete from public.partner_portal_links
   where organization_id = p_organization_id;

  insert into public.audit_logs (
    organization_id,
    user_id,
    action,
    entity,
    new_data
  )
  values (
    p_organization_id,
    v_user_id,
    'partner_portal_data_reset',
    'partner_portal',
    v_counts
  );

  return v_counts;
end
$function$;

revoke all on function public.create_partner_portal_link(
  uuid,
  uuid,
  text,
  text,
  timestamptz
) from public, anon;
revoke all on function public.revoke_partner_portal_link(
  uuid,
  uuid,
  text
) from public, anon;
revoke all on function public.publish_partner_payment(
  uuid,
  uuid,
  text,
  date,
  date,
  date,
  text,
  boolean
) from public, anon;
revoke all on function public.reply_partner_negotiation(
  uuid,
  uuid,
  text,
  text,
  jsonb
) from public, anon;
revoke all on function public.decide_partner_negotiation(
  uuid,
  uuid,
  text,
  text
) from public, anon;
revoke all on function public.validate_partner_portal_link(
  text,
  text,
  text
) from public, anon, authenticated;
revoke all on function public.get_partner_payment_portal(
  text,
  text
) from public;
revoke all on function public.open_partner_negotiation(
  text,
  text,
  uuid,
  text,
  text,
  date,
  integer,
  numeric,
  numeric
) from public;
revoke all on function public.post_partner_negotiation_message(
  text,
  text,
  uuid,
  text
) from public;
revoke all on function public.reset_partner_portal_data(uuid)
  from public, anon;

grant execute on function public.create_partner_portal_link(
  uuid,
  uuid,
  text,
  text,
  timestamptz
) to authenticated;
grant execute on function public.revoke_partner_portal_link(
  uuid,
  uuid,
  text
) to authenticated;
grant execute on function public.publish_partner_payment(
  uuid,
  uuid,
  text,
  date,
  date,
  date,
  text,
  boolean
) to authenticated;
grant execute on function public.reply_partner_negotiation(
  uuid,
  uuid,
  text,
  text,
  jsonb
) to authenticated;
grant execute on function public.decide_partner_negotiation(
  uuid,
  uuid,
  text,
  text
) to authenticated;
grant execute on function public.get_partner_payment_portal(
  text,
  text
) to anon, authenticated;
grant execute on function public.open_partner_negotiation(
  text,
  text,
  uuid,
  text,
  text,
  date,
  integer,
  numeric,
  numeric
) to anon, authenticated;
grant execute on function public.post_partner_negotiation_message(
  text,
  text,
  uuid,
  text
) to anon, authenticated;
grant execute on function public.reset_partner_portal_data(uuid)
  to authenticated;

insert into public.role_permissions (
  organization_id,
  role,
  permission_key,
  allowed,
  updated_at
)
select
  organization.id,
  role_name.role,
  permission.permission_key,
  case
    when role_name.role in ('admin', 'diretoria') then true
    when role_name.role = 'financeiro'
      and permission.permission_key <> 'partners.negotiations.approve'
      then true
    when role_name.role = 'compras'
      and permission.permission_key in (
        'partners.view',
        'partners.negotiations.view'
      ) then true
    else false
  end,
  now()
from public.organizations organization
cross join (
  values
    ('admin'),
    ('diretoria'),
    ('financeiro'),
    ('engenharia'),
    ('comercial'),
    ('compras'),
    ('consulta'),
    ('gestor_crm'),
    ('sdr'),
    ('corretor'),
    ('marketing')
) as role_name(role)
cross join (
  values
    ('partners.view'),
    ('partners.payments.publish'),
    ('partners.process'),
    ('partners.negotiations.view'),
    ('partners.negotiations.manage'),
    ('partners.negotiations.approve'),
    ('partners.access.manage')
) as permission(permission_key)
on conflict (organization_id, role, permission_key) do nothing;

comment on table public.partner_payment_publications is
  'Intentional, creditor-safe publication layer for outgoing financial entries.';
comment on function public.get_partner_payment_portal(text, text) is
  'Returns only explicitly published payables for one token-scoped partner after document-last4 verification.';
comment on function public.open_partner_negotiation(
  text,
  text,
  uuid,
  text,
  text,
  date,
  integer,
  numeric,
  numeric
) is
  'Opens a rate-limited negotiation scoped to the validated partner link.';
