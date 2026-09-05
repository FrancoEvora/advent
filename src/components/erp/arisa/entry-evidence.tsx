"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";

type Evidence = { id: string; file_name: string; storage_path: string };

/** Evidence stays in its financial-only bucket, including when reviewed from the ERP. */
export function ArisaEntryEvidence({ organizationId, entryId }: { organizationId: string; entryId: string }) {
  const [documents, setDocuments] = useState<Evidence[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const client = getSupabase();
    if (!client) return;
    void client.from("arisa_operation_items").select("id,file_name,storage_path")
      .eq("organization_id", organizationId).eq("entry_id", entryId)
      .order("created_at", { ascending: false }).then(result => {
        if (!active) return;
        setDocuments(result.data || []);
        setError(result.error ? "Não foi possível consultar os documentos da Arisa." : "");
      });
    return () => { active = false; };
  }, [organizationId, entryId]);

  async function openOriginal(document: Evidence) {
    const client = getSupabase();
    if (!client || busy) return;
    // Create the tab within the click gesture so opening also works on iPhone.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    setBusy(document.id);
    setError("");
    setFallbackUrl(null);
    try {
      const result = await client.storage.from("arisa-operations").createSignedUrl(document.storage_path, 120);
      if (result.error || !result.data?.signedUrl) throw new Error("Não foi possível abrir o documento original. Tente novamente.");
      if (tab) tab.location.href = result.data.signedUrl;
      else setFallbackUrl(result.data.signedUrl);
    } catch (caught) {
      tab?.close();
      setError(caught instanceof Error ? caught.message : "Documento indisponível.");
    } finally { setBusy(null); }
  }

  if (!documents.length && !error) return null;
  return <section aria-label="Documentos originais da Arisa" className="form-section">
    <h4>Documentos tratados pela Arisa</h4>
    <p>Consulte a origem do lançamento antes da aprovação financeira.</p>
    <div className="document-list">{documents.map(document => <article key={document.id}>
      <strong>{document.file_name}</strong>
      <button type="button" disabled={busy !== null} onClick={() => void openOriginal(document)}>{busy === document.id ? "Abrindo…" : "Abrir original"}</button>
    </article>)}</div>
    {error ? <p role="alert">{error}</p> : null}
    {fallbackUrl ? <a href={fallbackUrl} target="_blank" rel="noopener noreferrer">Abrir documento em nova aba</a> : null}
  </section>;
}
