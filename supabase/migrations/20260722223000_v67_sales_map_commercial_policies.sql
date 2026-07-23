-- Évora Gestão 6.7 — políticas comerciais por campanha e rastreabilidade da proposta

alter table public.crm_negotiation_parameters
  add column if not exists description text,
  add column if not exists is_default boolean not null default false,
  add column if not exists updated_by uuid references auth.users(id) on delete set null;

with ranked as (
  select id,
         row_number() over (
           partition by organization_id, project_id
           order by active desc, created_at desc, id
         ) as position
  from public.crm_negotiation_parameters
)
update public.crm_negotiation_parameters policy
set is_default = ranked.position = 1 and policy.active
from ranked
where ranked.id = policy.id;

create unique index if not exists crm_negotiation_one_default_per_project_idx
  on public.crm_negotiation_parameters(organization_id, project_id)
  where is_default and active;

alter table public.crm_campaigns
  add column if not exists negotiation_policy_id uuid;

alter table public.crm_campaigns
  drop constraint if exists crm_campaigns_negotiation_policy_id_fkey;
alter table public.crm_campaigns
  add constraint crm_campaigns_negotiation_policy_id_fkey
  foreign key (negotiation_policy_id)
  references public.crm_negotiation_parameters(id)
  on delete set null;

create index if not exists crm_campaigns_policy_idx
  on public.crm_campaigns(organization_id, project_id, negotiation_policy_id);

alter table public.crm_proposals
  add column if not exists campaign_id uuid,
  add column if not exists negotiation_policy_id uuid,
  add column if not exists policy_snapshot jsonb not null default '{}'::jsonb;

alter table public.crm_proposals
  drop constraint if exists crm_proposals_campaign_id_fkey;
alter table public.crm_proposals
  add constraint crm_proposals_campaign_id_fkey
  foreign key (campaign_id)
  references public.crm_campaigns(id)
  on delete set null;

alter table public.crm_proposals
  drop constraint if exists crm_proposals_negotiation_policy_id_fkey;
alter table public.crm_proposals
  add constraint crm_proposals_negotiation_policy_id_fkey
  foreign key (negotiation_policy_id)
  references public.crm_negotiation_parameters(id)
  on delete set null;

create index if not exists crm_proposals_campaign_policy_idx
  on public.crm_proposals(organization_id, campaign_id, negotiation_policy_id);

create or replace function public.crm_sync_default_negotiation_policy()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.is_default and new.active then
    update public.crm_negotiation_parameters
    set is_default = false,
        updated_at = now()
    where organization_id = new.organization_id
      and project_id = new.project_id
      and id <> new.id
      and is_default;
  end if;
  return new;
end;
$$;

drop trigger if exists crm_sync_default_negotiation_policy_trigger
  on public.crm_negotiation_parameters;
create trigger crm_sync_default_negotiation_policy_trigger
before insert or update of is_default, active, organization_id, project_id
on public.crm_negotiation_parameters
for each row
execute function public.crm_sync_default_negotiation_policy();

create or replace function public.crm_validate_campaign_policy()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  policy public.crm_negotiation_parameters%rowtype;
begin
  if new.negotiation_policy_id is null then
    return new;
  end if;

  select * into policy
  from public.crm_negotiation_parameters
  where id = new.negotiation_policy_id;

  if policy.id is null
     or policy.organization_id <> new.organization_id
     or new.project_id is null
     or policy.project_id <> new.project_id then
    raise exception 'A política comercial deve pertencer à mesma organização e ao mesmo empreendimento da campanha';
  end if;

  if not policy.active
     or (policy.valid_from is not null and policy.valid_from > current_date)
     or (policy.valid_until is not null and policy.valid_until < current_date) then
    raise exception 'A política comercial selecionada não está vigente';
  end if;

  return new;
end;
$$;

drop trigger if exists crm_validate_campaign_policy_trigger on public.crm_campaigns;
create trigger crm_validate_campaign_policy_trigger
before insert or update of negotiation_policy_id, organization_id, project_id
on public.crm_campaigns
for each row
execute function public.crm_validate_campaign_policy();

update public.crm_proposals proposal
set campaign_id = record.campaign_id
from public.crm_records record
where proposal.crm_record_id = record.id
  and proposal.organization_id = record.organization_id
  and proposal.campaign_id is null
  and record.campaign_id is not null;

