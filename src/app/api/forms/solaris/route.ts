import {validateSolarisSubmission} from "@/lib/forms/solaris";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
export async function POST(request:Request){
 const origin=request.headers.get("origin");
 if(origin&&origin!==new URL(request.url).origin)return reply({error:"Origem inválida."},403);
 if(!request.headers.get("content-type")?.includes("application/json"))return reply({error:"Formato inválido."},415);
 if(Number(request.headers.get("content-length")||0)>8192)return reply({error:"Dados muito longos."},413);
 let data;
 try{const raw=await request.text();if(raw.length>8192)return reply({error:"Dados muito longos."},413);data=validateSolarisSubmission(JSON.parse(raw));}catch{return reply({error:"Dados inválidos."},400)}
 if(!data)return reply({error:"Confira seu nome, WhatsApp, opções e autorização de contato."},400);
 try{
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(),key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if(!url||!key)throw new Error("Missing public application configuration");
  const response=await fetch(new URL("/functions/v1/solaris-form",url),{method:"POST",headers:{"Content-Type":"application/json",apikey:key},body:JSON.stringify(data),signal:AbortSignal.timeout(18000)});
  const result=await response.json() as {id?:unknown,error?:unknown};
  if(response.ok&&result.id===data.requestId)return reply({id:result.id},response.status);
  if(!response.ok&&[400,409,413,415,429].includes(response.status)&&typeof result.error==="string")return reply({error:result.error},response.status);
  console.error("Solaris intake request failed",{status:response.status});
 }catch{console.error("Solaris intake unavailable")}
 return reply({error:"Não foi possível registrar agora. Seus dados continuam preenchidos. Tente novamente."},503);
}
