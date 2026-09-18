-- Explicit NOT NULL evidence checks prevent UNKNOWN from satisfying PostgreSQL CHECK constraints.
alter table public.crm_records drop constraint crm_records_instagram_consent_check;
alter table public.crm_records add constraint crm_records_instagram_consent_check check (
 (not instagram_consent and instagram_consent_at is null and instagram_consent_version is null)
 or (instagram_consent and instagram_username is not null and instagram_consent_at is not null and instagram_consent_version is not null and instagram_consent_version='solaris-instagram-v1')
);
alter table private.crm_public_form_submissions drop constraint solaris_submission_instagram_check;
alter table private.crm_public_form_submissions add constraint solaris_submission_instagram_check check (
 (instagram_username is null or (instagram_username ~ '^[a-z0-9_]([a-z0-9._]{0,28}[a-z0-9_])?$' and position('..' in instagram_username)=0))
 and ((not instagram_consent and instagram_consent_at is null and instagram_consent_version is null)
 or (instagram_consent and instagram_username is not null and instagram_consent_at is not null and instagram_consent_version is not null and instagram_consent_version='solaris-instagram-v1'))
);
