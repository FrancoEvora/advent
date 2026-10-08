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
import { BrokerLeads, BrokerFunnel } from "./broker-leads";
import { BrokerAgenda, BrokerAppointmentModal } from "./broker-agenda";
import { BrokerProposalModal } from "./broker-proposal-modal";
import { BrokerInsights } from "./broker-insights";
import { statusLabel } from "../crm-v5/sales/utils";
import styles from "./broker-workspace.module.css";

const tabs: Array<{ id: BrokerSection; label: string }> = [{ id: "leads", label: "Meus atendimentos" }, { id: "pipelines", label: "Meu funil" }, { id: "proposals", label: "Minhas propostas" }, { id: "salesmap", label: "Lotes disponíveis" }, { id: "agenda", label: "Minha agenda" }, { id: "materials", label: "Materiais" }];
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const date = (value?: string | null) => value ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "Sem data definida";

export function BrokerWorkspace({ session, membership, initialSection }: { session: Session; membership: Membership; initialSection: BrokerSection }) {
  const [section, setSection] = useState(initialSection);
  const [loaded, setLoaded] = useState<BrokerData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [project, setProject] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activityId, setActivityId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<{ leadId?: string; unitId?: string } | null>(null);
  const [appointmentLead, setAppointmentLead] = useState<string | null>(null);
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
  const units = (loaded?.units ?? []).filter(unit => !project || unit.project_id === project);

  async function assignmentStatus(id: string, status: string) {
    setBusy(true); setError("");
    const result = await getSupabase()!.rpc("set_crm_assignment_status", { p_assignment_id: id, p_status: status });
    if (result.error) { setError(result.error.message); setBusy(false); return; }
    setNotice("Andamento registrado para acompanhamento da Diretoria."); await reload();
  }

  async function done(message: string) { setNotice(message); await reload(); }
  async function moveStage(id: string, stage: string) {
    setBusy(true); setError("");
    const result = await getSupabase()!.rpc("move_broker_lead_stage", { p_record_id: id, p_stage_id: stage });
    if (result.error) { setError(result.error.message); setBusy(false); return; }
    await done("Etapa atualizada no seu funil.");
  }

  return <main id="conteudo-principal" className={styles.workspace}>
    <header className={styles.header}><div><Image src="/evora-brand.svg" alt="Évora Urbanismo" width={175} height={62} priority /><small>ÁREA DO CORRETOR</small><h1>Minha carteira comercial</h1><p>{loaded?.data.profile?.full_name || "Corretor"}{loaded?.agencies.length ? ` · ${loaded.agencies.map(agency => agency.name).join(", ")}` : ""}</p></div><div><button disabled={busy} onClick={() => void reload()}>Atualizar</button><button onClick={() => getSupabase()?.auth.signOut()}>Sair</button></div></header>
    <nav className={styles.tabs} aria-label="Atendimento comercial">{tabs.map(tab => <button key={tab.id} aria-current={section === tab.id ? "page" : undefined} className={section === tab.id ? styles.active : ""} onClick={() => { setSection(tab.id); setSelectedId(null); }}>{tab.label}</button>)}</nav>
    {error && <p className="feedback error" role="alert">{error}</p>}{notice && <p className="feedback" role="status">{notice}</p>}{busy && <p role="status">Atualizando sua carteira…</p>}
    {loaded && <>
      {section === "leads" && <BrokerLeads loaded={loaded} openLead={setSelectedId} activity={setActivityId} proposal={leadId => setProposal({ leadId })} />}
      {section === "pipelines" && <BrokerFunnel loaded={loaded} openLead={setSelectedId} move={moveStage} busy={busy} />}
      {section === "proposals" && <section><div className={styles.sectionTitle}><div><h2>Minhas propostas</h2><p>Acompanhe a decisão da Diretoria e a reserva de cada lote.</p></div><button className="primary" onClick={() => setProposal({})}>+ Nova proposta</button></div><div className={styles.cards}>{loaded.commerce.proposals.map(item => <article key={item.id}><small>{item.proposal_number}</small><h3>{loaded.crm.records.find(lead => lead.id === item.crm_record_id)?.person_name}</h3><p>{item.unit_code} · {money.format(item.sale_price)}</p><span className={styles.badge}>{statusLabel[item.status] || item.status}</span><p>Entrada: {money.format(item.down_payment)} · {item.installments_count} parcelas</p><p>{item.reservation_status === "ativa" ? `Reserva até ${date(item.reserved_until)}` : `Reserva: ${{ cancelada: "cancelada", expirada: "expirada", convertida: "convertida em venda" }[item.reservation_status || ""] || "sem reserva ativa"}`}</p>{item.rejection_reason && <p className="feedback error">{item.rejection_reason}</p>}<button onClick={() => setSelectedId(item.crm_record_id)}>Abrir atendimento</button></article>)}</div>{!loaded.commerce.proposals.length && <div className={styles.empty}>Suas propostas e reservas aparecerão aqui.</div>}</section>}
      {section === "salesmap" && <section><div className={styles.sectionTitle}><div><h2>Lotes disponíveis</h2><p>Consulte área, localização e preço para orientar seu cliente.</p></div><select aria-label="Empreendimento" value={project} onChange={event => setProject(event.target.value)}><option value="">Todos os empreendimentos</option>{loaded.data.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>{[...new Set(units.map(unit => `${unit.project_id}:${unit.block_code}`))].map(group => { const block = units.filter(unit => `${unit.project_id}:${unit.block_code}` === group); return <section className={styles.block} key={group}><h3>{loaded.data.projects.find(item => item.id === block[0].project_id)?.name} · Quadra {block[0].block_code}</h3><div className={styles.lots}>{block.map(unit => <article key={unit.id}><small>DISPONÍVEL</small><h4>Lote {unit.lot_number}</h4><strong>{unit.area} m²</strong><p>{money.format(unit.list_price)}</p><small>{[unit.corner ? "Esquina" : "", unit.topography, unit.orientation].filter(Boolean).join(" · ")}</small><button className="primary" onClick={() => setProposal({ unitId: unit.id })}>Proposta / reservar</button><button onClick={async () => { await navigator.clipboard.writeText(`${unit.unit_code} · ${unit.area} m² · ${money.format(unit.list_price)}. Disponibilidade e condições sujeitas à confirmação.`); setNotice("Informações do lote copiadas."); }}>Copiar informações</button></article>)}</div></section>; })}{!units.length && <div className={styles.empty}>Nenhum lote disponível neste empreendimento.</div>}</section>}
      {section === "agenda" && <BrokerAgenda loaded={loaded} openLead={setSelectedId} done={done} />}
      {section === "materials" && <MaterialsView data={loaded.data} crm={loaded.crm} reload={reload} readOnly />}
      {selected && <div className="modal-backdrop" onMouseDown={() => setSelectedId(null)}><section className={`modal extra-large ${styles.detail}`} role="dialog" aria-modal="true" aria-label={`Atendimento de ${selected.person_name}`} onMouseDown={event => event.stopPropagation()}><button className="modal-close" onClick={() => setSelectedId(null)}>×</button><header><small>ATENDIMENTO</small><h2>{selected.person_name}</h2><p>{selected.phone} {selected.email}</p><p>{selected.notes}</p><div className={styles.actions}><button className="primary" onClick={() => setActivityId(selected.id)}>Registrar contato ou visita</button><button onClick={() => setAppointmentLead(selected.id)}>Agendar compromisso</button>{selected.record_status === "aberta" && <button onClick={() => setProposal({ leadId: selected.id })}>Proposta e reserva</button>}</div></header>
        <BrokerInsights key={selected.id} lead={selected} loaded={loaded} />
        {loaded.crm.assignments.filter(item => item.crm_record_id === selected.id && item.assigned_user_id === session.user.id && ["atribuida", "aceita", "em_atendimento"].includes(item.status)).map(item => <div className={styles.actions} key={item.id}><span>Prazo do atendimento: {date(item.due_at)}</span>{item.status === "atribuida" && <button disabled={busy} onClick={() => void assignmentStatus(item.id, "aceita")}>Aceitar atendimento</button>}{item.status === "aceita" && <button disabled={busy} onClick={() => void assignmentStatus(item.id, "em_atendimento")}>Iniciar atendimento</button>}{["aceita", "em_atendimento"].includes(item.status) && <button disabled={busy} onClick={() => void assignmentStatus(item.id, "concluida")}>Concluir atendimento</button>}</div>)}
        <LeadConversationHistory organizationId={membership.organization_id} crmRecordId={selected.id} accessToken={session.access_token} leadName={selected.person_name} />
        <section className={styles.history}><h3>Histórico de atendimento</h3>{loaded.crm.actions.filter(item => item.crm_record_id === selected.id).map(item => <article key={item.id}><strong>{item.subject}</strong><small>{date(item.completed_at || item.scheduled_at)} · {item.action_status}</small><p>{(loaded.crm.assignments.some(assignment => assignment.crm_action_id === item.id) || /designa[çc][aã]o/i.test(item.subject)) ? "Atendimento designado para acompanhamento comercial." : item.notes}</p></article>)}</section>
        <CommunicationResources key={selected.id} data={loaded.data} entityType="crm_record" entityId={selected.id} shareTarget={{ name: selected.person_name, phone: selected.phone, email: selected.email, projectId: selected.project_id, subject: "Informações para seu atendimento" }} />
      </section></div>}
      {proposal && <BrokerProposalModal loaded={loaded} initialLeadId={proposal.leadId} initialUnitId={proposal.unitId} close={() => setProposal(null)} done={done} />}
      {appointmentLead && <BrokerAppointmentModal loaded={loaded} initialLeadId={appointmentLead} close={() => setAppointmentLead(null)} done={done} />}
      {activity && <ActivityModal key={activity.id} data={loaded.data} crm={loaded.crm} lead={activity as CrmRecord} close={() => setActivityId(null)} done={async message => { setNotice(message); await reload(); }} canAssignBroker={false} />}
    </>}
  </main>;
}
