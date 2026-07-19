"use client";

import { FormEvent } from "react";
import { getSupabase } from "@/lib/supabase";
import type { AdminProps } from "../views-admin";
import { roleLabels } from "../utils";
import { PanelTitle } from "../views-dashboard";

export function InviteModal({ data, close, mutate }: AdminProps & { close: () => void }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await mutate(async () => {
      const supabase = getSupabase(); if (!supabase) throw new Error("Supabase indisponível.");
      const { error } = await supabase.from("user_invitations").upsert({ organization_id: data.organization.id, email: String(form.get("email")).toLowerCase(), full_name: form.get("full_name"), role: form.get("role"), invited_by: data.session.user.id, accepted_at: null, expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString() }, { onConflict: "organization_id,email" });
      if (error) throw new Error(error.message);
    }, "Convite registrado.");
    close();
  }
  return <div className="modal-backdrop" onMouseDown={close}><form className="modal" onSubmit={submit} onMouseDown={event => event.stopPropagation()}><PanelTitle eyebrow="NOVO ACESSO" title="Convidar usuário" /><button className="modal-close" type="button" onClick={close}>×</button><div className="form-grid"><label className="span-2">Nome completo<input name="full_name" required /></label><label className="span-2">E-mail<input name="email" type="email" required /></label><label className="span-2">Perfil<select name="role" defaultValue="consulta">{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><div className="info-box">O convite será vinculado ao e-mail informado e ficará pendente até a criação da conta.</div><footer><button type="button" onClick={close}>Cancelar</button><button className="primary">Registrar convite</button></footer></form></div>;
}
