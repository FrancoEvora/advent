import { handleConnect, handleConnectWebhook, readLimitedBody, routeCoexistenceAccountEvent } from "../../../src/lib/integrations/whatsapp/connect-server.ts";
import { whatsAppWebhookServiceKey } from "../_shared/arisa-whatsapp-webhook.ts";

// Gateway JWT verification is disabled because this function handles signed Meta
// webhooks too. User actions explicitly validate the caller JWT and active admin;
// webhook actions validate HMAC over raw bytes before persisting anything.
const dependencies = { env: { NODE_ENV: "production", SUPABASE_SECRET_KEY: whatsAppWebhookServiceKey(Deno.env.get("SUPABASE_SECRET_KEYS"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) } };
Deno.serve(async (request: Request) => {
  const path = new URL(request.url).pathname;
  if (path.endsWith("/status")) return handleConnect(request, "status", dependencies);
  if (path.endsWith("/begin")) return handleConnect(request, "begin", dependencies);
  if (path.endsWith("/callback")) return handleConnect(request, "callback", dependencies);
  const match = path.match(/\/webhook\/([0-9a-f-]{36})$/i);
  if (match) return handleConnectWebhook(request, match[1], dependencies);
  if (path.endsWith("/account-events") && request.method === "POST") {
    try { return await routeCoexistenceAccountEvent(request, await readLimitedBody(request, 2097152), dependencies) ?? new Response(null, { status: 204 }); }
    catch { return new Response("Unavailable", { status: 503 }); }
  }
  return new Response("Not found", { status: 404 });
});
