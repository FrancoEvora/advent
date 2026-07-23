-- Évora Gestão 6.6: o contrato usa o mesmo padrão de evidência da proposta.
-- O fluxo OTP legado permanece no histórico do schema, mas deixa de ser executável
-- por clientes públicos ou usuários comuns.

revoke execute on function public.get_public_signature_otp_mode(uuid, text) from public, anon, authenticated;
revoke execute on function public.issue_public_test_signature_otp(uuid, text) from public, anon, authenticated;
revoke execute on function public.issue_signature_otp(uuid, text, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.verify_signature_otp(uuid, text) from public, anon, authenticated;
revoke execute on function public.crm_sign_public_contract_with_otp(uuid, text, text, uuid, text, jsonb) from public, anon, authenticated;

grant execute on function public.get_public_signature_otp_mode(uuid, text) to service_role;
grant execute on function public.issue_public_test_signature_otp(uuid, text) to service_role;
grant execute on function public.issue_signature_otp(uuid, text, uuid, uuid, text, text) to service_role;
grant execute on function public.verify_signature_otp(uuid, text) to service_role;
grant execute on function public.crm_sign_public_contract_with_otp(uuid, text, text, uuid, text, jsonb) to service_role;

-- Helpers internos não precisam ser chamados por visitantes anônimos.
revoke execute on function public.crm_can_access(uuid) from public, anon;
revoke execute on function public.crm_can_manage(uuid) from public, anon;
revoke execute on function public.has_app_permission(uuid, text) from public, anon;
grant execute on function public.crm_can_access(uuid) to authenticated, service_role;
grant execute on function public.crm_can_manage(uuid) to authenticated, service_role;
grant execute on function public.has_app_permission(uuid, text) to authenticated, service_role;
