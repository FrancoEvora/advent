"use client";

import {FormEvent,useCallback,useEffect,useMemo,useState} from "react";
import {getSupabase} from "@/lib/supabase";
import {useAutoRefresh} from "@/lib/use-auto-refresh";
import type {Membership,Organization,Profile,Project} from "../types";

type Ctx={organization:Organization;membership:Membership;profile:Profile|null;projects:Project[];members:Membership[];profiles:Profile[];session:{user:{id:string}}};
type ChecklistItem={label:string;done:boolean};
type Activity={id:string;organization_id:string;owner_user_id:string;assigned_by:string;updated_by:string|null;acknowledged_at:string|null;acknowledged_by:string|null;title:string;description:string|null;activity_type:string;status:string;board_status:string;priority:string;starts_at:string|null;due_at:string|null;completed_at:string|null;project_id:string|null;checklist:ChecklistItem[];tags:string[];estimated_minutes:number|null;progress_percent:number;progress_note:string|null;last_progress_at:string|null};
type Notification={id:string;activity_id:string|null;notification_type:string;title:string;message:string;metadata:Record<string,unknown>;read_at:string|null;created_at:string;actor_user_id:string|null};
type Mode="board"|"list"|"notifications";

const columns=[{id:"backlog",label:"Planejadas"},{id:"em_andamento",label:"Em andamento"},{id:"aguardando",label:"Aguardando"},{id:"concluida",label:"Concluídas"}];

