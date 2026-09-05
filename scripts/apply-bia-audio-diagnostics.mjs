import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const qa='scripts/qa-bia-chat-browser.mjs';
let test=fs.readFileSync(qa,'utf8');
test=test.replaceAll("page.getByText('Entendi sua mensagem. Vou consultar os lotes do Solaris.')","page.locator('.public-agent-messages').getByText('Entendi sua mensagem. Vou consultar os lotes do Solaris.')");
test=test.replace("res.setHeader('content-type','text/css')","res.setHeader('content-type','text/css; charset=utf-8')");
test=test.replace('<head><meta name="viewport"','<head><meta charset="utf-8"><meta name="viewport"');
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
 fs.writeFileSync(ui,experience);
}
console.log('Applied bounded legacy transcription diagnostics and QA refinements.');
