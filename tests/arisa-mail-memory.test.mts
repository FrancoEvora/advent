import test from "node:test";
import assert from "node:assert/strict";
import { addresses, authorizationUrl, base64url, gmailContent, mailInput, mimeMessage } from "../supabase/functions/_shared/arisa-mail.ts";
import { validateMemories, type ArchiveEvent } from "../supabase/functions/_shared/arisa-memory.ts";
import { sendArisaMail } from "../supabase/functions/_shared/arisa-mail-runtime.ts";

const id="33333333-3333-4333-8333-333333333333", org="11111111-1111-4111-8111-111111111111", actor="22222222-2222-4222-8222-222222222222";
const source:ArchiveEvent={id,organization_id:org,owner_user_id:null,source:"crm_messages",source_id:id,subject_key:"crm:"+id,subject_label:"Contato de teste",author_type:"external",content:"Prefiro receber a proposta por e-mail. Minha irmã quer falar amanhã.",title:"Teste",occurred_at:"2026-09-05T12:00:00Z"};
const memory={kind:"preference",topic:"communication",claim:"Prefere propostas por e-mail.",evidence:"Prefiro receber a proposta por e-mail.",confidence:.9,about_speaker:true,sensitive:false};
test("memories require exact evidence and do not attribute third-party statements to the speaker",()=>{
  assert.equal(validateMemories({memories:[memory]},source).length,1);
  assert.equal(validateMemories({memories:[{...memory,evidence:"Sou proprietário de três lotes."}]},source).length,0);
  assert.equal(validateMemories({memories:[{...memory,claim:"Quer falar amanhã.",evidence:"Minha irmã quer falar amanhã.",about_speaker:false}]},source).length,0);
});
test("professional perceptions are capped, sensitive profiles rejected, AI output cannot become a personal fact",()=>{
  assert.equal(validateMemories({memories:[{...memory,kind:"observation",confidence:1}]},source)[0].confidence,.75);
  assert.equal(validateMemories({memories:[{...memory,claim:"Apresenta transtorno bipolar."}]},source).length,0);
  assert.equal(validateMemories({memories:[{...memory,sensitive:true}]},source).length,0);
  assert.equal(validateMemories({memories:[memory]},{...source,author_type:"crm_human"}).length,0);
  assert.equal(validateMemories({memories:[memory]},{...source,author_type:"assistant"}).length,0);
  assert.equal(validateMemories({memories:[{...memory,kind:"analysis",topic:"process",about_speaker:false}]},{...source,author_type:"assistant"})[0].confidence,.75);
});
test("recipient validation rejects header injection and normalizes duplicates",()=>{
  assert.deepEqual(addresses(["A@example.com","a@example.com"]),["a@example.com"]);
  for(const value of ["a@example.com\r\nBcc: x@example.com","Nome <a@example.com>","invalid"])assert.throws(()=>addresses([value]));
  assert.throws(()=>mailInput({to:["a@example.com"],subject:"Oi\nBcc: x@example.com",body:"Teste"}));
});
test("MIME preserves Unicode and attachments with bounded folded header lines and deterministic Message-ID",()=>{
  const input=mailInput({to:["a@example.com"],subject:"Évora 🌿 ".repeat(24),body:"Proposta com condições e anexo."});
  const bytes=new Uint8Array([0,1,2,255]), file={name:"Apresentação.pdf",mime:"application/pdf",bytes};
  const mime=mimeMessage(input,[file],id,source.occurred_at), text=new TextDecoder().decode(mime.bytes);
  assert.match(text,/AAEC\/w==/);assert.ok(text.includes(`<${id}@evoraurbanismo.com.br>`));
  assert.ok(text.split("\r\n").every(line=>line.length<998));
  assert.deepEqual(mimeMessage(input,[file],id,source.occurred_at).bytes,mime.bytes);
  assert.throws(()=>mimeMessage(input,[{...file,name:"x\r\nBcc: a@example.com"}],id,source.occurred_at));
  assert.throws(()=>mimeMessage(input,[{...file,bytes:new Uint8Array(19*1024*1024)}],id,source.occurred_at));
});
test("OAuth is bound to state, PKCE, exact mailbox, offline refresh and required scopes",()=>{
  const url=new URL(authorizationUrl("client","state-value","challenge-value"));
  assert.equal(url.origin,"https://accounts.google.com");assert.equal(url.searchParams.get("state"),"state-value");assert.equal(url.searchParams.get("code_challenge_method"),"S256");assert.equal(url.searchParams.get("login_hint"),"arisa@evoraurbanismo.com.br");assert.equal(url.searchParams.get("access_type"),"offline");assert.match(url.searchParams.get("scope")||"",/gmail.readonly/);
});
test("Gmail parsing retains plain text and attachment descriptors without executing HTML",()=>{
  const content=gmailContent({internalDate:"1788609600000",payload:{headers:[{name:"From",value:"Pessoa <pessoa@example.com>"},{name:"Subject",value:"Documento"}],parts:[{mimeType:"text/plain",body:{data:base64url(new TextEncoder().encode("Segue documento."))}},{mimeType:"application/pdf",filename:"nota.pdf",body:{attachmentId:"file-id",size:100}}]}});
  assert.equal(content.sender,"pessoa@example.com");assert.equal(content.body,"Segue documento.");assert.equal(content.files[0].id,"file-id");
});
test("a Gmail draft is never reported as sent merely because its From address is Arisa",()=>{
  const message={payload:{headers:[{name:"From",value:"arisa@evoraurbanismo.com.br"}]}};
  assert.equal(gmailContent({...message,labelIds:["DRAFT"]}).status,"draft");
  assert.equal(gmailContent({...message,labelIds:["SENT"]}).status,"sent");
  assert.equal(gmailContent({...message,labelIds:["INBOX"]}).status,"received");
});
test("ambiguous Gmail acceptance is archived and is not resent even if the model changes its wording on retry",async()=>{
  let row:Record<string,unknown>|null=null,sendCount=0;const original=globalThis.fetch;
  const db={rpc:async(name:string,args:Record<string,unknown>)=>{
    assert.equal(name,"arisa_mail_service");const action=args.p_action,p=args.p_args as Record<string,unknown>;
    if(action==="prepare"){if(!row)row={id,status:"draft",created_at:source.occurred_at,subject:p.subject,body:p.body,recipients:p.to,cc:p.cc,operation_key:p.operation_key};assert.equal(row.operation_key,p.operation_key);return {data:{...row},error:null};}
    if(action==="runtime")return {data:{client_id:"client",client_secret:"secret",refresh_token:"refresh"},error:null};
    if(action==="send_begin"){assert.equal(row?.status,"draft");row!.status="sending";return {data:{send:true,message:row},error:null};}
    throw new Error(String(action));
  },storage:{from:()=>({upload:async()=>({error:null})})},from:()=>{
    let values:Record<string,unknown>={};const q={update:(v:Record<string,unknown>)=>{values=v;return q;},eq:()=>q,in:()=>q,select:()=>q,single:async()=>{Object.assign(row!,values);return {data:{id},error:null};},then:(resolve:(x:unknown)=>unknown)=>{Object.assign(row!,values);return Promise.resolve({error:null}).then(resolve);}};return q;
  }};
  globalThis.fetch=async url=>{if(String(url).includes("oauth2"))return new Response(JSON.stringify({access_token:"test-access"}));sendCount++;throw new TypeError("response lost");};
  try{
    const client=db as unknown as Parameters<typeof sendArisaMail>[0],input={to:["pessoa@example.com"],subject:"Documento",body:"Segue o documento."};
    const first=await sendArisaMail(client,client,org,actor,input,{requestId:id});assert.equal(first.status,"unknown");
    const retry=await sendArisaMail(client,client,org,actor,{...input,body:"Segue documento solicitado."},{requestId:id});assert.equal(retry.status,"unknown");assert.equal(sendCount,1);
  }finally{globalThis.fetch=original;}
});
