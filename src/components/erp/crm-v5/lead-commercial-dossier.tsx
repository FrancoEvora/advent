"use client";

import {useEffect,useMemo,useState} from "react";
import {getSupabase} from "@/lib/supabase";
import type {CrmRecord} from "../types";
import styles from "./lead-commercial-dossier.module.css";

type ActionRow={id:string;action_type:string;subject:string;scheduled_at:string|null;completed_at:string|null;action_status:string;notes:string|null;channel:string|null;outcome:string|null;created_at:string;metadata:Record<string,unknown>|null};
type ProposalRow={id:string;proposal_number:string|null;status:string;approval_status:string|null;sale_price:number|null;down_payment:number|null;installments_count:number|null;monthly_interest_rate:number|null;indexer:string|null;balloon_total:number|null;conditions_text:string|null;valid_until:string|null;sent_at:string|null;accepted_at:string|null;declined_at:string|null;created_at:string;updated_at:string};
type EventRow={id:string;actor_type:string;event_type:string;event_source:string;channel:string|null;occurred_at:string;data:Record<string,unknown>|null};
type Tab="timeline"|"visits"|"proposals"|"activity";

const money=new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"});
const dt=new Intl.DateTimeFormat("pt-BR",{timeZone:"America/Sao_Paulo",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
function date(value:string|null){if(!value)return"—";const d=new Date(value);return Number.isFinite(d.getTime())?dt.format(d):"—"}
function label(value:string){return value.replaceAll("_"," ").replace(/\b\w/g,c=>c.toUpperCase())}
function isVisit(a:ActionRow){return /visita|visit/i.test(`${a.action_type} ${a.subject}`)}
function eventTitle(e:EventRow){const d=e.data||{};const title=typeof d.title==="string"?d.title:null;return title||label(e.event_type)}
function statusTone(status:string){if(/aceit|aprov|conclu|ganh|realiz/i.test(status))return styles.good;if(/cancel|recus|perdid|declin|expir/i.test(status))return styles.bad;return styles.neutral}

export function LeadCommercialDossier({lead}:{lead:CrmRecord}){
 const [tab,setTab]=useState<Tab>("timeline");const [loading,setLoading]=useState(true);const [error,setError]=useState("");
 const [actions,setActions]=useState<ActionRow[]>([]);const [proposals,setProposals]=useState<ProposalRow[]>([]);const [events,setEvents]=useState<EventRow[]>([]);
 useEffect(()=>{let active=true;(async()=>{const client=getSupabase();if(!client){setError("Conexão com o ERP indisponível.");setLoading(false);return}setLoading(true);setError("");const [a,p,e]=await Promise.all([
  client.from("crm_actions").select("id,action_type,subject,scheduled_at,completed_at,action_status,notes,channel,outcome,created_at,metadata").eq("crm_record_id",lead.id).order("created_at",{ascending:false}).limit(100),
  client.from("crm_proposals").select("id,proposal_number,status,approval_status,sale_price,down_payment,installments_count,monthly_interest_rate,indexer,balloon_total,conditions_text,valid_until,sent_at,accepted_at,declined_at,created_at,updated_at").eq("crm_record_id",lead.id).order("created_at",{ascending:false}).limit(50),
  client.from("crm_opportunity_events").select("id,actor_type,event_type,event_source,channel,occurred_at,data").eq("crm_record_id",lead.id).order("occurred_at",{ascending:false}).limit(150)
 ]);if(!active)return;const firstError=a.error||p.error||e.error;if(firstError)setError(firstError.message);setActions((a.data||[]) as ActionRow[]);setProposals((p.data||[]) as ProposalRow[]);setEvents((e.data||[]) as EventRow[]);setLoading(false)})();return()=>{active=false}},[lead.id]);
 const visits=useMemo(()=>actions.filter(isVisit),[actions]);
 const next=useMemo(()=>actions.filter(a=>a.action_status==="pendente"&&a.scheduled_at).sort((x,y)=>new Date(x.scheduled_at!).getTime()-new Date(y.scheduled_at!).getTime())[0]||null,[actions]);
 const lastProposal=proposals[0]||null;
 const timeline=useMemo(()=>[
  ...actions.map(a=>({id:`a-${a.id}`,at:a.completed_at||a.scheduled_at||a.created_at,kind:isVisit(a)?"Visita":"Atividade",title:a.subject,meta:`${label(a.action_status)}${a.channel?` · ${label(a.channel)}`:""}`,detail:a.notes||a.outcome||""})),
  ...proposals.map(p=>({id:`p-${p.id}`,at:p.sent_at||p.accepted_at||p.declined_at||p.created_at,kind:"Proposta",title:p.proposal_number?`Proposta ${p.proposal_number}`:"Proposta comercial",meta:`${label(p.status)}${p.sale_price!=null?` · ${money.format(Number(p.sale_price))}`:""}`,detail:p.conditions_text||""})),
  ...events.map(e=>({id:`e-${e.id}`,at:e.occurred_at,kind:e.actor_type==="ai"?"Bia":"Evento",title:eventTitle(e),meta:`${label(e.event_source)}${e.channel?` · ${label(e.channel)}`:""}`,detail:""}))
 ].sort((x,y)=>new Date(y.at).getTime()-new Date(x.at).getTime()).slice(0,120),[actions,events,proposals]);
 return <section className={styles.section}>
  <div className={styles.heading}><div><small>DOSSIÊ COMERCIAL DO LEAD</small><h3>Visão consolidada do atendimento</h3><p>Conversas, visitas, propostas e eventos comerciais vinculados a este lead.</p></div><span className={`${styles.stage} ${statusTone(lead.record_status)}`}>{label(lead.record_status)} · {label(lead.stage)}</span></div>
  <div className={styles.kpis}>
   <article><small>PRÓXIMA AÇÃO</small><strong>{next?.subject||"Sem próxima ação"}</strong><span>{next?date(next.scheduled_at):lead.next_action_at?date(lead.next_action_at):"Defina o próximo passo"}</span></article>
   <article><small>VISITAS</small><strong>{visits.length}</strong><span>{visits[0]?`${label(visits[0].action_status)} · ${date(visits[0].scheduled_at||visits[0].created_at)}`:"Nenhuma registrada"}</span></article>
   <article><small>PROPOSTAS</small><strong>{proposals.length}</strong><span>{lastProposal?`${label(lastProposal.status)}${lastProposal.sale_price!=null?` · ${money.format(Number(lastProposal.sale_price))}`:""}`:"Nenhuma registrada"}</span></article>
   <article><small>ÚLTIMO CONTATO</small><strong>{lead.last_contact_at?date(lead.last_contact_at):"—"}</strong><span>{lead.temperature?`Lead ${lead.temperature}`:"Temperatura não definida"}</span></article>
  </div>
  <nav className={styles.tabs} aria-label="Dossiê comercial"><button type="button" className={tab==="timeline"?styles.active:""} onClick={()=>setTab("timeline")}>Linha do tempo</button><button type="button" className={tab==="visits"?styles.active:""} onClick={()=>setTab("visits")}>Visitas <b>{visits.length}</b></button><button type="button" className={tab==="proposals"?styles.active:""} onClick={()=>setTab("proposals")}>Propostas <b>{proposals.length}</b></button><button type="button" className={tab==="activity"?styles.active:""} onClick={()=>setTab("activity")}>Atividades <b>{actions.length}</b></button></nav>
  {loading&&<div className={styles.state}>Carregando dossiê comercial…</div>}{error&&<div className={styles.error}>Parte do dossiê não pôde ser carregada: {error}</div>}
  {!loading&&tab==="timeline"&&<div className={styles.timeline}>{timeline.length?timeline.map(item=><article key={item.id}><i/><div><small>{item.kind} · {date(item.at)}</small><strong>{item.title}</strong><span>{item.meta}</span>{item.detail&&<p>{item.detail}</p>}</div></article>):<div className={styles.state}>Nenhum evento comercial registrado ainda.</div>}</div>}
  {!loading&&tab==="visits"&&<div className={styles.cards}>{visits.length?visits.map(v=><article key={v.id}><div><small>VISITA</small><strong>{v.subject}</strong></div><span className={statusTone(v.action_status)}>{label(v.action_status)}</span><dl><div><dt>Quando</dt><dd>{date(v.scheduled_at||v.created_at)}</dd></div><div><dt>Canal</dt><dd>{v.channel?label(v.channel):"Presencial"}</dd></div>{v.notes&&<div><dt>Observações</dt><dd>{v.notes}</dd></div>}</dl></article>):<div className={styles.state}>Nenhuma visita registrada para este lead.</div>}</div>}
  {!loading&&tab==="proposals"&&<div className={styles.cards}>{proposals.length?proposals.map(p=><article key={p.id}><div><small>{p.proposal_number?`PROPOSTA ${p.proposal_number}`:"PROPOSTA COMERCIAL"}</small><strong>{p.sale_price!=null?money.format(Number(p.sale_price)):"Valor não informado"}</strong></div><span className={statusTone(p.status)}>{label(p.status)}</span><dl><div><dt>Entrada</dt><dd>{p.down_payment!=null?money.format(Number(p.down_payment)):"—"}</dd></div><div><dt>Prazo</dt><dd>{p.installments_count?`${p.installments_count} parcelas`:"—"}</dd></div><div><dt>Juros</dt><dd>{p.monthly_interest_rate!=null?`${Number(p.monthly_interest_rate).toLocaleString("pt-BR")}% a.m.`:"—"}</dd></div><div><dt>Correção</dt><dd>{p.indexer||"—"}</dd></div><div><dt>Validade</dt><dd>{date(p.valid_until)}</dd></div><div><dt>Enviada</dt><dd>{date(p.sent_at)}</dd></div></dl>{p.conditions_text&&<p>{p.conditions_text}</p>}</article>):<div className={styles.state}>Nenhuma proposta persistida para este lead.</div>}</div>}
  {!loading&&tab==="activity"&&<div className={styles.cards}>{actions.length?actions.map(a=><article key={a.id}><div><small>{label(a.action_type)}</small><strong>{a.subject}</strong></div><span className={statusTone(a.action_status)}>{label(a.action_status)}</span><dl><div><dt>Agendada</dt><dd>{date(a.scheduled_at)}</dd></div><div><dt>Concluída</dt><dd>{date(a.completed_at)}</dd></div></dl>{a.notes&&<p>{a.notes}</p>}</article>):<div className={styles.state}>Nenhuma atividade registrada.</div>}</div>}
 </section>
}
