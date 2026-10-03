import { handleConnect } from "@/lib/integrations/whatsapp/connect-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export const POST = (request: Request) => handleConnect(request, "callback");
export const GET = (request: Request) => handleConnect(request, "callback");
