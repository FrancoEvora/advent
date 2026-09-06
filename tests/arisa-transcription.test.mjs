import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const source = readFileSync(new URL('../supabase/functions/arisa-manager/index.ts', import.meta.url), 'utf8');
const fn = source.slice(source.indexOf('export async function transcribe('), source.indexOf('\nexport async function handleRequest'));
const code = `class ManagerError extends Error { constructor(code,status){ super(code); this.status=status; } }\nconst isObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);\n${stripTypeScriptTypes(fn)}`;
const { transcribe } = await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const file={mime_type:'audio/mp4',file_name:'voice.m4a'}, bytes=new Uint8Array(128);
const original=globalThis.fetch;
test.afterEach(()=>{globalThis.fetch=original;});
test('model fallback reaches full transcription and preserves Portuguese text',async()=>{
 const models=[]; globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/audio/transcriptions'); models.push(options.body.get('model')); assert.equal(options.body.get('language'),'pt'); return models.length===1?Response.json({error:{code:'model_not_found'}},{status:403}):Response.json({text:' Reunião amanhã às dez. '});};
 assert.equal(await transcribe(bytes,file,'synthetic-key'),'Reunião amanhã às dez.'); assert.deepEqual(models,['gpt-4o-mini-transcribe','gpt-4o-transcribe']);
});
test('permission denial is actionable and never leaks provider details',async()=>{
 globalThis.fetch=async()=>Response.json({error:{code:'model_not_found',message:'private-project'}},{status:403});
 await assert.rejects(transcribe(bytes,file,'synthetic-key'),e=>e.message==='AUDIO_MODEL_ACCESS'&&e.status===403);
});
test('bad recording is not retried as a model access problem',async()=>{
 let count=0;globalThis.fetch=async()=>{count++;return Response.json({error:{code:'invalid_value'}},{status:400});};
 await assert.rejects(transcribe(bytes,file,'synthetic-key'),/AUDIO_INVALID/);assert.equal(count,1);
});
test('quota, rate limit, empty transcript and network failures remain distinct',async()=>{
 for(const [response,error] of [[Response.json({error:{code:'insufficient_quota'}},{status:429}),'AUDIO_QUOTA'],[new Response('',{status:429}),'AUDIO_LIMIT'],[Response.json({text:''}),'AUDIO_EMPTY']]){globalThis.fetch=async()=>response;await assert.rejects(transcribe(bytes,file,'synthetic-key'),new RegExp(error));}
 globalThis.fetch=async()=>{throw new Error('private network detail');};await assert.rejects(transcribe(bytes,file,'synthetic-key'),/AUDIO_UNAVAILABLE/);
});
