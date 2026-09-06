import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const root = new URL('../', import.meta.url);
const uri = (path, replacements=[]) => {
  let source=readFileSync(new URL(path, root), 'utf8');
  for (const [from,to] of replacements) source=source.replaceAll(from,to);
  return 'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source,{mode:'transform'})).toString('base64');
};
const textUri=uri('supabase/functions/_shared/arisa-speech-text.ts');
const {synthesize,providerSpeechError,partForReply,SPEECH_VERSION,VOICE,VOICE_INSTRUCTIONS,SPEECH_ERRORS}=await import(uri('supabase/functions/_shared/arisa-speech.ts', [['"./arisa-speech-text.ts"',JSON.stringify(textUri)]]));
const denied=(status,code,message='PRIVATE_PROVIDER_TEXT')=>new Response(JSON.stringify({error:{code,message}}),{status,headers:{'content-type':'application/json'}});
test('the observed 403 model_not_found returns an actionable configuration error',async()=>{
  let calls=0;
  await assert.rejects(synthesize('Texto','test',async()=>{calls++;return denied(403,'model_not_found')}), error=>{
    assert.equal(error.code,'SPEECH_MODEL_UNAVAILABLE'); assert.equal(error.status,409);
    assert.match(SPEECH_ERRORS[error.code],/gpt-4o-mini-tts/); assert.match(SPEECH_ERRORS[error.code],/Model Usage/);
    assert.ok(!JSON.stringify(error).includes('PRIVATE_PROVIDER_TEXT')); return true;
  });
  assert.equal(calls,1,'a denied request must not retry or silently change the voice');
});
test('known model access failures are classified for every documented client error',async()=>{
  for(const status of [400,403,404]) for(const code of ['model_not_found','model_not_available','model_access_denied']) assert.equal((await providerSpeechError(denied(status,code))).code,'SPEECH_MODEL_UNAVAILABLE');
});
test('permissions, billing and rate limits are distinguished without exposing credentials',async()=>{
  assert.equal((await providerSpeechError(denied(401,'invalid_api_key'))).code,'SPEECH_UNAVAILABLE');
  assert.equal((await providerSpeechError(denied(403,'missing_scope'))).code,'SPEECH_PERMISSION');
  assert.equal((await providerSpeechError(denied(429,'insufficient_quota'))).code,'SPEECH_PROVIDER_QUOTA');
  assert.equal((await providerSpeechError(denied(429,'rate_limit_exceeded'))).code,'SPEECH_LIMIT');
});
test('arbitrary provider messages never reach the browser or diagnostics',async()=>{
  const r=denied(500,'unrecognized','secret-key and private customer text');
  const error=await providerSpeechError(r);assert.equal(error.code,'SPEECH_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(error)+error.message,/secret-key|private customer/);
});
test('invalid, oversized and interrupted provider error bodies are handled safely',async()=>{
  assert.equal((await providerSpeechError(new Response('not json',{status:502}))).code,'SPEECH_UNAVAILABLE');
  let cancelled=false;
  const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(16385));},cancel(){cancelled=true;}});
  assert.equal((await providerSpeechError(new Response(stream,{status:500}))).code,'SPEECH_UNAVAILABLE');assert.equal(cancelled,true);
  const broken=new ReadableStream({start(c){c.error(new Error('sensitive transport detail'));}});
  assert.equal((await providerSpeechError(new Response(broken,{status:500}))).code,'SPEECH_UNAVAILABLE');
});
test('an abort neither retries nor starts another provider request',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(synthesize('Teste','key',async(_url,options)=>{calls++;options.signal.throwIfAborted();return new Response();},controller.signal),/SPEECH_UNAVAILABLE/);assert.equal(calls,1);
});
test('the selected Coral voice and the completed response remain unchanged',async()=>{
  assert.equal(VOICE,'coral');assert.match(VOICE_INSTRUCTIONS,/profissional, delicada, doce/);
  const reply={id:'id',content:'Pagamento ainda não realizado.',role:'assistant',status:'completed',parent_id:'parent'};
  const part=partForReply(reply,0,SPEECH_VERSION);
  const audio=await synthesize(part.text,'test',async(url,request)=>{
    assert.equal(url,'https://api.openai.com/v1/audio/speech');
    const body=JSON.parse(request.body);assert.equal(body.input,reply.content);assert.equal(body.voice,'coral');assert.equal(body.model,'gpt-4o-mini-tts');assert.equal(body.speed,.96);
    return new Response(new Uint8Array(128),{headers:{'content-type':'audio/mpeg'}});
  });assert.equal(audio.byteLength,128);
  assert.throws(()=>partForReply({...reply,status:'processing'},0,SPEECH_VERSION),/SPEECH_NOT_READY/);
});
