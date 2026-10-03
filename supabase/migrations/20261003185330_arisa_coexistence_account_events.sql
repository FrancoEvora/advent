begin;
create function public.arisa_coexistence_webhook_lookup(p_waba_id text) returns jsonb
language sql security definer set search_path='' as $fn$
select jsonb_build_object('connections',coalesce(jsonb_agg(jsonb_build_object('id',c.id)),'[]'::jsonb))
from public.arisa_whatsapp_connections c where c.waba_id=p_waba_id and c.coexistence_status='verified';
$fn$;
revoke all on function public.arisa_coexistence_webhook_lookup(text) from public,anon,authenticated;
grant execute on function public.arisa_coexistence_webhook_lookup(text) to service_role;
comment on function public.arisa_coexistence_webhook_lookup(text) is 'Service-only dispatch metadata; raw Meta events must still pass HMAC and exact WABA verification.';
commit;
