-- Evora Enterprise - endurecimento pos-validacao da fundacao canonica.

set lock_timeout = '5s';
set statement_timeout = '120s';

-- A funcao apenas confirma uma janela de restore pertencente ao proprio
-- administrador autenticado. As tabelas consultadas ja possuem RLS; executar
-- com os privilegios do chamador elimina elevacao desnecessaria.
alter function public.crm_canonical_restore_active(uuid)
  security invoker;

-- Cobertura exata das FKs compostas identificadas pelo advisor do Postgres.
create index if not exists crm_opportunity_attributions_product_fk_idx
  on public.crm_opportunity_attributions (
    organization_id, project_id, product_id
  )
  where product_id is not null;

create index if not exists crm_opportunity_events_product_fk_idx
  on public.crm_opportunity_events (
    organization_id, project_id, product_id
  )
  where product_id is not null;
