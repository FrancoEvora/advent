// POST verifies the bearer token and the caller's lead scope before reading history.
Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405, headers: { Allow: "POST" } });
  try {
    const { POST } = await import("../../../src/app/api/crm/conversations/route.ts");
    return await POST(request);
  } catch (error) {
    console.error("HISTORY_BACKEND_INITIALIZATION", error instanceof Error ? error.message : "UNKNOWN");
    return Response.json({error:"CRM_HISTORY_UNAVAILABLE",message:"Não foi possível carregar o histórico agora."}, {status:503});
  }
});
