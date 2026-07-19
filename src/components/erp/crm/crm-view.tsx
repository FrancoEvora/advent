"use client";

import { useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { CrmRecord, ErpData } from "../types";
import { dateAtNoon, money, shortDate } from "../utils";
import { Empty, Kpi, PanelTitle } from "../views-dashboard";
import { CrmActionModal } from "./crm-action-modal";
import { CrmRecordModal, crmStages } from "./crm-record-modal";

const stageLabels = Object.fromEntries(crmStages);

export function CrmView({ data, mutate }: { data: ErpData; mutate: (operation: () => Promise<void>, success: string) => Promise<void> }) {
  const [recordModal, setRecordModal] = useState<CrmRecord | "new" | null>(null);
  const [actionRecord, setActionRecord] = useState<CrmRecord | null | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("todos");
  const records = useMemo(() => data.crmRecords.filter(item => {
    const projectMatch = project === "todos" || item.project_id === project;
    const text = `${item.person_name} ${item.company_name || ""} ${item.email || ""} ${item.phone || ""}`.toLowerCase();
    return projectMatch && text.includes(query.toLowerCase());
  }), [data.crmRecords, project, query]);
  const openRecords = records.filter(item => item.record_status === "aberta");
  const openValue = openRecords.reduce((sum, item) => sum + Number(item.estimated_value || 0), 0);
  const weighted = openRecords.reduce((sum, item) => sum + Number(item.estimated_value || 0) * Number(item.probability || 0) / 100, 0);
  const won = records.filter(item => item.record_status === "ganha").reduce((sum, item) => sum + Number(item.estimated_value || 0), 0);
  const now = Date.now();
  const pendingActions = data.crmActions.filter(action => action.action_status === "pendente");
  const overdueActions = pendingActions.filter(action => action.scheduled_at && new Date(action.scheduled_at).getTime() < now);
  const upcomingActions = pendingActions.slice().sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at))).slice(0, 10);

  async function move(record: CrmRecord, stage: CrmRecord["stage"]) {
    await mutate(async () => {
      const client = getSupabase(); if (!client) throw new Error("Supabase indisponível.");
      const result = await client.from("crm_records").update({ stage, record_status: stage === "ganho" ? "ganha" : stage === "perdido" ? "perdida" : "aberta", updated_at: new Date().toISOString() }).eq("id", record.id);
      if (result.error) throw new Error(result.error.message);
    }, `Oportunidade movida para ${stageLabels[stage]}.`);
  }

  async function completeAction(id: string) {
    await mutate(async () => {
      const client = getSupabase(); if (!client) throw new Error("Supabase indisponível.");
      const result = await client.from("crm_actions").update({ action_status: "concluida", completed_at: new Date().toISOString() }).eq("id", id);
      if (result.error) throw new Error(result.error.message);
    }, "Atividade concluída.");
  }

  async function convertToClient(record: CrmRecord) {
    if (record.contact_id) return;
    await mutate(async () => {
      const client = getSupabase(); if (!client) throw new Error("Supabase indisponível.");
      const created = await client.from("contacts").insert({ organization_id: data.organization.id, contact_type: "cliente", name: record.company_name || record.person_name, trade_name: record.company_name || null, email: record.email, phone: record.phone, notes: `Convertido do CRM: ${record.person_name}`, active: true }).select("id").single();
      if (created.error) throw new Error(created.error.message);
      const updated = await client.from("crm_records").update({ contact_id: created.data.id, updated_at: new Date().toISOString() }).eq("id", record.id);
      if (updated.error) throw new Error(updated.error.message);
    }, "Lead convertido em cliente.");
  }

  return <div className="stack crm-module">
    <section className="module-toolbar"><div><small>GESTÃO COMERCIAL</small><h2>CRM e pipeline de oportunidades</h2></div><div className="toolbar-actions"><button onClick={() => setActionRecord(null)}>+ Atividade</button><button className="primary" onClick={() => setRecordModal("new")}>+ Nova oportunidade</button></div></section>
    <section className="kpi-grid four"><Kpi label="Pipeline aberto" value={money.format(openValue)} detail={`${openRecords.length} oportunidades`} tone="positive" /><Kpi label="Previsão ponderada" value={money.format(weighted)} detail="Valor × probabilidade" tone="gold" /><Kpi label="Fechados ganhos" value={money.format(won)} detail="Negócios convertidos" tone="positive" /><Kpi label="Ações vencidas" value={String(overdueActions.length)} detail={`${pendingActions.length} atividades pendentes`} tone={overdueActions.length ? "danger" : "gold"} /></section>
    <section className="filters crm-filters"><div className="search"><span>⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar lead, empresa, e-mail ou telefone" /></div><select value={project} onChange={event => setProject(event.target.value)}><option value="todos">Todos os empreendimentos</option>{data.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><span>{records.length} oportunidades</span></section>
    <section className="crm-pipeline">{crmStages.map(([stage, label]) => {
      const stageRecords = records.filter(item => item.stage === stage);
      const stageValue = stageRecords.reduce((sum, item) => sum + Number(item.estimated_value || 0), 0);
      return <article className={`crm-column ${stage}`} key={stage}><header><div><small>{label}</small><strong>{stageRecords.length}</strong></div><span>{money.format(stageValue)}</span></header><div>{stageRecords.map(record => <div className="crm-card" key={record.id}><div><strong>{record.person_name}</strong><small>{record.company_name || data.projects.find(item => item.id === record.project_id)?.name || "Sem empresa"}</small></div><b>{money.format(Number(record.estimated_value || 0))}</b><dl><div><dt>Probabilidade</dt><dd>{record.probability}%</dd></div><div><dt>Próxima ação</dt><dd>{record.next_action_at ? new Date(record.next_action_at).toLocaleDateString("pt-BR") : "Não definida"}</dd></div></dl><select value={record.stage} onChange={event => move(record, event.target.value as CrmRecord["stage"])}>{crmStages.map(([value, stageLabel]) => <option key={value} value={value}>{stageLabel}</option>)}</select><footer><button onClick={() => setRecordModal(record)}>Editar</button><button onClick={() => setActionRecord(record)}>Atividade</button>{record.stage === "ganho" && !record.contact_id && <button onClick={() => convertToClient(record)}>Converter</button>}</footer></div>)}{!stageRecords.length && <div className="crm-empty">Sem oportunidades</div>}</div></article>;
    })}</section>
    <section className="panel"><PanelTitle eyebrow="AGENDA COMERCIAL" title="Próximas atividades" /><div className="crm-activity-list">{upcomingActions.map(action => {
      const record = data.crmRecords.find(item => item.id === action.crm_record_id);
      const late = Boolean(action.scheduled_at && new Date(action.scheduled_at).getTime() < now);
      return <article key={action.id} className={late ? "late" : ""}><span>{action.action_type}</span><div><strong>{action.subject}</strong><small>{record?.person_name || "Oportunidade"} · {record?.company_name || data.projects.find(item => item.id === record?.project_id)?.name || "CRM"}</small></div><time>{action.scheduled_at ? shortDate.format(dateAtNoon(action.scheduled_at.slice(0, 10))) : "Sem data"}</time><button onClick={() => completeAction(action.id)}>Concluir</button></article>;
    })}{!upcomingActions.length && <Empty text="Nenhuma atividade comercial pendente." />}</div></section>
    {recordModal && <CrmRecordModal data={data} record={recordModal === "new" ? null : recordModal} mutate={mutate} close={() => setRecordModal(null)} />}
    {actionRecord !== undefined && <CrmActionModal data={data} record={actionRecord} mutate={mutate} close={() => setActionRecord(undefined)} />}
  </div>;
}