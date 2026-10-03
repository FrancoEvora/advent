import { rejectConnectCallback } from "@/lib/integrations/whatsapp/connect-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = rejectConnectCallback;
export const GET = rejectConnectCallback;
