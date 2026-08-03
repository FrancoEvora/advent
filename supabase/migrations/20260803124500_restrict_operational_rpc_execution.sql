-- Restringe funções operacionais SECURITY DEFINER.
-- PUBLIC inclui anon; portanto, a revogação deve ocorrer no papel base.

revoke all on function public.create_operational_contract(jsonb, jsonb) from public;
revoke all on function public.record_equipment_meter_reading(jsonb) from public;

grant execute on function public.create_operational_contract(jsonb, jsonb) to authenticated, service_role;
grant execute on function public.record_equipment_meter_reading(jsonb) to authenticated, service_role;
