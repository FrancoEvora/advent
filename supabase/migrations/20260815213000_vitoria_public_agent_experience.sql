begin;

create schema if not exists crm_private;

create table if not exists crm_private.public_agent_experiences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  slug text not null,
  project_id uuid not null references public.projects(id) on delete restrict,
  product_id uuid,
  pipeline_id uuid not null references public.crm_pipelines(id) on delete restrict,
  initial_stage_id uuid not null references public.crm_stages(id) on delete restrict,
  lead_source_id uuid not null,
  team_id uuid references public.crm_teams(id) on delete restrict,
  fallback_owner_user_id uuid not null,
  assignment_role text not null default 'sdr',
  active boolean not null default true,
  name text not null,
  agent_name text not null default 'Vitória',
  title text not null,
  subtitle text not null,
  eyebrow text not null default 'Atendimento inteligente',
  hero_image_url text,
  first_contact_sla_minutes integer not null default 60,
  knowledge jsonb not null default '{}'::jsonb,
  theme jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint public_agent_experiences_slug_key unique (slug),
  constraint public_agent_experiences_slug_check check (
    slug = lower(trim(slug))
    and slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'
  ),
  constraint public_agent_experiences_assignment_role_check check (
    assignment_role in ('sdr', 'broker')
  ),
  constraint public_agent_experiences_sla_check check (
    first_contact_sla_minutes between 5 and 1440
  ),
  constraint public_agent_experiences_knowledge_check check (
    jsonb_typeof(knowledge) = 'object' and pg_column_size(knowledge) <= 65536
  ),
  constraint public_agent_experiences_theme_check check (
    jsonb_typeof(theme) = 'object' and pg_column_size(theme) <= 32768
  ),
  constraint public_agent_experiences_org_product_fk foreign key (
    organization_id, project_id, product_id
  ) references public.crm_products(organization_id, project_id, id) on delete restrict,
  constraint public_agent_experiences_org_source_fk foreign key (
    organization_id, lead_source_id
  ) references public.crm_lead_sources(organization_id, id) on delete restrict,
  constraint public_agent_experiences_org_owner_fk foreign key (
    organization_id, fallback_owner_user_id
  ) references public.organization_members(organization_id, user_id) on delete restrict
);

