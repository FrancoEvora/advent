import type { SupabaseClient } from "npm:@supabase/supabase-js@2.110.7";
import { isObject, ManagerError, operationKey, UUID, type Obj } from "./arisa-manager.ts";
import { metaWhatsApp, normalizeWhatsAppPhone, templateComponents, whatsappRuntime } from "./arisa-whatsapp.ts";

type Context={requestId:string;messageId?:string;lease?:string};
async function service(admin:SupabaseClient,action:string,org:string,actor:string,args:Obj={}):Promise<Obj>{
  const result=await admin.rpc("arisa_whatsapp_service",{p_action:action,p_org:org,p_actor:actor,p_args:args});
  if(result.error){const message=String(result.error.message||"");if(result.error.code==="42501") throw new ManagerError(message.includes("BLOCKED")?"WHATSAPP_CONTACT_BLOCKED":"ADMIN_REQUIRED",403);if(/^[A-Z_]+$/.test(message)) throw new ManagerError(message,409);throw new ManagerError("WHATSAPP_UNAVAILABLE",503);}
  return isObject(result.data)?result.data:{};
}
async function credentials(admin:SupabaseClient,org:string){
  const result=await admin.rpc("get_whatsapp_runtime_credentials",{p_organization_id:org});
  if(result.error) throw new ManagerError("WHATSAPP_NOT_CONFIGURED",409);
  return whatsappRuntime(result.data);
}
async function approvedTemplates(admin:SupabaseClient,org:string){
  const runtime=await credentials(admin,org);const templates:Obj[]=[];let cursor:string|undefined;let pages=0;
  do{
    const query=new URLSearchParams({fields:"name,language,status,category,components,parameter_format",limit:"100"});if(cursor)query.set("after",cursor);
    const result=await metaWhatsApp(runtime,`${runtime.waba_id}/message_templates?${query}`);
    const rows=Array.isArray(result.data)?result.data.filter(isObject):[];
    templates.push(...rows.filter(row=>row.status==="APPROVED").map(row=>({name:row.name,language:row.language,category:row.category,parameter_format:row.parameter_format,components:Array.isArray(row.components)?row.components:[]})));
    const paging=isObject(result.paging)?result.paging:{},cursors=isObject(paging.cursors)?paging.cursors:{};cursor=typeof cursors.after==="string"?cursors.after:undefined;pages++;
  }while(cursor&&pages<5);
  return {runtime,templates};
}
function providerMessageId(result:Obj){const messages=Array.isArray(result.messages)?result.messages.filter(isObject):[];const id=messages[0]?.id;if(typeof id!=="string"||id.length<8||id.length>512) throw new ManagerError("WHATSAPP_UNAVAILABLE",502);return id;}
async function operationState(admin:SupabaseClient,org:string,actor:string,id:string){if(!UUID.test(id))throw new ManagerError("WHATSAPP_INVALID",422);return service(admin,"get",org,actor,{id});}

export async function runWhatsAppTool(admin:SupabaseClient,org:string,actor:string,action:string,args:Obj={},context?:Context):Promise<Obj>{
  if(action==="status"){
    const state=await service(admin,"status",org,actor);return {...state,configuration:"/arisa?painel=whatsapp",window_rule:"Texto livre somente dentro de 24h da última mensagem recebida; fora da janela, template aprovado pela Meta."};
  }
  if(action==="templates"){
    const {templates}=await approvedTemplates(admin,org);return {templates,count:templates.length,checked_at:new Date().toISOString(),note:"Somente templates com status APPROVED são retornados."};
  }
  if(action==="get") return operationState(admin,org,actor,String(args.operation_id||""));
  if(action==="reconcile"){
    const op=await operationState(admin,org,actor,String(args.operation_id||""));
    if(op.status==="completed")return {...(isObject(op.result)?op.result:{}),replayed:true};
    return {ok:false,status:op.status,operation_id:op.id,delivery_status:op.delivery_status,provider_message_id:op.provider_message_id??null,message:op.status==="unknown"?"O resultado do envio não foi confirmado. Não reenviar automaticamente; aguarde o webhook ou confira o contato.":"Envio ainda não concluído."};
  }
  if(action!=="send"||!context||!UUID.test(context.requestId)) throw new ManagerError("WHATSAPP_INVALID",422);
  const phone=normalizeWhatsAppPhone(args.phone);if(typeof args.content!=="string"||!args.content.trim()||args.content.length>12000)throw new ManagerError("WHATSAPP_INVALID",422);
  const content=args.content.trim();const templateName=typeof args.template_name==="string"&&args.template_name.trim()?args.template_name.trim():undefined;const templateLanguage=typeof args.template_language==="string"&&args.template_language.trim()?args.template_language.trim():"pt_BR";const components=templateComponents(args.template_components);
  if(templateName){
    const {templates}=await approvedTemplates(admin,org);if(!templates.some(row=>row.name===templateName&&row.language===templateLanguage))throw new ManagerError("WHATSAPP_TEMPLATE_NOT_FOUND",422);
  }
  const payload={actor,request:context.requestId,phone,content,template_name:templateName??null,template_language:templateLanguage,template_components:components,contact_id:args.contact_id??null};const key=await operationKey("whatsapp_send",payload);
  const op=await service(admin,"prepare",org,actor,{operation_key:key,payload_hash:await operationKey("whatsapp_payload",payload),message_id:context.messageId??null,lease:context.lease??null,phone,contact_id:args.contact_id??null,contact_name:args.contact_name??null,contact_type:args.contact_type??null,content,template_name:templateName??null,template_language:templateLanguage,template_components:components});
  if(!op.proceed)return runWhatsAppTool(admin,org,actor,"reconcile",{operation_id:op.id},context);
  const claim=await service(admin,"claim",org,actor,{id:op.id});if(!claim.proceed)return runWhatsAppTool(admin,org,actor,"reconcile",{operation_id:op.id},context);
  let writeStarted=false;
  try{
    const runtime=await credentials(admin,org);let body:Obj;
    if(claim.send_mode==="template")body={messaging_product:"whatsapp",recipient_type:"individual",to:phone,type:"template",template:{name:claim.template_name,language:{code:claim.template_language},components:claim.template_components}};
    else body={messaging_product:"whatsapp",recipient_type:"individual",to:phone,type:"text",text:{preview_url:false,body:content}};
    writeStarted=true;const provider=await metaWhatsApp(runtime,`${runtime.phone_number_id}/messages`,{method:"POST",body:JSON.stringify(body)});const providerId=providerMessageId(provider);return service(admin,"finish",org,actor,{id:op.id,provider_message_id:providerId});
  }catch(error){
    const known=error instanceof ManagerError&&[400,401,403,409,422,429].includes(error.status);const code=error instanceof ManagerError?error.code:"WHATSAPP_UNAVAILABLE";const status=!writeStarted||known?"failed":"unknown";await service(admin,"fail",org,actor,{id:op.id,status,error:code}).catch(()=>{});if(status==="unknown")return {ok:false,status,operation_id:op.id,message:"A Meta não confirmou o resultado. Não reenviar automaticamente; use reconcile e aguarde os status do webhook."};throw error;
  }
}
