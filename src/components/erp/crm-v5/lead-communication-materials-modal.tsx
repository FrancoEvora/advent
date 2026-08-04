"use client";

import type { CrmAction, CrmRecord, ErpData } from "../types";
import { CommunicationResources } from "../communication/communication-resources";

export function LeadCommunicationMaterialsModal({
  data,
  action,
  lead,
  close,
}: {
  data: ErpData;
  action: CrmAction;
  lead: CrmRecord | null;
  close: () => void;
}) {
  const contact = lead?.contact_id
    ? data.contacts.find((item) => item.id === lead.contact_id)
    : null;

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <section
        className="modal extra-large crm5-modal crm5-materials-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="crm-materials-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="modal-close"
          aria-label="Fechar materiais da comunicação"
          onClick={close}
        >
          ×
        </button>
        <header>
          <small>COMUNICAÇÃO COM O LEAD</small>
          <h2 id="crm-materials-title">Materiais de {action.subject}</h2>
          <p>
            {lead
              ? `Selecione o conteúdo e prepare o encaminhamento para ${lead.person_name}.`
              : "A atividade foi preservada, mas o lead relacionado não está mais disponível para encaminhamento."}
          </p>
        </header>

        <CommunicationResources
          data={data}
          entityType="crm_action"
          entityId={action.id}
          shareTarget={
            lead
              ? {
                  name: lead.person_name,
                  phone: lead.phone || contact?.phone,
                  email: lead.email || contact?.email,
                  subject: action.subject,
                  projectId: lead.project_id,
                  message:
                    "Conforme nosso atendimento com a Évora Urbanismo, seguem os materiais selecionados:",
                }
              : undefined
          }
        />

        <footer>
          <button type="button" className="primary" onClick={close}>
            Concluir
          </button>
        </footer>
      </section>
    </div>
  );
}
