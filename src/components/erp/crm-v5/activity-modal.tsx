"use client";

import { FormEvent, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { CrmRecord, ErpData } from "../types";
import { CommunicationResources } from "../communication/communication-resources";
import type { CrmEnterpriseData } from "./types";

type SavedActivity = {
  id: string;
  leadId: string;
  subject: string;
  completed: boolean;
};

export function ActivityModal({
  data,
  crm,
  lead,
  close,
  done,
}: {
  data: ErpData;
  crm: CrmEnterpriseData;
  lead: CrmRecord | null;
  close: () => void;
  done: (message: string) => Promise<void>;
}) {
  const [saved, setSaved] = useState<SavedActivity | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [defaultSchedule] = useState(() => {
    const date = new Date(Date.now() + 60 * 60 * 1000);
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 16);
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const form = new FormData(event.currentTarget);
      const client = getSupabase();
      if (!client) throw new Error("Supabase indisponível.");
      const leadId = String(
        form.get("crm_record_id") || lead?.id || "",
      );
      if (!leadId) throw new Error("Selecione um lead.");
      const selectedLead = crm.records.find((item) => item.id === leadId);
      if (!selectedLead || selectedLead.record_status === "arquivada") {
        throw new Error(
          "O lead está arquivado e não pode receber novas atividades.",
        );
      }
      const completed = form.get("complete_now") === "on";
      const now = new Date().toISOString();
      const subject = String(form.get("subject") || "").trim();
      const localSchedule = String(form.get("scheduled_at") || "");
      const scheduledAt = completed
        ? now
        : localSchedule
          ? new Date(localSchedule).toISOString()
          : null;
      const payload = {
        organization_id: data.organization.id,
        crm_record_id: leadId,
        action_type: String(form.get("action_type")),
        channel: String(form.get("channel")),
        subject,
        scheduled_at: scheduledAt,
        completed_at: completed ? now : null,
        action_status: completed ? "concluida" : "pendente",
        outcome: String(form.get("outcome") || "") || null,
        duration_minutes:
          Number(form.get("duration_minutes") || 0) || null,
        assigned_to: String(
          form.get("assigned_to") || data.session.user.id,
        ),
        notes: String(form.get("notes") || "") || null,
        created_by: data.session.user.id,
        metadata: {
          materials_supported: true,
          external_delivery_handoff: false,
        },
      };
      const result = await client
        .from("crm_actions")
        .insert(payload)
        .select("id")
        .single();
      if (result.error) throw new Error(result.error.message);

      setSaved({
        id: result.data.id,
        leadId,
        subject,
        completed,
      });

      if (completed) {
        const current = crm.records.find((item) => item.id === leadId);
        const leadUpdate = await client
          .from("crm_records")
          .update({
            last_contact_at: now,
            first_response_at: current?.first_response_at || now,
            attempts: Number(current?.attempts || 0) + 1,
            stagnation_at: now,
            updated_at: now,
          })
          .eq("organization_id", data.organization.id)
          .eq("id", leadId);
        if (leadUpdate.error) {
          setError(
            "A atividade foi salva, mas a ficha do lead não foi atualizada: " +
              leadUpdate.error.message +
              ". Os materiais podem ser preparados sem duplicar o registro.",
          );
        }
      }
      await done(
        completed
          ? "Contato registrado. Agora você pode anexar e encaminhar materiais."
          : "Atividade agendada. Materiais podem ser preparados desde já.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível salvar a atividade.",
      );
    } finally {
      setBusy(false);
    }
  }

  const savedLead = saved
    ? crm.records.find((item) => item.id === saved.leadId) || lead
    : lead;
  const savedContact = savedLead?.contact_id
    ? data.contacts.find((item) => item.id === savedLead.contact_id)
    : null;

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <section
        className="modal extra-large crm5-modal crm5-activity-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="crm-activity-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="modal-close" type="button" onClick={close}>
          ×
        </button>
        <header>
          <small>ATIVIDADE COMERCIAL</small>
          <h2 id="crm-activity-title">
            {saved
              ? "Materiais do atendimento"
              : lead
                ? "Interação com " + lead.person_name
                : "Nova atividade"}
          </h2>
          <p>
            {saved
              ? "A atividade já foi registrada. Vincule os materiais e prepare o encaminhamento pelo canal do lead."
              : "Registre a interação e, na sequência, selecione arquivos, vídeos, apresentações ou links."}
          </p>
        </header>

        {!saved ? (
          <form onSubmit={submit}>
            <div className="form-grid">
              <label className="span-2">
                Lead
                <select
                  name="crm_record_id"
                  defaultValue={lead?.id || ""}
                  required
                >
                  <option value="">Selecione</option>
                  {crm.records
                    .filter((item) => item.record_status !== "arquivada")
                    .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.person_name} ·{" "}
                      {item.company_name || item.phone || "Sem empresa"}
                    </option>
                    ))}
                </select>
              </label>
              <label>
                Tipo
                <select name="action_type" defaultValue="contato">
                  <option value="contato">Contato</option>
                  <option value="ligacao">Ligação</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="email">E-mail</option>
                  <option value="reuniao">Reunião</option>
                  <option value="visita">Visita</option>
                  <option value="proposta">Proposta</option>
                  <option value="tarefa">Tarefa</option>
                </select>
              </label>
              <label>
                Canal
                <select name="channel" defaultValue="whatsapp">
                  <option>whatsapp</option>
                  <option>telefone</option>
                  <option>email</option>
                  <option>presencial</option>
                  <option>video</option>
                  <option>instagram</option>
                </select>
              </label>
              <label className="span-2">
                Assunto
                <input
                  name="subject"
                  required
                  placeholder="Ex.: Primeiro contato, visita ao empreendimento..."
                />
              </label>
              <label>
                Agendamento
                <input
                  name="scheduled_at"
                  type="datetime-local"
                  defaultValue={defaultSchedule}
                />
              </label>
              <label>
                Responsável
                <select
                  name="assigned_to"
                  defaultValue={data.session.user.id}
                >
                  {data.members
                    .filter((item) => item.active)
                    .map((item) => (
                      <option key={item.user_id} value={item.user_id}>
                        {data.profiles.find(
                          (profile) => profile.id === item.user_id,
                        )?.full_name || item.role}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Resultado
                <select name="outcome" defaultValue="">
                  <option value="">Aguardando</option>
                  <option value="atendeu">Atendeu</option>
                  <option value="nao_atendeu">Não atendeu</option>
                  <option value="retornar">Retornar</option>
                  <option value="interessado">Interessado</option>
                  <option value="sem_interesse">Sem interesse</option>
                  <option value="visita_agendada">Visita agendada</option>
                  <option value="proposta_solicitada">
                    Proposta solicitada
                  </option>
                </select>
              </label>
              <label>
                Duração (minutos)
                <input name="duration_minutes" type="number" min="0" />
              </label>
              <label className="checkbox span-2">
                <input name="complete_now" type="checkbox" />
                <span>Registrar como concluída agora</span>
              </label>
              <label className="span-2">
                Observações
                <textarea name="notes" rows={4} />
              </label>
            </div>
            {error && <div className="feedback error">{error}</div>}
            <footer>
              <button type="button" onClick={close}>
                Cancelar
              </button>
              <button className="primary" disabled={busy}>
                {busy
                  ? "Salvando..."
                  : "Salvar e selecionar materiais"}
              </button>
            </footer>
          </form>
        ) : (
          <div className="crm5-activity-material-step">
            <div className="crm5-activity-saved">
              <b>✓</b>
              <span>
                <strong>Atividade registrada</strong>
                <small>
                  {saved.completed
                    ? "Contato concluído"
                    : "Atividade agendada"}{" "}
                  · {saved.subject}
                </small>
              </span>
            </div>
            <CommunicationResources
              data={data}
              entityType="crm_action"
              entityId={saved.id}
              shareTarget={{
                name: savedLead?.person_name || "lead",
                phone: savedLead?.phone || savedContact?.phone,
                email: savedLead?.email || savedContact?.email,
                subject: saved.subject,
                projectId: savedLead?.project_id,
                message:
                  "Conforme nosso contato com a Évora Urbanismo, seguem os materiais selecionados:",
              }}
            />
            <footer>
              <button className="primary" type="button" onClick={close}>
                Concluir atendimento
              </button>
            </footer>
          </div>
        )}
      </section>
    </div>
  );
}
