"use client";

import { FormEvent } from "react";
import { getSupabase } from "@/lib/supabase";
import type { CrmRecord, ErpData } from "../types";
import { PanelTitle } from "../views-dashboard";

export function CrmActionModal({ data, record, close, mutate }: { data: ErpData; record?: CrmRecord | null; close: () => void; mutate: (operation: () => Promise<void>, success: string) => Promise<void> }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const crmRecordId = String(form.get("crm_record_id"));
    await mutate(async () => {
      const client = getSupabase(); if (!client) throw new Error("Supabase indisponível.");
      const result = await client.from("crm_actions").insert({
        organization_id: data.organization.id,
        crm_record_id: crmRecordId,
        action_type: String(form.get("action_type")),
        subject: String(form.get("subject")).trim(),
        scheduled_at: String(form.get("scheduled_at") || "") || null,
        action_status: "pendente",
        notes: String(form.get("notes") || "") || null,
        created_by: data.session.user.id,
      });
      if (result.error) throw new Error(result.error.message);
      const scheduled = String(form.get("scheduled_at") || "") || null;
      if (scheduled) await client.from("crm_records").update({ next_action_at: scheduled, updated_at: new Date().toISOString() }).eq("id", crmRecordId);
    }, "Atividade comercial registrada.");
    close();
  }
  return <div className="modal-backdrop" onMouseDown={close}><form className="modal" onSubmit={submit} onMouseDown={event => event.stopPropagation()}><PanelTitle eyebrow="AGENDA COMERCIAL" title="Nova atividade" /><button className="modal-close" type="button" onClick={close}>×</button><div className="form-grid"><label className="span-2">Oportunidade<select name="crm_record_id" defaultValue={record?.id || ""} required><option value="">Selecione</option>{data.crmRecords.filter(item => item.record_status === "aberta").map(item => <option key={item.id} value={item.id}>{item.person_name} · {item.company_name || data.projects.find(project => project.id === item.project_id)?.name || "Oportunidade"}</option>)}</select></label><label>Tipo<select name="action_type" defaultValue="contato"><option value="contato">Contato</option><option value="ligacao">Ligação</option><option value="whatsapp">WhatsApp</option><option value="email">E-mail</option><option value="reuniao">Reunião</option><option value="visita">Visita</option><option value="proposta">Proposta</option><option value="tarefa">Tarefa</option><option value="outro">Outro</option></select></label><label>Data e hora<input name="scheduled_at" type="datetime-local" required /></label><label className="span-2">Assunto<input name="subject" required /></label><label className="span-2">Observações<textarea name="notes" rows={4} /></label></div><footer><button type="button" onClick={close}>Cancelar</button><button className="primary">Agendar atividade</button></footer></form></div>;
}