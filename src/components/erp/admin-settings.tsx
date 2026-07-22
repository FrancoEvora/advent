"use client";

import { FormEvent } from "react";
import { getSupabase } from "@/lib/supabase";
import type { AdminProps } from "./views-admin";
import { CurrencyInput } from "./currency-input";
import { PanelTitle } from "./views-dashboard";

const TEST_CODE = "260726";
const toLocalDateTime = (value?: string | null) => {
  const date = value ? new Date(value) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16);
};

export function SettingsView({ data, mutate }: AdminProps) {
  const isAdmin = data.membership.role === "admin";
  const simulationActive = Boolean(data.settings.otp_simulation_enabled && data.settings.otp_simulation_expires_at && new Date(data.settings.otp_simulation_expires_at).getTime() > Date.now());

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    await mutate(async () => {
      const supabase = getSupabase(); if (!supabase) throw new Error("Supabase indisponível.");
      const payload: Record<string, unknown> = { organization_id: data.organization.id, approval_threshold: Number(form.get("approval_threshold")), require_approval: form.get("require_approval") === "on", default_due_alert_days: Number(form.get("default_due_alert_days")), require_cash_risk_approval: form.get("require_cash_risk_approval") === "on", minimum_cash_buffer: Number(form.get("minimum_cash_buffer")), forecast_horizon_days: Number(form.get("forecast_horizon_days")), overdue_treatment_days: Number(form.get("overdue_treatment_days")), procurement_approval_required: form.get("procurement_approval_required") === "on", salary_payment_day: Number(form.get("salary_payment_day")), default_employer_charge_rate: Number(form.get("default_employer_charge_rate")) / 100, termination_reserve_rate: Number(form.get("termination_reserve_rate")) / 100, document_max_size_mb: Number(form.get("document_max_size_mb")) };
      if (isAdmin) {
        const enabled = form.get("otp_simulation_enabled") === "on";
        const expiresValue = String(form.get("otp_simulation_expires_at") || "");
        payload.otp_simulation_enabled = enabled;
        payload.otp_simulation_expires_at = enabled && expiresValue ? new Date(expiresValue).toISOString() : null;
        payload.otp_simulation_updated_at = new Date().toISOString();
        payload.otp_simulation_updated_by = data.session.user.id;
      }
      const { error } = await supabase.from("system_settings").upsert(payload);
      if (error) throw new Error(error.message);
      if (isAdmin) await supabase.from("audit_logs").insert({organization_id:data.organization.id,user_id:data.session.user.id,action:"otp_simulation_settings_updated",entity:"system_settings",entity_id:data.organization.id,new_data:{enabled:payload.otp_simulation_enabled,expires_at:payload.otp_simulation_expires_at,test_code_reference:"standard-v1"}});
    }, "Configurações administrativas atualizadas.");
  }

  return <div className="settings-layout"><form className="panel settings-form-v3" onSubmit={submit}><PanelTitle eyebrow="POLÍTICAS CORPORATIVAS" title="Financeiro, compras, documentos e RH" /><label>Valor mínimo para aprovação<CurrencyInput name="approval_threshold" defaultValue={Number(data.settings.approval_threshold || 0)} /></label><label>Caixa mínimo de segurança<CurrencyInput name="minimum_cash_buffer" defaultValue={Number(data.settings.minimum_cash_buffer || 0)} /></label><label>Dias de antecedência para alertas<input name="default_due_alert_days" type="number" min="1" defaultValue={data.settings.default_due_alert_days} /></label><label>Horizonte de projeção<input name="forecast_horizon_days" type="number" min="30" max="730" defaultValue={data.settings.forecast_horizon_days || 365} /></label><label>Dias para iniciar tratativa de atraso<input name="overdue_treatment_days" type="number" min="1" defaultValue={data.settings.overdue_treatment_days || 1} /></label><label>Dia padrão de pagamento salarial<input name="salary_payment_day" type="number" min="1" max="28" defaultValue={data.settings.salary_payment_day || 5} /></label><label>Encargos patronais padrão (%)<input name="default_employer_charge_rate" type="number" step="0.01" min="0" defaultValue={Number(data.settings.default_employer_charge_rate || 0) * 100} /></label><label>Reserva estimada para desligamento (%)<input name="termination_reserve_rate" type="number" step="0.01" min="0" defaultValue={Number(data.settings.termination_reserve_rate || 0.4) * 100} /></label><label>Limite de documento (MB)<input name="document_max_size_mb" type="number" min="1" max="100" defaultValue={data.settings.document_max_size_mb || 20} /></label><label className="switch"><input name="require_approval" type="checkbox" defaultChecked={data.settings.require_approval} /><span /> Exigir aprovação acima da alçada</label><label className="switch"><input name="require_cash_risk_approval" type="checkbox" defaultChecked={data.settings.require_cash_risk_approval ?? true} /><span /> Exigir aprovação quando o caixa projetado for insuficiente</label><label className="switch"><input name="procurement_approval_required" type="checkbox" defaultChecked={data.settings.procurement_approval_required ?? true} /><span /> Exigir aprovação administrativa para todas as compras</label>{isAdmin&&<section className={`otp-simulation-settings ${simulationActive?"active":""}`}><header><div><small>ASSINATURA ELETRÔNICA · TESTE CONTROLADO</small><h3>Simulação de código pelo WhatsApp</h3></div><span>{simulationActive?"Ativo":"Desativado"}</span></header><p>Enquanto ativo, a tela pública simula o recebimento do código sem usar a API da Meta. Toda assinatura fica marcada no certificado e na auditoria como teste.</p><label className="switch"><input name="otp_simulation_enabled" type="checkbox" defaultChecked={data.settings.otp_simulation_enabled ?? false}/><span/> Habilitar temporariamente o OTP simulado</label><label>Expiração automática<input name="otp_simulation_expires_at" type="datetime-local" defaultValue={toLocalDateTime(data.settings.otp_simulation_expires_at)}/></label><div className="otp-test-code"><small>CÓDIGO PADRÃO DE TESTE</small><strong>{TEST_CODE}</strong><span>Use apenas em propostas e contratos de homologação.</span></div></section>}<button className="primary">Salvar configurações</button></form><section className="panel"><PanelTitle eyebrow="ORGANIZAÇÃO" title="Dados corporativos" /><dl className="org-data"><div><dt>Razão social</dt><dd>{data.organization.name}</dd></div><div><dt>Nome de exibição</dt><dd>{data.organization.trade_name || "—"}</dd></div><div><dt>Documento</dt><dd>{data.organization.document || "Não informado"}</dd></div><div><dt>Moeda</dt><dd>{data.organization.currency}</dd></div></dl><div className="version-card"><strong>Évora Gestão Enterprise</strong><span>Versão 6.1 · OTP de teste controlado</span><small>CRM, financeiro, marketing, assinatura eletrônica, pós-venda e governança</small></div><div className="info-box">O modo de simulação deve permanecer ativo somente durante homologação. Ao expirar, a plataforma volta automaticamente ao envio oficial pelo WhatsApp.</div></section></div>;
}