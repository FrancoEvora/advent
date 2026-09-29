import { createAgentApiHandler } from "@/lib/agent-api/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 15;

const handle = createAgentApiHandler();
type Context = { params: Promise<{ path?: string[] }> };

async function route(request: Request, context: Context) {
  return handle(request, (await context.params).path ?? []);
}

export { route as GET, route as HEAD, route as POST, route as PUT,
  route as PATCH, route as DELETE, route as OPTIONS };
