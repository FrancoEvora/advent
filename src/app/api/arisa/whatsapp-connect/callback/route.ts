import { forwardConnect } from "@/lib/integrations/whatsapp/connect-proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export const POST = (request: Request) => forwardConnect(request, "callback");
export const GET = (request: Request) => forwardConnect(request, "callback");
