import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import "./arisa-google-oauth.test.mts";

const root=new URL("../",import.meta.url),org="11111111-1111-4111-8111-111111111111",user="22222222-2222-4222-8222-222222222222";
let authenticated=true,authorized=true,consumed=false;const calls:{key:string;action:string}[]=[];
function createClient(_url:string,key:string){return {auth:{getUser:async()=>({error:authenticated?null:{},data:{user:authenticated?{id:user}:null}})},rpc:async(name:string,args:Record<string,unknown>)=>{
  calls.push({key,action:String(args.p_action||name)});
  if(name==="arisa_admin_catalog")return {data:{},error:authorized?null:{code:"42501"}};
  if(args.p_action==="oauth_consume"){if(consumed)return {data:null,error:{message:"GOOGLE_STATE_EXPIRED"}};consumed=true;return {data:{client_id:"client",client_secret:"DO_NOT_EXPOSE",verifier:"verifier"},error:null};}
  if(args.p_action==="status")return {data:{configured:false,connected:false,sender_email:"arisa@evoraurbanismo.com.br"},error:null};
  if(args.p_action==="runtime")return {data:null,error:{message:"GOOGLE_NOT_CONNECTED"}};
  if(args.p_action==="oauth_finish")return {data:{connected:true},error:null};
  return {data:{},error:null};
}};}
const target=globalThis as unknown as {__mailClient:typeof createClient;Deno:{env:{get:(key:string)=>string|undefined}}};target.__mailClient=createClient;target.Deno={env:{get:key=>({SUPABASE_URL:"https://test.invalid",SUPABASE_ANON_KEY:"public",SUPABASE_SERVICE_ROLE_KEY:"service"} as Record<string,string>)[key]}};
let source=readFileSync(new URL("supabase/functions/arisa-mail/index.ts",root),"utf8").replace(/import \{ createClient \} from [^;]+;/,"const createClient = globalThis.__mailClient;").replace("Deno.serve(handleMail);","");
for(const name of ["arisa-manager","arisa-document","arisa-mail","arisa-mail-runtime","arisa-calendar","arisa-calendar-runtime"])source=source.replaceAll(`"../_shared/${name}.ts"`,JSON.stringify(new URL(`supabase/functions/_shared/${name}.ts`,root).href));
const {handleMail}=await import("data:text/javascript;base64,"+Buffer.from(stripTypeScriptTypes(source,{mode:"strip"})).toString("base64"));
const request=(action:string,token="Bearer test")=>new Request("https://test.invalid",{method:"POST",headers:{authorization:token},body:JSON.stringify({organizationId:org,action,state:"state",code:"code"})});
test.beforeEach(()=>{authenticated=true;authorized=true;consumed=false;calls.length=0;});
test("anonymous, expired, and non-admin users cannot reach Google credentials",async()=>{
  assert.equal((await handleMail(request("status",""))).status,401);assert.equal(calls.length,0);
  authenticated=false;assert.equal((await handleMail(request("status"))).status,401);assert.equal(calls.length,0);
  authenticated=true;authorized=false;assert.equal((await handleMail(request("status"))).status,403);assert.deepEqual(calls,[{key:"public",action:"arisa_admin_catalog"}]);
});
test("status never claims a newly created account is already connected",async()=>{
  const response=await handleMail(request("status")),body=await response.json();assert.equal(body.connected,false);assert.equal(body.configured,false);assert.equal(JSON.stringify(body).includes("DO_NOT_EXPOSE"),false);
});
test("OAuth rejects the wrong Gmail identity and consumes the state only once",async()=>{
  const original=globalThis.fetch;globalThis.fetch=async url=>new Response(JSON.stringify(String(url).includes("oauth2")?{access_token:"access",refresh_token:"refresh-token-1234567890",scope:"https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly"}:{emailAddress:"another@example.com"}));
  try{const response=await handleMail(request("complete"));assert.equal(response.status,409);assert.equal((await response.json()).error,"GOOGLE_ACCOUNT_MISMATCH");assert.equal(calls.some(call=>call.action==="oauth_finish"),false);assert.equal((await (await handleMail(request("complete"))).json()).error,"GOOGLE_STATE_EXPIRED");}finally{globalThis.fetch=original;}
});
test("invalid client returns a useful safe error, not an expired-authorization claim",async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({error:"invalid_client",error_description:"DO_NOT_EXPOSE"}),{status:401});
  try{
    const response=await handleMail(request("complete")),body=await response.json();
    assert.equal(body.error,"GOOGLE_CLIENT_INVALID");assert.match(body.message,/credenciais/);assert.ok(body.supportReference);
    assert.equal(JSON.stringify(body).includes("DO_NOT_EXPOSE"),false);assert.equal(calls.some(call=>call.action==="oauth_finish"),false);
  }finally{globalThis.fetch=original;}
});
test("disabled Gmail API is not diagnosed as refresh token expiry",async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async url=>String(url).includes("oauth2")?new Response(JSON.stringify({access_token:"access",refresh_token:"refresh-token-1234567890",scope:"https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly"})):new Response(JSON.stringify({error:{details:[{reason:"SERVICE_DISABLED"}]}}),{status:403});
  try{
    const body=await (await handleMail(request("complete"))).json();assert.equal(body.error,"GOOGLE_API_DISABLED");assert.match(body.message,/Gmail API/);assert.equal(calls.some(call=>call.action==="oauth_finish"),false);
  }finally{globalThis.fetch=original;}
});
test("missing first refresh token does not finish the connection",async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async url=>new Response(JSON.stringify(String(url).includes("oauth2")?{access_token:"access",scope:"https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly"}:{emailAddress:"arisa@evoraurbanismo.com.br"}));
  try{
    const body=await (await handleMail(request("complete"))).json();assert.equal(body.error,"GOOGLE_REFRESH_TOKEN_MISSING");assert.equal(calls.some(call=>call.action==="oauth_finish"),false);
  }finally{globalThis.fetch=original;}
});
test("successful first grant persists once and does not expose tokens to the browser",async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async url=>new Response(JSON.stringify(String(url).includes("oauth2")?{access_token:"DO_NOT_EXPOSE_ACCESS",refresh_token:"DO_NOT_EXPOSE_REFRESH_1234567890",scope:"https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly"}:{emailAddress:"arisa@evoraurbanismo.com.br"}));
  try{
    const body=await (await handleMail(request("complete"))).json();assert.equal(body.connected,true);assert.equal(calls.filter(call=>call.action==="oauth_finish").length,1);assert.equal(JSON.stringify(body).includes("DO_NOT_EXPOSE"),false);
  }finally{globalThis.fetch=original;}
});
