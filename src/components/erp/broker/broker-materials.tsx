"use client";

import { useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { CrmAsset } from "../crm-v5/types";
import type { BrokerData } from "./load-broker-data";
import { BrokerLeadSelect } from "./broker-lead-select";
import { prepareShareWindow, safeResourceUrl, type ShareChannel } from "./broker-share";
import styles from "./broker-workspace.module.css";

export function BrokerMaterials({ loaded }: { loaded: BrokerData }) {
  const [leadId, setLeadId] = useState("");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lead = loaded.crm.records.find(row => row.id === leadId);
  async function open(asset: CrmAsset, channel?: ShareChannel) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    let handoff: ReturnType<typeof prepareShareWindow> | undefined;
    let preview: Window | null = null;
    try {
      if (channel) {
        if (!lead) throw new Error("Selecione o lead que receberá o material.");
        handoff = prepareShareWindow(channel, lead);
      } else { preview = window.open("about:blank", "_blank"); if (!preview) throw new Error("Permita abrir uma janela para visualizar o material."); preview.opener = null; }
      let url = asset.external_url || "";
      if (!url && asset.storage_path) {
        const result = await getSupabase()!.storage.from("marketing-assets").createSignedUrl(asset.storage_path, 7 * 86400);
        if (result.error) throw result.error;
        url = result.data.signedUrl;
      }
      if (!url) throw new Error("O material não possui arquivo ou link disponível.");
      url = safeResourceUrl(url);
      if (handoff && lead) {
        handoff.finish(`${asset.name} — Évora Urbanismo`, `Olá, ${lead.person_name}.\n\nConforme nosso atendimento, segue ${asset.name}:\n${url}\n\nLinks de arquivos privados ficam disponíveis por 7 dias.`);
        setNotice(`Mensagem preparada no ${channel === "whatsapp" ? "WhatsApp" : "e-mail"}. Confira o destinatário e confirme o envio no aplicativo.`);
      } else if (preview) preview.location.href = url;
    } catch (cause) { handoff?.close(); preview?.close(); setError((cause as { message?: string })?.message || "Não foi possível preparar o material."); }
    finally { setBusy(false); }
  }
  const assets = loaded.crm.assets.filter(asset => (!folder || asset.folder_id === folder) && (!lead?.project_id || !asset.project_id || asset.project_id === lead.project_id));
  return <section><header className={styles.sectionTitle}><div><h2>Materiais para atendimento</h2><p>Selecione o lead e prepare o envio por WhatsApp ou e-mail.</p></div></header>
    <div className={styles.formGrid}><BrokerLeadSelect required leads={loaded.crm.records} value={leadId} onChange={setLeadId} disabled={busy} /><label>Pasta<select value={folder} onChange={event => setFolder(event.target.value)}><option value="">Todas as pastas</option>{loaded.crm.folders.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
    {lead && <p>Destinatário: {lead.person_name} · {lead.phone || "Sem telefone"} · {lead.email || "Sem e-mail"}</p>}
    {error && <p role="alert" className="feedback error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className={styles.cards}>{assets.map(asset => <article key={asset.id}><small>{asset.asset_type}</small><h3>{asset.name}</h3><p>{asset.description}</p><div className={styles.actions}>
      <button disabled={busy} onClick={() => void open(asset)}>Abrir material</button><button disabled={busy || !lead} onClick={() => void open(asset, "whatsapp")}>Enviar por WhatsApp</button><button disabled={busy || !lead} onClick={() => void open(asset, "email")}>Enviar por e-mail</button>
    </div></article>)}</div>{!assets.length && <p className={styles.empty}>Nenhum material disponível nesta seleção.</p>}
  </section>;
}
