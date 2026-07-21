"use client";
import { useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { Profile, Role } from "../types";
import type { AdminProps } from "../views-admin";
import { roleLabels, shortDate } from "../utils";
import { Empty, PanelTitle } from "../views-dashboard";
import { InviteModal } from "./invite-modal";
import { ProfileAvatar, ProfilePhotoModal } from "./profile-photo";
import { AccessProfilesView } from "./access-profiles-view";

export function UsersView({ data, mutate }: AdminProps) {
  const [tab,setTab]=useState<"users"|"permissions">("users");
  const [invite, setInvite] = useState(false); const [photo, setPhoto] = useState<Profile | null>(null); const profileMap = new Map(data.profiles.map(profile => [profile.id, profile]));
  const update = async (id: string, payload: Record<string, unknown>, success: string) => mutate(async () => { const supabase = getSupabase(); if (!supabase) throw new Error("Supabase indisponível."); const { error } = await supabase.from("organization_members").update(payload).eq("id", id); if (error) throw new Error(error.message); }, success);
  return <div className="stack"><section className="module-toolbar"><div><small>CONTROLE DE ACESSO</small><h2>Equipe, perfis e credenciais</h2><p>Administre usuários, papéis, permissões por módulo e exceções individuais.</p></div>{tab==="users"&&<button className="primary" onClick={() => setInvite(true)}>+ Convidar usuário</button>}</section>
  <nav className="module-tabs"><button className={tab==="users"?"active":""} onClick={()=>setTab("users")}>Usuários e convites</button><button className={tab==="permissions"?"active":""} onClick={()=>setTab("permissions")}>Perfis e permissões</button></nav>
  {tab==="permissions"?<AccessProfilesView data={data} mutate={mutate}/>:<>
  <section className="panel"><PanelTitle eyebrow="USUÁRIOS ATIVOS" title="Membros da organização" /><div className="users-list users-list-v3">{data.members.map(member => { const profile = profileMap.get(member.user_id); const isCurrent = member.user_id === data.session.user.id; return <article key={member.id}><ProfileAvatar profile={profile} organizationId={data.organization.id} /><div><strong>{profile?.full_name || "Usuário cadastrado"}</strong><small>{profile?.email || (isCurrent ? data.session.user.email : "E-mail não disponível")} · {member.active ? "Acesso ativo" : "Acesso suspenso"}</small></div><select value={member.role} onChange={event => update(member.id, { role: event.target.value as Role }, "Perfil atualizado.")}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><div className="user-actions">{profile && <button onClick={() => setPhoto(profile)}>Foto do perfil</button>}{isCurrent && <a className="button-link" href="/reset-password">Alterar minha senha</a>}<button onClick={() => update(member.id, { active: !member.active }, member.active ? "Acesso suspenso." : "Acesso reativado.")}>{member.active ? "Suspender" : "Reativar"}</button></div></article>; })}</div></section>
  <section className="panel"><PanelTitle eyebrow="POLÍTICA DE CREDENCIAIS" title="Segurança dos acessos" /><div className="security-policy-grid"><article><b>01</b><strong>Senha individual</strong><p>Cada usuário define e altera a própria credencial. A administração não visualiza senhas.</p></article><article><b>02</b><strong>Identidade visual</strong><p>Usuários podem ter foto de perfil armazenada de forma privada e visível apenas à equipe autorizada.</p></article><article><b>03</b><strong>Perfis e alçadas</strong><p>Permissões detalhadas por módulo e ação, com exceções individuais e acesso integral do administrador.</p></article></div></section>
  <section className="panel"><PanelTitle eyebrow="CONVITES" title="Acessos pendentes" /><div className="card-table">{data.invitations.map(item => <article key={item.id}><div className="avatar-square">✉</div><div><strong>{item.full_name || item.email}</strong><small>{item.email} · {roleLabels[item.role]}</small></div><span className={item.accepted_at ? "active-dot" : "inactive-dot"}>{item.accepted_at ? "Aceito" : "Pendente"}</span><div><small>Expira em {shortDate.format(new Date(item.expires_at))}</small></div></article>)}{!data.invitations.length && <Empty text="Nenhum convite enviado." />}</div></section>
  </>}
  {invite && <InviteModal data={data} close={() => setInvite(false)} mutate={mutate} />}{photo && <ProfilePhotoModal data={data} profile={photo} close={() => setPhoto(null)} mutate={mutate} />}</div>;
}
