import { isObject, ManagerError, type Obj } from "./arisa-manager.ts";

export const WHATSAPP_ERRORS: Record<string,string> = {
  WHATSAPP_NOT_CONFIGURED: "O WhatsApp Business ainda não está ativo para a Évora. Abra Arisa → Comunicações → WhatsApp para concluir a conexão.",
  WHATSAPP_TEMPLATE_REQUIRED: "Este contato está fora da janela de 24 horas. Para iniciar ou retomar a conversa, use um template aprovado pela Meta.",
  WHATSAPP_TEMPLATE_NOT_FOUND: "O template informado não está aprovado ou não existe no WhatsApp Business conectado. Consulte os templates disponíveis antes de enviar.",
  WHATSAPP_CONTACT_NOT_FOUND: "Não encontrei o contato informado na organização.",
  WHATSAPP_PHONE_INVALID: "O contato não possui um número de WhatsApp válido.",
  WHATSAPP_CONTACT_BLOCKED: "Este contato está bloqueado para comunicação na plataforma.",
  WHATSAPP_INVALID: "A mensagem do WhatsApp está incompleta ou inválida.",
  WHATSAPP_REQUEST_CHANGED: "Esta solicitação já foi registrada com outro conteúdo. Consulte o envio anterior antes de criar outro.",
  WHATSAPP_NOT_FOUND: "O envio do WhatsApp não foi encontrado.",
  WHATSAPP_BUSY: "Este envio já está em andamento. Aguarde ou consulte o resultado antes de tentar novamente.",
  WHATSAPP_LIMIT: "A Meta aplicou um limite temporário ao WhatsApp. O envio não será repetido automaticamente.",
  WHATSAPP_AUTH_REQUIRED: "A conexão da WhatsApp Business Platform precisa ser renovada.",
  WHATSAPP_UNAVAILABLE: "A Meta não confirmou o envio. Consulte o resultado antes de tentar novamente para evitar mensagem duplicada.",
};

export function normalizeWhatsAppPhone(value: unknown) {
  if (typeof value !== "string") throw new ManagerError("WHATSAPP_PHONE_INVALID",422);
  const phone=value.replace(/\D/g,"");
  if(!/^[0-9]{8,20}$/.test(phone)) throw new ManagerError("WHATSAPP_PHONE_INVALID",422);
  return phone;
}

export function templateComponents(value: unknown): Obj[] {
  if(value===undefined) return [];
  if(!Array.isArray(value)||value.length>8) throw new ManagerError("WHATSAPP_INVALID",422);
  const safe:Obj[]=[];
  for(const component of value){
    if(!isObject(component)||!["header","body","button"].includes(String(component.type||"").toLowerCase())) throw new ManagerError("WHATSAPP_INVALID",422);
    const type=String(component.type).toLowerCase();
    const parameters=Array.isArray(component.parameters)?component.parameters:[];
    if(parameters.length>20) throw new ManagerError("WHATSAPP_INVALID",422);
    const clean=parameters.map(parameter=>{
      if(!isObject(parameter)||!["text","currency","date_time","image","document","video"].includes(String(parameter.type||""))) throw new ManagerError("WHATSAPP_INVALID",422);
      if(parameter.type==="text"){
        if(typeof parameter.text!=="string"||parameter.text.length>4096||parameter.text.includes("\0")) throw new ManagerError("WHATSAPP_INVALID",422);
        return {type:"text",text:parameter.text};
      }
      if(parameter.type==="currency"&&isObject(parameter.currency)) return {type:"currency",currency:parameter.currency};
      if(parameter.type==="date_time"&&isObject(parameter.date_time)) return {type:"date_time",date_time:parameter.date_time};
      if(["image","document","video"].includes(String(parameter.type))&&isObject(parameter[parameter.type as string])) return {type:parameter.type,[String(parameter.type)]:parameter[parameter.type as string]};
      throw new ManagerError("WHATSAPP_INVALID",422);
    });
    const item:Obj={type,parameters:clean};
    if(type==="button"){
      if(typeof component.sub_type!=="string"||!["quick_reply","url"].includes(component.sub_type)||!Number.isInteger(component.index)||Number(component.index)<0||Number(component.index)>9) throw new ManagerError("WHATSAPP_INVALID",422);
      item.sub_type=component.sub_type;item.index=String(component.index);
    }
    safe.push(item);
  }
  return safe;
}

type Runtime={enabled:boolean;waba_id:string;phone_number_id:string;graph_api_version:string;access_token:string;display_phone_number?:string};
export function whatsappRuntime(value:unknown):Runtime{
  if(!isObject(value)||value.enabled!==true) throw new ManagerError("WHATSAPP_NOT_CONFIGURED",409);
  for(const key of ["waba_id","phone_number_id","graph_api_version","access_token"]){if(typeof value[key]!=="string"||!String(value[key]).trim()) throw new ManagerError("WHATSAPP_NOT_CONFIGURED",409);}
  if(!/^v[0-9]{1,3}\.[0-9]{1,2}$/.test(String(value.graph_api_version))||!/^[0-9]{1,64}$/.test(String(value.waba_id))||!/^[0-9]{1,64}$/.test(String(value.phone_number_id))) throw new ManagerError("WHATSAPP_NOT_CONFIGURED",409);
  return value as unknown as Runtime;
}

export async function metaWhatsApp(runtime:Runtime,path:string,options:RequestInit={},request:typeof fetch=fetch):Promise<Obj>{
  let response:Response;
  try{response=await request(`https://graph.facebook.com/${runtime.graph_api_version}/${path}`,{...options,headers:{"content-type":"application/json",...options.headers,authorization:"Bearer "+runtime.access_token},signal:AbortSignal.timeout(20000)});}catch{throw new ManagerError("WHATSAPP_UNAVAILABLE",503);}
  const body:unknown=await response.json().catch(()=>null);
  if(!response.ok){
    const error=isObject(body)&&isObject(body.error)?body.error:{};const code=Number(error.code||0),sub=Number(error.error_subcode||0);
    if(response.status===401||code===190) throw new ManagerError("WHATSAPP_AUTH_REQUIRED",401);
    if(response.status===429||[4,80007,130429].includes(code)) throw new ManagerError("WHATSAPP_LIMIT",429);
    if([131047,131026].includes(code)||sub===2494010) throw new ManagerError("WHATSAPP_TEMPLATE_REQUIRED",409);
    if([132000,132001,132005,132012,132015,132016].includes(code)) throw new ManagerError("WHATSAPP_TEMPLATE_NOT_FOUND",422);
    if(response.status>=500) throw new ManagerError("WHATSAPP_UNAVAILABLE",503);
    throw new ManagerError("WHATSAPP_INVALID",response.status||422);
  }
  if(!isObject(body)) throw new ManagerError("WHATSAPP_UNAVAILABLE",502);
  return body;
}
