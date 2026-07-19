"use client";

import type { ReactNode } from "react";
import type { ErpData, Profile } from "../types";
import { initials, money } from "../utils";

export function CrmSectionHeader({eyebrow,title,description,actions}:{eyebrow:string;title:string;description?:string;actions?:ReactNode}){return <header className="crm5-section-header"><div><small>{eyebrow}</small><h2>{title}</h2>{description&&<p>{description}</p>}</div>{actions&&<div>{actions}</div>}</header>}
export function CrmKpi({label,value,detail,tone="blue"}:{label:string;value:string|number;detail:string;tone?:string}){return <article className={`crm5-kpi ${tone}`}><small>{label}</small><strong>{typeof value==="number"?value.toLocaleString("pt-BR"):value}</strong><span>{detail}</span></article>}
export function Currency({value}:{value:number}){return <>{money.format(Number(value||0))}</>}
export function UserName({id,data}:{id:string|null|undefined;data:ErpData}){const profile=data.profiles.find(item=>item.id===id);return <>{profile?.full_name||profile?.email||"Não atribuído"}</>}
export function UserAvatar({profile,size="normal"}:{profile?:Profile;size?:"normal"|"small"}){return <span className={`crm5-avatar ${size}`}>{profile?.avatar_path?<img src={profile.avatar_path} alt=""/>:initials(profile?.full_name||profile?.email||"US")}</span>}
export function EmptyState({title,text}:{title:string;text:string}){return <div className="crm5-empty"><b>◇</b><strong>{title}</strong><span>{text}</span></div>}
export function Status({children,tone="neutral"}:{children:ReactNode;tone?:string}){return <span className={`crm5-status ${tone}`}>{children}</span>}
