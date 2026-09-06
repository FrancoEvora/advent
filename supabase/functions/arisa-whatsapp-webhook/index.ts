import { createWhatsAppWebhookRpc, handleWhatsAppWebhook, whatsAppWebhookServiceKey } from "../_shared/arisa-whatsapp-webhook.ts";

// Optional Arisa-only callback. Deploy with verify_jwt=false; POST is HMAC-authenticated.
// The existing enterprise-whatsapp-webhook callback also supports Arisa, without changing Meta setup.
const rpc = createWhatsAppWebhookRpc(
  Deno.env.get("SUPABASE_URL")?.trim() || "",
  whatsAppWebhookServiceKey(Deno.env.get("SUPABASE_SECRET_KEYS"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")),
);
Deno.serve((request: Request) => handleWhatsAppWebhook(request, rpc, "arisa"));
