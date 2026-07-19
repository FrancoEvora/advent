"use client";

import { useMemo, useState } from "react";
import type { ErpData } from "../types";
import { downloadCsv } from "../utils";
import { Empty, PanelTitle } from "../views-dashboard";

const actionLabels: Record<string, string> = { INSERT: "Criação", UPDATE: "Alteração", DELETE: "Exclusão" };
const entityLabels: Record<string, string> = { financial_entries: "Lançamento financeiro", cost_centers: "Centro de custo", revenue_centers: "Centro de recebimento", contacts: "Cliente/fornecedor", financial_categories: "Categoria financeira", bank_accounts: "Conta financeira", projects: "Empreendimento", organization_members: "Usuário e acesso", system_settings: "Configuração", approval_requests: "Aprovação" };

export function AuditView({ data }: { data: ErpData }) {
  const [action, setAction] = useState("todos");
  const [entity, setEntity] = useState("todos");
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const profileMap = new Map(data.profiles.map(profile => [profile.id, profile]));
  const filtered = useMemo(() => data.auditLogs.filter(item => (action === "todos" || item.action === action) && (entity === "todos" || item.entity === entity) && (!from || item.created_at.slice(0, 10) >= from) && (!to || item.created_at.slice(0, 10) <= to) && `${item.entity} ${item.entity_id || ""}`.toLowerCase().includes(query.toLowerCase())), [data.auditLogs, action, entity, from, to, query]);

  function exportAudit() {
    downloadCsv("evora-auditoria.csv", ["Data", "Usuário", "Ação", "Entidade", "Registro"], filtered.map(item => [item.created_at, profileMap.get(item.user_id || "")?.full_name, actionLabels[item.action] || item.action, entityLabels[item.entity] || item.entity, item.entity_id]));
  }

  return <div className="stack"><section className="module-toolbar"><div><small>RASTREABILIDADE E COMPLIANCE</small><h2>Auditoria corporativa</h2></div><button onClick={exportAudit}>Exportar log</button></section><section className="audit-filters"><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar entidade ou registro" /><select value={action} onChange={event => setAction(event.target.value)}><option value="todos">Todas as ações</option>{[...new Set(data.auditLogs.map(item => item.action))].map(item => <option key={item} value={item}>{actionLabels[item] || item}</option>)}</select><select value={entity} onChange={event => setEntity(event.target.value)}><option value="todos">Todas as entidades</option>{[...new Set(data.auditLogs.map(item => item.entity))].map(item => <option key={item} value={item}>{entityLabels[item] || item}</option>)}</select><input type="date" value={from} onChange={event => setFrom(event.target.value)} /><input type="date" value={to} onChange={event => setTo(event.target.value)} /><span>{filtered.length} eventos</span></section><section className="panel"><PanelTitle eyebrow="LOG PROTEGIDO" title="Histórico de alterações" /><div className="audit-list audit-list-v3">{filtered.map(item => <article key={item.id}><span>{actionLabels[item.action] || item.action}</span><div><strong>{entityLabels[item.entity] || item.entity}</strong><small>{item.entity_id || "Registro sem identificador"}</small></div><time>{new Date(item.created_at).toLocaleString("pt-BR")}</time><small>{profileMap.get(item.user_id || "")?.full_name || "Sistema"}</small></article>)}{!filtered.length && <Empty text="Nenhum evento encontrado." />}</div></section></div>;
}
