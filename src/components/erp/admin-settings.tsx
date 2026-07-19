"use client";

import { FormEvent } from "react";
import { getSupabase } from "@/lib/supabase";
import type { AdminProps } from "./views-admin";
import { CurrencyInput } from "./currency-input";
import { PanelTitle } from "./views-dashboard";

export function SettingsView({ data, mutate }: AdminProps) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await mutate(async () => {
      const supabase = getSupabase(); if (!supabase) throw new Error("Supabase indisponível.");
      const { error } = await supabase.from("system_settings").upsert({
        organization_id: data.organization.id,
        approval_threshold: Number(form.get("approval_threshold")),
        require_approval: form.get("require_approval") === "on",
        default_due_alert_days: Number(form.get("default_due_alert_days")),
        require_cash_risk_approval: form.get("require_cash_risk_approval") === "on",
        minimum_cash_buffer: Number(form.get("minimum_cash_buffer")),
        forecast_horizon_days: Number(form.get("forecast_horizon_days")),
        overdue_treatment_days: Number(form.get("overdue_treatment_days")),
      });
      if (error) throw new Error(error.message);
    }, "Configurações atualizadas.");
  }
  return <div className="settings-layout"><form className="panel settings-form-v3" onSubmit={submit}><PanelTitle eyebrow="POLÍTICAS FINANCEIRAS" title="Aprovações, caixa e alertas" /><label>Valor mínimo para aprovação<CurrencyInput name="approval_threshold" defaultValue={Number(data.settings.approval_threshold || 0)} /></label><label>Caixa mínimo de segurança<CurrencyInput name="minimum_cash_buffer" defaultValue={Number(data.settings.minimum_cash_buffer || 0)} /></label><label>Dias de antecedência para alertas<input name="default_due_alert_days" type="number" min="1" defaultValue={data.settings.default_due_alert_days} /></label><label>Horizonte de projeção<input name="forecast_horizon_days" type="number" min="30" max="730" defaultValue={data.settings.forecast_horizon_days || 180} /></label><label>Dias para iniciar tratativa de atraso<input name="overdue_treatment_days" type="number" min="1" defaultValue={data.settings.overdue_treatment_days || 1} /></label><label className="switch"><input name="require_approval" type="checkbox" defaultChecked={data.settings.require_approval} /><span /> Exigir aprovação acima da alçada</label><label className="switch"><input name="require_cash_risk_approval" type="checkbox" defaultChecked={data.settings.require_cash_risk_approval ?? true} /><span /> Exigir aprovação quando o caixa projetado for insuficiente</label><button className="primary">Salvar configurações</button></form><section className="panel"><PanelTitle eyebrow="ORGANIZAÇÃO" title="Dados corporativos" /><dl className="org-data"><div><dt>Razão social</dt><dd>{data.organization.name}</dd></div><div><dt>Nome de exibição</dt><dd>{data.organization.trade_name || "—"}</dd></div><div><dt>Documento</dt><dd>{data.organization.document || "Não informado"}</dd></div><div><dt>Moeda</dt><dd>{data.organization.currency}</dd></div></dl><div className="version-card"><strong>Évora Gestão ERP</strong><span>Versão 3.0 Executiva · Next.js + Supabase</span><small>Caixa preditivo, governança e inteligência de recebíveis</small></div></section></div>;
}
