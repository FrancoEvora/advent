"use client";

import { useState } from "react";
import type { BrokerData } from "./load-broker-data";
import type { CrmRecord } from "../types";
import { date } from "./broker-format";
import styles from "./broker-workspace.module.css";

export const personallyAssigned = (lead: CrmRecord, userId: string) => lead.broker_user_id === userId || (!lead.broker_user_id && lead.owner_user_id === userId);

export function BrokerLeads({ loaded, openLead, activity, proposal }: { loaded: BrokerData; openLead: (id: string) => void; activity: (id: string) => void; proposal: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("aberta");
  const [temperature, setTemperature] = useState("");
  const [scope, setScope] = useState("");
  const [sort, setSort] = useState("newest");
  const actor = loaded.data.session.user.id;
  const rows = loaded.crm.records.filter(lead => `${lead.person_name} ${lead.company_name || ""} ${lead.phone || ""} ${lead.email || ""}`.toLocaleLowerCase("pt-BR").includes(query.toLocaleLowerCase("pt-BR")) && (!status || lead.record_status === status) && (!temperature || lead.temperature === temperature) && (!scope || personallyAssigned(lead, actor))).sort((a, b) => sort === "name" ? a.person_name.localeCompare(b.person_name, "pt-BR") : sort === "score" ? (b.lead_score || 0) - (a.lead_score || 0) : sort === "next" ? (Date.parse(a.next_action_at || "") || Infinity) - (Date.parse(b.next_action_at || "") || Infinity) : (sort === "oldest" ? 1 : -1) * (Date.parse(a.originated_at || a.created_at) - Date.parse(b.originated_at || b.created_at)));
  const name = (id?: string | null) => loaded.commerce.responsibles.find(row => row.id === id)?.full_name || "Não atribuído";
  return <section>
    <div className={styles.sectionTitle}><div><small>CARTEIRA COMERCIAL</small><h2>Leads e clientes potenciais</h2><p>Seus atendimentos e os leads designados à sua imobiliária.</p></div></div>
    <div className={styles.filters}><input aria-label="Buscar na minha carteira" placeholder="Buscar por nome, empresa, telefone ou e-mail" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="Situação dos leads" value={status} onChange={e => setStatus(e.target.value)}><option value="aberta">Em aberto</option><option value="ganha">Ganhos</option><option value="perdida">Perdidos</option><option value="">Todos da carteira</option></select><select aria-label="Temperatura" value={temperature} onChange={e => setTemperature(e.target.value)}><option value="">Todas as temperaturas</option><option value="frio">Frio</option><option value="morno">Morno</option><option value="quente">Quente</option></select><select aria-label="Carteira" value={scope} onChange={e => setScope(e.target.value)}><option value="">Minha carteira e imobiliária</option><option value="mine">Somente meus leads</option></select><select aria-label="Ordenação" value={sort} onChange={e => setSort(e.target.value)}><option value="newest">Cadastro: mais recentes</option><option value="oldest">Cadastro: mais antigos</option><option value="name">Nome</option><option value="score">Maior score</option><option value="next">Próxima ação</option></select><span>{rows.length} registros</span></div>
    <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Lead</th><th>Empreendimento</th><th>Cadastro</th><th>Score</th><th>Responsáveis</th><th>Próxima ação</th><th>Ações</th></tr></thead><tbody>{rows.map(lead => <tr key={lead.id}>
      <td><button className={styles.leadName} onClick={() => openLead(lead.id)}>{lead.person_name}</button><small>{lead.phone || lead.email || "Contato não informado"}</small><div className={styles.tags}>{lead.tags?.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}</div></td>
      <td><strong>{loaded.data.projects.find(row => row.id === lead.project_id)?.name || "A definir"}</strong><small>{lead.source || lead.source_channel || ""}</small></td><td>{date(lead.originated_at || lead.created_at)}</td>
      <td><strong className={styles.score}>{lead.lead_score || 0}</strong><span className={styles.badge} data-temperature={lead.temperature}>{lead.temperature || "Sem classificação"}</span></td>
      <td><small>SDR: {name(lead.sdr_user_id)}</small><small>Corretor: {name(lead.broker_user_id)}</small></td><td>{date(lead.next_action_at)}<small>{lead.sla_due_at ? `Prazo ${date(lead.sla_due_at)}` : ""}</small></td>
      <td><div className={styles.actions}><button onClick={() => openLead(lead.id)}>Atendimento e Bia</button><button onClick={() => activity(lead.id)}>Atividade</button>{lead.record_status === "aberta" && <button onClick={() => proposal(lead.id)}>Proposta / reserva</button>}</div></td>
    </tr>)}</tbody></table></div>{!rows.length && <div className={styles.empty}>Nenhum atendimento corresponde aos filtros.</div>}
  </section>;
}

export function BrokerFunnel({ loaded, openLead, move, busy }: { loaded: BrokerData; openLead: (id: string) => void; move: (id: string, stage: string) => Promise<void>; busy: boolean }) {
  const [pipelineId, setPipelineId] = useState(loaded.crm.pipelines.find(row => row.is_default)?.id || loaded.crm.pipelines[0]?.id || "");
  const stages = loaded.crm.stages.filter(stage => stage.pipeline_id === pipelineId);
  const rows = loaded.crm.records.filter(lead => personallyAssigned(lead, loaded.data.session.user.id) && (!lead.pipeline_id || lead.pipeline_id === pipelineId));
  const unmatched = rows.filter(lead => !stages.some(stage => stage.id === lead.stage_id || stage.code === lead.stage));
  function card(lead: CrmRecord) {
    return <article key={lead.id}><button className={styles.leadName} onClick={() => openLead(lead.id)}>{lead.person_name}</button><small>{lead.phone}</small><p>Próxima ação: {date(lead.next_action_at)}</p><span className={styles.badge}>{lead.temperature || "Sem classificação"}</span>{lead.record_status === "aberta" && <select aria-label={`Etapa de ${lead.person_name}`} disabled={busy} value={stages.find(stage => stage.id === lead.stage_id || stage.code === lead.stage)?.id || ""} onChange={e => void move(lead.id, e.target.value)}><option value="" disabled>Selecionar etapa</option>{stages.filter(stage => !stage.is_won && !stage.is_lost).map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select>}</article>;
  }
  return <section><div className={styles.sectionTitle}><div><small>ACOMPANHAMENTO INDIVIDUAL</small><h2>Meu funil de vendas</h2><p>{rows.length} oportunidades sob sua responsabilidade.</p></div><select aria-label="Funil" value={pipelineId} onChange={e => setPipelineId(e.target.value)}>{loaded.crm.pipelines.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></div><div className={styles.funnel}>{unmatched.length > 0 && <section><h3>A classificar <span>{unmatched.length}</span></h3>{unmatched.map(card)}</section>}{stages.map(stage => { const items = rows.filter(lead => lead.stage_id === stage.id || (!lead.stage_id && lead.stage === stage.code)); return <section key={stage.id}><h3>{stage.name} <span>{items.length}</span></h3>{items.map(card)}{!items.length && <p className={styles.muted}>Nenhuma oportunidade</p>}</section>; })}</div></section>;
}
