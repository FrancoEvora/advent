import {
  McpOAuthError,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  oauthErrorResponse,
} from "@/lib/mcp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      throw new McpOAuthError(400, "invalid_request", "Use application/x-www-form-urlencoded.");
    }
    if (Number(request.headers.get("content-length")) > 32 * 1024) {
      throw new McpOAuthError(413, "invalid_request", "Solicitação muito grande.");
    }
    const form = new URLSearchParams(await request.text());
    const grantType = form.get("grant_type");
    const result = grantType === "authorization_code"
      ? await exchangeAuthorizationCode(form)
      : grantType === "refresh_token"
        ? await exchangeRefreshToken(form)
        : (() => { throw new McpOAuthError(400, "unsupported_grant_type", "Grant type não suportado."); })();

    return Response.json(result, {
      headers: {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
