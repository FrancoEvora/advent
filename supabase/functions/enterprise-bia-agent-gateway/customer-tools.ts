import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.110.7';
import { customerFileMetadata, validateCustomerBytes, customerFileInput } from '../_shared/bia-customer-files.ts';
import { partForReply, synthesize, SpeechError } from '../_shared/arisa-speech.ts';
import type { StoredReply } from '../_shared/arisa-speech.ts';
import type { Obj } from './core.ts';
const BUCKET='bia-customer-files';
const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEADERS={'cache-control':'no-store, private','x-content-type-options':'nosniff'};
type CustomerFile={id:string;name:string;mime:string;size_bytes:number;sha256:string;storage_path:string;ready:boolean;message_id?:number|null};
export async function customerRpc(admin:SupabaseClient,b:Obj,operation:string,args:Obj={}) {
  const result=await admin.rpc('bia_customer_tools_v1',{p_slug:b.slug,p_session_token_hash:b.tokenHash,p_fingerprint_hash:b.fingerprintHash,p_conversation_id:b.conversationId??null,p_operation:operation,p_args:args});
  if(result.error) throw new Error(String(result.error.message).match(/PUBLIC_AGENT_[A-Z0-9_]+/)?.[0]||'PUBLIC_AGENT_TOOL_UNAVAILABLE');
  return result.data;
}
function publicFile(f:CustomerFile) { return {id:f.id,name:f.name,mime:f.mime,size:f.size_bytes,messageId:f.message_id==null?null:String(f.message_id)}; }
async function downloaded(admin:SupabaseClient,file:CustomerFile) {
  const {data,error}=await admin.storage.from(BUCKET).download(file.storage_path);
  if(error||!data||data.size!==file.size_bytes) throw new Error('PUBLIC_AGENT_FILE_UPLOAD_INCOMPLETE');
  const bytes=new Uint8Array(await data.arrayBuffer());
  validateCustomerBytes(bytes,file.mime);
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
  if(hash!==file.sha256) throw new Error('PUBLIC_AGENT_FILE_UPLOAD_INCOMPLETE');
  return bytes;
}
export async function loadCustomerFiles(admin:SupabaseClient,b:Obj) {
  if(!b.conversationId && !b.fileIds) return [];
  let ids=Array.isArray(b.fileIds)?b.fileIds as string[]:[];
  if(!ids.length) {
    const previous=await customerRpc(admin,b,'files_list') as Array<{id:string;size:number}>;
    // Keep the latest documents available for follow-up questions without unbounded context.
    let total=0;
    ids=[...previous].reverse().filter(f=>{if(total+f.size>16777216)return false;total+=f.size;return true;}).slice(0,3).map(f=>f.id);
  }
  const files:CustomerFile[]=[];
  for(const id of ids) {
    if(!UUID.test(id)) throw new Error('PUBLIC_AGENT_FILE_INVALID');
    const file=await customerRpc(admin,b,'files_get',{fileId:id}) as CustomerFile;
    if(!file.ready) throw new Error('PUBLIC_AGENT_FILE_UPLOAD_INCOMPLETE');
    files.push(file);
  }
  if(files.reduce((sum,f)=>sum+f.size_bytes,0)>16777216)throw new Error('PUBLIC_AGENT_FILE_LIMIT');
  const parts=[];
  for(const file of files) parts.push(customerFileInput(await downloaded(admin,file),file));
  return parts;
}
export async function handleCustomerTool(admin:SupabaseClient,b:Obj,request:Request) {
  try {
    if(!HASH.test(String(b.tokenHash))||!HASH.test(String(b.fingerprintHash))||!UUID.test(String(b.conversationId))) throw new Error('PUBLIC_AGENT_INPUT_INVALID');
    const operation=String(b.operation),args=b.args&&typeof b.args==='object'&&!Array.isArray(b.args)?b.args as Obj:{};
    let result:unknown;
    if(['notices','notices_read','files_list'].includes(operation)) result=await customerRpc(admin,b,operation,args);
    else if(operation==='files_prepare') {
      const expected=customerFileMetadata(String(args.name),Number(args.size));
      if(args.mime!==expected.mime||!UUID.test(String(args.clientId))||!HASH.test(String(args.sha256)))throw new Error('PUBLIC_AGENT_FILE_INVALID');
      const file=await customerRpc(admin,b,operation,args) as CustomerFile;
      if(file.ready) result={file:publicFile(file),ready:true};
      else {
        const signed=await admin.storage.from(BUCKET).createSignedUploadUrl(file.storage_path,{upsert:false});
        if(signed.error||!signed.data?.signedUrl)throw new Error('PUBLIC_AGENT_FILE_UNAVAILABLE');
        result={file:publicFile(file),uploadUrl:signed.data.signedUrl};
      }
    } else if(operation==='files_confirm'||operation==='files_open') {
      if(!UUID.test(String(args.fileId)))throw new Error('PUBLIC_AGENT_FILE_INVALID');
      let file=await customerRpc(admin,b,'files_get',args) as CustomerFile;
      if(operation==='files_confirm') {
        await downloaded(admin,file);
        file=await customerRpc(admin,b,'files_ready',args) as CustomerFile;
        result={file:publicFile(file)};
      } else {
        if(!file.ready)throw new Error('PUBLIC_AGENT_FILE_UPLOAD_INCOMPLETE');
        const signed=await admin.storage.from(BUCKET).createSignedUrl(file.storage_path,120,{download:file.name});
        if(signed.error||!signed.data?.signedUrl)throw new Error('PUBLIC_AGENT_FILE_UNAVAILABLE');
        result={url:signed.data.signedUrl};
      }
    } else if(operation==='speech') {
      if(typeof args.messageId!=='string'||args.messageId.length>60)throw new Error('PUBLIC_AGENT_INPUT_INVALID');
      const reply=await customerRpc(admin,b,'speech_reply',args) as StoredReply&{organizationId:string};
      const part=partForReply(reply,args.partIndex,args.version);
      const config=await admin.rpc('get_crm_ai_runtime_credentials',{p_organization_id:reply.organizationId});
      if(config.error||config.data?.enabled!==true||typeof config.data.api_key!=='string'||config.data.api_key.length<32)throw new SpeechError('SPEECH_DISABLED',409);
      if(await customerRpc(admin,b,'speech_consume',{characters:part.text.length})!==true)throw new SpeechError('SPEECH_LIMIT',429);
      const audio=await synthesize(part.text,config.data.api_key,fetch,request.signal);
      return new Response(audio,{headers:{...HEADERS,'content-type':'audio/mpeg'}});
    } else throw new Error('PUBLIC_AGENT_INPUT_INVALID');
    return new Response(JSON.stringify({ok:true,data:result}),{headers:{...HEADERS,'content-type':'application/json'}});
  } catch(error) {
    const code=error instanceof SpeechError?error.code:error instanceof Error&&/^PUBLIC_AGENT_[A-Z0-9_]+$/.test(error.message)?error.message:'PUBLIC_AGENT_TOOL_UNAVAILABLE';
    const status=error instanceof SpeechError?error.status:/NOT_FOUND/.test(code)?404:/INACTIVE/.test(code)?410:/CHANGED|CONFLICT/.test(code)?409:/LIMIT/.test(code)?429:/INVALID/.test(code)?400:503;
    return new Response(JSON.stringify({ok:false,error:code}),{status,headers:{...HEADERS,'content-type':'application/json'}});
  }
}
