import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import { isObject, ManagerError, UUID, type Obj } from "../_shared/arisa-manager.ts";
import { sha256 } from "../_shared/arisa-document.ts";
import { ARISA_EMAIL, GOOGLE_SCOPES, authorizationUrl, base64url, gmail, googleToken } from "../_shared/arisa-mail.ts";
import { mailService, reconcileArisaMail, sendArisaMail, syncArisaMail } from "../_shared/arisa-mail-runtime.ts";

const HEADERS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type,x-client-info","access-control-allow-methods":"POST,OPTIONS","cache-control":"no-store","content-type":"application/json; charset=utf-8","x-content-type-options":"nosniff"};
const ERRORS: Record<string,string>={
  MAIL_REQUEST_CHANGED:"Este pedido já foi arquivado com outro conteúdo. Consulte seu registro e use um novo pedido para uma mensagem diferente.",
  SESSION_REQUIRED:"Entre na plataforma com uma conta administrativa.", ADMIN_REQUIRED:"A configuração de e-mail exige um administrador ativo.",
  GOOGLE_NOT_CONFIGURED:"Cadastre o ID e o segredo do cliente OAuth do Google na tela de e-mail da Arisa.", GOOGLE_NOT_CONNECTED:"Conecte arisa@evoraurbanismo.com.br pelo botão Conectar Google Workspace.",
  GOOGLE_CLIENT_INVALID:"Confira o ID e o segredo do cliente OAuth do tipo Aplicativo da Web.", GOOGLE_ACCOUNT_MISMATCH:"Autorize a conta arisa@evoraurbanismo.com.br e conceda as permissões de leitura e envio.", GOOGLE_STATE_EXPIRED:"Esta tentativa de conexão expirou ou já foi utilizada. Inicie novamente pelo botão Conectar.", GOOGLE_RECONNECT_REQUIRED:"A autorização Google precisa ser renovada. Reconecte a conta.",
  MAIL_RECIPIENT_INVALID:"Informe destinatários válidos, sem nomes ou quebras de linha nos endereços.", MAIL_INVALID:"Informe assunto, conteúdo e destinatários válidos.", MAIL_ATTACHMENT_INVALID:"Um anexo não está disponível nesta conta ou não passou na verificação de integridade.", MAIL_ATTACHMENTS_TOO_LARGE:"Use até 10 anexos, totalizando no máximo 18 MB por e-mail.", MAIL_ARCHIVE_FAILED:"Não foi possível concluir o arquivamento. Nenhum reenvio automático será feito.",
  GOOGLE_LIMIT:"O Google atingiu um limite temporário. O conteúdo permanece arquivado.", MAIL_SYNC_CONTINUE:"A sincronização continuará no próximo ciclo; as mensagens já arquivadas estão preservadas.", MAIL_SERVICE_UNAVAILABLE:"A integração não concluiu esta etapa. Consulte o arquivo e tente novamente.",
};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:HEADERS});
const envKey=(name:string)=>{try{const v=JSON.parse(Deno.env.get(name)||"{}");return typeof v.default==="string"?v.default:"";}catch{return "";}};

