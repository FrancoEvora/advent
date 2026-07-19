"use client";

import { FormEvent } from "react";
import { getSupabase } from "@/lib/supabase";
import type { CrmRecord, ErpData } from "../types";
import { CurrencyInput } from "../currency-input";
import { PanelTitle } from "../views-dashboard";

export const crmStages = [
  ["novo", "Novo lead"], ["qualificacao", "Qualificação"], ["visita", "Visita"], ["proposta", "Proposta"],
  ["negociacao", "Negociação"], ["ganho", "Fechado ganho"], ["perdido", "Fechado perdido"],
] as const;

export function CrmRecordModal({ data, record, close, mutate }: { data: ErpData; record: CrmRecord | null; close: () => void; mutate: (operation: () => Promise<void>, success: string) => Promise<void> }) {
  const profileMap = new Map(data.profiles.map(profile => [profile.id, profile]));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const stage = String(form.get("stage"));
    const payload = {
      organization_id: data.organization.id,
      contact_id: String(form.get("contact_id") || "") || null,
      person_name: String(form.get("person_name")).trim(),
      company_name: String(form.get("company_name") || "") || null,
      email: String(form.get("email") || "") || null,
      phone: String(form.get("phone") || "") || null,
      project_id: String(form.get("project_id") || "") || null,
      stage,
      record_status: stage === "ganho" ? "ganha" : stage === "perdido" ? "perdida" : "aberta",
      source: String(form.get("source") || "") || null,
      estimated_value: Number(form.get("estimated_value") || 0),
      probability: Number(form.get("probability") || 0),
      expected_close_date: String(form.get("expected_close_date") || "") || null,
      next_action_at: String(form.get("next_action_at") || "") || null,
      owner_user_id: String(form.get("owner_user_id") || "") || null,
      notes: String(form.get("notes") || "") || null,
      created_by: record?.created_by || data.session.user.id,
      updated_at: new Date().toISOString(),
    };
    await mutate(async () => {
      const client = getSupabase(); if (!client) throw new Error("Supabase indisponível.");
      const result = record ? await client.from("crm_records").update(payload).eq("id", record.id) : await client.from("crm_records").insert(payload);
      if (result.error) throw new Error(result.error.message);
    }, record ? "Oportunidade atualizada." : "Oportunidade criada no CRM.");
    close();
  }
  return <div className="modal-backdrop" onMouseDown={close}><form className="modal large" onSubmit={submit} onMouseDown={event => event.stopPropagation()}><PanelTitle eyebrow={record ? "EDITAR OPORTUNIDADE" : "NOVA OPORTUNIDADE"} title={record?.person_name || "Cadastrar lead comercial"} /><button className="modal-close" type="button" onClick={close}>×</button><div className="form-section"><h4>Contato e interesse</h4><div className="form-grid three"><label>Nome do contato<input name="person_name" defaultValue={record?.person_name || ""} required /></label><label>Empresa<input name="company_name" defaultValue={record?.company_name || ""} /></label><label>Origem<select name="source" defaultValue={record?.source || "indicação"}><option>Indicação</option><option>Instagram</option><option>Site</option><option>WhatsApp</option><option>Evento</option><option>Corretor</option><option>Prospecção</option><option>Outro</option></select></label><label>E-mail<input name="email" type="email" defaultValue={record?.email || ""} /></label><label>Telefone<input name="phone" defaultValue={record?.phone || ""} /></label><label>Cadastro relacionado<select name="contact_id" defaultValue={record?.contact_id || ""}><option value="">Lead ainda não convertido</option>{data.contacts.filter(contact => ["cliente","ambos"].includes(contact.contact_type)).map(contact => <option key={contact.id} value={contact.id}>{contact.trade_name || contact.name}</option>)}</select></label><label className="span-2">Empreendimento<select name="project_id" defaultValue={record?.project_id || ""}><option value="">Corporativo / não definido</option>{data.projects.filter(project => project.active).map(project => <option key={project.id} value={project.id}>{project.code} · {project.name}</option>)}</select></label><label>Responsável<select name="owner_user_id" defaultValue={record?.owner_user_id || data.session.user.id}><option value="">Equipe comercial</option>{data.members.filter(member => member.active).map(member => <option key={member.user_id} value={member.user_id}>{profileMap.get(member.user_id)?.full_name || profileMap.get(member.user_id)?.email || "Usuário"}</option>)}</select></label></div></div><div className="form-section"><h4>Funil e previsão</h4><div className="form-grid three"><label>Etapa<select name="stage" defaultValue={record?.stage || "novo"}>{crmStages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Valor potencial<CurrencyInput name="estimated_value" defaultValue={Number(record?.estimated_value || 0)} /></label><label>Probabilidade (%)<input name="probability" type="number" min="0" max="100" defaultValue={record?.probability ?? 10} /></label><label>Fechamento previsto<input name="expected_close_date" type="date" defaultValue={record?.expected_close_date || ""} /></label><label className="span-2">Próxima ação<input name="next_action_at" type="datetime-local" defaultValue={record?.next_action_at ? record.next_action_at.slice(0, 16) : ""} /></label><label className="span-3">Observações<textarea name="notes" rows={4} defaultValue={record?.notes || ""} /></label></div></div><footer><button type="button" onClick={close}>Cancelar</button><button className="primary">Salvar oportunidade</button></footer></form></div>;
}