create table if not exists public.mcp_oauth_authorization_codes (
  code_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null,
  project_ids uuid[] not null,
  client_id text not null,
  redirect_uri text not null,
  code_challenge text not null,
  resource text not null,
  scope text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint mcp_oauth_code_client_check
    check (client_id = 'https://chatgpt.com/oauth/client.json'),
  constraint mcp_oauth_code_redirect_check
    check (redirect_uri = 'https://chatgpt.com/connector_platform_oauth_redirect'),
  constraint mcp_oauth_code_resource_check
    check (resource = 'https://enterprise.terraragroup.com.br/mcp'),
  constraint mcp_oauth_code_scope_check
    check (scope = 'solaris:read'),
  constraint mcp_oauth_code_projects_check
    check (project_ids = array['85799c1b-e14a-5120-bf3d-976928d5dec3'::uuid])
);

create index if not exists mcp_oauth_authorization_codes_user_idx
  on public.mcp_oauth_authorization_codes (user_id, expires_at);

alter table public.mcp_oauth_authorization_codes enable row level security;
revoke all on table public.mcp_oauth_authorization_codes from anon, authenticated;
grant all on table public.mcp_oauth_authorization_codes to service_role;

create table if not exists public.mcp_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  access_token_hash text not null unique,
  refresh_token_hash text unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null,
  project_ids uuid[] not null,
  client_id text not null,
  resource text not null,
  scopes text[] not null,
  expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mcp_oauth_token_client_check
    check (client_id = 'https://chatgpt.com/oauth/client.json'),
  constraint mcp_oauth_token_resource_check
    check (resource = 'https://enterprise.terraragroup.com.br/mcp'),
  constraint mcp_oauth_token_scopes_check
    check (scopes = array['solaris:read'::text]),
  constraint mcp_oauth_token_projects_check
    check (project_ids = array['85799c1b-e14a-5120-bf3d-976928d5dec3'::uuid])
);

create index if not exists mcp_oauth_tokens_user_idx
  on public.mcp_oauth_tokens (user_id, expires_at);
create index if not exists mcp_oauth_tokens_refresh_expiry_idx
  on public.mcp_oauth_tokens (refresh_expires_at)
  where revoked_at is null;

alter table public.mcp_oauth_tokens enable row level security;
revoke all on table public.mcp_oauth_tokens from anon, authenticated;
grant all on table public.mcp_oauth_tokens to service_role;
