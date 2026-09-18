alter table public.crm_instagram_profile_analyses
  add column if not exists retrieval_method text not null default 'web_search';

alter table public.crm_instagram_profile_analyses
  drop constraint if exists crm_instagram_profile_analyses_version_check;

alter table public.crm_instagram_profile_analyses
  add constraint crm_instagram_profile_analyses_version_check
  check (analysis_version in ('instagram-profile-ai-v1','instagram-profile-ai-v2'));

alter table public.crm_instagram_profile_analyses
  add constraint crm_instagram_profile_analyses_retrieval_method_check
  check (retrieval_method in ('web_search','meta_business_discovery','operator_screenshots'));

comment on column public.crm_instagram_profile_analyses.retrieval_method is
'Método de coleta usado pela análise: web_search, meta_business_discovery ou operator_screenshots.';
