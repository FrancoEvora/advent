import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
const origin='https://advent-tau.vercel.app';
const cookies=new Map();
const runId=process.env.GITHUB_RUN_ID||randomUUID();
const headers={'origin':origin,'referer':origin+'/','user-agent':'Bia-Audio-Release-QA/1.0','accept-language':'pt-BR'};
const results={runId,startedAt:new Date().toISOString(),formats:[]};
fs.mkdirSync('.qa/results',{recursive:true});
async function request(path,options={}){
 const r=await fetch(origin+path,{...options,headers:{...headers,...options.headers,cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')},signal:AbortSignal.timeout(110000)});
 for(const line of r.headers.getSetCookie()){const first=line.split(';')[0],index=first.indexOf('=');if(index>0)cookies.set(first.slice(0,index),first.slice(index+1));}
 const data=await r.json().catch(()=>({ok:false,error:'NON_JSON_RESPONSE'}));return {status:r.status,data};
}
async function waitResponse(make){
 const deadline=Date.now()+180000;let r;
 do{r=await make();if(r.status!==202&&r.data.status!=='processing')return r;await new Promise(resolve=>setTimeout(resolve,Math.max(1500,Math.min(4000,r.data.retryAfterMs||2000))));}while(Date.now()<deadline);
 return r;
}
try{
 const session=await request('/api/public-agent/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({slug:'solaris',attribution:{utm_source:'bia_release_qa',utm_campaign:String(runId)},landingPage:origin+'/?utm_source=bia_release_qa',referrer:null})});
 assert.equal(session.status,200,'session HTTP');assert.equal(session.data.ok,true,'session opened');
 for(const [ext,mime] of [['m4a','audio/mp4'],['webm','audio/webm']]){
  const result={format:ext,mime,transcriptionId:randomUUID(),messageId:randomUUID()};results.formats.push(result);
  try{
   const bytes=fs.readFileSync(`.qa/voice.${ext}`);
   const make=()=>{const form=new FormData();form.set('slug','solaris');form.set('clientMessageId',result.transcriptionId);form.set('durationSeconds',String(process.env.QA_AUDIO_DURATION||8));form.set('audio',new Blob([bytes],{type:mime}),`mensagem.${ext}`);return request('/api/public-agent/transcribe',{method:'POST',body:form});};
   const transcribe=await waitResponse(make);result.transcriptionStatus=transcribe.status;result.transcriptionError=transcribe.data.error||null;
   assert.equal(transcribe.status,200,'transcription HTTP');assert.equal(transcribe.data.ok,true,'transcription completed');
   const text=String(transcribe.data.text||'').trim();result.transcript=text;
   assert.ok(/solaris/i.test(text),'recognizes Solaris');assert.ok(text.length>15,'nonempty spoken sentence');
   const replay=await waitResponse(make);result.transcriptionIdempotent=replay.status===200&&replay.data.text===text;assert.equal(result.transcriptionIdempotent,true);
   if(transcribe.data.audio?.url){
    const u=new URL(transcribe.data.audio.url,origin);assert.ok(u.protocol==='https:'&&(u.origin===origin||u.hostname==='qsdffayasuzsmngteika.supabase.co'));
    const media=await fetch(u,{headers:u.origin===origin?{...headers,cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')}:{},signal:AbortSignal.timeout(25000)});
    const mediaBytes=Buffer.from(await media.arrayBuffer());result.playbackStatus=media.status;result.audioBytesPreserved=media.ok&&createHash('sha256').update(mediaBytes).digest('hex')===createHash('sha256').update(bytes).digest('hex');assert.equal(result.audioBytesPreserved,true,'stored playback matches upload');
   }
   const messageBody=JSON.stringify({slug:'solaris',message:text,source:'audio',clientMessageId:result.messageId,transcriptionRequestId:result.transcriptionId});
   const send=()=>request('/api/public-agent/message',{method:'POST',headers:{'content-type':'application/json'},body:messageBody});
   const message=await waitResponse(send);result.messageStatus=message.status;result.messageError=message.data.error||null;result.degraded=message.data.degraded??null;result.reply=message.data.reply||null;
   assert.equal(message.status,200,'voice message HTTP');assert.equal(message.data.ok,true,'voice message completed');assert.ok(message.data.reply,'Bia replied');assert.notEqual(message.data.degraded,true,'not a fallback');
   const again=await waitResponse(send);result.messageIdempotent=again.status===200&&again.data.reply===message.data.reply;assert.equal(result.messageIdempotent,true,'voice message idempotent');result.passed=true;
  }catch(error){result.passed=false;result.failure=error instanceof Error?error.message:String(error);}
  fs.writeFileSync('.qa/results/live-audio.json',JSON.stringify(results,null,2));
 }
}catch(error){results.failure=error instanceof Error?error.message:String(error);}
results.finishedAt=new Date().toISOString();fs.writeFileSync('.qa/results/live-audio.json',JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
if(results.failure||results.formats.length!==2||results.formats.some(r=>!r.passed))process.exitCode=1;
