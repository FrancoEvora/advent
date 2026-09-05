-- Cover the composite foreign keys used by the Arisa operation ledger.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';

create index arisa_bank_item_organization
  on public.arisa_bank_transactions(item_id, organization_id);
create index arisa_events_item_organization
  on public.arisa_operation_events(item_id, organization_id);

commit;
