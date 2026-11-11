"use client";

import { useRef, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { createBrokerProposalPdf, type BrokerProposalDocument } from "@/lib/broker-proposal-pdf";
import type { BrokerData } from "./load-broker-data";
import { prepareShareWindow, type ShareChannel } from "./broker-share";
import styles from "./broker-workspace.module.css";

export function BrokerPdfActions({ loaded, leadId, proposalId, getDocument, disabled = false }: { loaded: BrokerData; leadId: string; proposalId?: string; getDocument?: () => BrokerProposalDocument; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  const cached = useRef<{ key: string; path: string } | null>(null);
  async function run(channel?: ShareChannel) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    let handoff: ReturnType<typeof prepareShareWindow> | undefined;
    try {
      const lead = loaded.crm.records.find(row => row.id === leadId);
      if (!lead) throw new Error("Selecione um lead da sua carteira.");
      // Validate before preparing a popup or creating a file.
      let doc = getDocument?.();
      if (channel) handoff = prepareShareWindow(channel, lead);
      const client = getSupabase()!;
      if (proposalId) {
        const result = await client.rpc("get_broker_proposal_document", { p_proposal_id: proposalId });
        if (result.error) throw result.error;
        doc = result.data as BrokerProposalDocument;
      }
      if (!doc?.payment_plan.length) throw new Error("Preencha e confira as condições da proposta antes de gerar o PDF.");
      const bytes = await createBrokerProposalPdf(doc);
      const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
      const filename = `proposta-conferencia-${(doc.proposal_number || doc.unit_code).replace(/[^a-zA-Z0-9_-]/g, "-")}.pdf`;
      if (!channel) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 60000);
        setNotice("PDF de conferência gerado. Nenhuma proposta foi encaminhada e nenhuma reserva foi alterada.");
      } else {
        const key = JSON.stringify({ leadId, doc });
        let path = cached.current?.key === key ? cached.current.path : "";
        if (!path) {
          path = `${loaded.data.organization.id}/crm_record/${leadId}/${crypto.randomUUID()}-${filename}`;
          const upload = await client.storage.from("erp-documents").upload(path, blob, { contentType: "application/pdf", upsert: false });
          if (upload.error) throw upload.error;
          const metadata = await client.from("document_attachments").insert({ organization_id: loaded.data.organization.id, entity_type: "crm_record", entity_id: leadId, document_type: "comunicacao", file_name: filename, storage_path: path, mime_type: "application/pdf", size_bytes: blob.size, notes: "PDF para simples conferência. Sem aceite ou envio automático.", uploaded_by: loaded.data.session.user.id });
          if (metadata.error) { await client.storage.from("erp-documents").remove([path]); throw metadata.error; }
          cached.current = { key, path };
        }
        const signed = await client.storage.from("erp-documents").createSignedUrl(path, 7 * 86400);
        if (signed.error || !signed.data?.signedUrl) throw new Error("Não foi possível preparar o link privado do PDF.");
        handoff!.finish("Proposta para conferência — Évora Urbanismo", `Olá, ${lead.person_name}.\n\nSegue o PDF para simples conferência das condições do lote ${doc.unit_code}:\n${signed.data.signedUrl}\n\nEste documento não constitui aceite, contrato ou confirmação de reserva. A contratação depende da aprovação da Diretoria e da formalização.\nLink disponível por 7 dias.`);
        setNotice(`Mensagem preparada no ${channel === "whatsapp" ? "WhatsApp" : "e-mail"}, com link do PDF válido por 7 dias. Confira o destinatário e confirme o envio no aplicativo.`);
      }
    } catch (cause) { handoff?.close(); setError((cause as { message?: string })?.message || "Não foi possível preparar o PDF."); }
    finally { lock.current = false; setBusy(false); }
  }
  return <section aria-label="PDF de conferência"><div className={styles.actions}>
    <button type="button" disabled={disabled || busy} onClick={() => void run()}>Gerar PDF de conferência</button>
    <button type="button" disabled={disabled || busy} onClick={() => void run("whatsapp")}>PDF por WhatsApp</button>
    <button type="button" disabled={disabled || busy} onClick={() => void run("email")}>PDF por e-mail</button>
  </div>{busy && <p role="status">Preparando PDF…</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert" className="feedback error">{error}</p>}</section>;
}
