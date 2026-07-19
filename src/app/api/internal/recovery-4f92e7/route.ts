import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!baseUrl || !publishableKey) {
    return NextResponse.json({ ok: false, error: "Configuração do Supabase ausente." }, { status: 500 });
  }

  const endpoint = new URL("/auth/v1/recover", baseUrl);
  endpoint.searchParams.set("redirect_to", "https://advent-tau.vercel.app/reset-password");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${publishableKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: "franco@evoraurbanismo.com.br" }),
    cache: "no-store",
  });

  const detail = await response.text();

  return NextResponse.json(
    { ok: response.ok, status: response.status, detail: response.ok ? "Recovery requested" : detail },
    { status: response.ok ? 200 : response.status },
  );
}
