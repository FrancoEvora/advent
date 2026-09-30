import { McpOAuthError, oauthErrorResponse, revokeDelegatedToken } from "@/lib/mcp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      throw new McpOAuthError(400, "invalid_request", "Use application/x-www-form-urlencoded.");
    }
    if (Number(request.headers.get("content-length")) > 16 * 1024) {
      throw new McpOAuthError(413, "invalid_request", "Solicitação muito grande.");
    }
    const form = new URLSearchParams(await request.text());
    await revokeDelegatedToken(form);
    return new Response(null, {
      status: 200,
      headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
    });
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
