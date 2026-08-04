"use client";

import type { ErpData } from "../../types";
import {
  CommunicationResources,
  type CommunicationShareChannel,
} from "../../communication/communication-resources";

type FormalCommunicationMaterialsModalProps = {
  data: ErpData;
  entityType: "crm_proposal" | "crm_contract";
  entityId: string;
  eyebrow: string;
  title: string;
  recipientName: string;
  recipientPhone?: string | null;
  recipientEmail?: string | null;
  projectId?: string | null;
  subject: string;
  message: string;
  onPrepared: (channel: CommunicationShareChannel) => Promise<void>;
  close: () => void;
};

export function FormalCommunicationMaterialsModal({
  data,
  entityType,
  entityId,
  eyebrow,
  title,
  recipientName,
  recipientPhone,
  recipientEmail,
  projectId,
  subject,
  message,
  onPrepared,
  close,
}: FormalCommunicationMaterialsModalProps) {
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <section
        className="modal extra-large crm5-modal crm5-materials-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`formal-materials-${entityId}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="modal-close" type="button" onClick={close}>
          ×
        </button>
        <header>
          <small>{eyebrow}</small>
          <h2 id={`formal-materials-${entityId}`}>{title}</h2>
          <p>
            Selecione os materiais complementares, confira o destinatário e
            prepare o encaminhamento pelo canal escolhido. A preparação fica
            registrada no histórico comercial; confirme o envio no aplicativo
            escolhido.
          </p>
        </header>

        <CommunicationResources
          data={data}
          entityType={entityType}
          entityId={entityId}
          shareTarget={{
            name: recipientName,
            phone: recipientPhone,
            email: recipientEmail,
            projectId,
            subject,
            message,
          }}
          onPrepared={onPrepared}
        />

        <footer>
          <button type="button" onClick={close}>
            Fechar
          </button>
        </footer>
      </section>
    </div>
  );
}
