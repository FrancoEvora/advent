-- Évora Gestão — data canônica da programação efetiva de pagamentos
--
-- `financial_entries.scheduled_payment_date` registra a data efetivamente
-- programada pelo financeiro. O vencimento contratual (`due_date`) não é
-- alterado. A publicação do portal continua sendo um snapshot controlado e
-- nunca é criada nem tornada visível por esta migração.

alter table if exists public.financial_entries
  add column if not exists scheduled_payment_date date;

comment on column public.financial_entries.scheduled_payment_date is
  'Data efetivamente programada para o pagamento. Nula até a programação financeira; não substitui o vencimento contratual.';

do $migration$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conname = 'financial_entries_scheduled_payment_outgoing_check'
       and conrelid = 'public.financial_entries'::regclass
  ) then
    alter table public.financial_entries
      add constraint financial_entries_scheduled_payment_outgoing_check
      check (
        scheduled_payment_date is null
        or type = 'saida'
      );
  end if;
end
$migration$;

create index if not exists
  financial_entries_org_scheduled_payment_date_idx
on public.financial_entries (
  organization_id,
  scheduled_payment_date
)
where type = 'saida'
  and scheduled_payment_date is not null;

-- Uma programação que já havia sido explicitamente publicada é evidência
-- suficiente para preencher a nova fonte canônica. Não se usa `due_date` como
-- backfill e nenhuma publicação nova é criada.
update public.financial_entries entry
   set scheduled_payment_date = publication.scheduled_date
  from public.partner_payment_publications publication
 where publication.financial_entry_id = entry.id
   and publication.organization_id = entry.organization_id
   and publication.public_status in (
     'programado',
     'em_processamento',
     'pago'
   )
   and publication.scheduled_date is not null
   and entry.type = 'saida'
   and entry.status <> 'cancelado'
   and entry.scheduled_payment_date is null;

-- Toda publicação nova em "programado" ou "em processamento" também grava
-- a data canônica no lançamento. Assim, inclusive os chamadores legados do
-- RPC publish_partner_payment permanecem coerentes sem mudar sua assinatura.
create or replace function public.sync_partner_publication_payment_date_to_entry()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if new.public_status not in (
    'programado',
    'em_processamento',
    'pago'
  ) then
    return new;
  end if;

  if new.public_status = 'pago' and new.scheduled_date is null then
    return new;
  end if;

  if new.scheduled_date is null then
    raise exception 'Informe a data efetivamente programada.';
  end if;

  update public.financial_entries entry
     set scheduled_payment_date = new.scheduled_date
   where entry.id = new.financial_entry_id
     and entry.organization_id = new.organization_id
     and entry.contact_id = new.contact_id
     and entry.type = 'saida'
     and entry.status <> 'cancelado'
     and entry.scheduled_payment_date is distinct from new.scheduled_date;

  if not found and not exists (
    select 1
      from public.financial_entries entry
     where entry.id = new.financial_entry_id
       and entry.organization_id = new.organization_id
       and entry.contact_id = new.contact_id
       and entry.type = 'saida'
       and entry.status <> 'cancelado'
       and entry.scheduled_payment_date = new.scheduled_date
  ) then
    raise exception 'Lançamento de saída válido não localizado para a programação.';
  end if;

  return new;
end
$function$;

drop trigger if exists partner_publication_sync_scheduled_payment_date
  on public.partner_payment_publications;
create trigger partner_publication_sync_scheduled_payment_date
before insert or update of
  public_status,
  scheduled_date,
  financial_entry_id,
  organization_id
on public.partner_payment_publications
for each row
execute function public.sync_partner_publication_payment_date_to_entry();

revoke all on function
  public.sync_partner_publication_payment_date_to_entry()
from public, anon, authenticated;

