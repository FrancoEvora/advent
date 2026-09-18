"use client";
import {useEffect,useMemo,useState,type ChangeEvent} from "react";
import {getSupabase} from "@/lib/supabase";
import {normalizeInstagram} from "@/lib/forms/solaris";
import type {CrmRecord} from "../types";
import ai from "./lead-instagram-analysis.module.css";

type InstagramRecord = CrmRecord & {
  instagram_username?: string | null;
  instagram_consent?: boolean;
  instagram_consent_at?: string | null;
  instagram_consent_version?: string | null;
  instagram_source?: string | null;
};
type Confidence="high"|"medium"|"low";
type ProfileAnalysis={
  status:"complete"|"limited"|"not_found";
  summary:string;
  observed_signals:Array<{signal:string;evidence:string;confidence:Confidence}>;
  real_estate_relevance:Array<{theme:string;rationale:string;confidence:Confidence}>;
  approach:{opening:string;validation_questions:string[];cautions:string[]};
  limitations:string[];
};
type AnalysisRow={
  id:string;
  instagram_username:string;
  access_basis?:"lead_consent"|"public_profile";
  retrieval_method?:"web_search"|"meta_business_discovery"|"operator_screenshots";
  analysis_status:string;
  analysis:ProfileAnalysis;
  sources:Array<{url:string;title?:string}>;
  model:string;
  created_at:string;
};
const statusLabel:Record<ProfileAnalysis["status"],string>={complete:"Análise concluída",limited:"Análise parcial",not_found:"Conteúdo insuficiente"};
const confidenceLabel:Record<Confidence,string>={high:"confiança alta",medium:"confiança média",low:"confiança baixa"};
const retrievalLabel:Record<string,string>={web_search:"Busca web pública",meta_business_discovery:"Meta Business Discovery",operator_screenshots:"Capturas públicas enviadas pelo operador"};

function validAnalysis(value:unknown):value is ProfileAnalysis{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  return ["complete","limited","not_found"].includes(String(v.status))&&typeof v.summary==="string"&&Array.isArray(v.observed_signals)&&Array.isArray(v.real_estate_relevance)&&!!v.approach&&typeof v.approach==="object"&&Array.isArray(v.limitations);
}
function sourceLabel(source:{url:string;title?:string}){
  if(source.title?.trim())return source.title.trim();
  return source.url.replace(/^https?:\/\//i,"").split("/")[0]||"Fonte pública";
}
function readDataUrl(blob:Blob):Promise<string>{
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>typeof reader.result==="string"?resolve(reader.result):reject(new Error("Não foi possível ler a imagem."));
    reader.onerror=()=>reject(new Error("Não foi possível ler a imagem."));
    reader.readAsDataURL(blob);
  });
}
async function compressCapture(file:File):Promise<string>{
  if(!["image/jpeg","image/png","image/webp"].includes(file.type))throw new Error("Use capturas JPG, PNG ou WebP.");
  if(file.size>12*1024*1024)throw new Error("Cada captura deve ter no máximo 12 MB.");
  const original=await readDataUrl(file);
  const image=await new Promise<HTMLImageElement>((resolve,reject)=>{
    const next=new Image();
    next.onload=()=>resolve(next);
    next.onerror=()=>reject(new Error("Não foi possível abrir uma das capturas."));
    next.src=original;
  });
  const maxSide=1600,ratio=Math.min(1,maxSide/Math.max(image.naturalWidth,image.naturalHeight));
  const canvas=document.createElement("canvas");
  canvas.width=Math.max(1,Math.round(image.naturalWidth*ratio));
  canvas.height=Math.max(1,Math.round(image.naturalHeight*ratio));
  const context=canvas.getContext("2d");if(!context)throw new Error("Não foi possível preparar a captura.");
  context.drawImage(image,0,0,canvas.width,canvas.height);
  const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,"image/jpeg",.78));
  if(!blob)throw new Error("Não foi possível preparar a captura.");
  const compressed=await readDataUrl(blob);
  if(compressed.length>1800000)throw new Error("Uma captura continuou muito grande após a compressão. Recorte a tela e tente novamente.");
  return compressed;
}

