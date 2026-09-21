create table if not exists crm_private.bia_bulk_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  settings_id uuid not null references crm_private.bia_campaign_outreach_settings(id) on delete restrict,
  created_by uuid not null references auth.users(id) on delete restrict,
  name text not null check (char_length(trim(name)) between 3 and 120),
  status text not null default 'scheduled' check (status in ('scheduled','running','paused','completed','cancelled')),
  starts_at timestamptz not null,
  pace_per_minute smallint not null default 3 check (pace_per_minute between 1 and 3),
  only_unserved boolean not null default true,
  total_count integer not null default 0 check (total_count >= 0),
  eligible_count integer not null default 0 check (eligible_count >= 0),
  blocked_count integer not null default 0 check (blocked_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crm_private.bia_bulk_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references crm_private.bia_bulk_campaigns(id) on delete cascade,
  crm_record_id uuid not null references public.crm_records(id) on delete cascade,
  phone text not null,
  recipient_name text not null,
  consent jsonb not null default '{}'::jsonb,
  eligibility_status text not null check (eligibility_status in ('eligible','blocked')),
  block_reason text,
  scheduled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (campaign_id, crm_record_id)
);

alter table crm_private.bia_bulk_campaigns enable row level security;
alter table crm_private.bia_bulk_campaign_recipients enable row level security;
revoke all on crm_private.bia_bulk_campaigns from public, anon, authenticated;
revoke all on crm_private.bia_bulk_campaign_recipients from public, anon, authenticated;

create index if not exists bia_bulk_campaigns_org_created_idx
  on crm_private.bia_bulk_campaigns(organization_id, created_at desc);
create index if not exists bia_bulk_recipients_campaign_status_idx
  on crm_private.bia_bulk_campaign_recipients(campaign_id, eligibility_status, scheduled_at);
create index if not exists bia_bulk_recipients_record_idx
  on crm_private.bia_bulk_campaign_recipients(crm_record_id);

alter table crm_private.bia_campaign_outreach_jobs
  drop constraint if exists bia_campaign_outreach_jobs_source_type_check;
alter table crm_private.bia_campaign_outreach_jobs
  add constraint bia_campaign_outreach_jobs_source_type_check
  check (source_type in ('public_form','meta','bulk'));

alter table crm_private.bia_campaign_outreach_jobs
  drop constraint if exists bia_campaign_outreach_jobs_settings_id_crm_record_id_key;
create unique index if not exists bia_campaign_jobs_ingress_unique_idx
  on crm_private.bia_campaign_outreach_jobs(settings_id, crm_record_id)
  where source_type in ('public_form','meta');

