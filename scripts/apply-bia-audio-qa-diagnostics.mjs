import fs from 'node:fs';
import assert from 'node:assert/strict';
const file='scripts/qa-bia-chat-browser.mjs';
let s=fs.readFileSync(file,'utf8');
if(!s.includes('mediaCapabilities')){
 const old='    await microphone(page);';
 assert.equal(s.split(old).length,2);
 s=s.replace(old,`    const mediaCapabilities=await page.evaluate(()=>({mediaRecorder:typeof MediaRecorder,audioContext:typeof AudioContext,secure:window.isSecureContext,mimes:['audio/webm;codecs=opus','audio/mp4;codecs=mp4a.40.2','audio/mp4'].map(mime=>({mime,supported:typeof MediaRecorder!=='undefined'&&MediaRecorder.isTypeSupported(mime)}))}));
    console.log('BIA_BROWSER_CAPABILITIES',name,JSON.stringify(mediaCapabilities));
    await microphone(page);`);
 const oldEnd="report.results.push({browser:name,kind:'real-mediarecorder-with-mocked-backend',passed:true,transcriptionRetries:2,voiceTurns:1});\n   }finally{await context.close();}";
 assert.equal(s.split(oldEnd).length,2);
 s=s.replace(oldEnd,`report.results.push({browser:name,kind:'real-mediarecorder-with-mocked-backend',passed:true,transcriptionRetries:2,voiceTurns:1});
   }catch(error){
    const diagnostic=await page.evaluate(()=>({body:document.body.innerText,micCalls:window.__qaMicCalls,streams:window.__qaStreams?.map(s=>s.getTracks().map(t=>({state:t.readyState,kind:t.kind}))),capabilities:typeof MediaRecorder==='undefined'?null:['audio/webm;codecs=opus','audio/mp4;codecs=mp4a.40.2','audio/mp4'].map(mime=>({mime,supported:MediaRecorder.isTypeSupported(mime)}))}));
    console.log('BIA_BROWSER_AUDIO_FAILURE',name,JSON.stringify(diagnostic));
    await page.screenshot({path:'.qa/results/'+name+'-audio-failure.png'});
    report.results.push({browser:name,kind:'audio-diagnostics',passed:false,diagnostic});
    throw error;
   }finally{await context.close();}`);
 fs.writeFileSync(file,s);
}
