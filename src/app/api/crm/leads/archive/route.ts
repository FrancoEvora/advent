import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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

type CommercialBlockers = {
  allowed: boolean;
  reasons: string[];
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

function serviceConfig() {
  const url =
    process.env.SUPABASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key =
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new ApiError(
      "O serviço administrativo do CRM está indisponível.",
      503,
      "SUPABASE_SERVICE_UNAVAILABLE",
    );
  }
  return { url, key };
}

async function authorizeAdmin(
  request: NextRequest,
  organizationId: string,
): Promise<{ user: SupabaseClient; service: SupabaseClient }> {
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

  const svc = serviceConfig();
  const service = createClient(svc.url, svc.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  const membership = await service
    .from("organization_members")
    .select("role,active")
    .eq("organization_id", organizationId)
    .eq("user_id", session.data.user.id)
    .eq("active", true)
    .maybeSingle();
  if (membership.error) {
    throw new ApiError(
      "Não foi possível validar a permissão administrativa.",
      503,
      "ADMIN_PERMISSION_UNAVAILABLE",
    );
  }
  if (membership.data?.role !== "admin") {
    throw new ApiError(
      "Somente administradores podem excluir leads da operação.",
      403,
      "ADMIN_PERMISSION_REQUIRED",
    );
  }

  return { user, service };
}

async function countByRecord(
  service: SupabaseClient,
  table: string,
  organizationId: string,
  crmRecordId: string,
) {
  const result = await service
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("crm_record_id", crmRecordId);
  if (result.error) {
    throw new ApiError(
      "Não foi possível verificar todos os vínculos do lead.",
      503,
      "LEAD_DEPENDENCY_CHECK_FAILED",
    );
  }
  return result.count || 0;
}

async function countActiveByRecord(
  service: SupabaseClient,
  table: string,
  organizationId: string,
  crmRecordId: string,
  terminalStatuses: string[],
) {
  const result = await service
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("crm_record_id", crmRecordId)
    .not("status", "in", `(${terminalStatuses.join(",")})`);
  if (result.error) {
    throw new ApiError(
      "Não foi possível verificar os vínculos comerciais ativos do lead.",
      503,
      "LEAD_COMMERCIAL_DEPENDENCY_CHECK_FAILED",
    );
  }
  return result.count || 0;
}

async function countContractsByRecord(
  service: SupabaseClient,
  organizationId: string,
  crmRecordId: string,
  activeOnly: boolean,
) {
  let query = service
    .from("crm_contracts")
    .select("id,crm_proposals!inner(crm_record_id)", {
      count: "exact",
      head: true,
    })
    .eq("organization_id", organizationId)
    .eq("crm_proposals.crm_record_id", crmRecordId);
  if (activeOnly) query = query.neq("status", "cancelado");
  const result = await query;
  if (result.error) {
    throw new ApiError(
      "Não foi possível verificar os contratos vinculados ao lead.",
      503,
      "LEAD_CONTRACT_DEPENDENCY_CHECK_FAILED",
    );
  }
  return result.count || 0;
}

function commercialBlockers(
  dependencies: DependencyCounts,
): CommercialBlockers {
  const reasons: string[] = [];
  if (dependencies.activeReservations > 0) {
    reasons.push(
      dependencies.activeReservations === 1
        ? "Existe uma reserva ativa. Cancele ou converta a reserva antes de excluir o lead."
        : `Existem ${dependencies.activeReservations} reservas ativas. Cancele ou converta as reservas antes de excluir o lead.`,
    );
  }
  if (dependencies.activeProposals > 0) {
    reasons.push(
      dependencies.activeProposals === 1
        ? "Existe uma proposta ou negociação em andamento. Encerre-a antes de excluir o lead."
        : `Existem ${dependencies.activeProposals} propostas ou negociações em andamento. Encerre-as antes de excluir o lead.`,
    );
  }
  if (dependencies.activeContracts > 0) {
    reasons.push(
      dependencies.activeContracts === 1
        ? "Existe um contrato não cancelado. O lead não pode ser excluído enquanto esse vínculo comercial estiver ativo."
        : `Existem ${dependencies.activeContracts} contratos não cancelados. O lead não pode ser excluído enquanto esses vínculos estiverem ativos.`,
    );
  }
  return { allowed: reasons.length === 0, reasons };
}

async function dependencyCounts(
  service: SupabaseClient,
  organizationId: string,
  crmRecordId: string,
): Promise<DependencyCounts> {
  const [
    activities,
    activeContracts,
    activeProposals,
    activeReservations,
    aiJobs,
    alerts,
    assignments,
    attributions,
    contracts,
    conversations,
    messages,
    opportunityEvents,
    proposals,
    reservations,
  ] = await Promise.all([
    countByRecord(service, "crm_actions", organizationId, crmRecordId),
    countContractsByRecord(service, organizationId, crmRecordId, true),
    countActiveByRecord(
      service,
      "crm_proposals",
      organizationId,
      crmRecordId,
      ["rejeitada", "recusada", "expirada", "cancelada"],
    ),
    countActiveByRecord(
      service,
      "crm_unit_reservations",
      organizationId,
      crmRecordId,
      ["expirada", "cancelada", "convertida"],
    ),
    countByRecord(service, "crm_ai_jobs", organizationId, crmRecordId),
    countByRecord(service, "crm_alerts", organizationId, crmRecordId),
    countByRecord(
      service,
      "crm_lead_assignments",
      organizationId,
      crmRecordId,
    ),
    countByRecord(
      service,
      "crm_opportunity_attributions",
      organizationId,
      crmRecordId,
    ),
    countContractsByRecord(service, organizationId, crmRecordId, false),
    countByRecord(
      service,
      "crm_conversations",
      organizationId,
      crmRecordId,
    ),
    countByRecord(service, "crm_messages", organizationId, crmRecordId),
    countByRecord(
      service,
      "crm_opportunity_events",
      organizationId,
      crmRecordId,
    ),
    countByRecord(service, "crm_proposals", organizationId, crmRecordId),
    countByRecord(
      service,
      "crm_unit_reservations",
      organizationId,
      crmRecordId,
    ),
  ]);

  return {
    activities,
    activeContracts,
    activeProposals,
    activeReservations,
    aiJobs,
    alerts,
    assignments,
    attributions,
    contracts,
    conversations,
    messages,
    opportunityEvents,
    proposals,
    reservations,
  };
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

    const auth = await authorizeAdmin(request, organizationId);
    if (action === "archive" && confirmation !== "EXCLUIR") {
      throw new ApiError(
        "Confirmação administrativa inválida.",
        400,
        "ARCHIVE_CONFIRMATION_REQUIRED",
      );
    }
    const record = await auth.service
      .from("crm_records")
      .select("id,contact_id,record_status")
      .eq("organization_id", organizationId)
      .eq("id", crmRecordId)
      .maybeSingle();
    if (record.error) {
      throw new ApiError(
        "Não foi possível localizar o lead.",
        503,
        "LEAD_LOOKUP_FAILED",
      );
    }
    if (!record.data) {
      throw new ApiError("Lead não localizado.", 404, "LEAD_NOT_FOUND");
    }

    const dependencies = await dependencyCounts(
      auth.service,
      organizationId,
      crmRecordId,
    );
    const blockers = commercialBlockers(dependencies);
    if (action === "preview") {
      return NextResponse.json(
        {
          ok: true,
          action,
          recordStatus: record.data.record_status,
          contactLinked: Boolean(record.data.contact_id),
          dependencies,
          archiveAllowed: blockers.allowed,
          blockingReasons: blockers.reasons,
        },
        { status: 200, headers: HEADERS },
      );
    }

    if (!blockers.allowed) {
      throw new ApiError(
        `O lead não pode ser excluído agora. ${blockers.reasons.join(" ")}`,
        409,
        "LEAD_HAS_ACTIVE_COMMERCIAL_LINKS",
      );
    }

    const archived = await auth.user.rpc("archive_crm_lead_v1", {
      p_organization_id: organizationId,
      p_crm_record_id: crmRecordId,
    });
    if (archived.error) {
      const integrityBlocked = archived.error.message.includes(
        "CRM_LEAD_COMMERCIAL_LINKS_ACTIVE",
      );
      throw new ApiError(
        integrityBlocked
          ? "O lead ganhou um vínculo comercial ativo durante a confirmação. Atualize a verificação e encerre esse vínculo antes de excluir."
          : "O lead não pôde ser arquivado. Nenhuma exclusão física foi realizada.",
        409,
        integrityBlocked
          ? "LEAD_HAS_ACTIVE_COMMERCIAL_LINKS"
          : "LEAD_ARCHIVE_FAILED",
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
        contactLinked: Boolean(record.data.contact_id),
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
