"use client";

import { useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { Membership, Profile, Role } from "../types";
import type { AdminProps } from "../views-admin";
import { roleLabels, shortDate } from "../utils";
import { Empty, PanelTitle } from "../views-dashboard";
import { InviteModal } from "./invite-modal";
import { PasswordModal } from "./password-modal";

export function UsersView({ data, mutate }: AdminProps) {
  const [invite, setInvite] = useState(false);
  const [credentialTarget, setCredentialTarget] = useState<{ member: Membership; profile?: Profile } | null>(null);
  const profileMap = new Map(data.profiles.map(profile => [profile.id, profile]));

  const update = async (id: string, payload: Record<string, unknown>, success: string) => mutate(async () => {
    const supabase = getSupabase(); if (!supabase) throw new Error("Supabase indisponível.");
    const { error } = await supabase.from("organization_members").update(payload).eq("id", id);
    if (error) throw new Error(error.message);
  }, success);

  return <div className="stack">
    <section className="module-toolbar"><div><small>CONTROLE DE ACESSO</small><h2>Equipe, perfis e credenciais</h2></div><button className="primary" onClick={() => setInvite(true)}>+ Convidar usuário</button></section>
    <section className="panel"><PanelTitle eyebrow="USUÁRIOS ATIVOS" title="Membros da organização" /><div className="users-list users-list-v3">{data.members.map(member => {
      const profile = profileMap.get(member.user_id);
      const isCurrent = member.user_id === data.session.user.id;
      return <article key={member.id}><span className="avatar-square">{(profile?.full_name || "US").slice(0, 2).toUpperCase()}</span><div><strong>{profile?.full_name || "Usuário cadastrado"}</strong><small>{profile?.email || (isCurrent ? data.session.user.email : "E-mail não disponível")} · {member.active ? "Acesso ativo" : "Acesso suspenso"}</small></div><select value={member.role} onChange={event => update(member.id, { role: event.target.value as Role }, "Perfil atualizado.")}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><div className="user-actions"><button onClick={() => setCredentialTarget({ member, profile })}>{isCurrent ? "Alterar minha senha" : "Redefinir acesso"}</button><button onClick={() => update(member.id, { active: !member.active }, member.active ? "Acesso suspenso." : "Acesso reativado.")}>{member.active ? "Suspender" : "Reativar"}</button></div></article>;
    })}</div></section>
    <section className="panel"><PanelTitle eyebrow="CONVITES" title="Acessos pendentes" /><div className="card-table">{data.invitations.map(item => <article key={item.id}><div className="avatar-square">✉</div><div><strong>{item.full_name || item.email}</strong><small>{item.email} · {roleLabels[item.role]}</small></div><span className={item.accepted_at ? "active-dot" : "inactive-dot"}>{item.accepted_at ? "Aceito" : "Pendente"}</span><div><small>Expira em {shortDate.format(new Date(item.expires_at))}</small></div></article>)}{!data.invitations.length && <Empty text="Nenhum convite enviado." />}</div></section>
    {invite && <InviteModal data={data} close={() => setInvite(false)} mutate={mutate} />}
    {credentialTarget && <PasswordModal data={data} member={credentialTarget.member} profile={credentialTarget.profile} close={() => setCredentialTarget(null)} mutate={mutate} />}
  </div>;
}
