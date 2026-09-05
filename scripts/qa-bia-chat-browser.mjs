import {build} from 'esbuild';
import {chromium,webkit} from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

fs.mkdirSync('.qa/results',{recursive:true});
const experience={slug:'solaris',name:'Solaris',agentName:'Bia',greetingText:'Oi! Sou a Bia, da Futura Casa, parceira da Évora Urbanismo. Como posso te ajudar com o Solaris?',title:'Solaris Residencial Resort',subtitle:'Monte Carmelo',eyebrow:'',heroImageUrl:'/vitoria/vitoria-avatar.webp',theme:{quickReplies:[]}};
const commercial={realTime:true,asOf:'2026-09-04T20:00:00Z',summary:{availableCount:165},units:[{unitCode:'SOL-C-10',area:400,listPrice:500000,pricePerSqm:1250},{unitCode:'SOL-C-04',area:360,listPrice:450000,pricePerSqm:1250},{unitCode:'SOL-C-06',area:360,listPrice:450000,pricePerSqm:1250},{unitCode:'SOL-C-08',area:380,listPrice:475000,pricePerSqm:1250},{unitCode:'SOL-C-12',area:410,listPrice:512500,pricePerSqm:1250}]};
await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {PublicAgentExperience} from './src/components/public-agent/PublicAgentExperience';createRoot(document.getElementById('app')).render(<PublicAgentExperience slug="solaris" experience={${JSON.stringify(experience)}}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,outfile:'.qa/app.js',platform:'browser',jsx:'automatic',plugins:[{name:'next-image-test-adapter',setup(b){b.onResolve({filter:/^next\/image$/},()=>({path:'image',namespace:'test-image'}));b.onLoad({filter:/.*/,namespace:'test-image'},()=>({contents:'import React from "react";export default function Image({priority,unoptimized,...props}){return <img {...props}/>}',loader:'jsx',resolveDir:process.cwd()}));}}]});
const css=['src/app/globals.css','src/app/styles/v6-26-public-agent.css','src/app/styles/v6-26-bia-commercial-presentation.css','src/app/styles/v6-27-bia-whatsapp.css'].map(f=>fs.readFileSync(f,'utf8')).join('\n');
const server=http.createServer((req,res)=>{
 if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script src="/app.js"></script></body></html>');}
 else if(req.url==='/style.css'){res.setHeader('content-type','text/css; charset=utf-8');res.end(css);}
 else if(req.url==='/app.js'){res.setHeader('content-type','text/javascript');res.end(fs.readFileSync('.qa/app.js'));}
 else if(req.url==='/voice.wav'){res.setHeader('content-type','audio/wav');res.end(fs.readFileSync('.qa/voice.wav'));}
 else if(req.url?.startsWith('/vitoria/')){const f=path.join('public',req.url);if(fs.existsSync(f)){res.setHeader('content-type','image/webp');res.end(fs.readFileSync(f));}else{res.statusCode=404;res.end();}}
 else {res.statusCode=404;res.end();}
});
await new Promise(resolve=>server.listen(3017,'127.0.0.1',resolve));
const report={fixtureData:true,startedAt:new Date().toISOString(),results:[]};
const origin='http://127.0.0.1:3017';
async function pageWithApi(browser,width,height,lots){
 const context=await browser.newContext({viewport:{width,height},locale:'pt-BR',hasTouch:width<600});const page=await context.newPage();
 const calls={messages:[],transcriptions:[]};
 await page.route('**/api/public-agent/session',route=>route.fulfill({json:{ok:true,stage:'discovery',profile:{},converted:false,messages:lots?[{id:'fixture',direction:'assistant',content:'Separei estas opções de lotes para você comparar.',created_at:'2026-09-04T20:00:00Z',metadata:{public_response:{commercial}}}]:[]}}));
 await page.route('**/api/public-agent/transcribe',route=>{
  const raw=route.request().postDataBuffer();assert.ok(raw&&raw.length>1500,'real MediaRecorder bytes');
  const id=raw.toString('latin1').match(/name="clientMessageId"\r\n\r\n([^\r]+)/)?.[1];calls.transcriptions.push(id);
  if(calls.transcriptions.length===1)return route.fulfill({status:503,json:{ok:false,error:'PUBLIC_AGENT_TRANSCRIPTION_UNAVAILABLE'}});
  return route.fulfill({json:{ok:true,status:'completed',text:'Bom dia, Bia. Quais lotes estão disponíveis no Solaris?'}});
 });
 await page.route('**/api/public-agent/message',route=>{calls.messages.push(route.request().postDataJSON());return route.fulfill({json:{ok:true,status:'completed',reply:'Entendi sua mensagem. Vou consultar os lotes do Solaris.',stage:'discovery',quickReplies:[]}});});
 await page.goto(origin);await page.getByRole('textbox',{name:'Mensagem para a Bia'}).waitFor();await page.waitForFunction(()=>!document.querySelector('textarea')?.disabled);
 return {context,page,calls};
}
async function microphone(page,denied=false){
 await page.evaluate(({denied})=>{
  window.__qaMicCalls=0;window.__qaStreams=[];
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>{
   window.__qaMicCalls++;await new Promise(r=>setTimeout(r,200));
   if(denied)throw new DOMException('Fixture permission refusal','NotAllowedError');
   const ctx=new AudioContext();const buffer=await ctx.decodeAudioData(await (await fetch('/voice.wav')).arrayBuffer());const source=ctx.createBufferSource();source.buffer=buffer;source.loop=true;const destination=ctx.createMediaStreamDestination();source.connect(destination);await ctx.resume();source.start();window.__qaStreams.push(destination.stream);return destination.stream;
  }});
 },{denied});
}
try{
 for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
  const browser=await engine.launch({headless:true});
  try{
   for(const [width,height] of name==='chromium'?[[320,740],[390,844],[430,932],[1280,900]]:[[390,844]]){
    const {page,context,calls}=await pageWithApi(browser,width,height,true);
    try{
     await page.locator('.bia-lot').first().waitFor();assert.equal(await page.locator('.bia-lot').count(),3);
     assert.ok((await page.locator('.bia-lot').first().innerText()).includes('Lote 04'));
     assert.equal(await page.getByText('165 no estoque').count(),0);
     const overflow=await page.evaluate(()=>[...document.querySelectorAll('.bia-lot,.bia-lot-simulate,.public-agent-composer,.public-agent-chat-head')].some(el=>{const b=el.getBoundingClientRect();return b.left<-.5||b.right>innerWidth+.5;}));assert.equal(overflow,false,'no horizontal card clipping');
     await page.getByLabel('Ver detalhes do lote SOL-C-04').click();await page.getByText('SOL-C-04',{exact:true}).first().waitFor();await page.getByLabel('Ver detalhes do lote SOL-C-04').click();
     await page.getByRole('button',{name:'Ver mais 2 opções consultadas'}).click();assert.equal(await page.locator('.bia-lot').count(),5);await page.getByRole('button',{name:'Mostrar só 3 opções'}).click();
     await page.locator('.bia-lots-compare summary').click();assert.equal(await page.locator('.bia-lots-compare tbody tr').count(),3);await page.locator('.bia-lots-compare summary').click();
     await page.locator('.public-agent-messages').evaluate(el=>el.scrollTop=0);await page.waitForTimeout(300);
     await page.screenshot({path:`.qa/results/${name}-${width}-lotes.png`});
     await page.getByLabel('Simular parcelas do lote SOL-C-04').click();await page.locator('.public-agent-messages').getByText('Entendi sua mensagem. Vou consultar os lotes do Solaris.').waitFor();assert.equal(calls.messages.length,1);assert.match(calls.messages[0].message,/SOL-C-04/);
     report.results.push({browser:name,width,kind:'layout-and-lots',passed:true});
    }finally{await context.close();}
   }
   const {page,context,calls}=await pageWithApi(browser,390,844,false);
   try{
    await microphone(page);
    await page.getByRole('button',{name:'Gravar mensagem de voz'}).click();await page.getByRole('group',{name:'Gravando mensagem de voz'}).waitFor();
    await page.waitForTimeout(3600);assert.equal(await page.evaluate(()=>window.__qaMicCalls),1);
    await page.screenshot({path:`.qa/results/${name}-recording.png`});
    await page.getByRole('button',{name:'Parar gravação'}).click();await page.getByLabel('Prévia da mensagem de voz').waitFor();assert.equal(calls.transcriptions.length,0,'preview does not send');
    await page.getByRole('button',{name:'Ouvir mensagem de voz antes de enviar'}).click();await page.waitForTimeout(650);assert.equal(await page.locator('.public-agent-audio-draft audio').evaluate(el=>el.paused),false,'recorded audio plays before sending');
    await page.getByRole('button',{name:'Pausar mensagem de voz'}).click();await page.screenshot({path:`.qa/results/${name}-audio-preview.png`});
    await page.getByRole('button',{name:'Enviar mensagem de voz'}).evaluate(el=>{el.click();el.click();});
    await page.locator('.public-agent-messages').getByText('Entendi sua mensagem. Vou consultar os lotes do Solaris.').waitFor({timeout:30000});
    assert.equal(calls.messages.length,1,'one voice send');assert.equal(calls.messages[0].source,'audio');assert.equal(calls.transcriptions.length,2,'transcription retry');assert.equal(new Set(calls.transcriptions).size,1,'same id on retry');assert.equal(calls.messages[0].transcriptionRequestId,calls.transcriptions[0]);
    assert.equal(await page.locator('.public-agent-message.user .bia-voice-message').count(),1,'no duplicate voice bubble');
    await page.locator('.bia-voice-transcript summary').click();await page.locator('.bia-voice-transcript p').waitFor();
    await page.screenshot({path:`.qa/results/${name}-audio-delivered.png`});
    await page.getByRole('button',{name:'Gravar mensagem de voz'}).click();await page.getByRole('group',{name:'Gravando mensagem de voz'}).waitFor();await page.getByRole('button',{name:'Descartar gravação'}).click();await page.getByRole('button',{name:'Gravar mensagem de voz'}).waitFor();assert.equal(calls.transcriptions.length,2,'cancel never sends');
    assert.equal(await page.evaluate(()=>window.__qaStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true,'all microphone tracks released');
    report.results.push({browser:name,kind:'real-mediarecorder-with-mocked-backend',passed:true,transcriptionRetries:2,voiceTurns:1});
   }finally{await context.close();}
   const denied=await pageWithApi(browser,390,844,false);
   try{await microphone(denied.page,true);await denied.page.getByRole('button',{name:'Gravar mensagem de voz'}).click();await denied.page.getByRole('alert').waitFor();assert.match(await denied.page.getByRole('alert').innerText(),/permita o microfone/);assert.equal(await denied.page.getByRole('textbox').isEnabled(),true);report.results.push({browser:name,kind:'permission-denied',passed:true});}finally{await denied.context.close();}
  }catch(error){report.results.push({browser:name,passed:false,error:error instanceof Error?error.message:String(error)});}
  finally{await browser.close();}
 }
}finally{server.close();report.finishedAt=new Date().toISOString();fs.writeFileSync('.qa/results/browser.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
if(report.results.some(r=>!r.passed))process.exitCode=1;
