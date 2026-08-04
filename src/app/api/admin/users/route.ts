import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  "https://qsdffayasuzsmngteika.supabase.co";
const supabasePublishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  "sb_publishable_nMCXNDXMvU0EbMSSmnEfQg_0uE_lVOW";

type AdminFunctionResult = {
  error?: string;
  message?: string;
  auditWarning?: boolean;
  code?: string;
  supportReference?: string;
  operationId?: string;
  activeAssignmentsCancelled?: number;
};

function errorResponse(
  message: string,
  status = 400,
  code?: string,
  supportReference?: string,
) {
  return NextResponse.json(
    {
      error: message,
      ...(code ? { code } : {}),
      ...(supportReference ? { supportReference } : {}),
    },
    { status },
  );
}

function sanitizeFunctionResult(value: unknown): AdminFunctionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return {
    ...(typeof source.error === "string" ? { error: source.error } : {}),
    ...(typeof source.message === "string" ? { message: source.message } : {}),
    ...(typeof source.auditWarning === "boolean"
      ? { auditWarning: source.auditWarning }
      : {}),
    ...(typeof source.code === "string" ? { code: source.code } : {}),
    ...(typeof source.supportReference === "string"
      ? { supportReference: source.supportReference }
      : {}),
    ...(typeof source.operationId === "string"
      ? { operationId: source.operationId }
      : {}),
    ...(typeof source.activeAssignmentsCancelled === "number"
      ? { activeAssignmentsCancelled: source.activeAssignmentsCancelled }
      : {}),
  };
}

export async function POST(request: NextRequest) {
  const supportReference = `ADM-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

  try {
    const authorization = request.headers.get("authorization") || "";
    if (!authorization.toLowerCase().startsWith("bearer ")) {
      return errorResponse(
        "Sessão administrativa não informada.",
        401,
        "SESSION_REQUIRED",
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return errorResponse(
        "Não foi possível interpretar os dados da operação.",
        400,
        "INVALID_REQUEST",
      );
    }

    const response = await fetch(`${supabaseUrl}/functions/v1/admin-users`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        apikey: supabasePublishableKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });

    let rawResult: unknown = null;
    try {
      rawResult = await response.json();
    } catch {
      // A resposta será substituída por uma mensagem segura e correlacionável.
    }
    const result = sanitizeFunctionResult(rawResult);

    if (!response.ok) {
      return NextResponse.json(
        {
          error:
            result.error ||
            (response.status === 401
              ? "A sessão expirou. Entre novamente na plataforma."
              : "O serviço administrativo não conseguiu concluir a operação."),
          code:
            (result.error ? result.code : undefined) ||
            (response.status === 401
              ? "SESSION_EXPIRED"
              : "ADMIN_OPERATION_FAILED"),
          ...(result.supportReference
            ? { supportReference: result.supportReference }
            : response.status >= 500
              ? { supportReference }
              : {}),
        },
        { status: response.status },
      );
    }

    return NextResponse.json(result, {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Admin users proxy failed", {
      supportReference,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage:
        error instanceof Error ? error.message : "Falha de comunicação desconhecida",
    });
    return errorResponse(
      "O serviço administrativo está temporariamente indisponível. Nenhuma conclusão foi confirmada.",
      503,
      "ADMIN_SERVICE_UNAVAILABLE",
      supportReference,
    );
  }
}
