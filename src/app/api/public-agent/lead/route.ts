import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      error: "PUBLIC_AGENT_CONVERSATIONAL_CAPTURE_REQUIRED",
      message: "O cadastro é concluído diretamente na conversa com a Vitória.",
    },
    { status: 410, headers: HEADERS },
  );
}
