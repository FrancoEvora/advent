import {createClient} from "npm:@supabase/supabase-js@2.110.7";
import {validateSolarisSubmission} from "./validation.ts";
const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
const readKeys=(name:string):Record<string,string>=>{try{return JSON.parse(Deno.env.get(name)||"{}")}catch{return {}}};
Deno.serve(async(request:Request)=>{
 if(request.method!=="POST")return reply({error:"Método não permitido."},405);
 const key=request.headers.get("apikey"),accepted=[...Object.values(readKeys("SUPABASE_PUBLISHABLE_KEYS")),Deno.env.get("SUPABASE_ANON_KEY")].filter(Boolean);
 // Public intake authenticated with the project's publishable API key; no CRM reads.
 if(!key||!accepted.includes(key))return reply({error:"Chave de aplicação inválida."},401);
 if(!request.headers.get("content-type")?.includes("application/json"))return reply({error:"Formato inválido."},415);
 if(Number(request.headers.get("content-length")||0)>8192)return reply({error:"Dados muito longos."},413);
 let data;
 try{const raw=await request.text();if(raw.length>8192)return reply({error:"Dados muito longos."},413);data=validateSolarisSubmission(JSON.parse(raw));}catch{return reply({error:"Dados inválidos."},400)}
 if(!data)return reply({error:"Confira seu nome, WhatsApp, opções e autorização de contato."},400);
 try{
  const secret=readKeys("SUPABASE_SECRET_KEYS").default||Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  const db=createClient(Deno.env.get("SUPABASE_URL")||"",secret,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(15000)})}});
  const address=(request.headers.get("x-forwarded-for")||"unknown").split(",")[0].trim().slice(0,128);
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(`solaris-form:${Math.floor(Date.now()/3600000)}:${address}`));
  const fingerprint=Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,"0")).join("");
  const {data:result,error}=await db.rpc("submit_solaris_public_form",{p_submission:data,p_fingerprint:fingerprint});
  if(error){
   if(error.message.includes("FORM_RATE_LIMIT"))return reply({error:"Muitas tentativas. Aguarde um pouco e tente novamente."},429);
   if(error.message.includes("FORM_ID_CONFLICT"))return reply({error:"Este envio já foi registrado com outros dados. Reabra o formulário para um novo cadastro."},409);
   console.error("Solaris persistence failed",{code:error.code});throw new Error("Persistence failed");
  }
  if(!result||result.id!==data.requestId)throw new Error("Invalid receipt");
  return reply({id:result.id},result.duplicate?200:201);
 }catch{console.error("Solaris intake unavailable");return reply({error:"Não foi possível registrar agora. Seus dados continuam preenchidos. Tente novamente."},503)}
});
