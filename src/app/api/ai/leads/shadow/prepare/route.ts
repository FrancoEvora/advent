import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";

import { parseMetaCredentialBearer } from "@/lib/integrations/meta/credential-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const MAX_CONTENT_LENGTH = 1_200;

type Obj = Record<string, unknown>;
type AuthContext = {
  service: SupabaseClient;
  organizationId: string;
  userId: string;
};

class ApiError extends Error {
  status: number;
  code: string;

  constructor(
    message: string,
    status = 400,
    code = "AI_DRAFT_PREPARE_FAILED",
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function publicConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key) {
    throw new ApiError(
      "Supabase público indisponível.",
      503,
      "SUPABASE_PUBLIC_UNAVAILABLE",
    );
  }
  return { url, key };
}

function serviceConfig() {
  const url =
    process.env.SUPABASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key =
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new ApiError(
      "Supabase de integração indisponível.",
      503,
      "SUPABASE_SERVICE_UNAVAILABLE",
    );
  }
  return { url, key };
}

function enforceSameOrigin(request: NextRequest) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new ApiError(
      "Requisição entre origens recusada.",
      403,
      "CROSS_ORIGIN_REJECTED",
    );
  }
}

function requiredUuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ApiError("Identificador inválido.", 400, code);
  }
  return value;
}

function normalizeContent(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError("Mensagem inválida.", 400, "INVALID_MESSAGE_CONTENT");
  }
  const content = value.normalize("NFC").trim();
  if (!content || content.length > MAX_CONTENT_LENGTH || /\u0000/.test(content)) {
    throw new ApiError(
      `A mensagem deve ter entre 1 e ${MAX_CONTENT_LENGTH} caracteres.`,
      400,
      "INVALID_MESSAGE_CONTENT",
    );
  }
  return content;
}

async function authContext(
  request: NextRequest,
  organizationId: string,
): Promise<AuthContext> {
  const bearer = parseMetaCredentialBearer(request.headers.get("authorization"));
  if (!bearer) throw new ApiError("Sessão necessária.", 401, "SESSION_REQUIRED");

  const pub = publicConfig();
  const user = createClient(pub.url, pub.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const session = await user.auth.getUser(bearer);
  if (session.error || !session.data.user) {
    throw new ApiError("Sessão expirada.", 401, "SESSION_EXPIRED");
  }

  const permission = await user.rpc("has_app_permission", {
    p_organization_id: organizationId,
    p_permission_key: "crm.copilot.approve_send",
  });
  if (permission.error || permission.data !== true) {
    throw new ApiError(
      "Seu perfil não pode preparar mensagens da Bia.",
      403,
      "COPILOT_APPROVAL_PERMISSION_REQUIRED",
    );
  }

  const svc = serviceConfig();
  const service = createClient(svc.url, svc.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return {
    service,
    organizationId,
    userId: session.data.user.id,
  };
}

export async function POST(request: NextRequest) {
  try {
    enforceSameOrigin(request);
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    ) {
      throw new ApiError("Envie os dados em JSON.", 415, "JSON_REQUIRED");
    }

    const raw = (await request.json()) as unknown;
    if (!isObj(raw)) {
      throw new ApiError("Dados inválidos.", 400, "INVALID_REQUEST");
    }

    const organizationId = requiredUuid(
      raw.organizationId,
      "INVALID_ORGANIZATION",
    );
    const crmRecordId = requiredUuid(raw.crmRecordId, "INVALID_CRM_RECORD");
    const messageId = requiredUuid(raw.messageId, "INVALID_MESSAGE");
    const content = normalizeContent(raw.content);
    const auth = await authContext(request, organizationId);

    const result = await auth.service.rpc("prepare_crm_ai_shadow_message", {
      p_organization_id: auth.organizationId,
      p_crm_record_id: crmRecordId,
      p_message_id: messageId,
      p_actor_user_id: auth.userId,
      p_content: content,
    });
    if (result.error) {
      const forbidden = result.error.code === "42501";
      throw new ApiError(
        forbidden
          ? "A preparação foi recusada pelas regras de comunicação."
          : "O rascunho não está mais disponível para preparação.",
        forbidden ? 403 : 409,
        forbidden
          ? "AI_DRAFT_PREPARE_FORBIDDEN"
          : "AI_DRAFT_PREPARE_REJECTED",
      );
    }

    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (
      !isObj(row) ||
      typeof row.message_id !== "string" ||
      typeof row.content !== "string" ||
      row.delivery_status !== "prepared"
    ) {
      throw new ApiError(
        "Retorno inválido da preparação.",
        503,
        "AI_DRAFT_PREPARE_CONTRACT_FAILED",
      );
    }

    return NextResponse.json(
      {
        prepared: true,
        message: {
          messageId: row.message_id,
          content: row.content,
          deliveryStatus: row.delivery_status,
          preparedAt:
            typeof row.prepared_at === "string" ? row.prepared_at : null,
        },
      },
      { status: 200, headers: HEADERS },
    );
  } catch (error) {
    const apiError = error instanceof ApiError ? error : null;
    if (!apiError) {
      console.error("CRM AI shadow preparation failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return NextResponse.json(
      {
        prepared: false,
        error: apiError?.code || "AI_DRAFT_PREPARE_UNAVAILABLE",
      },
      { status: apiError?.status || 503, headers: HEADERS },
    );
  }
}
