create table if not exists public.crm_instagram_profile_analyses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  crm_record_id uuid not null references public.crm_records(id) on delete cascade,
  instagram_username text not null,
  consent_version text not null,
  analysis_version text not null default 'instagram-profile-ai-v1',
  analysis_status text not null,
  analysis jsonb not null,
  sources jsonb not null default '[]'::jsonb,
  model text not null,
  response_id text,
  usage jsonb not null default '{}'::jsonb,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint crm_instagram_profile_analyses_handle_check check (
    instagram_username ~ '^[a-z0-9_]([a-z0-9._]{0,28}[a-z0-9_])?$'
    and position('..' in instagram_username)=0
  ),
  constraint crm_instagram_profile_analyses_consent_check check (consent_version='solaris-instagram-v1'),
  constraint crm_instagram_profile_analyses_version_check check (analysis_version='instagram-profile-ai-v1'),
  constraint crm_instagram_profile_analyses_status_check check (analysis_status in ('complete','limited','not_found')),
  constraint crm_instagram_profile_analyses_analysis_check check (jsonb_typeof(analysis)='object'),
  constraint crm_instagram_profile_analyses_sources_check check (jsonb_typeof(sources)='array'),
  constraint crm_instagram_profile_analyses_usage_check check (jsonb_typeof(usage)='object'),
  constraint crm_instagram_profile_analyses_model_check check (length(model) between 2 and 120),
  constraint crm_instagram_profile_analyses_response_check check (response_id is null or length(response_id) between 2 and 200)
);
create index if not exists crm_instagram_profile_analyses_lead_created_idx
  on public.crm_instagram_profile_analyses(organization_id,crm_record_id,created_at desc);
create index if not exists crm_instagram_profile_analyses_handle_created_idx
  on public.crm_instagram_profile_analyses(organization_id,instagram_username,created_at desc);

alter table public.crm_instagram_profile_analyses enable row level security;
revoke all on table public.crm_instagram_profile_analyses from anon, authenticated;
grant select on table public.crm_instagram_profile_analyses to authenticated;
grant select,insert,update,delete on table public.crm_instagram_profile_analyses to service_role;

drop policy if exists crm_instagram_profile_analyses_read on public.crm_instagram_profile_analyses;
create policy crm_instagram_profile_analyses_read
on public.crm_instagram_profile_analyses
for select
to authenticated
using (
  public.has_app_permission(organization_id,'crm.view')
  and exists (
    select 1
    from public.crm_records r
    where r.id=crm_instagram_profile_analyses.crm_record_id
      and r.organization_id=crm_instagram_profile_analyses.organization_id
      and r.instagram_consent=true
      and r.instagram_consent_version='solaris-instagram-v1'
      and r.instagram_username=crm_instagram_profile_analyses.instagram_username
  )
);

comment on table public.crm_instagram_profile_analyses is 'Histórico de análises de IA de perfis Instagram explicitamente autorizados por leads. Não deve ser usado para crédito, preço, elegibilidade ou decisões desfavoráveis.';
comment on column public.crm_instagram_profile_analyses.analysis is 'Leitura comercial gerada por IA com separação entre sinais observáveis e hipóteses, sem atributos sensíveis.';
