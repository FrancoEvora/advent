"use client";

import { FormEvent, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ErpData, Role } from "../types";
import { roleLabels } from "../utils";
import type { CrmEnterpriseData, CrmTeam } from "./types";
import { CrmSectionHeader, EmptyState, Status, UserName } from "./shared";

export function TeamsView({ data, crm, reload }: { data: ErpData; crm: CrmEnterpriseData; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState<CrmTeam | "new" | null>(null);
  async function updateRole(id: string, role: Role) {
    const client = getSupabase(); if (!client) return;
    const result = await client.from("organization_members").update({ role, updated_at: new Date().toISOString() }).eq("id", id);
    if (result.error) throw result.error; location.reload();
  }
  return <div className="crm5-stack">
    <CrmSectionHeader eyebrow="ESTRUTURA COMERCIAL" title="Equipes, SDRs e permissões" description="Papéis específicos, capacidade, distribuição e acesso por função." actions={<button className="primary" onClick={() => setEditing("new")}>+ Nova equipe</button>} />
    <section className="crm5-team-grid">
      {crm.teams.map((team) => {
        const members = crm.teamMembers.filter((member) => member.team_id === team.id && member.active);
        return <article key={team.id}>
          <header><div><small>{team.team_type}</small><h3>{team.name}</h3></div><Status tone={team.active ? "success" : "neutral"}>{team.active ? "ativa" : "inativa"}</Status></header>
          <p>Distribuição: {team.assignment_strategy}</p>
          <div>{members.map((member) => <span key={member.id}><UserName id={member.user_id} data={data} /><small>{member.team_role} · capacidade {member.capacity}</small></span>)}{!members.length && <small>Nenhum membro associado.</small>}</div>
          <footer><button onClick={() => setEditing(team)}>Gerenciar equipe</button></footer>
        </article>;
      })}
      {!crm.teams.length && <EmptyState title="Nenhuma equipe" text="Crie equipes de SDR, corretores e marketing." />}
    </section>
    <section className="crm5-panel"><header><div><small>USUÁRIOS</small><h3>Perfis e autorizações do CRM</h3></div></header><div className="crm5-permissions">{data.members.map((member) => { const profile = data.profiles.find((item) => item.id === member.user_id); return <article key={member.id}><div><strong>{profile?.full_name || "Usuário"}</strong><small>{profile?.email || member.user_id}</small></div><select value={member.role} onChange={(event) => updateRole(member.id, event.target.value as Role)}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><div><Permission label="Ver CRM" active={!['engenharia', 'compras'].includes(member.role)} /><Permission label="Editar leads" active={['admin', 'diretoria', 'gestor_crm', 'sdr', 'corretor', 'comercial'].includes(member.role)} /><Permission label="Campanhas" active={['admin', 'diretoria', 'gestor_crm', 'marketing'].includes(member.role)} /><Permission label="Automações" active={['admin', 'diretoria', 'gestor_crm'].includes(member.role)} /></div></article>; })}</div></section>
    {editing && <TeamModal data={data} crm={crm} team={editing === "new" ? null : editing} close={() => setEditing(null)} reload={reload} />}
  </div>;
}

function Permission({ label, active }: { label: string; active: boolean }) { return <span className={active ? "yes" : "no"}>{active ? "✓" : "—"} {label}</span>; }

function TeamModal({ data, crm, team, close, reload }: { data: ErpData; crm: CrmEnterpriseData; team: CrmTeam | null; close: () => void; reload: () => Promise<void> }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const client = getSupabase(); if (!client) return; let teamId = team?.id;
    const payload = { organization_id: data.organization.id, name: String(form.get("name")), team_type: String(form.get("team_type")), manager_user_id: String(form.get("manager_user_id") || "") || null, assignment_strategy: String(form.get("assignment_strategy")), active: true, updated_at: new Date().toISOString() };
    if (team) { const result = await client.from("crm_teams").update(payload).eq("id", team.id); if (result.error) throw result.error; }
    else { const result = await client.from("crm_teams").insert(payload).select("id").single(); if (result.error) throw result.error; teamId = result.data.id; }
    const selected = form.getAll("members").map(String);
    if (teamId) {
      await client.from("crm_team_members").delete().eq("team_id", teamId);
      if (selected.length) {
        const rows = selected.map((user_id) => ({ organization_id: data.organization.id, team_id: teamId, user_id, team_role: String(form.get("team_type")) === "sdr" ? "sdr" : "membro", capacity: 50, active: true }));
        const result = await client.from("crm_team_members").insert(rows); if (result.error) throw result.error;
      }
    }
    await reload(); close();
  }
  const current = new Set(crm.teamMembers.filter((member) => member.team_id === team?.id).map((member) => member.user_id));
  return <div className="modal-backdrop" onMouseDown={close}><form className="modal crm5-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" type="button" onClick={close}>×</button><header><small>EQUIPE</small><h2>{team?.name || "Nova equipe comercial"}</h2></header><div className="form-grid"><label className="span-2">Nome<input name="name" defaultValue={team?.name || ""} required /></label><label>Tipo<select name="team_type" defaultValue={team?.team_type || "sdr"}><option value="sdr">SDR / Pré-vendas</option><option value="corretores">Corretores</option><option value="marketing">Marketing</option><option value="gestao">Gestão comercial</option></select></label><label>Distribuição<select name="assignment_strategy" defaultValue={team?.assignment_strategy || "round_robin"}><option value="round_robin">Round robin</option><option value="menor_carteira">Menor carteira</option><option value="manual">Manual</option><option value="ponderada">Ponderada</option></select></label><label className="span-2">Gestor<select name="manager_user_id" defaultValue={team?.manager_user_id || ""}><option value="">Não definido</option>{data.members.map((member) => <option key={member.user_id} value={member.user_id}>{data.profiles.find((profile) => profile.id === member.user_id)?.full_name || member.role}</option>)}</select></label><fieldset className="span-2 crm5-member-select"><legend>Membros</legend>{data.members.map((member) => <label key={member.user_id}><input type="checkbox" name="members" value={member.user_id} defaultChecked={current.has(member.user_id)} /><span>{data.profiles.find((profile) => profile.id === member.user_id)?.full_name || member.role}<small>{roleLabels[member.role]}</small></span></label>)}</fieldset></div><footer><button type="button" onClick={close}>Cancelar</button><button className="primary">Salvar equipe</button></footer></form></div>;
}
