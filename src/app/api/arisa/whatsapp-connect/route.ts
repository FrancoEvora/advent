import { handleConnect } from "@/lib/integrations/whatsapp/connect-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => handleConnect(request, "status");
export const POST = (request: Request) => handleConnect(request, "begin");
