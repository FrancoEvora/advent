"use client";
import {useEffect,useMemo,useState} from "react";
import {getSupabase} from "@/lib/supabase";
import type {AdminProps} from "../views-admin";
import type {PermissionMap,Role} from "../types";
import {permissionCatalog,rolePermissions} from "../access/permissions";
import {roleLabels} from "../utils";

export function AccessProfilesView({data,mutate}:{data:AdminProps["data"];mutate:AdminProps["mutate"]}){
  const [tab,setTab]=useState<"profiles"|"users">("profiles");
  const roles=useMemo(()=>data.rolePermissionProfiles.map(item=>item.role),[data.rolePermissionProfiles]);
  const [selectedRole,setSelectedRole]=useState<Role>((roles.find(role=>role!=="admin")||"diretoria") as Role);
  const [draft,setDraft]=useState<PermissionMap>({});
  const [selectedMember,setSelectedMember]=useState(data.members[0]?.id||"");
  const member=data.members.find(item=>item.id===selectedMember);
  useEffect(()=>{setDraft({...rolePermissions(data,selectedRole)})},[data,selectedRole]);
  const groups=[...new Set(permissionCatalog.map(item=>item.group))];
  const saveRole=()=>mutate(async()=>{const s=getSupabase();if(!s)throw new Error("Supabase indisponível");const row=data.rolePermissionProfiles.find(item=>item.role===selectedRole);if(!row)throw new Error("Perfil não encontrado");const r=await s.from("role_permission_profiles").update({permissions:draft,updated_by:data.session.user.id,updated_at:new Date().toISOString()}).eq("id",row.id);if(r.error)throw r.error},"Permissões do perfil atualizadas.");
  const setOverride=async(key:string,value:string)=>{if(!member)return;const next={...(member.permissions||{})};if(value==="inherit")delete next[key];else next[key]=value==="allow";await mutate(async()=>{const s=getSupabase();if(!s)throw new Error("Supabase indisponível");const r=await s.from("organization_members").update({permissions:next}).eq("id",member.id);if(r.error)throw r.error},"Exceção individual atualizada.")};
  return <div className="access-profiles-view stack">
    <section className="module-toolbar"><div><small>GOVERNANÇA DE ACESSOS</small><h2>Perfis e permissões</h2><p>Defina o padrão de cada função e, quando necessário, exceções individuais por usuário.</p></div></section>
    <nav className="module-tabs"><button className={tab==="profiles"?"active":""} onClick={()=>setTab("profiles")}>Perfis de acesso</button><button className={tab==="users"?"active":""} onClick={()=>setTab("users")}>Exceções por usuário</button></nav>
    {tab==="profiles"&&<section className="permission-layout"><aside className="permission-roles">{data.rolePermissionProfiles.map(profile=><button key={profile.role} className={selectedRole===profile.role?"active":""} onClick={()=>setSelectedRole(profile.role)}><strong>{profile.label||roleLabels[profile.role]}</strong><small>{profile.role==="admin"?"Acesso integral e não restringível":"Clique para configurar"}</small></button>)}</aside><article className="panel permission-matrix"><header><div><small>PERFIL SELECIONADO</small><h3>{roleLabels[selectedRole]}</h3></div><button className="primary" disabled={selectedRole==="admin"} onClick={saveRole}>Salvar permissões</button></header>{groups.map(group=><section key={group}><h4>{group}</h4><div>{permissionCatalog.filter(item=>item.group===group).map(item=><label key={item.key}><input type="checkbox" checked={selectedRole==="admin"||draft[item.key]===true} disabled={selectedRole==="admin"} onChange={e=>setDraft(current=>({...current,[item.key]:e.target.checked}))}/><span><strong>{item.label}</strong><small>{item.key}</small></span></label>)}</div></section>)}</article></section>}
    {tab==="users"&&<section className="panel individual-permissions"><header><div><small>EXCEÇÕES INDIVIDUAIS</small><h3>Permissões específicas do usuário</h3><p>“Herdar” utiliza o padrão do perfil selecionado no cadastro do usuário.</p></div><select value={selectedMember} onChange={e=>setSelectedMember(e.target.value)}>{data.members.map(item=>{const profile=data.profiles.find(p=>p.id===item.user_id);return <option key={item.id} value={item.id}>{profile?.full_name||profile?.email||item.user_id} · {roleLabels[item.role]}</option>})}</select></header>{member&&groups.map(group=><section key={group}><h4>{group}</h4><div className="individual-permission-grid">{permissionCatalog.filter(item=>item.group===group).map(item=>{const override=Object.prototype.hasOwnProperty.call(member.permissions||{},item.key)?(member.permissions[item.key]?"allow":"deny"):"inherit";return <label key={item.key}><span><strong>{item.label}</strong><small>Padrão do perfil: {rolePermissions(data,member.role)[item.key]?"permitido":"bloqueado"}</small></span><select value={override} onChange={e=>setOverride(item.key,e.target.value)} disabled={member.role==="admin"}><option value="inherit">Herdar do perfil</option><option value="allow">Permitir</option><option value="deny">Bloquear</option></select></label>})}</div></section>)}</section>}
  </div>
}
