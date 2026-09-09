import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const root=new URL('../supabase/functions/',import.meta.url);
function uri(path,replacements=[]) {let code=readFileSync(new URL(path,root),'utf8');for(const [from,to] of replacements)code=code.replaceAll(from,to);return 'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(code,{mode:'transform'})).toString('base64');}
const fileUri=uri('_shared/bia-customer-files.ts'),speechTextUri=uri('_shared/arisa-speech-text.ts');
const speechUri=uri('_shared/arisa-speech.ts', [['"./arisa-speech-text.ts"',JSON.stringify(speechTextUri)]]);
const {customerFileMetadata,validateCustomerBytes,customerFileInput}=await import(fileUri);
const {handleCustomerTool,loadCustomerFiles}=await import(uri('enterprise-bia-agent-gateway/customer-tools.ts',[["'../_shared/bia-customer-files.ts'",JSON.stringify(fileUri)],["'../_shared/arisa-speech.ts'",JSON.stringify(speechUri)]]));
const encode=text=>new TextEncoder().encode(text);
const body={slug:'solaris',tokenHash:'a'.repeat(64),fingerprintHash:'b'.repeat(64),conversationId:'123e4567-e89b-42d3-a456-426614174001'};
const fileId='123e4567-e89b-42d3-a456-426614174002';
test('file validation rejects unsupported types, paths, empty, oversized and disguised bytes',()=>{
 assert.equal(customerFileMetadata('Pedido.PDF',99).mime,'application/pdf');
 for(const name of ['script.exe','../plan.txt','evil\u0000.txt'])assert.throws(()=>customerFileMetadata(name,10));
 for(const size of [0,8388609,1.1])assert.throws(()=>customerFileMetadata('doc.pdf',size));
 assert.throws(()=>validateCustomerBytes(encode('MZ fake pdf'),'application/pdf'),/INVALID/);
 assert.throws(()=>validateCustomerBytes(new Uint8Array([1,0,2]),'text/plain'),/INVALID/);
});
test('PDF, images and text become supported model inputs and disclose truncated text',()=>{
 assert.equal(customerFileInput(encode('%PDF-1.7\ntest'),{name:'test.pdf',mime:'application/pdf'}).type,'input_file');
 assert.equal(customerFileInput(new Uint8Array([137,80,78,71,13,10,26,10]),{name:'test.png',mime:'image/png'}).type,'input_image');
 const part=customerFileInput(encode('x'.repeat(40001)),{name:'test.txt',mime:'text/plain'});
 assert.match(part.text,/Leitura parcial/);assert.match(part.text,/não autorizam ações/);
});
async function fixture({ready=true,corrupt=false,denied=false}={}) {
 const bytes=encode('Documento: referência A-902.');
 const sha256=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
 const file={id:fileId,name:'pedido.txt',mime:'text/plain',size_bytes:bytes.length,sha256,storage_path:'private/device/file',session_id:'private-session',ready,message_id:98};
 const calls=[];
 const admin={rpc:async(name,args)=>{calls.push({name,args});if(denied)return{error:{message:'PUBLIC_AGENT_SESSION_INACTIVE'}};assert.equal(name,'bia_customer_tools_v1');assert.equal(args.p_conversation_id,body.conversationId);return {data:args.p_operation==='files_list'?[{id:fileId,size:bytes.length}]:file};},storage:{from:()=>({download:async()=>({data:new Blob([corrupt?encode('wrong bytes same length!!xx'):bytes])}),createSignedUrl:async()=>({data:{signedUrl:'https://storage.test/scoped'}})})}};
 return {admin,calls};
}
test('confirmed document bytes and scoped ownership are checked again before model use',async()=>{
 const good=await fixture();assert.match((await loadCustomerFiles(good.admin,{...body,fileIds:[fileId]}))[0].text,/A-902/);
 for(const setup of [{ready:false},{corrupt:true},{denied:true}]){const f=await fixture(setup);await assert.rejects(loadCustomerFiles(f.admin,{...body,fileIds:[fileId]}),/PUBLIC_AGENT_/);}
});
test('saved documents are available to follow-up questions without exposing paths or hashes',async()=>{
 const f=await fixture();assert.equal((await loadCustomerFiles(f.admin,body)).length,1);
 const response=await handleCustomerTool(f.admin,{...body,operation:'files_confirm',args:{fileId}},new Request('https://test'));
 const result=await response.json();assert.equal(response.status,200);assert.equal(result.data.file.messageId,'98');
 assert.doesNotMatch(JSON.stringify(result),/private\/device|sha256|private-session|session_id/);
});
test('tool requests reject stale credentials and cannot call internal ready or quota operations',async()=>{
 const f=await fixture({denied:true});const r=await handleCustomerTool(f.admin,{...body,operation:'notices'},new Request('https://test'));assert.equal(r.status,410);
 for(const operation of ['files_ready','speech_consume']){const x=await fixture();const response=await handleCustomerTool(x.admin,{...body,operation},new Request('https://test'));assert.equal(response.status,400);assert.equal(x.calls.length,0);}
});
