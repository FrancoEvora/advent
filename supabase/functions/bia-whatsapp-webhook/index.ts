import { createWhatsAppWebhookRpc, handleWhatsAppWebhook, whatsAppWebhookServiceKey } from '../_shared/arisa-whatsapp-webhook.ts';

const rpc = createWhatsAppWebhookRpc(Deno.env.get('SUPABASE_URL') || '', whatsAppWebhookServiceKey(Deno.env.get('SUPABASE_SECRET_KEYS'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')));
// The same tested raw-byte HMAC receiver as Arisa, with a dedicated commercial channel.
Deno.serve(request => handleWhatsAppWebhook(request, rpc, 'bia'));