create or replace function crm_private.bia_bulk_consent_for_record(p_settings uuid, p_record uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  cfg crm_private.bia_campaign_outreach_settings;
  lead public.crm_records;
  submission private.crm_public_form_submissions;
  attribution public.crm_opportunity_attributions;
  v_phone text;
begin
  select * into cfg from crm_private.bia_campaign_outreach_settings where id=p_settings;
  select * into lead from public.crm_records where id=p_record;
  if cfg.id is null or lead.id is null or lead.organization_id<>cfg.organization_id or lead.project_id<>cfg.project_id then
    return null;
  end if;
  v_phone:=regexp_replace(coalesce(lead.phone,''),'[^0-9]','','g');
  if length(v_phone) in (10,11) then v_phone:='55'||v_phone; end if;

  select s.* into submission
  from private.crm_public_form_submissions s
  where s.crm_record_id=lead.id
    and s.organization_id=cfg.organization_id
    and s.original_created_at is null
    and s.consent_version='solaris-whatsapp-v1'
    and regexp_replace(coalesce(s.phone,''),'[^0-9]','','g') in (v_phone, regexp_replace(v_phone,'^55','','g'))
  order by s.created_at desc
  limit 1;
  if submission.id is not null then
    return jsonb_build_object(
      'source','public_form','sourceId',submission.id,'version',submission.consent_version,
      'at',submission.created_at,'basis','documented_whatsapp_opt_in'
    );
  end if;

  select a.* into attribution
  from public.crm_opportunity_attributions a
  where a.crm_record_id=lead.id
    and a.organization_id=cfg.organization_id
    and a.provider='meta'
    and a.channel='meta_lead_ads'
    and a.campaign_id=cfg.meta_campaign_id
    and a.form_id=cfg.meta_form_id
    and cfg.meta_consent_verified_at is not null
    and nullif(trim(cfg.meta_consent_notice),'') is not null
    and a.captured_at>=cfg.meta_consent_verified_at
  order by a.captured_at desc
  limit 1;
  if attribution.id is not null then
    return jsonb_build_object(
      'source','meta','sourceId',attribution.id,'version','meta_form_solaris_whatsapp_v1',
      'at',attribution.captured_at,'basis','reviewed_meta_whatsapp_opt_in',
      'notice',cfg.meta_consent_notice,'noticeVerifiedAt',cfg.meta_consent_verified_at
    );
  end if;
  return null;
end
$function$;

create or replace function crm_private.bia_bulk_candidate_reason(p_settings uuid, p_record uuid)
returns text
language plpgsql
security definer
set search_path=''
as $function$
declare
  cfg crm_private.bia_campaign_outreach_settings;
  lead public.crm_records;
  contact public.contacts;
  v_phone text;
begin
  select * into cfg from crm_private.bia_campaign_outreach_settings where id=p_settings;
  select * into lead from public.crm_records where id=p_record;
  if cfg.id is null or not cfg.enabled then return 'BIA_CAMPAIGN_DISABLED'; end if;
  if lead.id is null or lead.organization_id<>cfg.organization_id or lead.project_id<>cfg.project_id or lead.record_status<>'aberta'
    then return 'BIA_CAMPAIGN_LEAD_INACTIVE'; end if;
  if exists(
    select 1 from public.crm_actions a
    where a.crm_record_id=lead.id and a.organization_id=cfg.organization_id
      and a.action_status='pendente'
      and a.metadata->>'requires_human_review'='true'
      and a.metadata->>'no_external_delivery'='true'
  ) then return 'BIA_CONTACT_PAUSED'; end if;

  v_phone:=regexp_replace(coalesce(lead.phone,''),'[^0-9]','','g');
  if length(v_phone) in(10,11) then v_phone:='55'||v_phone; end if;
  if coalesce(v_phone,'') !~ '^55[1-9][0-9]([2-9][0-9]{7}|9[0-9]{8})$' then return 'BIA_PHONE_INVALID'; end if;

  select * into contact from public.contacts where id=lead.contact_id;
  if contact.id is not null and (not contact.active or contact.do_not_contact_at is not null or contact.marketing_consent_status in('denied','revoked'))
    then return 'BIA_CONTACT_PAUSED'; end if;

  if exists(
    select 1 from crm_private.bia_whatsapp_threads t
    join crm_private.bia_whatsapp_channels ch on ch.id=t.channel_id
    where ch.organization_id=cfg.organization_id
      and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(v_phone)
      and (t.opted_out_at is not null or t.human_requested)
  ) then return 'BIA_CONTACT_PAUSED'; end if;

  if exists(
    select 1 from crm_private.bia_whatsapp_threads t
    join crm_private.bia_whatsapp_channels ch on ch.id=t.channel_id
    where ch.organization_id=cfg.organization_id
      and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(v_phone)
      and (t.last_inbound_at is not null or exists(
        select 1 from crm_private.bia_whatsapp_outbound o where o.thread_id=t.id and o.status<>'failed'
      ))
  ) then return 'BIA_CAMPAIGN_ALREADY_CONTACTED'; end if;

  if crm_private.bia_bulk_consent_for_record(p_settings,p_record) is null then return 'BIA_BULK_CONSENT_REQUIRED'; end if;
  return null;
end
$function$;