with resolved as (
  select proposal.id as proposal_id,
         policy.id as policy_id,
         to_jsonb(policy) - 'created_by' - 'updated_by' as snapshot
  from public.crm_proposals proposal
  left join public.crm_campaigns campaign
    on campaign.id = proposal.campaign_id
   and campaign.organization_id = proposal.organization_id
  join lateral (
    select candidate.*
    from public.crm_negotiation_parameters candidate
    where candidate.organization_id = proposal.organization_id
      and candidate.project_id = proposal.project_id
    order by case
      when candidate.id = proposal.negotiation_policy_id then 0
      when candidate.id = campaign.negotiation_policy_id then 1
      when candidate.is_default then 2
      else 3
    end,
    candidate.created_at desc
    limit 1
  ) policy on true
  where proposal.negotiation_policy_id is null
     or proposal.policy_snapshot = '{}'::jsonb
)
update public.crm_proposals proposal
set negotiation_policy_id = coalesce(proposal.negotiation_policy_id, resolved.policy_id),
    policy_snapshot = case
      when proposal.policy_snapshot = '{}'::jsonb then resolved.snapshot
      else proposal.policy_snapshot
    end
from resolved
where proposal.id = resolved.proposal_id;

create or replace function public.crm_prepare_proposal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  policy public.crm_negotiation_parameters%rowtype;
  unit_row public.crm_inventory_units%rowtype;
  campaign public.crm_campaigns%rowtype;
  lead_campaign_id uuid;
  lead_organization_id uuid;
  lead_project_id uuid;
  down_pct numeric := 0;
