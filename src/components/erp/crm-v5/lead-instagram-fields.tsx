"use client";
import {useState} from "react";
import {normalizeInstagram} from "@/lib/forms/solaris";
import type {CrmRecord} from "../types";

type InstagramRecord = CrmRecord & {
  instagram_username?: string | null;
  instagram_consent?: boolean;
  instagram_consent_at?: string | null;
  instagram_consent_version?: string | null;
  instagram_source?: string | null;
};

/** Manual edits never grant consent; replacing a handle invalidates previous authorization. */
export function buildInstagramPayload(form: FormData, record: CrmRecord | null): Record<string, unknown> {
  const lead = record as InstagramRecord | null;
  const raw = String(form.get("instagramUsername") || "").trim();
  const username = normalizeInstagram(raw);
  if (raw && !username) throw new Error("Instagram inválido. Informe o @ ou o link de um perfil, ou deixe o campo em branco.");
  const changed = username !== (lead?.instagram_username || null);
  const revoked = form.get("instagramRevokeConsent") === "yes";
  if (!changed && !revoked) return {};
  return {
    instagram_username: username,
    instagram_consent: false,
    instagram_consent_at: null,
    instagram_consent_version: null,
    ...(changed ? {instagram_source: username ? "crm_manual" : null} : {}),
  };
}

export function LeadInstagramFields({lead: record}: {lead: CrmRecord | null}) {
  const lead = record as InstagramRecord | null;
  const [value, setValue] = useState(lead?.instagram_username || "");
  const [revoke, setRevoke] = useState(false);
  const username = normalizeInstagram(value);
  const changed = username !== (lead?.instagram_username || null);
  const authorized = !!lead?.instagram_consent && !changed && !revoke;
  const consentDate = lead?.instagram_consent_at ? new Date(lead.instagram_consent_at) : null;
  const timestamp = consentDate && !Number.isNaN(consentDate.getTime())
    ? consentDate.toLocaleString("pt-BR", {timeZone: "America/Sao_Paulo"}) : null;
  return <section className="buyer-form-section" aria-labelledby="lead-instagram-title">
    <h3 id="lead-instagram-title">Instagram e personalização do atendimento</h3>
    <label>Instagram (opcional)
      <input name="instagramUsername" value={value} onChange={event => setValue(event.target.value)} placeholder="@seuperfil ou link do perfil" maxLength={200} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby="lead-instagram-note" />
    </label>
    {username && <p><a href={`https://www.instagram.com/${username}/`} target="_blank" rel="noopener noreferrer">Abrir perfil informado: @{username} ↗</a></p>}
    <p role="status"><strong>{authorized ? "Personalização autorizada pelo lead" : username ? "Sem autorização para personalização pelo Instagram" : "Instagram não informado"}</strong></p>
    {authorized && <p>{timestamp ? `Autorização registrada em ${timestamp} (Brasília). ` : ""}{lead?.instagram_consent_version ? `Termo: ${lead.instagram_consent_version}.` : ""}</p>}
    {lead?.instagram_source && <p>Origem do perfil: {lead.instagram_source === "solaris_landing_page" ? "formulário da landing page do Solaris" : "cadastro manual no CRM"}.</p>}
    {lead?.instagram_consent && <label style={{display:"flex",alignItems:"flex-start",gap:8}}><input style={{width:18,height:18,flex:"0 0 18px"}} type="checkbox" name="instagramRevokeConsent" value="yes" checked={revoke} onChange={event => setRevoke(event.target.checked)} /><span>Retirar autorização de personalização ao salvar o cadastro.</span></label>}
    <p id="lead-instagram-note" style={{fontSize:12,lineHeight:1.6}}>Perfil fornecido, não verificado. Cadastrar ou alterar o @ não autoriza análise e não conecta a conta. Alterar o perfil remove a autorização anterior. O atendimento continua normalmente sem Instagram; não há leitura automática de publicações neste recurso.</p>
  </section>;
}
