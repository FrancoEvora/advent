import { transcribeBiaAudio } from './bia-audio-transcription.ts';

type Obj = Record<string, unknown>;
export type BiaRpc = (name: string, args: Obj) => Promise<unknown>;
const obj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => typeof v === 'string' ? v : '';
const MAX_AUDIO = 3_000_000;

export function biaOutboundText(response: unknown): string {
  if (!obj(response) || !str(response.reply).trim()) throw new Error('BIA_REPLY_MISSING');
  let content = str(response.reply).trim();
  const attachments = Array.isArray(response.attachments) ? response.attachments : [];
  for (const item of attachments.slice(0, 4)) {
    if (!obj(item)) continue;
    try {
      const url = new URL(str(item.url));
      if (url.protocol !== 'https:' || url.username || url.password) continue;
      const line = `\n\n${str(item.title).slice(0, 100) || 'Material do empreendimento'}: ${url.href}`;
      if (content.length + line.length <= 4096) content += line;
    } catch { /* An attachment without a public HTTPS URL cannot be sent. */ }
  }
  if (content.length > 4096) throw new Error('BIA_REPLY_TOO_LONG');
  return content;
}

async function boundedAudio(response: Response): Promise<Uint8Array> {
  if (!response.ok || Number(response.headers.get('content-length') || 0) > MAX_AUDIO || !response.body) throw new Error('BIA_MEDIA_UNAVAILABLE');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_AUDIO) throw new Error('BIA_MEDIA_TOO_LARGE'); chunks.push(value); }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function audioText(job: Obj, credentials: Obj, rpc: BiaRpc, http: typeof fetch): Promise<string> {
  const meta = obj(job.metadata) ? job.metadata : {};
  const id = str(meta.media_id); if (!/^\d{1,64}$/.test(id)) throw new Error('BIA_MEDIA_INVALID');
  const headers = { Authorization: `Bearer ${credentials.access_token}` };
  const infoResponse = await http(`https://graph.facebook.com/${credentials.graph_api_version}/${id}`, { headers, signal: AbortSignal.timeout(12000) });
  const info: unknown = await infoResponse.json();
  if (!infoResponse.ok || !obj(info) || Number(info.file_size || 0) > MAX_AUDIO) throw new Error('BIA_MEDIA_UNAVAILABLE');
  const url = new URL(str(info.url));
  // Media URLs are returned by Meta. Never send the access token to an arbitrary host or redirect.
  if (url.protocol !== 'https:' || url.username || url.password || !(url.hostname === 'lookaside.fbsbx.com' || url.hostname.endsWith('.fbcdn.net'))) throw new Error('BIA_MEDIA_HOST_INVALID');
  const mime = str(info.mime_type).split(';')[0];
  if (!['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/aac'].includes(mime)) throw new Error('BIA_MEDIA_TYPE_INVALID');
  const media = await http(url, { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
  const bytes = await boundedAudio(media);
  const expectedHash = str(meta.sha256) || str(info.sha256);
  if (expectedHash) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
    const hex = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
    const base64 = btoa(String.fromCharCode(...digest));
    if (expectedHash !== hex && expectedHash !== base64) throw new Error('BIA_MEDIA_HASH_INVALID');
  }
  const ai = await rpc('get_crm_ai_runtime_credentials', { p_organization_id: job.organizationId });
  if (!obj(ai) || ai.enabled !== true || !str(ai.api_key)) throw new Error('BIA_AI_DISABLED');
  const transcript = await transcribeBiaAudio({ apiKey: str(ai.api_key), bytes, mime, timeoutMs: 30000, diagnose: async () => undefined });
  if (!transcript.ok) throw new Error(transcript.code);
  return transcript.text;
}

export async function processBiaWhatsApp(input: { rpc: BiaRpc; gatewayUrl: string; publishableKey: string; http?: typeof fetch }) {
  const { rpc, gatewayUrl, publishableKey } = input, http = input.http || fetch;
  let sent = 0;
  const started = Date.now();
  for (let i = 0; i < 4 && Date.now() - started < 110000; i++) {
    const job = await rpc('bia_whatsapp_reply_worker', { p_action: 'claim', p_args: {} });
    if (!obj(job) || !job.id) break;
    const args = { id: job.id, lease: job.lease };
    try {
      const credentials = await rpc('bia_whatsapp_credentials', { p_organization_id: job.organizationId });
      if (!obj(credentials) || credentials.enabled !== true || !str(credentials.access_token) || !/^v\d+\.\d+$/.test(str(credentials.graph_api_version)) || !/^\d+$/.test(str(credentials.phone_number_id))) throw new Error('BIA_CHANNEL_DISABLED');
      let content = str(job.generatedContent), handoff = job.humanRequested === true;
      if (!content) {
        let message = str(job.message);
        if (job.messageType === 'audio') {
          try { message = await audioText(job, credentials, rpc, http); }
          catch { content = 'Não consegui compreender este áudio. Pode enviar uma mensagem de texto ou um áudio mais curto?'; }
        } else if (!['text', 'button', 'interactive'].includes(str(job.messageType))) {
          content = 'Recebi seu arquivo. Para ajudar com segurança, me conte por texto ou áudio o que você precisa consultar sobre ele.';
        }
        if (!content && message.length > 800) content = 'Sua mensagem ficou longa para esta consulta. Pode dividir em mensagens menores, com até 800 caracteres?';
        if (!content) {
          const response = await http(gatewayUrl, { method: 'POST', headers: { apikey: publishableKey, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'message', slug: job.slug, tokenHash: job.tokenHash, fingerprintHash: job.fingerprintHash, message, source: 'text', clientMessageId: job.id }), signal: AbortSignal.timeout(85000) });
          const body: unknown = await response.json();
          if (!response.ok || response.status === 202 || !obj(body) || body.ok !== true || !obj(body.data)) throw new Error('BIA_TURN_UNAVAILABLE');
          content = biaOutboundText(body.data); handoff = body.data.handoffRequested === true && obj(body.data.followup) && body.data.followup.recorded === true;
        }
      }
      const permission = await rpc('bia_whatsapp_reply_worker', { p_action: 'send', p_args: { ...args, content, humanRequested: handoff } });
      if (!obj(permission) || permission.proceed !== true) continue;
      const response = await http(`https://graph.facebook.com/${credentials.graph_api_version}/${credentials.phone_number_id}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${credentials.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: job.phone, type: 'text', text: { body: content, preview_url: false }, biz_opaque_callback_data: String(job.id) }), signal: AbortSignal.timeout(20000) });
      const result: unknown = await response.json();
      const id = obj(result) && Array.isArray(result.messages) && obj(result.messages[0]) ? str(result.messages[0].id) : '';
      if (!response.ok || !id) throw new Error('BIA_META_SEND_UNCONFIRMED');
      await rpc('bia_whatsapp_reply_worker', { p_action: 'finish', p_args: { ...args, providerMessageId: id } });
      sent++;
    } catch (error) {
      const message = error instanceof Error && /^(BIA_|PUBLIC_AGENT_)[A-Z_]+$/.test(error.message) ? error.message : 'BIA_WORKER_UNAVAILABLE';
      await rpc('bia_whatsapp_reply_worker', { p_action: 'fail', p_args: { ...args, error: message } }).catch(() => undefined);
    }
  }
  return { sent };
}