export async function handleMail(request:Request):Promise<Response>{
  if(request.method==="OPTIONS")return new Response(null,{status:204,headers:HEADERS});
  if(request.method!=="POST")return json({ok:false,error:"METHOD_NOT_ALLOWED"},405);
  const reference=crypto.randomUUID();
  let archiveError:((code:string)=>Promise<unknown>)|null=null;
  try{
    const authorization=request.headers.get("authorization")||"";
    if(!/^Bearer \S+$/i.test(authorization)||authorization.length>9000)throw new ManagerError("SESSION_REQUIRED",401);
    if(Number(request.headers.get("content-length")||0)>200000)throw new ManagerError("MAIL_INVALID",422);
    const text=await request.text();if(text.length>200000)throw new ManagerError("MAIL_INVALID",422);
    let body:unknown;try{body=JSON.parse(text);}catch{throw new ManagerError("MAIL_INVALID",422);}
    if(!isObject(body)||typeof body.organizationId!=="string"||!UUID.test(body.organizationId))throw new ManagerError("MAIL_INVALID",422);
    const org=body.organizationId,url=Deno.env.get("SUPABASE_URL")||"",publicKey=envKey("SUPABASE_PUBLISHABLE_KEYS")||Deno.env.get("SUPABASE_ANON_KEY")||"";
    const caller=createClient(url,publicKey,{global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false}});
    const auth=await caller.auth.getUser();if(auth.error||!auth.data.user)throw new ManagerError("SESSION_REQUIRED",401);
    const authorized=await caller.rpc("arisa_admin_catalog",{p_organization_id:org});if(authorized.error)throw new ManagerError("ADMIN_REQUIRED",403);
    const actor=auth.data.user.id,serviceKey=envKey("SUPABASE_SECRET_KEYS")||Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
    const admin=createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    archiveError=code=>mailService(admin,"log",org,actor,{action:body.action,error:code,reference});
    let result:Obj;
    if(body.action==="status")result=await mailService(admin,"status",org,actor);
    else if(body.action==="configure")result=await mailService(admin,"configure",org,actor,{client_id:body.clientId,client_secret:body.clientSecret});
    else if(body.action==="connect"){
      const state=base64url(crypto.getRandomValues(new Uint8Array(32))),verifier=base64url(crypto.getRandomValues(new Uint8Array(48)));
      const challenge=base64url(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier))));
      const config=await mailService(admin,"oauth_begin",org,actor,{state_hash:await sha256(new TextEncoder().encode(state)),verifier});
      result={url:authorizationUrl(String(config.client_id),state,challenge)};
    }else if(body.action==="complete"){
      if(typeof body.state!=="string"||body.state.length>100||typeof body.code!=="string"||body.code.length>4000)throw new ManagerError("GOOGLE_STATE_EXPIRED",409);
      const state_hash=await sha256(new TextEncoder().encode(body.state));
      const config=await mailService(admin,"oauth_consume",org,actor,{state_hash});
      const token=await googleToken(config,body.code,String(config.verifier));
      const scopes=typeof token.scope==="string"?token.scope.split(" "):[];
      if(!GOOGLE_SCOPES.every(scope=>scopes.includes(scope))||typeof token.refresh_token!=="string")throw new ManagerError("GOOGLE_ACCOUNT_MISMATCH",409);
      const profile=await gmail(String(token.access_token),"profile");
      if(String(profile.emailAddress).toLowerCase()!==ARISA_EMAIL)throw new ManagerError("GOOGLE_ACCOUNT_MISMATCH",409);
      result=await mailService(admin,"oauth_finish",org,actor,{state_hash,email:ARISA_EMAIL,refresh_token:token.refresh_token,scopes});
    }else if(body.action==="disconnect"){
      // Revoke at Google when possible, then always discard the local refresh token.
      const config=await mailService(admin,"runtime",org,actor).catch(()=>null);
      if(config)await fetch("https://oauth2.googleapis.com/revoke",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token:String(config.refresh_token)}),signal:AbortSignal.timeout(10000)}).catch(()=>null);
      result=await mailService(admin,"disconnect",org,actor);
    }else if(body.action==="send"){
      if(typeof body.requestId!=="string"||!UUID.test(body.requestId))throw new ManagerError("MAIL_INVALID",422);
      result=await sendArisaMail(caller,admin,org,actor,body,{requestId:body.requestId});
    }else if(body.action==="sync")result=await syncArisaMail(admin,org);
    else if(body.action==="reconcile"){
      const config=await mailService(admin,"runtime",org,actor),token=await googleToken(config);
      result=await reconcileArisaMail(admin,org,String(token.access_token),typeof body.id==="string"?body.id:undefined);
    }else throw new ManagerError("MAIL_INVALID",422);
    return json({ok:true,...result});
  }catch(error){
    const code=error instanceof ManagerError?error.code:"MAIL_SERVICE_UNAVAILABLE";
    await archiveError?.(code).catch(()=>{});
    console.error("arisa-mail",{code,reference});
    return json({ok:false,error:code,message:ERRORS[code]||ERRORS.MAIL_SERVICE_UNAVAILABLE,supportReference:reference},error instanceof ManagerError&&error.status>=400&&error.status<600?error.status:503);
  }
}
Deno.serve(handleMail);
