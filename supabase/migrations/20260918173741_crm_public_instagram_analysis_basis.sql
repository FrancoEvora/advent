alter table public.crm_instagram_profile_analyses
  add column if not exists access_basis text not null default 'lead_consent';

alter table public.crm_instagram_profile_analyses
  alter column consent_version drop not null;

alter table public.crm_instagram_profile_analyses
  drop constraint if exists crm_instagram_profile_analyses_consent_check;

alter table public.crm_instagram_profile_analyses
  add constraint crm_instagram_profile_analyses_access_basis_check
  check (
    (access_basis='lead_consent' and consent_version='solaris-instagram-v1')
    or
    (access_basis='public_profile' and consent_version is null)
  );

drop policy if exists crm_instagram_profile_analyses_read
  on public.crm_instagram_profile_analyses;

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
      and r.instagram_username=crm_instagram_profile_analyses.instagram_username
  )
);

comment on column public.crm_instagram_profile_analyses.access_basis is
'Origem do acesso usado na análise: lead_consent quando existe autorização específica do lead; public_profile quando a análise usa somente conteúdo publicamente acessível, sem contornar restrições.';
comment on column public.crm_instagram_profile_analyses.consent_version is
'Versão do consentimento quando access_basis=lead_consent; nulo quando access_basis=public_profile.';
