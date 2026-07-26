-- Enforce the portal.manage control at the database boundary.
-- Read access follows post_sale.view; every mutation requires portal.manage.

drop policy if exists post_sale_portal_tokens_org_access
  on public.post_sale_portal_tokens;

create policy post_sale_portal_tokens_select
  on public.post_sale_portal_tokens
  for select
  using (
    public.has_app_permission(organization_id, 'post_sale.view')
  );

create policy post_sale_portal_tokens_insert
  on public.post_sale_portal_tokens
  for insert
  with check (
    public.has_app_permission(organization_id, 'portal.manage')
  );

create policy post_sale_portal_tokens_update
  on public.post_sale_portal_tokens
  for update
  using (
    public.has_app_permission(organization_id, 'portal.manage')
  )
  with check (
    public.has_app_permission(organization_id, 'portal.manage')
  );

create policy post_sale_portal_tokens_delete
  on public.post_sale_portal_tokens
  for delete
  using (
    public.has_app_permission(organization_id, 'portal.manage')
  );

drop policy if exists org_access
  on public.portal_content_items;

create policy portal_content_items_select
  on public.portal_content_items
  for select
  using (
    public.has_app_permission(organization_id, 'post_sale.view')
  );

create policy portal_content_items_insert
  on public.portal_content_items
  for insert
  with check (
    public.has_app_permission(organization_id, 'portal.manage')
  );

create policy portal_content_items_update
  on public.portal_content_items
  for update
  using (
    public.has_app_permission(organization_id, 'portal.manage')
  )
  with check (
    public.has_app_permission(organization_id, 'portal.manage')
  );

create policy portal_content_items_delete
  on public.portal_content_items
  for delete
  using (
    public.has_app_permission(organization_id, 'portal.manage')
  );

drop policy if exists customer_portal_settings_select
  on public.customer_portal_settings;

create policy customer_portal_settings_select
  on public.customer_portal_settings
  for select
  using (
    public.has_app_permission(organization_id, 'post_sale.view')
  );
