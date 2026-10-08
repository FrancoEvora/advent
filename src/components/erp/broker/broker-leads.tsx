"use client";

import { useState } from "react";
import { APPROVED_PROPOSALS_COLUMN, buildBrokerFunnel, normalizeBrokerSearch, personallyAssigned } from "@/lib/broker-funnel";
import type { BrokerData } from "./load-broker-data";
import { date } from "./broker-format";
import styles from "./broker-workspace.module.css";

export function BrokerLeads({ loaded, openLead, activity, proposal }: { loaded: BrokerData; openLead: (id: string) => void; activity: (id: string) => void; proposal: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("aberta");
  const [temperature, setTemperature] = useState("");
  const [scope, setScope] = useState("");
  const [sort, setSort] = useState("newest");
  const actor = loaded.data.session.user.id;
  const rows = loaded.crm.records.filter(lead => normalizeBrokerSearch(`${lead.person_name} ${lead.company_name || ""} ${lead.phone || ""} ${lead.email || ""}`).includes(normalizeBrokerSearch(query)) && (!status || lead.record_status === status) && (!temperature || lead.temperature === temperature) && (!scope || personallyAssigned(lead, actor))).sort((a, b) => sort === "name" ? a.person_name.localeCompare(b.person_name, "pt-BR") : sort === "score" ? (b.lead_score || 0) - (a.lead_score || 0) : sort === "next" ? (Date.parse(a.next_action_at || "") || Infinity) - (Date.parse(b.next_action_at || "") || Infinity) : (sort === "oldest" ? 1 : -1) * (Date.parse(a.originated_at || a.created_at) - Date.parse(b.originated_at || b.created_at)));
  const name = (id?: string | null) => loaded.commerce.responsibles.find(row => row.id === id)?.full_name || "Não atribuído";
  return <section>
    <div className={styles.sectionTitle}><div><small>CARTEIRA COMERCIAL</small><h2>Leads e clientes potenciais</h2><p>Seus atendimentos e os leads designados à sua imobiliária.</p></div></div>
    <div className={styles.filters}><label className={styles.searchField}>Buscar por nome<input type="search" placeholder="Digite o nome do lead, telefone ou e-mail" value={query} onChange={e => setQuery(e.target.value)} /></label><select aria-label="Situação dos leads" value={status} onChange={e => setStatus(e.target.value)}><option value="aberta">Em aberto</option><option value="ganha">Ganhos</option><option value="perdida">Perdidos</option><option value="">Todos da carteira</option></select><select aria-label="Temperatura" value={temperature} onChange={e => setTemperature(e.target.value)}><option value="">Todas as temperaturas</option><option value="frio">Frio</option><option value="morno">Morno</option><option value="quente">Quente</option></select><select aria-label="Carteira" value={scope} onChange={e => setScope(e.target.value)}><option value="">Minha carteira e imobiliária</option><option value="mine">Somente meus leads</option></select><select aria-label="Ordenação" value={sort} onChange={e => setSort(e.target.value)}><option value="newest">Cadastro: mais recentes</option><option value="oldest">Cadastro: mais antigos</option><option value="name">Nome</option><option value="score">Maior score</option><option value="next">Próxima ação</option></select><span>{rows.length} registros</span></div>
    <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Lead</th><th>Empreendimento</th><th>Cadastro</th><th>Score</th><th>Responsáveis</th><th>Próxima ação</th><th>Ações</th></tr></thead><tbody>{rows.map(lead => <tr key={lead.id}>
      <td><button className={styles.leadName} onClick={() => openLead(lead.id)}>{lead.person_name}</button><small>{lead.phone || lead.email || "Contato não informado"}</small><div className={styles.tags}>{lead.tags?.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}</div></td>
      <td><strong>{loaded.data.projects.find(row => row.id === lead.project_id)?.name || "A definir"}</strong><small>{lead.source || lead.source_channel || ""}</small></td><td>{date(lead.originated_at || lead.created_at)}</td>
      <td><strong className={styles.score}>{lead.lead_score || 0}</strong><span className={styles.badge} data-temperature={lead.temperature}>{lead.temperature || "Sem classificação"}</span></td>
      <td><small>SDR: {name(lead.sdr_user_id)}</small><small>Corretor: {name(lead.broker_user_id)}</small></td><td>{date(lead.next_action_at)}<small>{lead.sla_due_at ? `Prazo ${date(lead.sla_due_at)}` : ""}</small></td>
      <td><div className={styles.actions}><button onClick={() => openLead(lead.id)}>Insights IA</button><button onClick={() => activity(lead.id)}>Atividade</button>{lead.record_status === "aberta" && <button onClick={() => proposal(lead.id)}>Encaminhar proposta</button>}</div></td>
    </tr>)}</tbody></table></div>{!rows.length && <div className={styles.empty}>Nenhum atendimento corresponde aos filtros.</div>}
  </section>;
}

export function BrokerFunnel({ loaded, openLead, proposal, move, busy }: { loaded: BrokerData; openLead: (id: string) => void; proposal: (id?: string) => void; move: (id: string, stage: string) => Promise<void>; busy: boolean }) {
  const [pipelineId, setPipelineId] = useState(loaded.crm.pipelines.find(row => row.is_default)?.id || loaded.crm.pipelines[0]?.id || "");
  const funnel = buildBrokerFunnel(loaded.crm.records, loaded.crm.stages, loaded.commerce.proposals, loaded.data.session.user.id, pipelineId);
  return <section>
    <div className={styles.sectionTitle}><div><small>ACOMPANHAMENTO INDIVIDUAL</small><h2>Meu funil de vendas</h2><p>{funnel.rows.length} oportunidades sob sua responsabilidade.</p></div><div className={styles.actions}><select aria-label="Funil" value={pipelineId} onChange={e => setPipelineId(e.target.value)}>{loaded.crm.pipelines.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select><button className="primary" onClick={() => proposal()}>Gerar proposta</button></div></div>
    <div className={styles.funnel}>{funnel.columns.map(column => <section key={column.id} aria-label={column.name} data-approved={column.id === APPROVED_PROPOSALS_COLUMN || undefined}>
      <h3>{column.name} <span>{column.leads.length}</span></h3>
      {column.id === APPROVED_PROPOSALS_COLUMN && <p className={styles.muted}>Atualizado pela aprovação da Diretoria.</p>}
      {column.leads.map(lead => <article key={lead.id}>
        <button className={styles.leadName} onClick={() => openLead(lead.id)}>{lead.person_name}</button><small>{lead.phone}</small><p>Próxima ação: {date(lead.next_action_at)}</p><span className={styles.badge}>{lead.temperature || "Sem classificação"}</span>
        {column.id === APPROVED_PROPOSALS_COLUMN && funnel.approvedByLead.get(lead.id)?.map(item => <p key={item.id}><strong>{item.proposal_number}</strong> · {item.unit_code}</p>)}
        {lead.record_status === "aberta" && <>
          {column.id !== APPROVED_PROPOSALS_COLUMN && <select aria-label={`Etapa de ${lead.person_name}`} disabled={busy} value={funnel.movableStages.some(stage => stage.id === funnel.stageByLead.get(lead.id)) ? funnel.stageByLead.get(lead.id) : ""} onChange={e => void move(lead.id, e.target.value)}><option value="" disabled>Selecionar etapa</option>{funnel.movableStages.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select>}
          <div className={styles.funnelActions}><button onClick={() => openLead(lead.id)}>Insights IA</button><button className="primary" onClick={() => proposal(lead.id)}>Gerar proposta</button></div>
        </>}
      </article>)}
      {!column.leads.length && <p className={styles.muted}>Nenhuma oportunidade</p>}
    </section>)}</div>
  </section>;
}
