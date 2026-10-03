import { forwardConnect } from "@/lib/integrations/whatsapp/connect-proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => forwardConnect(request, "status");
export const POST = (request: Request) => forwardConnect(request, "begin");
