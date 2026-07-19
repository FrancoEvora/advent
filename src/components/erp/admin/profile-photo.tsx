"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ErpData, Profile } from "../types";
import { initials } from "../utils";
import { PanelTitle } from "../views-dashboard";

function cleanName(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-80);
}

export function ProfileAvatar({ profile, organizationId, className = "" }: { profile?: Profile | null; organizationId: string; className?: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let active = true;
    const client = getSupabase();
    if (!client || !profile?.avatar_path) { setUrl(""); return; }
    client.storage.from("profile-photos").createSignedUrl(profile.avatar_path, 900).then(({ data }) => {
      if (active) setUrl(data?.signedUrl || "");
    });
    return () => { active = false; };
  }, [profile?.avatar_path, organizationId]);
  const label = profile?.full_name || profile?.email || "Usuário";
  return <span className={`profile-avatar ${className}`}>{url ? <img src={url} alt={label} /> : initials(label)}</span>;
}

export function ProfilePhotoModal({ data, profile, close, mutate }: { data: ErpData; profile: Profile; close: () => void; mutate: (operation: () => Promise<void>, success: string) => Promise<void> }) {
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const form = new FormData(event.currentTarget); const file = form.get("photo") as File;
    if (!file?.size) { setError("Selecione uma imagem."); return; }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { setError("Use JPG, PNG ou WEBP."); return; }
    if (file.size > 5 * 1024 * 1024) { setError("A imagem deve ter no máximo 5 MB."); return; }
    await mutate(async () => {
      const client = getSupabase(); if (!client) throw new Error("Supabase indisponível.");
      const path = `${data.organization.id}/${profile.id}/${crypto.randomUUID()}-${cleanName(file.name)}`;
      const upload = await client.storage.from("profile-photos").upload(path, file, { contentType: file.type, upsert: false });
      if (upload.error) throw new Error(upload.error.message);
      const update = await client.from("profiles").update({ avatar_path: path }).eq("id", profile.id);
      if (update.error) { await client.storage.from("profile-photos").remove([path]); throw new Error(update.error.message); }
      if (profile.avatar_path) await client.storage.from("profile-photos").remove([profile.avatar_path]);
    }, "Foto do perfil atualizada.");
    close();
  }
  return <div className="modal-backdrop" onMouseDown={close}><form className="modal" onSubmit={submit} onMouseDown={event => event.stopPropagation()}><PanelTitle eyebrow="IDENTIDADE DO USUÁRIO" title={profile.full_name || profile.email || "Foto de perfil"} /><button className="modal-close" type="button" onClick={close}>×</button><div className="profile-photo-editor"><ProfileAvatar profile={profile} organizationId={data.organization.id} className="large" /><label>Nova foto<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" required /></label><small>JPG, PNG ou WEBP, com até 5 MB.</small>{error && <div className="feedback error">{error}</div>}</div><footer><button type="button" onClick={close}>Cancelar</button><button className="primary">Salvar foto</button></footer></form></div>;
}