"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";
import type { BrokerSection } from "@/lib/broker-access";
import type { CrmRecord, Membership } from "../types";
import { ActivityModal } from "../crm-v5/activity-modal";
import { LeadConversationHistory } from "../crm-v5/lead-conversation-history";
import { CommunicationResources } from "../communication/communication-resources";
import { MaterialsView } from "../crm-v5/views-marketing";
import { loadBrokerData, type BrokerData } from "./load-broker-data";
import styles from "./broker-workspace.module.css";

const tabs: Array<{ id: BrokerSection; label: string }> = [{ id: "leads", label: "Meus atendimentos" }, { id: "salesmap", label: "Lotes disponíveis" }, { id: "agenda", label: "Minha agenda" }, { id: "materials", label: "Materiais" }];
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const date = (value?: string | null) => value ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "Sem data definida";

export function BrokerWorkspace({ session, membership, initialSection }: { session: Session; membership: Membership; initialSection: BrokerSection }) {
  const [section, setSection] = useState(initialSection);
  const [loaded, setLoaded] = useState<BrokerData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activityId, setActivityId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const reload = useCallback(async () => {
    setBusy(true); setError("");
    try { setLoaded(await loadBrokerData(session, membership)); }
    catch (cause) { setLoaded(null); setError(cause instanceof Error ? cause.message : "Não foi possível carregar seus atendimentos."); }
    finally { setBusy(false); }
  }, [membership, session]);
  useEffect(() => { const timer = window.setTimeout(() => { void reload(); }, 0); return () => window.clearTimeout(timer); }, [reload]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void reload(); };
    window.addEventListener("focus", refresh);
    const interval = window.setInterval(refresh, 60000);
    return () => { window.removeEventListener("focus", refresh); window.clearInterval(interval); };
  }, [reload]);
  const selected = loaded?.crm.records.find(lead => lead.id === selectedId);
  const activity = loaded?.crm.records.find(lead => lead.id === activityId);
  const rows = (loaded?.crm.records ?? []).filter(lead => `${lead.person_name} ${lead.phone ?? ""} ${lead.email ?? ""}`.toLocaleLowerCase("pt-BR").includes(query.toLocaleLowerCase("pt-BR")));
  const units = (loaded?.units ?? []).filter(unit => !project || unit.project_id === project);

  async function assignmentStatus(id: string, status: string) {
    setBusy(true); setError("");
    const result = await getSupabase()!.rpc("set_crm_assignment_status", { p_assignment_id: id, p_status: status });
    if (result.error) { setError(result.error.message); setBusy(false); return; }
    setNotice("Andamento registrado para acompanhamento da Diretoria."); await reload();
  }

  return <main id="conteudo-principal" className={styles.workspace}>
    <header className={styles.header}><div><Image src="/evora-brand.svg" alt="Évora Urbanismo" width={175} height={62} priority /><small>ÁREA DO CORRETOR</small><h1>Seu próximo atendimento começa aqui.</h1><p>{loaded?.data.profile?.full_name || "Corretor"}{loaded?.agencies.length ? ` · ${loaded.agencies.map(agency => agency.name).join(", ")}` : ""}</p></div><div><button disabled={busy} onClick={() => void reload()}>Atualizar</button><button onClick={() => getSupabase()?.auth.signOut()}>Sair</button></div></header>
    <nav className={styles.tabs} aria-label="Atendimento comercial">{tabs.map(tab => <button key={tab.id} aria-current={section === tab.id ? "page" : undefined} className={section === tab.id ? styles.active : ""} onClick={() => { setSection(tab.id); setSelectedId(null); }}>{tab.label}</button>)}</nav>
    {error && <p className="feedback error" role="alert">{error}</p>}{notice && <p className="feedback" role="status">{notice}</p>}{busy && <p role="status">Atualizando sua carteira…</p>}
    {loaded && <>
      {section === "leads" && <section><div className={styles.sectionTitle}><div><h2>Meus atendimentos</h2><p>Leads designados a você ou à sua imobiliária.</p></div><input aria-label="Buscar na minha carteira" placeholder="Buscar nome, telefone ou e-mail" value={query} onChange={event => setQuery(event.target.value)} /></div><div className={styles.cards}>{rows.map(lead => <article key={lead.id}><small>{lead.broker_user_id === session.user.id || lead.owner_user_id === session.user.id ? "DESIGNAÇÃO PESSOAL" : "CARTEIRA DA IMOBILIÁRIA"}</small><h3>{lead.person_name}</h3><p>{lead.phone || lead.email || "Contato ainda não informado"}</p><p>{loaded.data.projects.find(item => item.id === lead.project_id)?.name || "Empreendimento a definir"}</p><p>Próximo contato: {date(lead.next_action_at)}</p><button className="primary" onClick={() => setSelectedId(lead.id)}>Abrir atendimento</button></article>)}</div>{!rows.length && <div className={styles.empty}><h3>Nenhum lead designado</h3><p>{query ? "Nenhum atendimento corresponde à busca." : "Os atendimentos aparecerão aqui quando a Diretoria designar leads para você ou para sua imobiliária."}</p></div>}</section>}
      {section === "salesmap" && <section><div className={styles.sectionTitle}><div><h2>Lotes disponíveis</h2><p>Consulte área, localização e preço para orientar seu cliente.</p></div><select aria-label="Empreendimento" value={project} onChange={event => setProject(event.target.value)}><option value="">Todos os empreendimentos</option>{loaded.data.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>{[...new Set(units.map(unit => `${unit.project_id}:${unit.block_code}`))].map(group => { const block = units.filter(unit => `${unit.project_id}:${unit.block_code}` === group); return <section className={styles.block} key={group}><h3>{loaded.data.projects.find(item => item.id === block[0].project_id)?.name} · Quadra {block[0].block_code}</h3><div className={styles.lots}>{block.map(unit => <article key={unit.id}><small>DISPONÍVEL</small><h4>Lote {unit.lot_number}</h4><strong>{unit.area} m²</strong><p>{money.format(unit.list_price)}</p><small>{[unit.corner ? "Esquina" : "", unit.topography, unit.orientation].filter(Boolean).join(" · ")}</small><button onClick={async () => { await navigator.clipboard.writeText(`${unit.unit_code} · ${unit.area} m² · ${money.format(unit.list_price)}. Disponibilidade e condições sujeitas à confirmação.`); setNotice("Informações do lote copiadas."); }}>Copiar informações</button></article>)}</div></section>; })}{!units.length && <div className={styles.empty}>Nenhum lote disponível neste empreendimento.</div>}</section>}
      {section === "agenda" && <section><h2>Minha agenda</h2><p>Compromissos e prazos dos seus atendimentos.</p><div className={styles.cards}>{loaded.activities.filter(item => !["concluida", "cancelada"].includes(item.status)).map(item => <article key={item.id}><small>{date(item.starts_at || item.due_at)}</small><h3>{item.title}</h3><p>{item.description}</p><p>Prazo: {date(item.due_at)}</p>{(() => { const leadId = item.related_type === "crm_records" ? item.related_id : loaded.crm.actions.find(action => action.id === item.related_id)?.crm_record_id; return leadId && loaded.crm.records.some(lead => lead.id === leadId) ? <button onClick={() => setSelectedId(leadId)}>Abrir atendimento</button> : null; })()}</article>)}{loaded.crm.actions.filter(item => item.assigned_to === session.user.id && item.action_status === "pendente" && !item.metadata?.calendar_user_activity_id && !loaded.crm.assignments.some(assignment => assignment.crm_action_id === item.id)).map(item => <article key={item.id}><small>{date(item.scheduled_at)}</small><h3>{item.subject}</h3><p>{loaded.crm.records.find(lead => lead.id === item.crm_record_id)?.person_name}</p>{item.crm_record_id && <button onClick={() => setSelectedId(item.crm_record_id)}>Abrir atendimento</button>}</article>)}</div>{!loaded.activities.length && !loaded.crm.actions.length && <div className={styles.empty}>Sua agenda ainda não possui atividades.</div>}</section>}
      {section === "materials" && <MaterialsView data={loaded.data} crm={loaded.crm} reload={reload} readOnly />}
      {selected && <div className="modal-backdrop" onMouseDown={() => setSelectedId(null)}><section className={`modal extra-large ${styles.detail}`} role="dialog" aria-modal="true" aria-label={`Atendimento de ${selected.person_name}`} onMouseDown={event => event.stopPropagation()}><button className="modal-close" onClick={() => setSelectedId(null)}>×</button><header><small>ATENDIMENTO</small><h2>{selected.person_name}</h2><p>{selected.phone} {selected.email}</p><p>{selected.notes}</p><button className="primary" onClick={() => setActivityId(selected.id)}>Registrar contato ou agendar visita</button></header>
        {loaded.crm.assignments.filter(item => item.crm_record_id === selected.id && ["atribuida", "aceita", "em_atendimento"].includes(item.status)).map(item => <article className={styles.guidance} key={item.id}><small>INSIGHTS DA ARISA · PRAZO {date(item.due_at)}</small><h3>{item.guidance.headline || "Orientação para o atendimento"}</h3><p>{item.guidance.objective || item.instructions}</p><p>{item.guidance.opening_suggestion || item.guidance.approach}</p>{!!item.guidance.questions?.length && <ul>{item.guidance.questions.map(question => <li key={question}>{question}</li>)}</ul>}{!!item.guidance.next_steps?.length && <ol>{item.guidance.next_steps.map(step => <li key={step}>{step}</li>)}</ol>}{item.assigned_user_id === session.user.id && <div>{item.status === "atribuida" && <button disabled={busy} onClick={() => void assignmentStatus(item.id, "aceita")}>Aceitar atendimento</button>}{item.status === "aceita" && <button disabled={busy} onClick={() => void assignmentStatus(item.id, "em_atendimento")}>Iniciar atendimento</button>}{["aceita", "em_atendimento"].includes(item.status) && <button disabled={busy} onClick={() => void assignmentStatus(item.id, "concluida")}>Concluir atendimento</button>}</div>}</article>)}
        <LeadConversationHistory organizationId={membership.organization_id} crmRecordId={selected.id} accessToken={session.access_token} leadName={selected.person_name} />
        <section className={styles.history}><h3>Histórico de atendimento</h3>{loaded.crm.actions.filter(item => item.crm_record_id === selected.id).map(item => <article key={item.id}><strong>{item.subject}</strong><small>{date(item.completed_at || item.scheduled_at)} · {item.action_status}</small><p>{item.notes}</p></article>)}</section>
        <CommunicationResources key={selected.id} data={loaded.data} entityType="crm_record" entityId={selected.id} shareTarget={{ name: selected.person_name, phone: selected.phone, email: selected.email, projectId: selected.project_id, subject: "Informações para seu atendimento" }} />
      </section></div>}
      {activity && <ActivityModal key={activity.id} data={loaded.data} crm={loaded.crm} lead={activity as CrmRecord} close={() => setActivityId(null)} done={async message => { setNotice(message); await reload(); }} canAssignBroker={false} />}
    </>}
  </main>;
}