export function ActivityPlanner({context}:{context:Ctx}){
 const[items,setItems]=useState<Activity[]>([]),[notifications,setNotifications]=useState<Notification[]>([]),[mode,setMode]=useState<Mode>("board"),[scope,setScope]=useState<"all"|"mine"|"delegated">("all"),[show,setShow]=useState(false),[message,setMessage]=useState("");
 const role=String(context.membership.role||"").toLowerCase(),canAssign=["admin","administrador","diretoria","diretor"].includes(role);
 const currentUser=context.session.user.id;
 const memberName=(id:string|null|undefined)=>context.profiles.find(profile=>profile.id===id)?.full_name||context.profiles.find(profile=>profile.id===id)?.email||"Usuário";
 const canEdit=(item:Activity)=>canAssign||item.owner_user_id===currentUser;

 const load=useCallback(async()=>{
  const supabase=getSupabase();if(!supabase)return;
  await supabase.rpc("run_my_automations",{p_organization_id:context.organization.id});
  const[activitiesResult,notificationsResult]=await Promise.all([
   supabase.from("user_activities").select("*").eq("organization_id",context.organization.id).order("position").order("due_at",{ascending:true}),
   supabase.from("activity_notifications").select("*").eq("organization_id",context.organization.id).eq("recipient_user_id",currentUser).order("created_at",{ascending:false}).limit(100),
  ]);
  if(activitiesResult.error)setMessage(activitiesResult.error.message);else setItems((activitiesResult.data||[]) as Activity[]);
  if(notificationsResult.error)setMessage(notificationsResult.error.message);else setNotifications((notificationsResult.data||[]) as Notification[]);
 },[context.organization.id,currentUser]);
 useEffect(()=>{queueMicrotask(()=>{void load()})},[load]);
 useAutoRefresh(load);

 const now=new Date(),week=new Date(now.getTime()+7*86400000);
 const overdue=items.filter(item=>item.board_status!=="concluida"&&item.due_at&&new Date(item.due_at)<now),unread=notifications.filter(item=>!item.read_at).length;
 const myItems=useMemo(()=>items.filter(item=>item.owner_user_id===currentUser),[items,currentUser]);
 const visibleItems=useMemo(()=>items.filter(item=>scope==="mine"?item.owner_user_id===currentUser:scope==="delegated"?item.assigned_by===currentUser&&item.owner_user_id!==currentUser:true),[items,scope,currentUser]);

 async function save(event:FormEvent<HTMLFormElement>){
  event.preventDefault();const form=new FormData(event.currentTarget),supabase=getSupabase();if(!supabase)return;
  const owner=canAssign?String(form.get("owner_user_id")||currentUser):currentUser;
  const checklist=String(form.get("checklist")||"").split("\n").map(value=>value.trim()).filter(Boolean).map(label=>({label,done:false}));
  const tags=String(form.get("tags")||"").split(",").map(value=>value.trim()).filter(Boolean);
  const result=await supabase.from("user_activities").insert({organization_id:context.organization.id,owner_user_id:owner,assigned_by:currentUser,updated_by:currentUser,title:form.get("title"),description:form.get("description")||null,activity_type:form.get("activity_type"),status:"pendente",board_status:"backlog",priority:form.get("priority"),starts_at:form.get("starts_at")||null,due_at:form.get("due_at")||null,project_id:form.get("project_id")||null,estimated_minutes:Number(form.get("estimated_minutes")||0)||null,checklist,tags,progress_percent:0});
  if(result.error)setMessage(result.error.message);else{setShow(false);await load()}
 }

 async function move(item:Activity,status:string){
  if(!canEdit(item))return;const supabase=getSupabase();if(!supabase)return;const concluded=status==="concluida";
  const result=await supabase.from("user_activities").update({board_status:status,status:concluded?"concluida":"pendente",progress_percent:concluded?100:item.progress_percent,completed_at:concluded?new Date().toISOString():null,updated_by:currentUser,updated_at:new Date().toISOString()}).eq("id",item.id);
  if(result.error)setMessage(result.error.message);else await load();
 }

 async function registerProgress(item:Activity){
  if(!canEdit(item))return;const percentText=prompt("Percentual concluído (0 a 100):",String(item.progress_percent||0));if(percentText===null)return;
  const percent=Math.max(0,Math.min(100,Number(percentText)));if(!Number.isFinite(percent)){setMessage("Informe um percentual válido.");return}
  const note=prompt("Informe um resumo do andamento:",item.progress_note||"");if(note===null)return;
  const supabase=getSupabase();if(!supabase)return;const completed=percent===100;
  const result=await supabase.from("user_activities").update({progress_percent:percent,progress_note:note||null,last_progress_at:new Date().toISOString(),updated_by:currentUser,board_status:completed?"concluida":item.board_status,status:completed?"concluida":"pendente",completed_at:completed?new Date().toISOString():null,updated_at:new Date().toISOString()}).eq("id",item.id);
  if(result.error)setMessage(result.error.message);else await load();
 }

 async function acknowledge(item:Activity){
  if(item.owner_user_id!==currentUser||item.acknowledged_at)return;const supabase=getSupabase();if(!supabase)return;
  const result=await supabase.from("user_activities").update({acknowledged_at:new Date().toISOString(),acknowledged_by:currentUser,updated_by:currentUser,updated_at:new Date().toISOString()}).eq("id",item.id);
  if(result.error)setMessage(result.error.message);else await load();
 }

 async function reassign(item:Activity,ownerUserId:string){
  if(!canAssign||ownerUserId===item.owner_user_id)return;const supabase=getSupabase();if(!supabase)return;
  const result=await supabase.from("user_activities").update({owner_user_id:ownerUserId,acknowledged_at:null,acknowledged_by:null,updated_by:currentUser,updated_at:new Date().toISOString()}).eq("id",item.id);
  if(result.error)setMessage(result.error.message);else await load();
 }

 async function toggleChecklist(item:Activity,index:number){
  if(!canEdit(item))return;const checklist=(item.checklist||[]).map((entry,itemIndex)=>itemIndex===index?{...entry,done:!entry.done}:entry);
  const completed=checklist.filter(entry=>entry.done).length,percent=checklist.length?Math.round(completed/checklist.length*100):item.progress_percent;
  const supabase=getSupabase();if(!supabase)return;const concluded=percent===100&&checklist.length>0;
  const result=await supabase.from("user_activities").update({checklist,progress_percent:percent,last_progress_at:new Date().toISOString(),updated_by:currentUser,board_status:concluded?"concluida":item.board_status,status:concluded?"concluida":"pendente",completed_at:concluded?new Date().toISOString():null,updated_at:new Date().toISOString()}).eq("id",item.id);
  if(result.error)setMessage(result.error.message);else await load();
 }

 async function markRead(id:string){const supabase=getSupabase();if(!supabase)return;await supabase.from("activity_notifications").update({read_at:new Date().toISOString()}).eq("id",id);await load()}
 async function markAllRead(){const supabase=getSupabase();if(!supabase)return;await supabase.from("activity_notifications").update({read_at:new Date().toISOString()}).eq("recipient_user_id",currentUser).is("read_at",null);await load()}

 const card=(item:Activity)=><article className={`task-card ${item.due_at&&new Date(item.due_at)<now&&item.board_status!=="concluida"?"overdue":""}`} key={item.id}>
  <header><i data-priority={item.priority}>{item.priority}</i>{item.due_at&&<time>{new Date(item.due_at).toLocaleString("pt-BR")}</time>}</header>
  <h3>{item.title}</h3><p>{item.description||"Sem descrição"}</p>
  <div className="task-progress"><i><b style={{width:`${item.progress_percent||0}%`}}/></i><span>{item.progress_percent||0}%</span></div>
  {item.progress_note&&<p className="task-progress-note">{item.progress_note}</p>}
  <div className="task-tags">{(item.tags||[]).map(tag=><span key={tag}>{tag}</span>)}</div>
  <small>Cadastrada por {memberName(item.assigned_by)} · Responsável: {memberName(item.owner_user_id)}</small>
  <small>{item.project_id?context.projects.find(project=>project.id===item.project_id)?.name:"Corporativo"}</small>
  {canAssign&&<div className="task-assignment"><label>Redistribuir para<select value={item.owner_user_id} onChange={event=>reassign(item,event.target.value)}>{context.members.map(member=><option key={member.user_id} value={member.user_id}>{memberName(member.user_id)}</option>)}</select></label></div>}
  <div className={`task-acknowledgement ${item.acknowledged_at?"accepted":""}`}><span>{item.acknowledged_at?`Recebida por ${memberName(item.acknowledged_by)} em ${new Date(item.acknowledged_at).toLocaleString("pt-BR")}`:"Aguardando confirmação do responsável"}</span>{item.owner_user_id===currentUser&&!item.acknowledged_at&&<button type="button" onClick={()=>acknowledge(item)}>Confirmar recebimento</button>}</div>
  {!!item.checklist?.length&&<div className="task-checklist">{item.checklist.map((entry,index)=><label key={`${entry.label}-${index}`}><input type="checkbox" checked={entry.done} disabled={!canEdit(item)} onChange={()=>toggleChecklist(item,index)}/><span>{entry.label}</span></label>)}</div>}
  <footer><span>{item.checklist?.filter(value=>value.done).length||0}/{item.checklist?.length||0} itens</span>{canEdit(item)&&<button onClick={()=>registerProgress(item)}>Registrar avanço</button>}<select value={item.board_status||"backlog"} disabled={!canEdit(item)} onChange={event=>move(item,event.target.value)}>{columns.map(column=><option key={column.id} value={column.id}>{column.label}</option>)}</select></footer>
 </article>;

 return <div className="agenda-shell agenda-v65">
  {message&&<button className="notice" onClick={()=>setMessage("")}>{message}</button>}
  <section className="agenda-kpis"><article><small>Minhas atividades</small><strong>{myItems.filter(item=>item.board_status!=="concluida").length}</strong><span>em execução</span></article><article className={overdue.length?"danger":""}><small>Atrasadas</small><strong>{overdue.length}</strong><span>exigem ação</span></article><article><small>Próximos 7 dias</small><strong>{items.filter(item=>item.due_at&&new Date(item.due_at)>=now&&new Date(item.due_at)<=week&&item.board_status!=="concluida").length}</strong><span>compromissos</span></article><article className={unread?"warning":""}><small>Notificações</small><strong>{unread}</strong><span>não lidas</span></article></section>
  <section className="agenda-card"><header><div><small>OPERAÇÃO COLABORATIVA</small><h2>Atividades da equipe</h2><p>{canAssign?"Distribua responsabilidades e acompanhe a execução.":"Acompanhe as atividades designadas a você."}</p><div className="agenda-scope"><button className={scope==="all"?"active":""} onClick={()=>setScope("all")}>Todas</button><button className={scope==="mine"?"active":""} onClick={()=>setScope("mine")}>Minhas</button>{canAssign&&<button className={scope==="delegated"?"active":""} onClick={()=>setScope("delegated")}>Delegadas por mim</button>}</div></div><div><button className={mode==="board"?"active":""} onClick={()=>setMode("board")}>Quadro</button><button className={mode==="list"?"active":""} onClick={()=>setMode("list")}>Lista</button><button className={mode==="notifications"?"active":""} onClick={()=>setMode("notifications")}>Notificações {unread?`(${unread})`:""}</button><button className="primary" onClick={()=>setShow(true)}>+ Nova atividade</button></div></header>
   {mode==="board"?<div className="task-board">{columns.map(column=><section key={column.id}><header><strong>{column.label}</strong><span>{visibleItems.filter(item=>(item.board_status||"backlog")===column.id).length}</span></header><div>{visibleItems.filter(item=>(item.board_status||"backlog")===column.id).map(card)}</div></section>)}</div>:mode==="list"?<div className="agenda-list">{visibleItems.map(card)}{!visibleItems.length&&<p className="empty-state">Nenhuma atividade cadastrada.</p>}</div>:<div className="activity-notifications"><header><div><strong>Central de notificações</strong><span>Designações, confirmações, alterações, progresso e atrasos.</span></div>{unread>0&&<button onClick={markAllRead}>Marcar todas como lidas</button>}</header>{notifications.map(notification=><article key={notification.id} className={notification.read_at?"read":"unread"} onClick={()=>!notification.read_at&&markRead(notification.id)}><i data-type={notification.notification_type}>●</i><div><strong>{notification.title}</strong><p>{notification.message}</p><small>{notification.actor_user_id?`${memberName(notification.actor_user_id)} · `:""}{new Date(notification.created_at).toLocaleString("pt-BR")}</small></div>{!notification.read_at&&<b>Nova</b>}</article>)}{!notifications.length&&<p className="empty-state">Nenhuma notificação registrada.</p>}</div>}
  </section>
  {show&&<div className="modal-backdrop" onMouseDown={()=>setShow(false)}><form className="modal" onSubmit={save} onMouseDown={event=>event.stopPropagation()}><button type="button" className="modal-close" onClick={()=>setShow(false)}>×</button><header><small>NOVA ATIVIDADE</small><h2>Planejar e distribuir</h2></header><div className="form-grid"><label className="span-2">Título<input name="title" required/></label><label>Tipo<select name="activity_type"><option value="tarefa">Tarefa</option><option value="reuniao">Reunião</option><option value="ligacao">Ligação</option><option value="visita">Visita</option><option value="prazo">Prazo</option><option value="follow_up">Follow-up</option></select></label><label>Prioridade<select name="priority"><option value="normal">Normal</option><option value="alta">Alta</option><option value="urgente">Urgente</option></select></label>{canAssign&&<label>Responsável<select name="owner_user_id" defaultValue={currentUser}>{context.members.map(member=><option key={member.user_id} value={member.user_id}>{memberName(member.user_id)}</option>)}</select></label>}<label>Empreendimento<select name="project_id"><option value="">Corporativo</option>{context.projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>Início<input name="starts_at" type="datetime-local"/></label><label>Prazo<input name="due_at" type="datetime-local"/></label><label>Estimativa em minutos<input name="estimated_minutes" type="number" min="0"/></label><label>Tags<input name="tags" placeholder="obra, urgente, cliente"/></label><label className="span-2">Descrição<textarea name="description" rows={3}/></label><label className="span-2">Checklist — um item por linha<textarea name="checklist" rows={4}/></label></div><footer><button type="button" onClick={()=>setShow(false)}>Cancelar</button><button className="primary">Salvar atividade</button></footer></form></div>}
 </div>;
}
