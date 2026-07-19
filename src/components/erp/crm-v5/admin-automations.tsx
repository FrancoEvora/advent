"use client";

import { FormEvent, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ErpData } from "../types";
import type { CrmAutomation, CrmEnterpriseData } from "./types";
import { CrmSectionHeader, EmptyState, Status } from "./shared";

export function AutomationsView({ data, crm, reload }: { data: ErpData; crm: CrmEnterpriseData; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState<CrmAutomation | "new" | null>(null);
  async function toggle(item: CrmAutomation) {
    const client = getSupabase(); if (!client) return;
    const result = await client.from("crm_automations").update({ active: !item.active, updated_at: new Date().toISOString() }).eq("id", item.id);
    if (result.error) throw result.error; await reload();
  }
  return <div className="crm5-stack">
    <CrmSectionHeader eyebrow="ORQUESTRAÇÃO COMERCIAL" title="Automações e cadências" description="Gatilhos para distribuição, SLA, tarefas, tags, prioridade, mensagens e alertas." actions={<button className="primary" onClick={() => setEditing("new")}>+ Nova automação</button>} />
    <section className="crm5-automation-list">
      {crm.automations.map((item) => <article key={item.id} className={item.active ? "active" : "inactive"}>
        <div><span className="crm5-automation-icon">⚡</span><div><strong>{item.name}</strong><small>Gatilho: {triggerLabel(item.trigger_event)} · prioridade {item.priority}</small></div></div>
        <div className="crm5-automation-flow"><b>SE</b><span>{describeConditions(item.conditions)}</span><i>→</i><b>ENTÃO</b><span>{describeActions(item.actions)}</span></div>
        <footer><small>{item.execution_count || 0} execuções {item.last_run_at ? `· última ${new Date(item.last_run_at).toLocaleDateString("pt-BR")}` : ""}</small><button onClick={() => setEditing(item)}>Editar</button><button onClick={() => toggle(item)}>{item.active ? "Pausar" : "Ativar"}</button></footer>
      </article>)}
      {!crm.automations.length && <EmptyState title="Nenhuma automação" text="Crie regras para responder e distribuir leads automaticamente." />}
    </section>
    <section className="crm5-panel"><header><div><small>MODELOS</small><h3>Mensagens e cadências prontas</h3></div></header><div className="crm5-templates">{crm.templates.map((item) => <article key={item.id}><Status tone="info">{item.channel}</Status><strong>{item.name}</strong><p>{item.subject || item.body.slice(0, 90)}</p><small>{item.category || "geral"}</small></article>)}</div></section>
    {editing && <AutomationModal data={data} crm={crm} automation={editing === "new" ? null : editing} close={() => setEditing(null)} reload={reload} />}
  </div>;
}

const triggerLabel = (value: string) => ({ lead_created: "Lead criado", stage_changed: "Mudança de etapa", lead_stagnant: "Lead parado", sla_expired: "SLA vencido", campaign_lead: "Lead de campanha", activity_completed: "Atividade concluída" } as Record<string, string>)[value] || value;
const describeConditions = (value: Record<string, unknown>) => Object.keys(value || {}).length ? Object.entries(value).map(([key, item]) => `${key}: ${String(item)}`).join(" · ") : "qualquer lead";
const describeActions = (value: Array<Record<string, unknown>>) => (value || []).map((item) => String(item.type || "ação")).join(" + ") || "nenhuma ação";

function AutomationModal({ data, crm, automation, close, reload }: { data: ErpData; crm: CrmEnterpriseData; automation: CrmAutomation | null; close: () => void; reload: () => Promise<void> }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const client = getSupabase(); if (!client) return;
    const conditions: Record<string, unknown> = {};
    if (form.get("source")) conditions.source = String(form.get("source"));
    if (form.get("temperature")) conditions.temperature = String(form.get("temperature"));
    if (form.get("stage_id")) conditions.stage_id = String(form.get("stage_id"));
    const actions = [{ type: String(form.get("action_type")), value: String(form.get("action_value") || ""), delay_minutes: Number(form.get("delay_minutes") || 0) }];
    const payload = { organization_id: data.organization.id, name: String(form.get("name")), trigger_event: String(form.get("trigger_event")), conditions, actions, active: true, priority: Number(form.get("priority") || 100), created_by: data.session.user.id, updated_at: new Date().toISOString() };
    const result = automation ? await client.from("crm_automations").update(payload).eq("id", automation.id) : await client.from("crm_automations").insert(payload);
    if (result.error) throw result.error; await reload(); close();
  }
  return <div className="modal-backdrop" onMouseDown={close}><form className="modal crm5-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" type="button" onClick={close}>×</button><header><small>AUTOMAÇÃO</small><h2>{automation?.name || "Nova regra comercial"}</h2></header><div className="form-grid"><label className="span-2">Nome<input name="name" defaultValue={automation?.name || ""} required /></label><label>Gatilho<select name="trigger_event" defaultValue={automation?.trigger_event || "lead_created"}><option value="lead_created">Lead criado</option><option value="stage_changed">Mudança de etapa</option><option value="lead_stagnant">Lead parado</option><option value="sla_expired">SLA vencido</option><option value="campaign_lead">Lead de campanha</option><option value="activity_completed">Atividade concluída</option></select></label><label>Prioridade<input name="priority" type="number" defaultValue={automation?.priority || 100} /></label><label>Origem opcional<input name="source" /></label><label>Temperatura<select name="temperature"><option value="">Qualquer</option><option value="frio">Frio</option><option value="morno">Morno</option><option value="quente">Quente</option></select></label><label>Etapa<select name="stage_id"><option value="">Qualquer</option>{crm.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label><label>Ação<select name="action_type"><option value="assign_sdr">Distribuir para SDR</option><option value="create_task">Criar tarefa</option><option value="create_alert">Criar alerta</option><option value="set_priority">Alterar prioridade</option><option value="add_tag">Adicionar tag</option><option value="send_template">Enviar modelo</option><option value="move_stage">Mover etapa</option></select></label><label>Valor / destino<input name="action_value" /></label><label>Atraso (minutos)<input name="delay_minutes" type="number" min="0" defaultValue="0" /></label></div><footer><button type="button" onClick={close}>Cancelar</button><button className="primary">Salvar automação</button></footer></form></div>;
}
