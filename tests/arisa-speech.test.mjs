import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const root = new URL('../',import.meta.url);
const uri = (path, replace = []) => {
 let source=readFileSync(new URL(path,root),'utf8');
 for(const [from,to] of replace)source=source.replaceAll(from,to);
 return 'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source,{mode:'transform'})).toString('base64');
};
const textUri=uri('supabase/functions/_shared/arisa-speech-text.ts');
const speechUri=uri('supabase/functions/_shared/arisa-speech.ts', [['"./arisa-speech-text.ts"',JSON.stringify(textUri)]]);
const {speechParts,spokenText,SPEECH_VERSION}=await import(textUri);
const {partForReply,synthesize,VOICE,VOICE_INSTRUCTIONS}=await import(speechUri);
const {VoiceQueue}=await import(uri('src/components/arisa/voice-queue.ts', [['"../../../supabase/functions/_shared/arisa-speech-text"',JSON.stringify(textUri)]]));
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('text boundaries preserve financial decimals, dates and all non-markup content',()=>{
 const text=('**Saldo:** R$ 1.250,35 em 06/09/2026. A reunião está confirmada às 10h.\n').repeat(80);
 const parts=speechParts(text);assert.ok(parts.length>2);assert.equal(parts.at(-1).end,text.length);
 assert.ok(parts.every((p,i)=>p.index===i&&p.text.length<=1000));
 assert.equal(parts.map(p=>p.text).join(' ').replace(/\s+/g,' '),spokenText(text));
 assert.match(parts[0].text,/R\$ 1\.250,35/);
});
test('empty and oversized responses are explicit, never silently truncated',()=>{assert.deepEqual(speechParts('   '),[]);assert.throws(()=>speechParts('x'.repeat(32001)),/SPEECH_TOO_LONG/)});
test('links have readable labels and no secret URLs are spoken aloud',()=>{assert.equal(spokenText('Abra [o extrato](https://example.test/token-secret).'),'Abra o extrato.');assert.ok(!spokenText('https://example.test/token-secret').includes('token-secret'))});
test('only completed assistant text and valid protocol parts can be synthesized',()=>{
 const reply={id:'test',role:'assistant',status:'completed',parent_id:'parent',content:'Documento registrado. Pagamento ainda não realizado.'};
 assert.match(partForReply(reply,0,SPEECH_VERSION).text,/ainda não realizado/);
 assert.throws(()=>partForReply({...reply,role:'user'},0,SPEECH_VERSION),/NOT_FOUND/);
 assert.throws(()=>partForReply({...reply,status:'processing'},0,SPEECH_VERSION),/NOT_READY/);
 for(const index of [-1,.5,999,'0'])assert.throws(()=>partForReply(reply,index,SPEECH_VERSION),/INVALID/);
 assert.throws(()=>partForReply(reply,0,'old'),/INVALID/);
});
test('voice has fixed gentle adult pt-BR direction, exact input and no user-selectable endpoint',async()=>{
 assert.equal(VOICE,'marin');assert.match(VOICE_INSTRUCTIONS,/profissional, delicada, doce/);
 const request=async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/audio/speech');const body=JSON.parse(options.body);assert.equal(body.input,'Olá, Franco.');assert.equal(body.voice,'marin');assert.equal(body.speed,1.12);return new Response(new Uint8Array(128),{headers:{'content-type':'audio/mpeg'}})};
 assert.equal((await synthesize('Olá, Franco.','test-key',request)).byteLength,128);
});
test('provider failures do not leak sensitive error bodies',async()=>{
 await assert.rejects(synthesize('Texto','test-key',async()=>new Response('provider-secret',{status:401})),/SPEECH_UNAVAILABLE/);
 await assert.rejects(synthesize('Texto','test-key',async()=>new Response('private',{status:429})),/SPEECH_LIMIT/);
});
function audioFake(){let finished;const audio={plays:0,closed:false,paused:false,unlock:async()=>{},pause:async()=>{audio.paused=true},resume:async()=>{audio.paused=false},decode:async x=>x,play:()=>{audio.plays++;return {ended:new Promise(r=>{finished=r}),stop:()=>finished?.()}},close:()=>{audio.closed=true},finish:()=>finished?.()};return audio}
test('one next phrase is prefetched and playback remains ordered',async()=>{
 const audio=audioFake(), fetched=[];const q=new VoiceQueue(audio,async(id,index)=>{fetched.push(index);return new ArrayBuffer(64)},()=>{});
 await q.enable();const run=q.read('reply',('Informação financeira validada pela plataforma. ').repeat(25));await tick();
 assert.equal(audio.plays,1);assert.deepEqual(fetched,[0,1]);
 await q.pause();assert.equal(q.state.phase,'paused');assert.equal(audio.paused,true);
 await q.resume();assert.equal(q.state.phase,'speaking');
 q.stop();await run;assert.equal(q.state.messageId,null);
});
test('late network results cannot restart stopped speech',async()=>{
 const audio=audioFake();let resolve;const q=new VoiceQueue(audio,()=>new Promise(r=>{resolve=r}),()=>{});
 await q.enable();const run=q.read('reply','Não repetir nenhuma ação.');q.stop(true);resolve(new ArrayBuffer(64));await run;assert.equal(audio.plays,0);assert.equal(q.state.enabled,false);
});
test('replay never invokes a business action and destroy closes audio',async()=>{
 const audio=audioFake(),calls=[];const q=new VoiceQueue(audio,async(id,index)=>{calls.push({id,index});return new ArrayBuffer(64)},()=>{});
 await q.enable();for(let i=0;i<2;i++){const run=q.read('same-reply','Reunião criada.');await tick();audio.finish();await run;}
 assert.deepEqual(calls,[{id:'same-reply',index:0},{id:'same-reply',index:0}]);q.destroy();assert.equal(audio.closed,true);
});