begin
  select * into unit_row
  from public.crm_inventory_units
  where id = new.unit_id;

  if unit_row.id is null then
    raise exception 'Unidade comercial não encontrada';
  end if;

  if unit_row.organization_id <> new.organization_id
     or unit_row.project_id <> new.project_id then
    raise exception 'A unidade não pertence à organização e ao empreendimento da proposta';
  end if;

  if (tg_op = 'INSERT' or new.unit_id is distinct from old.unit_id)
     and unit_row.status in ('vendido', 'indisponivel') then
    raise exception 'A unidade não está disponível para proposta';
  end if;

  if tg_op = 'UPDATE' and old.submitted_at is not null and (
    new.organization_id is distinct from old.organization_id
    or new.project_id is distinct from old.project_id
    or new.unit_id is distinct from old.unit_id
    or new.crm_record_id is distinct from old.crm_record_id
    or new.campaign_id is distinct from old.campaign_id
    or new.negotiation_policy_id is distinct from old.negotiation_policy_id
    or new.policy_snapshot is distinct from old.policy_snapshot
    or new.list_price is distinct from old.list_price
    or new.sale_price is distinct from old.sale_price
    or new.down_payment is distinct from old.down_payment
    or new.down_payment_installments_count is distinct from old.down_payment_installments_count
    or new.down_payment_first_due_date is distinct from old.down_payment_first_due_date
    or new.installments_count is distinct from old.installments_count
    or new.monthly_interest_rate is distinct from old.monthly_interest_rate
    or new.grace_months is distinct from old.grace_months
    or new.balloon_total is distinct from old.balloon_total
    or new.payment_plan is distinct from old.payment_plan
  ) then
    raise exception 'As condições e a política de uma proposta submetida são imutáveis; cancele e emita uma nova proposta';
  end if;

  if tg_op = 'UPDATE' and old.submitted_at is not null then
    return new;
  end if;

  if new.proposal_number is null then
    new.proposal_number := 'PROP-' || to_char(now(), 'YYYY') || '-' ||
      lpad(nextval('public.crm_proposal_number_seq')::text, 6, '0');
  end if;

  if new.list_price <= 0 then
    new.list_price := unit_row.list_price;
  end if;
  if new.sale_price <= 0 then
    new.sale_price := greatest(new.list_price - new.discount_amount, 0);
  end if;

  new.discount_amount := greatest(new.list_price - new.sale_price, 0);
  new.discount_pct := case when new.list_price > 0
    then new.discount_amount / new.list_price else 0 end;
  new.financed_amount := greatest(new.sale_price - new.down_payment, 0);
  down_pct := case when new.sale_price > 0
    then new.down_payment / new.sale_price else 0 end;

  if new.crm_record_id is not null then
    select record.organization_id, record.project_id, record.campaign_id
    into lead_organization_id, lead_project_id, lead_campaign_id
    from public.crm_records record
    where record.id = new.crm_record_id;

    if lead_organization_id is null
       or lead_organization_id <> new.organization_id
       or (lead_project_id is not null and lead_project_id <> new.project_id) then
      raise exception 'O lead não pertence à organização e ao empreendimento da proposta';
    end if;

    if new.campaign_id is null then
      new.campaign_id := lead_campaign_id;
    end if;
  end if;

  if new.campaign_id is not null then
    select * into campaign
    from public.crm_campaigns
    where id = new.campaign_id
      and organization_id = new.organization_id;

    if campaign.id is null
       or (campaign.project_id is not null and campaign.project_id <> new.project_id) then
      raise exception 'A campanha comercial não pertence ao empreendimento da proposta';
    end if;
  end if;

  if campaign.negotiation_policy_id is not null then
    if new.negotiation_policy_id is not null
       and new.negotiation_policy_id <> campaign.negotiation_policy_id then
      raise exception 'A proposta deve utilizar a política comercial vinculada à campanha';
    end if;

    select * into policy
    from public.crm_negotiation_parameters
    where id = campaign.negotiation_policy_id
      and organization_id = new.organization_id
      and project_id = new.project_id
      and active
      and (valid_from is null or valid_from <= current_date)
      and (valid_until is null or valid_until >= current_date);

    if policy.id is null then
      raise exception 'A política comercial vinculada à campanha não está vigente';
    end if;
  elsif new.negotiation_policy_id is not null then
    select * into policy
    from public.crm_negotiation_parameters
    where id = new.negotiation_policy_id
      and organization_id = new.organization_id
      and project_id = new.project_id
      and active
      and (valid_from is null or valid_from <= current_date)
      and (valid_until is null or valid_until >= current_date);

    if policy.id is null then
      raise exception 'A política comercial informada não está vigente para o empreendimento';
    end if;
  else
    select * into policy
    from public.crm_negotiation_parameters
    where project_id = new.project_id
      and organization_id = new.organization_id
      and active
      and (valid_from is null or valid_from <= current_date)
      and (valid_until is null or valid_until >= current_date)
    order by is_default desc, created_at desc
    limit 1;
  end if;

  if policy.id is not null then
    new.negotiation_policy_id := policy.id;
    if tg_op = 'INSERT' or coalesce(new.policy_snapshot, '{}'::jsonb) = '{}'::jsonb then
      new.policy_snapshot := to_jsonb(policy) - 'created_by' - 'updated_by';
    end if;
    if new.valid_until is null then
      new.valid_until := now() + (policy.proposal_validity_days || ' days')::interval;
    end if;
    new.requires_approval :=
      new.discount_pct > policy.admin_approval_discount_pct
      or new.discount_pct > policy.max_discount_pct
      or down_pct < policy.min_down_payment_pct
      or new.installments_count > policy.max_installments
      or (
        policy.min_installment > 0
        and new.installments_count > 0
        and new.financed_amount / new.installments_count < policy.min_installment
      )
      or (
        policy.require_admin_below_min_price
        and unit_row.minimum_price is not null
        and new.sale_price < unit_row.minimum_price
      );
  elsif new.status = 'submetida' then
    raise exception 'Nenhuma política comercial vigente foi definida para o empreendimento';
  elsif new.valid_until is null then
    new.valid_until := now() + interval '5 days';
  end if;

  if new.status = 'submetida' then
    new.submitted_at := coalesce(new.submitted_at, now());
    new.approval_status := case when new.requires_approval
      then 'pendente' else 'aprovada' end;
  end if;

  return new;
end;
$$;

comment on column public.crm_negotiation_parameters.is_default is
  'Política de contingência usada quando uma campanha não possui política específica.';
comment on column public.crm_campaigns.negotiation_policy_id is
  'Política comercial aplicada automaticamente às propostas originadas desta campanha.';
comment on column public.crm_proposals.policy_snapshot is
  'Cópia imutável dos parâmetros comerciais vigentes no momento da submissão.';

revoke execute on function public.crm_prepare_proposal() from public, anon, authenticated;
