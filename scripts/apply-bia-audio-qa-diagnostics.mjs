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
}
if(!s.includes("kind:'unsupported-mediarecorder-fallback'")){
 const old="    console.log('BIA_BROWSER_CAPABILITIES',name,JSON.stringify(mediaCapabilities));\n    await microphone(page);";
 assert.equal(s.split(old).length,2);
 s=s.replace(old,`    console.log('BIA_BROWSER_CAPABILITIES',name,JSON.stringify(mediaCapabilities));
    if(mediaCapabilities.mediaRecorder==='undefined'){
      await page.getByRole('button',{name:'Gravar mensagem de voz'}).click();
      await page.getByRole('alert').waitFor();
      assert.match(await page.getByRole('alert').innerText(),/gravação não está disponível/);
      assert.equal(await page.getByRole('textbox').isEnabled(),true);
      assert.equal(calls.transcriptions.length,0);
      await page.screenshot({path:'.qa/results/'+name+'-recording-unavailable.png'});
      report.results.push({browser:name,kind:'unsupported-mediarecorder-fallback',passed:true,recordingTested:false,reason:'The installed WebKit build does not expose MediaRecorder. Physical Safari/iPhone recording remains unverified.'});
      continue;
    }
    await microphone(page);`);
}
fs.writeFileSync(file,s);
