import { handleBiaOutbound } from '../_shared/bia-whatsapp-outbound.ts';
import { whatsAppWebhookServiceKey } from '../_shared/arisa-whatsapp-webhook.ts';

const url = Deno.env.get('SUPABASE_URL') || '';
const key = whatsAppWebhookServiceKey(Deno.env.get('SUPABASE_SECRET_KEYS'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
Deno.serve(request => handleBiaOutbound(request, {
  authenticate: async token => {
    const response = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const user = await response.json();
    return typeof user.id === 'string' && user.is_anonymous !== true ? user.id : null;
  },
  rpc: async (name, args) => {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: 'POST',
      headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(args), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.message === 'string' && /^BIA_[A-Z_]+$/.test(result.message) ? result.message : 'BIA_OUTBOUND_UNAVAILABLE');
    return result;
  },
}));
