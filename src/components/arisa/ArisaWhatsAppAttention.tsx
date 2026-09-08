"use client";
import {useEffect,useState} from "react";
import {workspaceCall,displayDate} from "./workspace-client";
import {errorText} from "./chat-client";
import styles from "./workspace.module.css";
type Recipient={user_id:string;name:string;phone:string|null;enabled:boolean};
type RequestItem={id:string;summary:string;status:string;phone:string;contact_name:string|null;created_at:string;approved_content:string|null};
type Notice={title:string;message:string;recipient_name:string;status:string;delivery_status?:string;created_at:string};
type Attention={recipients:Recipient[];requests:RequestItem[];notices:Notice[]};
const states:Record<string,string>={pending:"Na fila",processing:"Processando",sending:"Enviando",awaiting_contact:"Falta vincular o WhatsApp do usuário",awaiting_template:"Aguardando aprovação do modelo pela Meta",sent:"Envio aceito pela Meta",failed:"Falha no envio",unknown:"Resultado não confirmado",skipped:"Aviso suspenso",approved:"Texto autorizado",denied:"Não autorizado"};
const stateLabel=(state:string)=>states[state]||state;
export default function ArisaWhatsAppAttention({organizationId}:{organizationId:string}){
 const [data,setData]=useState<Attention|null>(null),[revision,setRevision]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const [drafts,setDrafts]=useState<Record<string,string>>({}),[phones,setPhones]=useState<Record<string,string>>({});
 useEffect(()=>{let alive=true;workspaceCall("arisa-whatsapp",{action:"attention",organizationId}).then(value=>{if(alive){setData(value);setPhones(Object.fromEntries((value.recipients||[]).map((r:Recipient)=>[r.user_id,r.phone||""])));}}).catch(reason=>{if(alive)setError(errorText(reason));});return()=>{alive=false};},[organizationId,revision]);
 async function perform(action:string,args:Record<string,unknown>){if(busy)return;setBusy(true);setError("");setNotice("");try{const value=await workspaceCall("arisa-whatsapp",{action,organizationId,args});setNotice(action==="authorize"?(value.accepted_by_meta?"O texto autorizado foi aceito para envio pela Meta.":"O resultado do envio ainda não foi confirmado."):action==="deny"?"Compartilhamento não autorizado.":"Preferência de aviso salva.");setRevision(v=>v+1);}catch(reason){setError(errorText(reason));}finally{setBusy(false);}}
 return <section className={styles.card} aria-labelledby="arisa-attention-title">
  <h3 id="arisa-attention-title">Solicitações e avisos aos usuários</h3>
  <p>A Arisa avisa na plataforma quando uma conversa envolve um usuário. O WhatsApp recebe um aviso para consultar a solicitação na conta, preservando os detalhes internos.</p>
  <button disabled={busy} onClick={()=>setRevision(v=>v+1)}>Atualizar solicitações e avisos</button>
  {error&&<p role="alert" className={styles.error}>{error}</p>}{notice&&<p role="status">{notice}</p>}
  <details><summary>WhatsApp de cada usuário</summary><p>Vincule apenas um número confirmado com o usuário. Fora da janela de 24 horas, o aviso aguarda o modelo aprovado pela Meta.</p>
   {data?.recipients.map(r=><div className={styles.card} key={r.user_id}><label>{r.name}<input type="tel" value={phones[r.user_id]||""} placeholder="+55 DDD e número" onChange={e=>setPhones(v=>({...v,[r.user_id]:e.target.value}))}/></label><small>{r.enabled?"Avisos habilitados":"Avisos sem número ou pausados"}</small><div className={styles.row}><button disabled={busy||!phones[r.user_id]?.trim()} onClick={()=>void perform("save_recipient",{user_id:r.user_id,phone:phones[r.user_id],enabled:true})}>Salvar e habilitar avisos</button>{r.enabled&&<button disabled={busy} onClick={()=>void perform("save_recipient",{user_id:r.user_id,phone:r.phone,enabled:false})}>Pausar avisos</button>}</div></div>)}
  </details>
  <h4>Autorização para compartilhar informações</h4>
  <p>Informações internas e sensíveis permanecem protegidas. Uma aprovação permite enviar somente o texto escrito abaixo ao contato indicado; ela não libera outros dados.</p>
  {data&&!data.requests.length&&<p>Nenhuma solicitação de autorização registrada.</p>}
  {data?.requests.map(r=><article className={styles.card} key={r.id}><strong>{r.contact_name||"Contato"} · +{r.phone}</strong><p>{r.summary}</p><small>{displayDate(r.created_at)} · {stateLabel(r.status)}</small>{r.status==="pending"&&<><label>Texto exato autorizado para este contato<textarea rows={4} maxLength={4096} value={drafts[r.id]||""} onChange={e=>setDrafts(v=>({...v,[r.id]:e.target.value}))}/></label><div className={styles.row}><button disabled={busy||!drafts[r.id]?.trim()} onClick={()=>void perform("authorize",{id:r.id,content:drafts[r.id]})}>Autorizar e enviar este texto</button><button disabled={busy} onClick={()=>void perform("deny",{id:r.id})}>Não autorizar</button></div></>}</article>)}
  <details><summary>Avisos recentes pelo WhatsApp</summary>{data&&!data.notices.length&&<p>Nenhum aviso registrado.</p>}{data?.notices.map((n,i)=><article className={styles.card} key={`${n.created_at}:${i}`}><strong>{n.recipient_name} · {n.title}</strong><p>{n.message}</p><small>{displayDate(n.created_at)} · {n.delivery_status==="delivered"||n.delivery_status==="read"?"Entrega confirmada":stateLabel(n.status)}</small></article>)}</details>
 </section>;
}