/** Manual edits never grant consent; replacing a handle invalidates previous authorization. */
export function buildInstagramPayload(form: FormData, record: CrmRecord | null): Record<string, unknown> {
  const lead = record as InstagramRecord | null;
  const raw = String(form.get("instagramUsername") || "").trim();
  const username = normalizeInstagram(raw);
  if (raw && !username) throw new Error("Instagram inválido. Informe o @ ou o link de um perfil, ou deixe o campo em branco.");
  const changed = username !== (lead?.instagram_username || null);
  const revoked = form.get("instagramRevokeConsent") === "yes";
  if (!changed && !revoked) return {};
  return {
    instagram_username: username,
    instagram_consent: false,
    instagram_consent_at: null,
    instagram_consent_version: null,
    ...(changed ? {instagram_source: username ? "crm_manual" : null} : {}),
  };
}

export function LeadInstagramFields({lead: record}: {lead: CrmRecord | null}) {
  const lead = record as InstagramRecord | null;
  const [value, setValue] = useState(lead?.instagram_username || "");
  const [revoke, setRevoke] = useState(false);
  const [analysis,setAnalysis]=useState<AnalysisRow|null>(null);
  const [analysisBusy,setAnalysisBusy]=useState(false);
  const [analysisError,setAnalysisError]=useState("");
  const username = normalizeInstagram(value);
  const savedUsername=lead?.instagram_username||null;
  const changed = username !== savedUsername;
  const authorized = !!lead?.instagram_consent && !changed && !revoke;
  const canAnalyze=!!lead?.id&&!!lead?.organization_id&&!!username&&!changed;
  const consentDate = lead?.instagram_consent_at ? new Date(lead.instagram_consent_at) : null;
  const timestamp = consentDate && !Number.isNaN(consentDate.getTime())
    ? consentDate.toLocaleString("pt-BR", {timeZone: "America/Sao_Paulo"}) : null;
  const analysisTimestamp=useMemo(()=>{
    if(!analysis?.created_at)return null;
    const date=new Date(analysis.created_at);
    return Number.isNaN(date.getTime())?null:date.toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"});
  },[analysis?.created_at]);

  useEffect(()=>{
    let active=true;
    setAnalysisError("");
    if(!lead?.id||!lead.organization_id||!savedUsername){setAnalysis(null);return()=>{active=false};}
    const client=getSupabase();
    if(!client)return()=>{active=false};
    client.from("crm_instagram_profile_analyses")
      .select("id,instagram_username,access_basis,analysis_status,analysis,sources,model,created_at")
      .eq("organization_id",lead.organization_id)
      .eq("crm_record_id",lead.id)
      .eq("instagram_username",savedUsername)
      .order("created_at",{ascending:false})
      .limit(1).maybeSingle()
      .then(({data,error})=>{
        if(!active)return;
        if(error){setAnalysis(null);return;}
        if(data&&validAnalysis(data.analysis))setAnalysis(data as AnalysisRow);else setAnalysis(null);
      });
    return()=>{active=false};
  },[lead?.id,lead?.organization_id,savedUsername]);

  async function analyzeProfile(){
    if(!canAnalyze||analysisBusy)return;
    const client=getSupabase();if(!client)return;
    setAnalysisBusy(true);setAnalysisError("");
    try{
      const {data,error}=await client.functions.invoke("crm-instagram-profile-analysis",{body:{action:"analyze",organizationId:lead!.organization_id,crmRecordId:lead!.id}});
      if(error){
        let message="Não foi possível concluir a análise agora.";
        const context=(error as unknown as {context?:Response}).context;
        if(context){const body=await context.clone().json().catch(()=>null) as {message?:string}|null;if(body?.message)message=body.message;}
        throw new Error(message);
      }
      const row=(data as {analysis?:AnalysisRow}|null)?.analysis;
      if(!row||!validAnalysis(row.analysis))throw new Error("A IA não retornou uma análise válida.");
      setAnalysis(row);
    }catch(cause){setAnalysisError(cause instanceof Error?cause.message:"Não foi possível concluir a análise agora.");}
    finally{setAnalysisBusy(false);}
  }

  async function analyzeCaptures(event:ChangeEvent<HTMLInputElement>){
    const input=event.currentTarget;
    const files=Array.from(input.files||[]);
    input.value="";
    if(!files.length||analysisBusy)return;
    if(!canAnalyze)return setAnalysisError("Salve o Instagram antes de enviar capturas.");
    if(files.length>4)return setAnalysisError("Envie no máximo 4 capturas por análise.");
    const client=getSupabase();if(!client)return;
    setAnalysisBusy(true);setAnalysisError("");
    try{
      const images=await Promise.all(files.map(compressCapture));
      const {data,error}=await client.functions.invoke("crm-instagram-profile-analysis",{body:{action:"analyze_captures",organizationId:lead!.organization_id,crmRecordId:lead!.id,images:images.map(data_url=>({data_url}))}});
      if(error){
        let message="Não foi possível analisar as capturas agora.";
        const context=(error as unknown as {context?:Response}).context;
        if(context){const body=await context.clone().json().catch(()=>null) as {message?:string}|null;if(body?.message)message=body.message;}
        throw new Error(message);
      }
      const row=(data as {analysis?:AnalysisRow}|null)?.analysis;
      if(!row||!validAnalysis(row.analysis))throw new Error("A IA não retornou uma análise válida.");
      setAnalysis(row);
    }catch(cause){setAnalysisError(cause instanceof Error?cause.message:"Não foi possível analisar as capturas agora.");}
    finally{setAnalysisBusy(false);}
  }

  return <section className="buyer-form-section" aria-labelledby="lead-instagram-title">
    <h3 id="lead-instagram-title">Instagram e personalização do atendimento</h3>
    <label>Instagram (opcional)
      <input name="instagramUsername" value={value} onChange={event => {setValue(event.target.value);setAnalysisError("");}} placeholder="@seuperfil ou link do perfil" maxLength={200} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby="lead-instagram-note" />
    </label>
    {username && <p><a href={`https://www.instagram.com/${username}/`} target="_blank" rel="noopener noreferrer">Abrir perfil informado: @{username} ↗</a></p>}
    <p role="status"><strong>{authorized ? "Personalização autorizada pelo lead" : username ? "Perfil informado · análise restrita a conteúdo público" : "Instagram não informado"}</strong></p>
    {authorized && <p>{timestamp ? `Autorização registrada em ${timestamp} (Brasília). ` : ""}{lead?.instagram_consent_version ? `Termo: ${lead.instagram_consent_version}.` : ""}</p>}
    {lead?.instagram_source && <p>Origem do perfil: {lead.instagram_source === "solaris_landing_page" ? "formulário da landing page do Solaris" : "cadastro manual no CRM"}.</p>}
    {lead?.instagram_consent && <label style={{display:"flex",alignItems:"flex-start",gap:8}}><input style={{width:18,height:18,flex:"0 0 18px"}} type="checkbox" name="instagramRevokeConsent" value="yes" checked={revoke} onChange={event => setRevoke(event.target.checked)} /><span>Retirar autorização de personalização ao salvar o cadastro.</span></label>}

    <div className={ai.analysisBlock}>
      <div className={ai.actionRow}>
        <button className={ai.analyzeButton} type="button" onClick={analyzeProfile} disabled={!canAnalyze||analysisBusy}>{analysisBusy?"Analisando…":"Analisar perfil"}</button>
        <label className={`${ai.captureButton} ${!canAnalyze||analysisBusy?ai.captureDisabled:""}`}>
          Analisar capturas
          <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden disabled={!canAnalyze||analysisBusy} onChange={analyzeCaptures}/>
        </label>
      </div>
      {!username&&<p className={ai.helper}>Informe e salve o Instagram para disponibilizar a análise.</p>}
      {username&&changed&&<p className={ai.helper}>Salve o cadastro antes de analisar o novo perfil.</p>}
      {username&&!changed&&!authorized&&<p className={ai.helper}>Sem autorização específica, a IA analisará exclusivamente conteúdo publicamente acessível do perfil informado e fontes públicas relacionadas, sem contornar login, perfil privado ou outras restrições de acesso.</p>}
      {username&&!changed&&<p className={ai.helper}>A IA usa a mesma configuração OpenAI da Arisa. Primeiro tenta a API oficial da Meta para contas profissionais; se o Instagram não estiver disponível, você pode enviar até 4 capturas públicas do perfil. O resultado serve para preparar a conversa, nunca para crédito, preço, elegibilidade ou tratamento desfavorável.</p>}
      {analysisError&&<p className={ai.error} role="alert">{analysisError}</p>}

      {analysis&&validAnalysis(analysis.analysis)&&<article className={ai.card} aria-label="Análise de IA do perfil do Instagram">
        <div className={ai.cardHeader}><div><span className={ai.eyebrow}>ANÁLISE DE IA · PERFIL PÚBLICO</span><strong>@{analysis.instagram_username}</strong></div><span className={ai.badge}>{statusLabel[analysis.analysis.status]}</span></div>
        <p className={ai.summary}>{analysis.analysis.summary}</p>

        {!!analysis.analysis.observed_signals.length&&<><h4 className={ai.sectionTitle}>Sinais observáveis</h4><ul className={ai.list}>{analysis.analysis.observed_signals.map((item,index)=><li key={index}><strong>{item.signal}</strong><small>{item.evidence} · {confidenceLabel[item.confidence]}</small></li>)}</ul></>}
        {!!analysis.analysis.real_estate_relevance.length&&<><h4 className={ai.sectionTitle}>Hipóteses úteis para o atendimento</h4><ul className={ai.list}>{analysis.analysis.real_estate_relevance.map((item,index)=><li key={index}><strong>{item.theme}</strong><small>{item.rationale} · {confidenceLabel[item.confidence]}</small></li>)}</ul></>}

        <h4 className={ai.sectionTitle}>Abordagem sugerida</h4>
        <p className={ai.opening}>{analysis.analysis.approach.opening}</p>
        {!!analysis.analysis.approach.validation_questions.length&&<ol className={ai.questionList}>{analysis.analysis.approach.validation_questions.map((item,index)=><li key={index}>{item}</li>)}</ol>}

        {!!analysis.analysis.approach.cautions.length&&<><h4 className={ai.sectionTitle}>Cuidados</h4><ul className={ai.list}>{analysis.analysis.approach.cautions.map((item,index)=><li key={index}>{item}</li>)}</ul></>}
        {!!analysis.analysis.limitations.length&&<><h4 className={ai.sectionTitle}>Limitações da leitura</h4><ul className={ai.list}>{analysis.analysis.limitations.map((item,index)=><li key={index}>{item}</li>)}</ul></>}
        {!!analysis.sources?.length&&<><h4 className={ai.sectionTitle}>Fontes públicas consultadas</h4><div className={ai.sources}>{analysis.sources.slice(0,12).map((source,index)=><a key={source.url+index} href={source.url} target="_blank" rel="noopener noreferrer">{sourceLabel(source)} ↗</a>)}</div></>}
        <p className={ai.meta}>{analysisTimestamp?`Analisado em ${analysisTimestamp} (Brasília). `:""}{analysis.retrieval_method?`Coleta: ${retrievalLabel[analysis.retrieval_method]||analysis.retrieval_method}. `:""}{analysis.access_basis==="public_profile"?"Base de acesso: conteúdo público. ":"Base de acesso: autorização registrada pelo lead. "}A análise é uma hipótese comercial e deve ser validada na conversa com o lead.</p>
      </article>}
    </div>

    <p id="lead-instagram-note" style={{fontSize:12,lineHeight:1.6}}>Perfil fornecido, não verificado. Cadastrar ou alterar o @ não conecta a conta. A coleta automática pela Meta funciona apenas quando a plataforma disponibiliza o perfil à API; para os demais casos, use capturas de conteúdo publicamente acessível. Alterar o perfil remove eventual autorização anterior. O atendimento continua normalmente sem Instagram.</p>
  </section>;
}
