import {
  MCP_ORIGIN,
  approveAuthorization,
  authorizationRedirect,
  oauthErrorResponse,
  parseAuthorizationRequest,
} from "@/lib/mcp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function requestFromBody(body: Record<string, unknown>) {
  const url = new URL(`${MCP_ORIGIN}/oauth/authorize`);
  for (const key of [
    "response_type", "client_id", "redirect_uri", "code_challenge",
    "code_challenge_method", "state", "resource", "scope",
  ]) {
    const value = body[key];
    if (typeof value === "string") url.searchParams.set(key, value);
  }
  return parseAuthorizationRequest(url);
}

export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length")) > 32 * 1024) {
      return Response.json(
        { error: "invalid_request", error_description: "Solicitação muito grande." },
        { status: 413, headers: { "Cache-Control": "no-store" } },
      );
    }
    const body = await request.json() as Record<string, unknown>;
    const oauth = requestFromBody(body);
    if (body.decision === "deny") {
      return Response.json({
        redirect_url: authorizationRedirect(oauth, {
          error: "access_denied",
          errorDescription: "O acesso ao Évora Enterprise foi recusado.",
        }),
      }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.decision !== "approve") {
      return Response.json(
        { error: "invalid_request", error_description: "Decisão inválida." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const auth = request.headers.get("authorization") || "";
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (!match) {
      return Response.json(
        { error: "access_denied", error_description: "Entre com sua conta administrativa da Évora." },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    const redirectUrl = await approveAuthorization({
      request: oauth,
      enterpriseAccessToken: match[1],
    });
    return Response.json({ redirect_url: redirectUrl }, {
      headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
    });
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
