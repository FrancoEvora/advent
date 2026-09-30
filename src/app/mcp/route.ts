import { handleMcpRequest } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 15;

export async function POST(request: Request) {
  return handleMcpRequest(request);
}

export async function GET(request: Request) {
  return handleMcpRequest(request);
}

export async function DELETE(request: Request) {
  return handleMcpRequest(request);
}

export async function PUT(request: Request) {
  return handleMcpRequest(request);
}

export async function PATCH(request: Request) {
  return handleMcpRequest(request);
}
