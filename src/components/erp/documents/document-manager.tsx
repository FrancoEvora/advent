"use client";

import { FormEvent, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { DocumentAttachment, ErpData } from "../types";
import { Empty, PanelTitle } from "../views-dashboard";

const documentTypes = [
  ["cartao_cnpj", "Cartão do CNPJ"], ["nota_fiscal", "Nota fiscal"], ["comprovante_pagamento", "Comprovante de pagamento"],
  ["comprovante_recebimento", "Comprovante de recebimento"], ["contrato", "Contrato"], ["orcamento", "Orçamento / proposta"],
  ["documento_pessoal", "Documento pessoal"], ["folha_pagamento", "Folha de pagamento"], ["outro", "Outro documento"],
];

const entityLabels: Record<string, string> = {
  contact: "Cliente / fornecedor", financial_entry: "Lançamento financeiro", purchase_request: "Compra / contratação",
  hr_employee: "Colaborador", payroll_run: "Folha de pagamento", other: "Documento geral",
};

function safeName(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-100); }
function bytes(value: number | null) { if (!value) return "—"; if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`; return `${(value / 1024 / 1024).toFixed(1)} MB`; }

export function DocumentManager({ data, mutate, initialEntityType, initialEntityId, compact = false }: {
  data: ErpData;
  mutate: (operation: () => Promise<void>, success: string) => Promise<void>;
  initialEntityType?: string;
  initialEntityId?: string | null;
  compact?: boolean;
}) {
  const [entityType, setEntityType] = useState(initialEntityType || "other");
  const [entityId, setEntityId] = useState(initialEntityId || "");
  const [error, setError] = useState("");
  const documents = useMemo(() => data.documents.filter(item => item.entity_type === entityType && (!entityId || item.entity_id === entityId)).sort((a, b) => b.created_at.localeCompare(a.created_at)), [data.documents, entityType, entityId]);

  const targets = entityType === "contact" ? data.contacts.map(item => ({ id: item.id, label: item.trade_name || item.name }))
    : entityType === "financial_entry" ? data.entries.map(item => ({ id: item.id, label: `${item.description} · ${item.due_date}` }))
    : entityType === "purchase_request" ? data.purchaseRequests.map(item => ({ id: item.id, label: item.title }))
    : entityType === "hr_employee" ? data.hrEmployees.map(item => ({ id: item.id, label: item.full_name }))
    : entityType === "payroll_run" ? data.hrPayrollRuns.map(item => ({ id: item.id, label: `Folha ${item.reference_month.slice(0, 7)}` })) : [];

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const form = new FormData(event.currentTarget); const file = form.get("file") as File;
    if (!file?.size) { setError("Selecione um arquivo."); return; }
    if (entityType !== "other" && !entityId) { setError("Selecione o cadastro relacionado ao documento."); return; }
    const max = Number(data.settings.document_max_size_mb || 20) * 1024 * 1024;
    if (file.size > max) { setError(`O arquivo supera o limite de ${data.settings.document_max_size_mb || 20} MB.`); return; }
    await mutate(async () => {
      const supabase = getSupabase(); if (!supabase) throw new Error("Supabase indisponível.");
      const path = `${data.organization.id}/${entityType}/${entityId || "geral"}/${crypto.randomUUID()}-${safeName(file.name)}`;
      const { error: uploadError } = await supabase.storage.from("erp-documents").upload(path, file, { contentType: file.type, upsert: false });
      if (uploadError) throw new Error(uploadError.message);
      const { error: metadataError } = await supabase.from("document_attachments").insert({ organization_id: data.organization.id, entity_type: entityType, entity_id: entityId || null, document_type: String(form.get("document_type")), file_name: file.name, storage_path: path, mime_type: file.type || null, size_bytes: file.size, notes: String(form.get("notes") || "") || null, uploaded_by: data.session.user.id });
      if (metadataError) { await supabase.storage.from("erp-documents").remove([path]); throw new Error(metadataError.message); }
    }, "Documento anexado com segurança.");
    event.currentTarget.reset();
  }

  async function openDocument(item: DocumentAttachment) {
    const supabase = getSupabase(); if (!supabase) return;
    const { data: link, error: linkError } = await supabase.storage.from("erp-documents").createSignedUrl(item.storage_path, 120);
    if (linkError || !link?.signedUrl) { setError(linkError?.message || "Não foi possível abrir o documento."); return; }
    window.open(link.signedUrl, "_blank", "noopener,noreferrer");
  }

  async function removeDocument(item: DocumentAttachment) {
    if (!confirm(`Excluir o documento “${item.file_name}”?`)) return;
    await mutate(async () => {
      const supabase = getSupabase(); if (!supabase) throw new Error("Supabase indisponível.");
      const { error: storageError } = await supabase.storage.from("erp-documents").remove([item.storage_path]);
      if (storageError) throw new Error(storageError.message);
      const { error: metadataError } = await supabase.from("document_attachments").delete().eq("id", item.id);
      if (metadataError) throw new Error(metadataError.message);
    }, "Documento excluído.");
  }

  return <div className={compact ? "documents-compact" : "stack"}>
    {!compact && <section className="module-toolbar"><div><small>ARQUIVO DIGITAL</small><h2>Documentos e comprovantes</h2></div></section>}
    <section className="panel document-upload"><PanelTitle eyebrow="NOVO DOCUMENTO" title="Anexar arquivo" /><form onSubmit={upload}><div className="form-grid three"><label>Vincular a<select value={entityType} onChange={event => { setEntityType(event.target.value); setEntityId(""); }}>{Object.entries(entityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{entityType !== "other" && <label>Cadastro relacionado<select value={entityId} onChange={event => setEntityId(event.target.value)} required><option value="">Selecione</option>{targets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}<label>Tipo do documento<select name="document_type">{documentTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="span-2">Arquivo<input name="file" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.xlsx,.csv" required /></label><label>Observações<input name="notes" placeholder="Opcional" /></label></div>{error && <div className="feedback error">{error}</div>}<button className="primary">Anexar documento</button></form></section>
    <section className="panel"><PanelTitle eyebrow="DOCUMENTOS" title={`${documents.length} arquivo(s) localizado(s)`} /><div className="document-list">{documents.map(item => <article key={item.id}><div className="document-icon">▧</div><div><strong>{item.file_name}</strong><small>{documentTypes.find(type => type[0] === item.document_type)?.[1] || item.document_type} · {bytes(item.size_bytes)} · {new Date(item.created_at).toLocaleString("pt-BR")}</small></div><div><button onClick={() => openDocument(item)}>Abrir</button><button onClick={() => removeDocument(item)}>Excluir</button></div></article>)}{!documents.length && <Empty text="Nenhum documento anexado a este cadastro." />}</div></section>
  </div>;
}
