import { forwardConnect } from "@/lib/integrations/whatsapp/connect-proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ connectionId: string }> };
export const maxDuration = 120;
export async function GET(request: Request, context: Context) { return forwardConnect(request, `webhook/${(await context.params).connectionId}`); }
export const POST = GET;
