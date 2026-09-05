import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const qa='scripts/qa-bia-chat-browser.mjs';
let test=fs.readFileSync(qa,'utf8');
test=test.replaceAll("page.getByText('Entendi sua mensagem. Vou consultar os lotes do Solaris.')","page.locator('.public-agent-messages').getByText('Entendi sua mensagem. Vou consultar os lotes do Solaris.')");
test=test.replace("res.setHeader('content-type','text/css')","res.setHeader('content-type','text/css; charset=utf-8')");
test=test.replace('<head><meta name="viewport"','<head><meta charset="utf-8"><meta name="viewport"');
// The synthetic microphone needs its AudioContext resumed inside the user gesture,
// just as Safari requires for audio playback. Real getUserMedia does not use this adapter.
test=test.replace('window.__qaMicCalls++;await new Promise(r=>setTimeout(r,200));','window.__qaMicCalls++;const ctx=denied?null:new AudioContext();const resumed=ctx?.resume();await new Promise(r=>setTimeout(r,200));');
test=test.replace('const ctx=new AudioContext();const buffer=','const buffer=');
test=test.replace('await ctx.resume();source.start();','await resumed;source.start();');
fs.writeFileSync(qa,test);

const css='src/app/styles/v6-27-bia-whatsapp.css';let styles=fs.readFileSync(css,'utf8');
const more='\n.bia-whatsapp .public-agent-message.assistant .public-agent-message-meta{justify-content:flex-end}\n.bia-whatsapp .bia-lot-simulate,.bia-whatsapp .bia-lots-more{font-size:12px}\n';
if(!styles.includes(more))styles+=more;fs.writeFileSync(css,styles);

const file='supabase/functions/enterprise-vitoria-agent/index.ts';
let source=fs.readFileSync(file,'utf8');
if(!source.includes('transcribeBiaAudio')){
 const sha=createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
 assert.equal(sha,'31fa674de36c2169f2983146534c30f7b9711f92','Legacy agent changed: inspect before audio patch');
 source='import { transcribeBiaAudio } from "../_shared/bia-audio-transcription.ts";\n'+source;
 const start=source.indexOf('async function transcribe(\n');
 const end=source.indexOf('\nasync function persistPublicAudio(',start);
 assert.ok(start>0&&end>start);
 const replacement=`async function transcribe(
  admin: ReturnType<typeof createClient>,
  runtime: Runtime,
  slug: string,
  tokenHash: string,
  fingerprintHash: string,
  mime: string,
  bytes: Uint8Array,
) {
  await rpc(admin, "claim_public_agent_media_quota", {
    p_slug: slug, p_session_token_hash: tokenHash, p_fingerprint_hash: fingerprintHash, p_kind: "voice",
  });
  const result = await transcribeBiaAudio({
    apiKey: runtime.apiKey,
    model: Deno.env.get("BIA_TRANSCRIPTION_MODEL") || "gpt-4o-mini-transcribe",
    mime, bytes, timeoutMs: TRANSCRIPTION_TIMEOUT_MS,
    diagnose: async (diagnostic) => {
      console.error("bia-audio-provider", diagnostic);
      await admin.rpc("record_bia_openai_diagnostic", {
        p_organization_id: null,
        p_model: diagnostic.model,
        p_http_status: diagnostic.status,
        p_error_code: diagnostic.code,
        p_error_type: diagnostic.type,
        p_request_id: diagnostic.requestId,
        p_limit_requests: null, p_remaining_requests: null, p_reset_requests: null,
        p_limit_tokens: null, p_remaining_tokens: null, p_reset_tokens: null,
      });
    },
  });
  if (!result.ok) throw new EdgeError(result.code, 503);
  return { text: result.text };
}
`;
 source=source.slice(0,start)+replacement+source.slice(end);
 fs.writeFileSync(file,source);
}
const ui='src/components/public-agent/PublicAgentExperience.tsx';let experience=fs.readFileSync(ui,'utf8');
if(!experience.includes('PUBLIC_AGENT_AUDIO_MODEL_UNAVAILABLE:')){
 experience=experience.replace('const ERROR_TEXT: Record<string, string> = {','const ERROR_TEXT: Record<string, string> = {\n  PUBLIC_AGENT_AUDIO_MODEL_UNAVAILABLE: "A transcrição de áudio precisa ser habilitada na integração. Por enquanto, envie sua mensagem por escrito.",\n  PUBLIC_AGENT_AUDIO_PROVIDER_QUOTA: "A transcrição está temporariamente indisponível na integração. Seu áudio foi mantido para tentar novamente.",\n  PUBLIC_AGENT_AUDIO_PROVIDER_BUSY: "A transcrição está ocupada agora. Aguarde um momento e tente novamente com o mesmo áudio.",');
}
if(!experience.includes('const permanentAudioErrors = [')){
 const start=experience.indexOf('  async function requestTranscription(');assert.ok(start>0);
 const before=experience.slice(0,start),after=experience.slice(start);
 experience=before+after.replace('      if (response.status >= 500) {','      const permanentAudioErrors = ["PUBLIC_AGENT_AUDIO_MODEL_UNAVAILABLE", "PUBLIC_AGENT_AUDIO_PROVIDER_QUOTA", "PUBLIC_AGENT_AUDIO_TRANSCRIPT_TOO_LONG"];\n      if (permanentAudioErrors.includes(payload.error || "")) throw new Error(payload.error);\n      if (response.status >= 500) {');
}
fs.writeFileSync(ui,experience);
const viewport='tests/public-agent-mobile-viewport.test.mjs';
let vp=fs.readFileSync(viewport,'utf8');
vp=vp.replace('/ref=\\{messagesRef\\} className="public-agent-messages"/', '/ref=\\{messagesRef\\}[\\s\\S]{0,400}className="public-agent-messages"/');
fs.writeFileSync(viewport,vp);
const contracts='tests/vitoria-runtime-v4.test.mts';
let ct=fs.readFileSync(contracts,'utf8');
ct=ct.replace('assert.match(ui, /Simular condições do lote \\$\\{unit\\.unitCode\\}/);','assert.match(ui, /Simule a menor parcela do lote \\$\\{unit\\.unitCode\\}/);');
ct=ct.replace('assert.match(ui, />\\s*Simular condições\\s*</);','assert.match(readFileSync(new URL("../src/components/public-agent/ChatLotOptions.tsx", import.meta.url), "utf8"), />\\s*Simular parcelas\\s*</);');
fs.writeFileSync(contracts,ct);
if(process.env.GITHUB_ACTIONS==='true')execFileSync('git',['add',viewport,contracts]);
console.log('Applied bounded legacy transcription diagnostics and QA refinements.');
