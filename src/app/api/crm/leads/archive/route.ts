import { createClient } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const MAX_BODY_BYTES = 4_096;

type ArchiveAction = "preview" | "archive";
type DependencyCounts = {
  activities: number;
  activeContracts: number;
  activeProposals: number;
  activeReservations: number;
  aiJobs: number;
  alerts: number;
  assignments: number;
  attributions: number;
  contracts: number;
  conversations: number;
  messages: number;
  opportunityEvents: number;
  proposals: number;
  reservations: number;
};

type ArchivePreviewResult = {
  recordStatus?: unknown;
  contactLinked?: unknown;
  dependencies?: unknown;
  archiveAllowed?: unknown;
  blockingReasons?: unknown;
};

type ArchiveResult = {
  archived?: boolean;
  alreadyArchived?: boolean;
  closedConversations?: number;
  closedSessions?: number;
};

class ApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bearerToken(request: NextRequest) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(
    request.headers.get("authorization") || "",
  );
  return match?.[1] || null;
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

async function jsonBody(request: NextRequest) {
  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.startsWith("application/json")) {
    throw new ApiError("Envie os dados em JSON.", 415, "JSON_REQUIRED");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new ApiError("Requisição muito grande.", 413, "REQUEST_TOO_LARGE");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError("JSON inválido.", 400, "INVALID_JSON");
  }
}

function publicConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key) {
    throw new ApiError(
      "A conexão segura com o CRM está indisponível.",
      503,
      "SUPABASE_PUBLIC_UNAVAILABLE",
    );
  }
  return { url, key };
}

