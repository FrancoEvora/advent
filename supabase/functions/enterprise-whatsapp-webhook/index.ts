import { createWhatsAppWebhookRpc, handleWhatsAppWebhook, whatsAppWebhookServiceKey } from "../_shared/arisa-whatsapp-webhook.ts";

// Deploy with verify_jwt=false: Meta authenticates each delivery with its HMAC.
// Keep the existing Meta callback URL and CRM RPCs while routing administrative replies to Arisa.
const rpc = createWhatsAppWebhookRpc(
  Deno.env.get("SUPABASE_URL")?.trim() || "",
  whatsAppWebhookServiceKey(Deno.env.get("SUPABASE_SECRET_KEYS"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")),
);
Deno.serve((request: Request) => handleWhatsAppWebhook(request, rpc, "shared"));