const org='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
let allowed=true,authenticated=true,visible=true,ready=true,limit=false;const queries=[],calls=[];
globalThis.__speechClient=(_url,key)=>({
 auth:{getUser:async()=>({error:authenticated?null:{},data:{user:authenticated?{id:user}:null}})},
 rpc:async(name,args)=>{calls.push({key,name,args});if(name==='arisa_admin_catalog')return{error:allowed?null:{},data:{}};if(name==='get_crm_ai_runtime_credentials')return{error:null,data:{enabled:true,api_key:'private-test-key'.repeat(4)}};if(name==='arisa_speech_consume')return{error:null,data:!limit};throw new Error('Unexpected mutation '+name)},
 from:table=>{assert.equal(table,'arisa_chat_messages');assert.equal(key,'public-test');const q={select:()=>q,eq:(column,value)=>{queries.push([column,value]);return q},maybeSingle:async()=>({error:null,data:visible?{id,content:'Resposta confirmada.',role:'assistant',status:ready?'completed':'processing',parent_id:'parent'}:null})};return q;}
});
globalThis.Deno={env:{get:key=>({SUPABASE_URL:'https://test.invalid',SUPABASE_ANON_KEY:'public-test',SUPABASE_SERVICE_ROLE_KEY:'secret-test'})[key]}};
const {handleRequest}=await import(uri('supabase/functions/arisa-speech/index.ts',[[/import \{ createClient \} from [^;]+;/g,'const createClient=globalThis.__speechClient;'],['"../_shared/arisa-speech.ts"',JSON.stringify(speechUri)]]));
const req=(overrides={},token='Bearer test')=>new Request('https://test.invalid',{method:'POST',headers:{authorization:token},body:JSON.stringify({organizationId:org,messageId:id,partIndex:0,version:SPEECH_VERSION,...overrides})});
function reset(){allowed=authenticated=visible=ready=true;limit=false;queries.length=0;calls.length=0}
test('speech endpoint blocks anonymous, expired, non-admin and inaccessible replies',async()=>{
 reset();assert.equal((await handleRequest(req({},''))).status,401);assert.equal(calls.length,0);
 authenticated=false;assert.equal((await handleRequest(req())).status,401);assert.equal(calls.length,0);
 reset();allowed=false;assert.equal((await handleRequest(req())).status,403);assert.deepEqual(calls.map(x=>x.name),['arisa_admin_catalog']);
 reset();visible=false;assert.equal((await handleRequest(req())).status,404);assert.equal(calls.length,1);
 assert.ok(queries.some(([k,v])=>k==='owner_user_id'&&v===user));assert.ok(queries.some(([k,v])=>k==='organization_id'&&v===org));
});
test('arbitrary text and unfinished responses never access provider credentials',async()=>{
 reset();assert.equal((await handleRequest(req({text:'injected'}))).status,400);assert.equal(calls.length,0);
 ready=false;assert.equal((await handleRequest(req())).status,409);assert.equal(calls.length,1);
});
test('rate limiting occurs before any synthesis request',async()=>{reset();limit=true;assert.equal((await handleRequest(req())).status,429)});
test('private audio is no-store and speech access never runs chat/administrative tools',async()=>{
 reset();const original=globalThis.fetch;globalThis.fetch=async()=>new Response(new Uint8Array(128),{headers:{'content-type':'audio/mpeg'}});
 try{const r=await handleRequest(req());assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/no-store/);assert.equal(r.headers.get('content-type'),'application/octet-stream');assert.equal((await r.arrayBuffer()).byteLength,128);assert.deepEqual(calls.map(x=>x.name),['arisa_admin_catalog','get_crm_ai_runtime_credentials','arisa_speech_consume']);}finally{globalThis.fetch=original}
});
