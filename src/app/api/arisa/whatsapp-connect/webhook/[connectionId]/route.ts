import { handleConnectWebhook } from "@/lib/integrations/whatsapp/connect-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ connectionId: string }> };
export async function GET(request: Request, context: Context) { return handleConnectWebhook(request, (await context.params).connectionId); }
export const POST = GET;
