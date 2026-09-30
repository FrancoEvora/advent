import { protectedResourceMetadata } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET() {
  return Response.json(protectedResourceMetadata(), {
    headers: {
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
