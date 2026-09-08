import { createWhatsAppWebhookRpc, whatsAppWebhookServiceKey } from '../_shared/arisa-whatsapp-webhook.ts';
import { processBiaWhatsApp } from '../_shared/bia-whatsapp-replies.ts';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
Deno.serve(async request => {
  if (request.method !== 'POST') return json({ ok: false }, 405);
  const supplied = request.headers.get('x-bia-worker-secret') || '';
  if (!supplied || supplied.length > 512) return json({ ok: false }, 401);
  const url = Deno.env.get('SUPABASE_URL') || '';
  const rpc = createWhatsAppWebhookRpc(url, whatsAppWebhookServiceKey(Deno.env.get('SUPABASE_SECRET_KEYS'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')));
  try {
    const expected = await rpc('bia_whatsapp_worker_secret', {});
    if (typeof expected !== 'string' || !expected) return json({ ok: false }, 401);
    const digest = async (v: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
    const [a,b] = await Promise.all([digest(supplied),digest(expected)]);
    if (a.some((value,index) => value !== b[index])) return json({ ok: false }, 401);
    const keys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}');
    const key = Object.values(keys).find((v): v is string => typeof v === 'string' && v.startsWith('sb_publishable_'));
    if (!key) throw new Error('BIA_CONFIG_MISSING');
    return json({ ok: true, ...await processBiaWhatsApp({ rpc, gatewayUrl: `${url}/functions/v1/enterprise-bia-agent-gateway`, publishableKey: key }) });
  } catch { return json({ ok: false, error: 'BIA_WORKER_UNAVAILABLE' }, 503); }
});
