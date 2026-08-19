create table if not exists crm_private.bia_openai_diagnostics (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid null,
  model text null,
  http_status integer not null,
  error_code text null,
  error_type text null,
  request_id text null,
  limit_requests text null,
  remaining_requests text null,
  reset_requests text null,
  limit_tokens text null,
  remaining_tokens text null,
  reset_tokens text null,
  created_at timestamptz not null default now()
);

alter table crm_private.bia_openai_diagnostics enable row level security;

create or replace function public.record_bia_openai_diagnostic(
  p_organization_id uuid,
  p_model text,
  p_http_status integer,
  p_error_code text,
  p_error_type text,
  p_request_id text,
  p_limit_requests text,
  p_remaining_requests text,
  p_reset_requests text,
  p_limit_tokens text,
  p_remaining_tokens text,
  p_reset_tokens text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform crm_private.assert_public_agent_service_role();
  insert into crm_private.bia_openai_diagnostics (
    organization_id, model, http_status, error_code, error_type, request_id,
    limit_requests, remaining_requests, reset_requests,
    limit_tokens, remaining_tokens, reset_tokens
  ) values (
    p_organization_id, left(p_model,120), p_http_status,
    left(p_error_code,160), left(p_error_type,160), left(p_request_id,200),
    left(p_limit_requests,100), left(p_remaining_requests,100), left(p_reset_requests,100),
    left(p_limit_tokens,100), left(p_remaining_tokens,100), left(p_reset_tokens,100)
  );
end;
$$;

revoke all on function public.record_bia_openai_diagnostic(uuid,text,integer,text,text,text,text,text,text,text,text,text) from public;
grant execute on function public.record_bia_openai_diagnostic(uuid,text,integer,text,text,text,text,text,text,text,text,text) to service_role;