async function authorizedUserClient(request: NextRequest) {
  const token = bearerToken(request);
  if (!token) {
    throw new ApiError("Sessão necessária.", 401, "SESSION_REQUIRED");
  }

  const pub = publicConfig();
  const user = createClient(pub.url, pub.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const session = await user.auth.getUser(token);
  if (session.error || !session.data.user) {
    throw new ApiError("Sessão expirada.", 401, "SESSION_EXPIRED");
  }

  return user;
}

function rpcApiError(
  message: string,
  fallbackMessage: string,
  fallbackCode: string,
) {
  if (message.includes("CRM_LEAD_ARCHIVE_SESSION_REQUIRED")) {
    return new ApiError("Sessão necessária.", 401, "SESSION_REQUIRED");
  }
  if (message.includes("CRM_LEAD_ARCHIVE_ADMIN_REQUIRED")) {
    return new ApiError(
      "Somente administradores podem excluir leads da operação.",
      403,
      "ADMIN_PERMISSION_REQUIRED",
    );
  }
  if (message.includes("CRM_LEAD_NOT_FOUND")) {
    return new ApiError("Lead não localizado.", 404, "LEAD_NOT_FOUND");
  }
  if (message.includes("CRM_LEAD_COMMERCIAL_LINKS_ACTIVE")) {
    return new ApiError(
      "O lead ganhou um vínculo comercial ativo durante a confirmação. Atualize a verificação e encerre esse vínculo antes de excluir.",
      409,
      "LEAD_HAS_ACTIVE_COMMERCIAL_LINKS",
    );
  }
  return new ApiError(fallbackMessage, 503, fallbackCode);
}

function dependencyCounts(value: unknown): DependencyCounts {
  const raw = isObject(value) ? value : {};
  const count = (key: keyof DependencyCounts) => {
    const n = Number(raw[key]);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  return {
    activities: count("activities"),
    activeContracts: count("activeContracts"),
    activeProposals: count("activeProposals"),
    activeReservations: count("activeReservations"),
    aiJobs: count("aiJobs"),
    alerts: count("alerts"),
    assignments: count("assignments"),
    attributions: count("attributions"),
    contracts: count("contracts"),
    conversations: count("conversations"),
    messages: count("messages"),
    opportunityEvents: count("opportunityEvents"),
    proposals: count("proposals"),
    reservations: count("reservations"),
  };
}

function blockingReasons(value: unknown) {
  if (!Array.isArray(value)) return [] as string[];
  return value.filter((item): item is string => typeof item === "string");
}

export async function POST(request: NextRequest) {
  const correlationId = `CRM-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

  try {
    enforceSameOrigin(request);
    const raw = await jsonBody(request);
    if (!isObject(raw)) {
      throw new ApiError("Dados inválidos.", 400, "INVALID_REQUEST");
    }
    const organizationId =
      typeof raw.organizationId === "string" ? raw.organizationId : "";
    const crmRecordId =
      typeof raw.crmRecordId === "string" ? raw.crmRecordId : "";
    const action = raw.action as ArchiveAction;
    const confirmation =
      typeof raw.confirmation === "string" ? raw.confirmation : "";

    if (!UUID.test(organizationId) || !UUID.test(crmRecordId)) {
      throw new ApiError("Lead inválido.", 400, "INVALID_LEAD");
    }
    if (action !== "preview" && action !== "archive") {
      throw new ApiError("Operação inválida.", 400, "INVALID_ACTION");
    }
    if (action === "archive" && confirmation !== "EXCLUIR") {
      throw new ApiError(
        "Confirmação administrativa inválida.",
        400,
        "ARCHIVE_CONFIRMATION_REQUIRED",
      );
    }

    const user = await authorizedUserClient(request);
    const preview = await user.rpc("preview_archive_crm_lead_v1", {
      p_organization_id: organizationId,
      p_crm_record_id: crmRecordId,
    });
    if (preview.error) {
      throw rpcApiError(
        preview.error.message,
        "Não foi possível verificar todos os vínculos do lead.",
        "LEAD_DEPENDENCY_CHECK_FAILED",
      );
    }
    if (!isObject(preview.data)) {
      throw new ApiError(
        "A verificação administrativa do lead retornou dados inválidos.",
        503,
        "LEAD_DEPENDENCY_CHECK_FAILED",
      );
    }

    const previewResult = preview.data as ArchivePreviewResult;
    const dependencies = dependencyCounts(previewResult.dependencies);
    const reasons = blockingReasons(previewResult.blockingReasons);
    const archiveAllowed = previewResult.archiveAllowed === true;
    const contactLinked = previewResult.contactLinked === true;
    const recordStatus =
      typeof previewResult.recordStatus === "string"
        ? previewResult.recordStatus
        : null;

    if (action === "preview") {
      return NextResponse.json(
        {
          ok: true,
          action,
          recordStatus,
          contactLinked,
          dependencies,
          archiveAllowed,
          blockingReasons: reasons,
        },
        { status: 200, headers: HEADERS },
      );
    }

    if (!archiveAllowed) {
      throw new ApiError(
        `O lead não pode ser excluído agora. ${reasons.join(" ")}`,
        409,
        "LEAD_HAS_ACTIVE_COMMERCIAL_LINKS",
      );
    }

    const archived = await user.rpc("archive_crm_lead_v1", {
      p_organization_id: organizationId,
      p_crm_record_id: crmRecordId,
    });
    if (archived.error) {
      throw rpcApiError(
        archived.error.message,
        "O lead não pôde ser arquivado. Nenhuma exclusão física foi realizada.",
        "LEAD_ARCHIVE_FAILED",
      );
    }

    const archiveResult = isObject(archived.data)
      ? (archived.data as ArchiveResult)
      : {};
    if (archiveResult.archived !== true) {
      throw new ApiError(
        "O arquivamento não foi confirmado pelo CRM.",
        409,
        "LEAD_ARCHIVE_NOT_CONFIRMED",
      );
    }
    const alreadyArchived = archiveResult.alreadyArchived === true;

    return NextResponse.json(
      {
        ok: true,
        action,
        archived: true,
        alreadyArchived,
        closedConversations: Number(
          archiveResult.closedConversations || 0,
        ),
        closedSessions: Number(archiveResult.closedSessions || 0),
        contactLinked,
        dependencies,
        message: alreadyArchived
          ? "O lead já estava arquivado."
          : "Lead excluído da operação ativa e arquivado com seu histórico preservado.",
      },
      { status: 200, headers: HEADERS },
    );
  } catch (error) {
    const failure =
      error instanceof ApiError
        ? error
        : new ApiError(
            "O serviço administrativo do CRM está temporariamente indisponível.",
            503,
            "LEAD_ARCHIVE_UNAVAILABLE",
          );
    if (!(error instanceof ApiError)) {
      console.error("CRM lead archive failed", {
        correlationId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return NextResponse.json(
      {
        ok: false,
        error: failure.message,
        code: failure.code,
        ...(failure.status >= 500 ? { correlationId } : {}),
      },
      { status: failure.status, headers: HEADERS },
    );
  }
}