-- O portal recebe a data de emissão e a data canônica somente quando o título
-- já está publicamente programado, em processamento ou pago. Para publicações
-- legadas, scheduled_date preserva o snapshot existente como fallback.
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
            'issue_date', entry.issue_date,
            'contractual_due_date', entry.due_date,
            'public_status', case
              when entry.status = 'pago'
                and entry.settlement_date is not null
              then 'pago'
              else publication.public_status
            end,
            'forecast_start', publication.forecast_start,
            'forecast_end', publication.forecast_end,
            'scheduled_payment_date', case
              when (
                case
                  when entry.status = 'pago'
                    and entry.settlement_date is not null
                  then 'pago'
                  else publication.public_status
                end
              ) in ('programado', 'em_processamento', 'pago')
              then entry.scheduled_payment_date
              else null
            end,
            'scheduled_date', case
              when (
                case
                  when entry.status = 'pago'
                    and entry.settlement_date is not null
                  then 'pago'
                  else publication.public_status
                end
              ) in ('programado', 'em_processamento', 'pago')
              then coalesce(
                entry.scheduled_payment_date,
                publication.scheduled_date
              )
              else null
            end,
            'processing_started_at', publication.processing_started_at,
            'paid_on', entry.settlement_date,
            'paid_at', publication.paid_at,
            'public_note', publication.public_note,
            'updated_at', publication.updated_at
          )
          order by
            case
              when publication.public_status in (
                'programado',
                'em_processamento',
                'pago'
              )
              then coalesce(
                entry.scheduled_payment_date,
                publication.scheduled_date
              )
            end,
            publication.forecast_start,
            entry.due_date,
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
      'scheduled', 'Data registrada na programação atual; a conclusão depende da liquidação.',
      'processing', 'Processamento iniciado; a conclusão depende da confirmação da liquidação.',
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

revoke all on function public.get_partner_payment_portal(text, text)
  from public;
grant execute on function public.get_partner_payment_portal(text, text)
  to anon, authenticated;

-- Mudanças diretas na fonte canônica só refletem em snapshots que já existam
-- e estejam programados/em processamento. A criação de uma publicação ou sua
-- visibilidade continuam sendo decisões explícitas da Central de Parceiros.
create or replace function public.sync_partner_payment_public_status()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  -- Evita recursão quando a atualização da fonte canônica nasceu do próprio
  -- trigger de uma publicação.
  if pg_catalog.pg_trigger_depth() > 1 then
    return new;
  end if;

  if new.type <> 'saida' then
    if old.type = 'saida' then
      update public.partner_payment_publications
         set public_status = 'suspenso',
             visible = false,
             scheduled_date = null,
             processing_started_at = null,
             paid_at = null,
             version = version + 1,
             published_at = now()
       where financial_entry_id = new.id;
    end if;

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
           scheduled_date = coalesce(
             new.scheduled_payment_date,
             scheduled_date
           ),
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

  if old.scheduled_payment_date
      is distinct from new.scheduled_payment_date then
    if new.scheduled_payment_date is null then
      update public.partner_payment_publications
         set public_status = 'suspenso',
             visible = false,
             scheduled_date = null,
             processing_started_at = null,
             version = version + 1,
             published_at = now()
       where financial_entry_id = new.id
         and public_status in ('programado', 'em_processamento');
    else
      update public.partner_payment_publications
         set scheduled_date = new.scheduled_payment_date,
             version = version + 1,
             published_at = now()
       where financial_entry_id = new.id
         and public_status in ('programado', 'em_processamento');
    end if;
  end if;

  return new;
end
$function$;

drop trigger if exists financial_entry_partner_public_status
  on public.financial_entries;
create trigger financial_entry_partner_public_status
after update of
  type,
  status,
  settlement_date,
  scheduled_payment_date
on public.financial_entries
for each row execute function public.sync_partner_payment_public_status();

revoke all on function public.sync_partner_payment_public_status()
  from public, anon, authenticated;

comment on function public.get_partner_payment_portal(text, text) is
  'Valida o acesso do parceiro e retorna somente informações financeiras publicadas, incluindo emissão, vencimento e programação efetiva quando o status público permitir.';
