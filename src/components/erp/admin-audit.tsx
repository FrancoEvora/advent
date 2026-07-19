"use client";
import type { ErpData } from "./types";
import { Empty, PanelTitle } from "./views-dashboard";
export function AuditView({data}:{data:ErpData}){return <section className="panel"><PanelTitle eyebrow="RASTREABILIDADE" title="Log de auditoria"/><div className="audit-list">{data.auditLogs.map(item=><article key={item.id}><span>{item.action}</span><div><strong>{item.entity}</strong><small>{item.entity_id||"—"}</small></div><time>{new Date(item.created_at).toLocaleString("pt-BR")}</time><small>Registro protegido</small></article>)}{!data.auditLogs.length&&<Empty text="Nenhum evento de auditoria disponível."/>}</div></section>}
