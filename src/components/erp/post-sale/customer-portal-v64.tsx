"use client";

import {FormEvent,useEffect,useMemo,useState} from "react";
import {getSupabase} from "@/lib/supabase";
import {brl,stageLabel} from "./utils";

function embed(url:string){try{const parsed=new URL(url);if(parsed.hostname.includes("youtube.com")){const id=parsed.searchParams.get("v");return id?`https://www.youtube.com/embed/${id}`:url}if(parsed.hostname.includes("youtu.be"))return `https://www.youtube.com/embed/${parsed.pathname.slice(1)}`;return url}catch{return url}}
function date(value:string){return value?new Date(`${value.slice(0,10)}T12:00:00`).toLocaleDateString("pt-BR"):"—"}

export function CustomerPortalV64({token}:{token:string}){
 const[data,setData]=useState<any>(null);
 const[loading,setLoading]=useState(true);
 const[error,setError]=useState("");
 const[feedback,setFeedback]=useState("");
 const[busy,setBusy]=useState(false);

 async function load(){const client=getSupabase();if(!client){setError("Portal indisponível.");setLoading(false);return}const result=await client.rpc("get_post_sale_portal_v2",{p_token:token});if(result.error||!result.data)setError("Este acesso é inválido ou expirou.");else setData(result.data);setLoading(false)}
 useEffect(()=>{load()},[token]);

 const financial=useMemo(()=>data?.financial||[],[data]);
 const summary=useMemo(()=>{const result={paid:0,overdue:0,due:0,open:0,paidCount:0,overdueCount:0,dueCount:0,openCount:0};const now=Date.now(),limit=now+30*86400000;for(const item of financial){const amount=Number(item.amount||0),status=String(item.status||"").toLowerCase(),time=item.due_date?new Date(`${item.due_date}T12:00:00`).getTime():0;if(["recebido","pago","liquidado"].includes(status)){result.paid+=amount;result.paidCount++}else if(status==="vencido"||(time&&time<now)){result.overdue+=amount;result.overdueCount++}else if(time&&time<=limit){result.due+=amount;result.dueCount++}else{result.open+=amount;result.openCount++}}return result},[financial]);

 async function quickRequest(subject:string,message:string){setBusy(true);setFeedback("");const client=getSupabase();if(!client){setFeedback("Portal indisponível.");setBusy(false);return}const result=await client.rpc("send_portal_message",{p_token:token,p_subject:subject,p_message:message});setFeedback(result.error?result.error.message:"Solicitação enviada para a equipe de pós-venda.");setBusy(false);if(!result.error)load()}
 async function send(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=new FormData(event.currentTarget);await quickRequest(String(form.get("subject")||"Atendimento"),String(form.get("message")||""));if(!error)event.currentTarget.reset()}

 if(loading)return <div className="customer-portal-loading"><img src="/evora-brand.svg" alt="Évora Urbanismo"/><div className="spinner"/><p>Preparando seu portal...</p></div>;
 if(error)return <div className="customer-portal-error"><img src="/evora-brand.svg" alt="Évora Urbanismo"/><h1>Acesso indisponível</h1><p>{error}</p></div>;

 const cfg=data.settings||{},items=data.content||[],featured=items.filter((item:any)=>item.featured),feed=items.filter((item:any)=>!item.featured),first=String(data.customer?.name||"Cliente").split(" ")[0],progress=Number(data.journey?.progress||0);
 const shortcuts=[
  {icon:"▤",label:"Extrato financeiro",hint:"Parcelas e vencimentos",href:"#financeiro"},
  {icon:"▧",label:"Segunda via do boleto",hint:"Solicitar ao financeiro",action:()=>quickRequest("Segunda via de cobrança",`Solicito a segunda via da cobrança do contrato ${data.contract.number}.`)},
  {icon:"✓",label:"Valores pagos",hint:"Demonstrativo recebido",href:"#pagos"},
  {icon:"↗",label:"Antecipação ou quitação",hint:"Receber simulação",action:()=>quickRequest("Antecipação ou quitação",`Solicito uma simulação de antecipação ou quitação do contrato ${data.contract.number}.`)},
  {icon:"▦",label:"Empreendimento",hint:"Obra e unidade",href:"#empreendimento"},
  {icon:"•••",label:"Acesso e senha",hint:"Atualizar segurança",action:()=>quickRequest("Alteração de acesso",`Solicito orientação para alteração das credenciais de acesso ao portal do contrato ${data.contract.number}.`)},
 ];

 return <div className="consumer-portal-v64" style={{"--portal-primary":cfg.theme_primary||"#1D5271","--portal-accent":cfg.theme_accent||"#79B82B"} as React.CSSProperties}>
  <header className="consumer-top"><img src="/evora-brand.svg" alt="Évora Urbanismo"/><span>Portal do cliente</span><b>●</b></header>
  <section className="consumer-greeting"><small>OLÁ,</small><h1>{first}</h1><p>{data.project?.name} · Unidade {data.unit?.code}</p></section>
  <main>
   <section className="consumer-shortcuts">{shortcuts.map(item=>item.href?<a key={item.label} href={item.href}><b>{item.icon}</b><span>{item.label}<small>{item.hint}</small></span></a>:<button key={item.label} disabled={busy} onClick={item.action}><b>{item.icon}</b><span>{item.label}<small>{item.hint}</small></span></button>)}</section>
   {feedback&&<button className="consumer-feedback" onClick={()=>setFeedback("")}>{feedback}<span>×</span></button>}

   <section id="empreendimento" className="consumer-card consumer-project-card"><header><div><small>ACOMPANHE A OBRA</small><h2>{data.project?.name}</h2></div><a href="#obra">Mais detalhes</a></header><div className="consumer-progress"><div className="consumer-gauge" style={{"--progress":`${Math.min(100,progress)}%`} as React.CSSProperties}><strong>{progress}%</strong><small>total</small></div><div><b>{data.project?.name}</b><span>Quadra {data.unit?.block} · Lote {data.unit?.lot}</span><p>{data.journey?.next_action||"Acompanhamento regular"}</p></div></div></section>

   <section className="consumer-card consumer-finance-summary"><header><div><small>FINANCEIRO</small><h2>{financial.length} parcelas</h2></div><a href="#financeiro">Extrato financeiro</a></header><div className="consumer-status-bar"><i className="paid" style={{flex:summary.paidCount||0}}/><i className="overdue" style={{flex:summary.overdueCount||0}}/><i className="due" style={{flex:summary.dueCount||0}}/><i className="open" style={{flex:summary.openCount||1}}/></div><div className="consumer-legend"><span><i className="paid"/>Pago <b>{summary.paidCount}</b></span><span><i className="overdue"/>Atraso <b>{summary.overdueCount}</b></span><span><i className="due"/>Vence <b>{summary.dueCount}</b></span><span><i className="open"/>Aberto <b>{summary.openCount}</b></span></div><footer><strong>{data.project?.name}</strong><span>{data.unit?.code}</span></footer></section>

   {featured.length>0&&<section className="consumer-card consumer-feature"><header><small>DESTAQUES</small><h2>Novidades para você</h2></header><div>{featured.slice(0,3).map((item:any)=><article key={item.id}>{item.media_url&&item.content_type==="video"?<iframe src={embed(item.media_url)} title={item.title} allowFullScreen/>:item.media_url?<img src={item.media_url} alt=""/>:<span className="consumer-placeholder">É</span>}<div><small>{item.content_type}</small><h3>{item.title}</h3><p>{item.subtitle||item.body}</p>{item.cta_url&&<a href={item.cta_url} target="_blank">{item.cta_label||"Saiba mais"}</a>}</div></article>)}</div></section>}

   <section id="obra" className="consumer-card"><header><small>EVOLUÇÃO</small><h2>Andamento da obra</h2></header><div className="consumer-milestones">{(data.milestones||[]).map((milestone:any)=><article key={milestone.id}><div><strong>{milestone.title}</strong><small>{milestone.description}</small></div><span>{milestone.progress}%</span><i><b style={{width:`${milestone.progress}%`}}/></i></article>)}{!data.milestones?.length&&<p>As próximas atualizações técnicas serão publicadas aqui.</p>}</div></section>

   {feed.length>0&&<section className="consumer-card consumer-news"><header><small>CONTEÚDO</small><h2>Notícias e orientações</h2></header><div>{feed.map((item:any)=><article key={item.id}>{item.media_url&&item.content_type==="video"?<iframe src={embed(item.media_url)} title={item.title}/>:item.media_url?<img src={item.media_url} alt=""/>:null}<div><h3>{item.title}</h3><p>{item.subtitle||item.body}</p></div></article>)}</div></section>}

   <section id="financeiro" className="consumer-card"><header><small>EXTRATO FINANCEIRO</small><h2>Parcelas do contrato</h2></header><div className="consumer-financial-list">{financial.map((item:any)=><article key={item.id}><span><strong>{item.description}</strong><small>{date(item.due_date)}</small></span><b>{brl.format(Number(item.amount))}</b><i data-status={item.status}>{item.status}</i></article>)}</div></section>

   <section id="pagos" className="consumer-card"><header><small>DEMONSTRATIVO</small><h2>Valores pagos</h2></header><div className="consumer-paid-total"><span>Total confirmado</span><strong>{brl.format(summary.paid)}</strong></div><div className="consumer-financial-list">{financial.filter((item:any)=>["recebido","pago","liquidado"].includes(String(item.status).toLowerCase())).map((item:any)=><article key={item.id}><span><strong>{item.description}</strong><small>{date(item.due_date)}</small></span><b>{brl.format(Number(item.amount))}</b><i data-status="recebido">recebido</i></article>)}</div></section>

   <section id="documentos" className="consumer-card"><header><small>DOCUMENTOS</small><h2>Arquivos do contrato</h2></header><div className="consumer-documents">{(data.documents||[]).map((doc:any)=><article key={doc.id}><b>▧</b><span><strong>{doc.name}</strong><small>{doc.type} · {doc.notes||"Documento disponível"}</small></span></article>)}{!data.documents?.length&&<p>Nenhum documento foi liberado.</p>}</div></section>

   <section id="atendimento" className="consumer-card consumer-contact"><div><small>ATENDIMENTO</small><h2>Fale com a Évora</h2><p>Solicitações ficam vinculadas ao histórico do seu contrato.</p><div>{(data.messages||[]).slice(-5).map((message:any)=><article key={message.id}><strong>{message.sender_name||message.sender_type}</strong><p>{message.message}</p><small>{new Date(message.created_at).toLocaleString("pt-BR")}</small></article>)}</div></div><form onSubmit={send}><label>Assunto<input name="subject" required placeholder="Como podemos ajudar?"/></label><label>Mensagem<textarea name="message" rows={5} required/></label><button disabled={busy}>{busy?"Enviando...":"Enviar mensagem"}</button></form></section>
  </main>
  <footer className="consumer-footer"><img src="/evora-brand.svg" alt="Évora Urbanismo"/><span>Ambiente pessoal e protegido · Contrato {data.contract?.number}</span></footer>
 </div>
}
