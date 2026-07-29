-- Índices auxiliares do portal de terrenistas.
-- Cobrem as chaves estrangeiras para exclusões, auditoria e consultas por vínculo.

create index if not exists partner_landowner_publications_contact_idx
  on public.partner_landowner_publications (contact_id);

create index if not exists partner_landowner_publications_project_idx
  on public.partner_landowner_publications (project_id);

create index if not exists partner_landowner_publications_published_by_idx
  on public.partner_landowner_publications (published_by);

create index if not exists partner_landowner_repasses_contact_idx
  on public.partner_landowner_repass_entries (contact_id);

create index if not exists partner_landowner_repasses_project_idx
  on public.partner_landowner_repass_entries (project_id);

create index if not exists partner_landowner_repasses_registered_by_idx
  on public.partner_landowner_repass_entries (registered_by);