create table if not exists crm_private.public_agent_sessions (
  id uuid primary key default gen_random_uuid(),
  experience_id uuid not null references crm_private.public_agent_experiences(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  session_token_hash text not null unique,
  fingerprint_hash text not null,
  status text not null default 'active',
  stage text not null default 'welcome',
  utm jsonb not null default '{}'::jsonb,
  landing_page text,
  referrer text,
  user_agent text,
  captured_profile jsonb not null default '{}'::jsonb,
  marketing_consent boolean not null default false,
  contact_id uuid references public.contacts(id) on delete set null,
  crm_record_id uuid references public.crm_records(id) on delete set null,
  conversation_id uuid references public.crm_conversations(id) on delete set null,
  message_count integer not null default 0,
  last_activity_at timestamptz not null default now(),
  converted_at timestamptz,
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint public_agent_sessions_token_hash_check check (
    session_token_hash ~ '^[a-f0-9]{64}$'
  ),
  constraint public_agent_sessions_fingerprint_hash_check check (
    fingerprint_hash ~ '^[a-f0-9]{64}$'
  ),
  constraint public_agent_sessions_status_check check (
    status in ('active', 'converted', 'closed', 'blocked')
  ),
  constraint public_agent_sessions_stage_check check (
    stage in ('welcome', 'discovery', 'qualification', 'contact', 'handoff', 'completed')
  ),
  constraint public_agent_sessions_utm_check check (
    jsonb_typeof(utm) = 'object' and pg_column_size(utm) <= 16384
  ),
  constraint public_agent_sessions_profile_check check (
    jsonb_typeof(captured_profile) = 'object'
    and pg_column_size(captured_profile) <= 32768
  ),
  constraint public_agent_sessions_message_count_check check (
    message_count between 0 and 200
  )
);

create table if not exists crm_private.public_agent_messages (
  id bigint generated always as identity primary key,
  session_id uuid not null references crm_private.public_agent_sessions(id) on delete cascade,
  direction text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint public_agent_messages_direction_check check (
    direction in ('user', 'assistant', 'system')
  ),
  constraint public_agent_messages_content_check check (
    char_length(content) between 1 and 4000
  ),
  constraint public_agent_messages_metadata_check check (
    jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 16384
  )
);

create index if not exists public_agent_sessions_experience_activity_idx
  on crm_private.public_agent_sessions(experience_id, last_activity_at desc);
create index if not exists public_agent_sessions_fingerprint_created_idx
  on crm_private.public_agent_sessions(fingerprint_hash, created_at desc);
create index if not exists public_agent_sessions_record_idx
  on crm_private.public_agent_sessions(organization_id, crm_record_id)
  where crm_record_id is not null;
create index if not exists public_agent_messages_session_created_idx
  on crm_private.public_agent_messages(session_id, created_at, id);

alter table crm_private.public_agent_experiences enable row level security;
alter table crm_private.public_agent_sessions enable row level security;
alter table crm_private.public_agent_messages enable row level security;

revoke all on crm_private.public_agent_experiences from public, anon, authenticated;
revoke all on crm_private.public_agent_sessions from public, anon, authenticated;
revoke all on crm_private.public_agent_messages from public, anon, authenticated;

create or replace function crm_private.assert_public_agent_service_role()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'PUBLIC_AGENT_FORBIDDEN';
  end if;
end
$function$;

create or replace function crm_private.validate_public_agent_experience()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not exists (
    select 1 from public.projects project
    where project.id = new.project_id
      and project.organization_id = new.organization_id
      and project.active
  ) then
    raise exception 'PUBLIC_AGENT_PROJECT_INVALID';
  end if;

  if new.product_id is not null and not exists (
    select 1 from public.crm_products product
    where product.id = new.product_id
      and product.organization_id = new.organization_id
      and product.project_id = new.project_id
      and product.active
  ) then
    raise exception 'PUBLIC_AGENT_PRODUCT_INVALID';
  end if;

  if not exists (
    select 1 from public.crm_pipelines pipeline
    where pipeline.id = new.pipeline_id
      and pipeline.organization_id = new.organization_id
      and pipeline.active
  ) then
    raise exception 'PUBLIC_AGENT_PIPELINE_INVALID';
  end if;

  if not exists (
    select 1 from public.crm_stages stage
    where stage.id = new.initial_stage_id
      and stage.organization_id = new.organization_id
      and stage.pipeline_id = new.pipeline_id
      and stage.active
      and not stage.is_won
      and not stage.is_lost
  ) then
    raise exception 'PUBLIC_AGENT_STAGE_INVALID';
  end if;

  if new.team_id is not null and not exists (
    select 1 from public.crm_teams team
    where team.id = new.team_id
      and team.organization_id = new.organization_id
      and team.active
  ) then
    raise exception 'PUBLIC_AGENT_TEAM_INVALID';
  end if;

  if not exists (
    select 1 from public.organization_members member
    where member.organization_id = new.organization_id
      and member.user_id = new.fallback_owner_user_id
      and member.active
  ) then
    raise exception 'PUBLIC_AGENT_OWNER_INVALID';
  end if;

  return new;
end
$function$;

create or replace function crm_private.validate_public_agent_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not exists (
    select 1 from crm_private.public_agent_experiences experience
    where experience.id = new.experience_id
      and experience.organization_id = new.organization_id
  ) then
    raise exception 'PUBLIC_AGENT_SESSION_ORGANIZATION_INVALID';
  end if;

  if new.contact_id is not null and not exists (
    select 1 from public.contacts contact
    where contact.id = new.contact_id
      and contact.organization_id = new.organization_id
  ) then
    raise exception 'PUBLIC_AGENT_SESSION_CONTACT_INVALID';
  end if;

  if new.crm_record_id is not null and not exists (
    select 1 from public.crm_records opportunity
    where opportunity.id = new.crm_record_id
      and opportunity.organization_id = new.organization_id
  ) then
    raise exception 'PUBLIC_AGENT_SESSION_RECORD_INVALID';
  end if;

  if new.conversation_id is not null and not exists (
    select 1 from public.crm_conversations conversation
    where conversation.id = new.conversation_id
      and conversation.organization_id = new.organization_id
  ) then
    raise exception 'PUBLIC_AGENT_SESSION_CONVERSATION_INVALID';
  end if;

  return new;
end
$function$;

drop trigger if exists public_agent_experiences_validate on crm_private.public_agent_experiences;
create trigger public_agent_experiences_validate
before insert or update on crm_private.public_agent_experiences
for each row execute function crm_private.validate_public_agent_experience();

drop trigger if exists public_agent_sessions_validate on crm_private.public_agent_sessions;
create trigger public_agent_sessions_validate
before insert or update on crm_private.public_agent_sessions
for each row execute function crm_private.validate_public_agent_session();

revoke all on function crm_private.assert_public_agent_service_role() from public, anon, authenticated;
revoke all on function crm_private.validate_public_agent_experience() from public, anon, authenticated;
revoke all on function crm_private.validate_public_agent_session() from public, anon, authenticated;

commit;
