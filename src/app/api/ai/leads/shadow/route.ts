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
const MAX_RECORDS = 200;

type Obj = Record<string, unknown>;
type AuthContext = {
  user: SupabaseClient;
  service: SupabaseClient;
  organizationId: string;
};

type ShadowRow = {
  crmRecordId: string;
  status: string;
  messageId: string | null;
  deliveryStatus: string | null;
  draft: string | null;
  qualityScore: number | null;
  supervisorDecision: string | null;
  updatedAt: string | null;
};

class ApiError extends Error {
  status: number;
  code: string;

  constructor(
    message: string,
    status = 400,
    code = "AI_SHADOW_REQUEST_FAILED",
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

async function authContext(
  request: NextRequest,
  organizationId: string,
): Promise<AuthContext> {
  if (!UUID.test(organizationId)) {
    throw new ApiError("Organização inválida.", 400, "INVALID_ORGANIZATION");
  }
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
    p_permission_key: "crm.copilot.use",
  });
  if (permission.error || permission.data !== true) {
    throw new ApiError(
      "Seu perfil não pode consultar a Bia.",
      403,
      "COPILOT_PERMISSION_REQUIRED",
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
  return { user, service, organizationId };
}

function normalizeRecordIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RECORDS) {
    throw new ApiError(
      `Informe entre 1 e ${MAX_RECORDS} oportunidades.`,
      400,
      "INVALID_RECORD_LIST",
    );
  }
  const unique = [
    ...new Set(
      value.filter((item): item is string => typeof item === "string"),
    ),
  ];
  if (unique.length !== value.length || unique.some((id) => !UUID.test(id))) {
    throw new ApiError(
      "Lista de oportunidades inválida.",
      400,
      "INVALID_RECORD_LIST",
    );
  }
  return unique;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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
    const organizationId =
      typeof raw.organizationId === "string" ? raw.organizationId : "";
    const crmRecordIds = normalizeRecordIds(raw.crmRecordIds);
    const auth = await authContext(request, organizationId);

    const readiness = await auth.service.rpc("get_crm_ai_runtime_readiness", {
      p_organization_id: auth.organizationId,
    });
    if (readiness.error) {
      throw new ApiError(
        "Estado da Bia indisponível.",
        503,
        "AI_RUNTIME_READINESS_FAILED",
      );
    }
    const ready = isObj(readiness.data) && readiness.data.ready === true;
    if (!ready) {
      return NextResponse.json(
        { enabled: false, leads: [] satisfies ShadowRow[] },
        { status: 200, headers: HEADERS },
      );
    }

    const records = await auth.service
      .from("crm_records")
      .select("id")
      .eq("organization_id", auth.organizationId)
      .in("id", crmRecordIds);
    if (records.error) {
      throw new ApiError(
        "Não foi possível validar as oportunidades.",
        503,
        "CRM_RECORD_VALIDATION_FAILED",
      );
    }
    const allowedIds = new Set(
      (records.data || []).map((row) => String(row.id)),
    );
    if (allowedIds.size !== crmRecordIds.length) {
      throw new ApiError(
        "Uma ou mais oportunidades não pertencem à organização.",
        403,
        "RECORD_SCOPE_REJECTED",
      );
    }

    const [conversations, jobs] = await Promise.all([
      auth.service
        .from("crm_conversations")
        .select("id,crm_record_id,status,updated_at,last_message_at")
        .eq("organization_id", auth.organizationId)
        .eq("channel", "whatsapp")
        .in("crm_record_id", crmRecordIds),
      auth.service
        .from("crm_ai_jobs")
        .select("id,crm_record_id,status,result,updated_at,created_at")
        .eq("organization_id", auth.organizationId)
        .in("crm_record_id", crmRecordIds)
        .order("created_at", { ascending: false }),
    ]);
    if (conversations.error || jobs.error) {
      throw new ApiError(
        "A leitura da Bia está indisponível.",
        503,
        "AI_CONVERSATION_READ_FAILED",
      );
    }

    const conversationRows = conversations.data || [];
    const conversationIds = conversationRows.map((row) => String(row.id));
    const messages = conversationIds.length
      ? await auth.service
          .from("crm_messages")
          .select(
            "id,conversation_id,crm_record_id,content,delivery_status,metadata,occurred_at",
          )
          .eq("organization_id", auth.organizationId)
          .eq("actor_type", "ai")
          .in("conversation_id", conversationIds)
          .order("occurred_at", { ascending: false })
      : { data: [], error: null };
    if (messages.error) {
      throw new ApiError(
        "Os rascunhos da Bia estão indisponíveis.",
        503,
        "AI_MESSAGE_READ_FAILED",
      );
    }

    const conversationByRecord = new Map<string, Obj>();
    for (const row of conversationRows) {
      conversationByRecord.set(String(row.crm_record_id), row as Obj);
    }

    const latestMessage = new Map<string, Obj>();
    for (const row of messages.data || []) {
      const recordId = String(row.crm_record_id || "");
      if (recordId && !latestMessage.has(recordId)) {
        latestMessage.set(recordId, row as Obj);
      }
    }

    const latestJob = new Map<string, Obj>();
    for (const row of jobs.data || []) {
      const recordId = String(row.crm_record_id || "");
      if (recordId && !latestJob.has(recordId)) {
        latestJob.set(recordId, row as Obj);
      }
    }

    const analyzedRecordIds = new Set<string>([
      ...conversationByRecord.keys(),
      ...latestJob.keys(),
    ]);

    const response: ShadowRow[] = [...analyzedRecordIds].map((recordId) => {
      const conversation = conversationByRecord.get(recordId);
      const message = latestMessage.get(recordId);
      const job = latestJob.get(recordId);
      const metadata = message && isObj(message.metadata) ? message.metadata : null;
      const result = job && isObj(job.result) ? job.result : null;
      const deliveryStatus = stringOrNull(message?.delivery_status);

      return {
        crmRecordId: recordId,
        status:
          stringOrNull(conversation?.status) ||
          stringOrNull(job?.status) ||
          "shadow",
        messageId: stringOrNull(message?.id),
        deliveryStatus,
        draft:
          deliveryStatus === "draft" ? stringOrNull(message?.content) : null,
        qualityScore:
          numberOrNull(metadata?.quality_score) ??
          numberOrNull(result?.quality_score),
        supervisorDecision:
          stringOrNull(metadata?.supervisor_decision) ||
          stringOrNull(result?.decision),
        updatedAt:
          stringOrNull(message?.occurred_at) ||
          stringOrNull(job?.updated_at) ||
          stringOrNull(conversation?.last_message_at) ||
          stringOrNull(conversation?.updated_at),
      };
    });

    return NextResponse.json(
      { enabled: true, leads: response },
      { status: 200, headers: HEADERS },
    );
  } catch (error) {
    const apiError = error instanceof ApiError ? error : null;
    if (!apiError) {
      console.error("CRM AI shadow read model failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return NextResponse.json(
      {
        enabled: false,
        leads: [],
        error: apiError?.code || "AI_SHADOW_READ_UNAVAILABLE",
      },
      { status: apiError?.status || 503, headers: HEADERS },
    );
  }
}
