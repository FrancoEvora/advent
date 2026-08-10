-- Évora Gestão 6.24.2
-- Formaliza a intenção de acesso somente por funções controladas.

alter table public.admin_user_lifecycle_operations enable row level security;
alter table public.spatial_v4_markers enable row level security;
alter table public.spatial_v4_sessions enable row level security;

drop policy if exists admin_user_lifecycle_operations_direct_deny on public.admin_user_lifecycle_operations;
create policy admin_user_lifecycle_operations_direct_deny
on public.admin_user_lifecycle_operations
for all
to anon, authenticated
using (false)
with check (false);

drop policy if exists spatial_v4_markers_direct_deny on public.spatial_v4_markers;
create policy spatial_v4_markers_direct_deny
on public.spatial_v4_markers
for all
to anon, authenticated
using (false)
with check (false);

drop policy if exists spatial_v4_sessions_direct_deny on public.spatial_v4_sessions;
create policy spatial_v4_sessions_direct_deny
on public.spatial_v4_sessions
for all
to anon, authenticated
using (false)
with check (false);
