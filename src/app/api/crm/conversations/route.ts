import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";

import type {
  CrmConversationAttachment,
  CrmConversationAudio,
  CrmConversationChannel,
  CrmConversationHistoryResponse,
  CrmConversationMessage,
  CrmConversationSimulation,
  CrmConversationSummary,
} from "@/lib/crm/conversation-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const PAGE_SIZE = 80;
const MAX_BODY_BYTES = 4_096;
const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  Vary: "Authorization",
  "X-Content-Type-Options": "nosniff",
};
const CHANNELS = new Set<CrmConversationChannel>([
  "site",
  "whatsapp",
  "instagram",
  "facebook",
  "email",
  "internal",
]);
const MEDIA_BUCKETS = new Set([
  "erp-documents",
  "vitoria-generated",
  "vitoria-knowledge",
]);
const MEDIA_KINDS = new Set(["audio", "document", "image", "video"]);
const STORAGE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const MEDIA_URL_TTL_SECONDS = 10 * 60;

type Obj = Record<string, unknown>;
type RequestBody = {
  organizationId?: unknown;
  crmRecordId?: unknown;
  cursor?: unknown;
};

type MessageCursor = {
  occurredAt: string;
  id: string;
};

type ServerMediaRef = {
  kind: "audio" | "document" | "image" | "video";
  bucket: string;
  storagePath: string;
  mimeType: string;
  attachmentId: string | null;
  title: string | null;
  durationSeconds: number | null;
};

type AuthContext = {
  service: SupabaseClient;
  organizationId: string;
};

class ApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = "CRM_HISTORY_REQUEST_FAILED") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  return normalized ? normalized.slice(0, max) : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function safeUrl(value: unknown): string | null {
  const raw = stringValue(value, 2_048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeStoragePath(value: unknown): string | null {
  const path = stringValue(value, 512);
  if (
    !path ||
    !STORAGE_PATH.test(path) ||
    path.includes("//") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }
  return path;
}

function serverMediaRef(value: unknown): ServerMediaRef | null {
  if (!isObj(value)) return null;
  const kind = stringValue(value.kind, 24);
  const bucket = stringValue(value.bucket, 80);
  const storagePath = safeStoragePath(value.storagePath ?? value.storage_path);
  const mimeType = stringValue(value.mimeType ?? value.mime_type, 120);
  if (
    !kind ||
    !MEDIA_KINDS.has(kind) ||
    !bucket ||
    !MEDIA_BUCKETS.has(bucket) ||
    !storagePath ||
    !mimeType
  ) {
    return null;
  }
  const duration = numberValue(value.durationSeconds ?? value.duration_seconds);
  return {
    kind: kind as ServerMediaRef["kind"],
    bucket,
    storagePath,
    mimeType,
    attachmentId: stringValue(value.attachmentId ?? value.attachment_id, 180),
    title: stringValue(value.title, 180),
    durationSeconds:
      duration !== null && duration > 0 && duration <= 600 ? duration : null,
  };
}

function messageServerMediaRefs(metadata: Obj): ServerMediaRef[] {
  if (metadata.server_media_contract !== "v1") return [];
  const refs = Array.isArray(metadata.server_media_refs)
    ? metadata.server_media_refs
    : [];
  return refs.slice(0, 8).flatMap((value) => {
    const parsed = serverMediaRef(value);
    return parsed ? [parsed] : [];
  });
}

function storageRefFromSignedUrl(
  value: unknown,
  fallback: Omit<ServerMediaRef, "bucket" | "storagePath">,
): ServerMediaRef | null {
  const raw = safeUrl(value);
  if (!raw) return null;
  try {
    const pathname = decodeURIComponent(new URL(raw).pathname);
    const marker = "/storage/v1/object/sign/";
    const markerIndex = pathname.indexOf(marker);
    if (markerIndex < 0) return null;
    const locator = pathname.slice(markerIndex + marker.length);
    const separator = locator.indexOf("/");
    if (separator < 1) return null;
    const bucket = locator.slice(0, separator);
    const storagePath = safeStoragePath(locator.slice(separator + 1));
    if (!MEDIA_BUCKETS.has(bucket) || !storagePath) return null;
    return { ...fallback, bucket, storagePath };
  } catch {
    return null;
  }
}

function legacyRefInScope(
  ref: ServerMediaRef,
  organizationId: string,
  sessionId: string,
) {
  if (ref.bucket === "vitoria-generated") {
    return ref.storagePath.startsWith(`${organizationId}/${sessionId}/`);
  }
  if (ref.bucket !== "erp-documents") return false;
  return (
    ref.storagePath.startsWith(
      `vitoria/audio/${organizationId}/${sessionId}/`,
    ) ||
    ref.storagePath.startsWith(
      `vitoria-simulations/${organizationId}/${sessionId}/`,
    )
  );
}

function legacyMessageMediaRefs(
  metadata: Obj,
  organizationId: string,
): ServerMediaRef[] {
  const sessionId = stringValue(metadata.public_agent_session_id, 80);
  if (!sessionId || !UUID.test(sessionId)) return [];
  const refs: ServerMediaRef[] = [];
  if (isObj(metadata.public_audio)) {
    const mimeType = stringValue(metadata.public_audio.mimeType, 120);
    const duration = numberValue(metadata.public_audio.durationSeconds);
    if (mimeType) {
      const ref = storageRefFromSignedUrl(metadata.public_audio.url, {
        kind: "audio",
        mimeType,
        attachmentId: null,
        title: null,
        durationSeconds:
          duration !== null && duration > 0 && duration <= 600
            ? duration
            : null,
      });
      if (ref && legacyRefInScope(ref, organizationId, sessionId)) {
        refs.push(ref);
      }
    }
  }

  const response = isObj(metadata.public_response)
    ? metadata.public_response
    : {};
  const sources = [response.attachments, metadata.attachments, metadata.resources];
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const value of source.slice(0, 12)) {
      if (!isObj(value)) continue;
      const mimeType = stringValue(value.mimeType ?? value.mime_type, 120);
      if (!mimeType) continue;
      const kind = mimeType.startsWith("image/")
        ? "image"
        : mimeType.startsWith("video/")
          ? "video"
          : "document";
      const ref = storageRefFromSignedUrl(value.url, {
        kind,
        mimeType,
        attachmentId: stringValue(value.id, 180),
        title: stringValue(value.title ?? value.name, 180),
        durationSeconds: null,
      });
      if (ref && legacyRefInScope(ref, organizationId, sessionId)) refs.push(ref);
    }
  }
  return refs.slice(0, 8);
}

function attachmentMatchesRef(value: unknown, ref: ServerMediaRef) {
  if (!isObj(value) || ref.kind === "audio") return false;
  const id = stringValue(value.id, 180);
  if (ref.attachmentId && id) return ref.attachmentId === id;
  const title = stringValue(value.title ?? value.name, 180);
  const mimeType = stringValue(value.mimeType ?? value.mime_type, 120);
  return Boolean(
    ref.title &&
      title === ref.title &&
      (!mimeType || mimeType.toLowerCase() === ref.mimeType.toLowerCase()),
  );
}

function hydrateMessageMetadata(
  metadataValue: unknown,
  refs: ServerMediaRef[],
  signedUrls: Map<string, string>,
): Obj {
  const metadata = isObj(metadataValue) ? structuredClone(metadataValue) : {};
  const urlFor = (ref: ServerMediaRef) =>
    signedUrls.get(`${ref.bucket}:${ref.storagePath}`) || null;

  const audioRef = refs.find((ref) => ref.kind === "audio");
  const audioUrl = audioRef ? urlFor(audioRef) : null;
  if (audioRef && audioUrl) {
    const currentAudio = isObj(metadata.public_audio)
      ? metadata.public_audio
      : {};
    metadata.public_audio = {
      ...currentAudio,
      url: audioUrl,
      mimeType: audioRef.mimeType,
      ...(audioRef.durationSeconds !== null
        ? { durationSeconds: audioRef.durationSeconds }
        : {}),
    };
  }

  const hydrateList = (value: unknown) => {
    if (!Array.isArray(value)) return value;
    return value.map((attachment) => {
      if (!isObj(attachment)) return attachment;
      const ref = refs.find((candidate) =>
        attachmentMatchesRef(attachment, candidate),
      );
      const signedUrl = ref ? urlFor(ref) : null;
      return signedUrl ? { ...attachment, url: signedUrl } : attachment;
    });
  };

  if (isObj(metadata.public_response)) {
    metadata.public_response = {
      ...metadata.public_response,
      attachments: hydrateList(metadata.public_response.attachments),
    };
  }
  if (Array.isArray(metadata.attachments)) {
    metadata.attachments = hydrateList(metadata.attachments);
  }
  if (Array.isArray(metadata.resources)) {
    metadata.resources = hydrateList(metadata.resources);
  }

  delete metadata.server_media_contract;
  delete metadata.server_media_refs;
  return metadata;
}

async function hydrateStableMedia(
  service: SupabaseClient,
  organizationId: string,
  rows: Obj[],
): Promise<Obj[]> {
  const refsByRow = rows.map((row) => {
    const metadata = isObj(row.metadata) ? row.metadata : {};
    const stable = messageServerMediaRefs(metadata);
    const legacy = legacyMessageMediaRefs(metadata, organizationId);
    const unique = new Map<string, ServerMediaRef>();
    for (const ref of [...stable, ...legacy]) {
      unique.set(`${ref.bucket}:${ref.storagePath}`, ref);
    }
    return [...unique.values()].slice(0, 8);
  });
  const pathsByBucket = new Map<string, Set<string>>();
  for (const refs of refsByRow) {
    for (const ref of refs) {
      const paths = pathsByBucket.get(ref.bucket) || new Set<string>();
      paths.add(ref.storagePath);
      pathsByBucket.set(ref.bucket, paths);
    }
  }

  const signedUrls = new Map<string, string>();
  await Promise.all(
    [...pathsByBucket.entries()].map(async ([bucket, pathSet]) => {
      const paths = [...pathSet];
      for (let offset = 0; offset < paths.length; offset += 100) {
        const chunk = paths.slice(offset, offset + 100);
        const result = await service.storage
          .from(bucket)
          .createSignedUrls(chunk, MEDIA_URL_TTL_SECONDS);
        if (result.error) continue;
        for (const item of result.data || []) {
          const path = safeStoragePath(item.path);
          const signedUrl = safeUrl(item.signedUrl);
          if (path && signedUrl) signedUrls.set(`${bucket}:${path}`, signedUrl);
        }
      }
    }),
  );

  return rows.map((row, index) => ({
    ...row,
    metadata: hydrateMessageMetadata(
      row.metadata,
      refsByRow[index] || [],
      signedUrls,
    ),
  }));
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

function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim() || "";
  return token && token.length <= 8_192 ? token : null;
}

function enforceRequestHeaders(request: NextRequest) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new ApiError(
      "Requisição entre origens recusada.",
      403,
      "CROSS_ORIGIN_REJECTED",
    );
  }
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new ApiError(
      "O corpo da requisição deve ser JSON.",
      415,
      "JSON_CONTENT_TYPE_REQUIRED",
    );
  }
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new ApiError("Requisição muito grande.", 413, "REQUEST_TOO_LARGE");
  }
}

async function readJsonBody(request: NextRequest): Promise<RequestBody> {
  if (!request.body) {
    throw new ApiError("Corpo JSON obrigatório.", 400, "JSON_BODY_REQUIRED");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_BODY_BYTES) {
        await reader.cancel("request body exceeds limit");
        throw new ApiError("Requisição muito grande.", 413, "REQUEST_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (byteLength === 0) {
    throw new ApiError("Corpo JSON obrigatório.", 400, "JSON_BODY_REQUIRED");
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError("JSON inválido.", 400, "INVALID_JSON");
  }

  try {
    const parsed: unknown = JSON.parse(decoded);
    if (!isObj(parsed)) throw new Error("JSON body must be an object");
    return parsed as RequestBody;
  } catch {
    throw new ApiError("JSON inválido.", 400, "INVALID_JSON");
  }
}

function cursorValue(value: unknown): MessageCursor | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 512) {
    throw new ApiError("Cursor inválido.", 400, "INVALID_CURSOR");
  }

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (!isObj(parsed)) throw new Error("invalid cursor object");
    const occurredAt = stringValue(parsed.occurredAt, 80);
    const id = stringValue(parsed.id, 80);
    if (!occurredAt || !RFC3339.test(occurredAt) || !id || !UUID.test(id)) {
      throw new Error("invalid cursor fields");
    }
    return { occurredAt, id };
  } catch {
    throw new ApiError("Cursor inválido.", 400, "INVALID_CURSOR");
  }
}

function encodeCursor(row: Obj): string {
  const occurredAt = String(row.occurred_at || "");
  const id = String(row.id || "");
  if (!RFC3339.test(occurredAt) || !UUID.test(id)) {
    throw new ApiError(
      "Não foi possível paginar as mensagens.",
      502,
      "CRM_MESSAGES_CURSOR_FAILED",
    );
  }
  return Buffer.from(JSON.stringify({ occurredAt, id }), "utf8").toString(
    "base64url",
  );
}

async function authContext(
  request: NextRequest,
  organizationId: string,
): Promise<AuthContext> {
  if (!UUID.test(organizationId)) {
    throw new ApiError("Organização inválida.", 400, "INVALID_ORGANIZATION");
  }
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) throw new ApiError("Sessão necessária.", 401, "SESSION_REQUIRED");

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

  const permission = await user.rpc("has_app_permission", {
    p_organization_id: organizationId,
    p_permission_key: "crm.view",
  });
  if (permission.error || permission.data !== true) {
    throw new ApiError(
      "Seu perfil não pode consultar o histórico do CRM.",
      403,
      "CRM_HISTORY_PERMISSION_REQUIRED",
    );
  }

  const svc = serviceConfig();
  return {
    organizationId,
    service: createClient(svc.url, svc.key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    }),
  };
}

function normalizeChannel(value: unknown): CrmConversationChannel {
  const channel = stringValue(value, 24) as CrmConversationChannel | null;
  return channel && CHANNELS.has(channel) ? channel : "internal";
}

function normalizeAttachment(value: unknown): CrmConversationAttachment | null {
  if (!isObj(value)) return null;
  const mimeType = stringValue(value.mimeType ?? value.mime_type, 120);
  const inferredType = mimeType?.startsWith("image/") ? "image" : "document";
  const rawType = stringValue(value.type, 24) || inferredType;
  if (rawType !== "document" && rawType !== "image" && rawType !== "project") {
    return null;
  }
  return {
    id: stringValue(value.id, 180),
    type: rawType,
    title:
      stringValue(value.title ?? value.name ?? value.originalFilename, 180) ||
      "Arquivo",
    description: stringValue(value.description ?? value.displayDescription, 500),
    url: safeUrl(value.url ?? value.external_url),
    mimeType,
    badge: stringValue(value.badge, 80),
    disclaimer: stringValue(value.disclaimer, 800),
  };
}

function messageAttachments(metadata: Obj): CrmConversationAttachment[] {
  const response = isObj(metadata.public_response) ? metadata.public_response : {};
  const sources = [response.attachments, metadata.attachments, metadata.resources];
  const unique = new Map<string, CrmConversationAttachment>();
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const raw of source.slice(0, 12)) {
      const attachment = normalizeAttachment(raw);
      if (!attachment) continue;
      const key = `${attachment.id || ""}:${attachment.type}:${attachment.title}:${attachment.url || ""}`;
      unique.set(key, attachment);
    }
  }
  return [...unique.values()].slice(0, 12);
}

function messageAudio(metadata: Obj): CrmConversationAudio | null {
  if (!isObj(metadata.public_audio)) return null;
  const url = safeUrl(metadata.public_audio.url);
  if (!url) return null;
  const duration = numberValue(metadata.public_audio.durationSeconds);
  return {
    url,
    mimeType: stringValue(metadata.public_audio.mimeType, 120),
    durationSeconds:
      duration !== null && duration >= 0 && duration <= 600 ? duration : null,
  };
}

function messageSimulation(metadata: Obj): CrmConversationSimulation | null {
  const response = isObj(metadata.public_response) ? metadata.public_response : {};
  const simulation = isObj(response.simulation) ? response.simulation : null;
  if (!simulation) return null;
  const rawScenarios = Array.isArray(simulation.scenarios)
    ? simulation.scenarios.slice(0, 8)
    : [];
  const scenarios = rawScenarios.flatMap((raw) => {
    if (!isObj(raw)) return [];
    const months = numberValue(raw.months);
    const monthlyPayment = numberValue(raw.monthlyPayment);
    if (months === null || monthlyPayment === null) return [];
    return [{ months, monthlyPayment }];
  });
  return {
    projectName: stringValue(simulation.projectName, 180),
    unitCode: stringValue(simulation.unitCode, 80),
    price: numberValue(simulation.price),
    downPayment: numberValue(simulation.downPayment),
    balloonCount: numberValue(simulation.balloonCount),
    balloonAmount: numberValue(simulation.balloonAmount),
    scenarios,
  };
}

function normalizeConversation(row: Obj): CrmConversationSummary {
  return {
    id: String(row.id),
    channel: normalizeChannel(row.channel),
    status: stringValue(row.status, 40) || "shadow",
    aiEnabled: row.ai_enabled === true,
    assignedUserId: stringValue(row.assigned_user_id, 80),
    startedAt: String(row.started_at),
    lastMessageAt: stringValue(row.last_message_at, 80),
    humanTakeoverAt: stringValue(row.human_takeover_at, 80),
    closedAt: stringValue(row.closed_at, 80),
  };
}

function normalizeMessage(row: Obj): CrmConversationMessage {
  const metadata = isObj(row.metadata) ? row.metadata : {};
  const direction =
    row.direction === "inbound" ||
    row.direction === "outbound" ||
    row.direction === "internal"
      ? row.direction
      : "internal";
  const actorType =
    row.actor_type === "lead" ||
    row.actor_type === "ai" ||
    row.actor_type === "human" ||
    row.actor_type === "system"
      ? row.actor_type
      : "system";
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    direction,
    actorType,
    channel: normalizeChannel(row.channel),
    content: String(row.content || ""),
    deliveryStatus: stringValue(row.delivery_status, 40) || "delivered",
    occurredAt: String(row.occurred_at),
    audio: messageAudio(metadata),
    attachments: messageAttachments(metadata),
    simulation: messageSimulation(metadata),
  };
}

export async function POST(request: NextRequest) {
  try {
    enforceRequestHeaders(request);
    const body = await readJsonBody(request);
    const organizationId = stringValue(body.organizationId, 80) || "";
    const crmRecordId = stringValue(body.crmRecordId, 80) || "";
    const cursor = cursorValue(body.cursor);
    if (!UUID.test(crmRecordId)) {
      throw new ApiError("Lead inválido.", 400, "INVALID_CRM_RECORD");
    }

    const { service } = await authContext(request, organizationId);
    const record = await service
      .from("crm_records")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("id", crmRecordId)
      .maybeSingle();
    if (record.error) {
      throw new ApiError(
        "Não foi possível validar o lead.",
        502,
        "CRM_RECORD_LOOKUP_FAILED",
      );
    }
    if (!record.data) {
      throw new ApiError("Lead não localizado.", 404, "CRM_RECORD_NOT_FOUND");
    }

    const conversationsResult = await service
      .from("crm_conversations")
      .select(
        "id,channel,status,ai_enabled,assigned_user_id,started_at,last_message_at,human_takeover_at,closed_at",
      )
      .eq("organization_id", organizationId)
      .eq("crm_record_id", crmRecordId)
      .order("started_at", { ascending: true });
    if (conversationsResult.error) {
      throw new ApiError(
        "Não foi possível carregar as conversas.",
        502,
        "CRM_CONVERSATIONS_READ_FAILED",
      );
    }

    let messagesQuery = service
      .from("crm_messages")
      .select(
        "id,conversation_id,direction,actor_type,channel,content,delivery_status,metadata,occurred_at",
      )
      .eq("organization_id", organizationId)
      .eq("crm_record_id", crmRecordId)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false });
    if (cursor) {
      messagesQuery = messagesQuery.or(
        `occurred_at.lt.${cursor.occurredAt},and(occurred_at.eq.${cursor.occurredAt},id.lt.${cursor.id})`,
      );
    }
    const messagesResult = await messagesQuery.limit(PAGE_SIZE + 1);
    if (messagesResult.error) {
      throw new ApiError(
        "Não foi possível carregar as mensagens.",
        502,
        "CRM_MESSAGES_READ_FAILED",
      );
    }

    const rows = (messagesResult.data || []) as Obj[];
    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = await hydrateStableMedia(
      service,
      organizationId,
      rows.slice(0, PAGE_SIZE),
    );
    const lastRow = pageRows.at(-1);
    const payload: CrmConversationHistoryResponse = {
      conversations: (conversationsResult.data || []).map((row) =>
        normalizeConversation(row as Obj),
      ),
      messages: pageRows.map((row) => normalizeMessage(row)),
      pagination: {
        pageSize: PAGE_SIZE,
        hasMore,
        nextCursor: hasMore && lastRow ? encodeCursor(lastRow) : null,
      },
    };
    return NextResponse.json(payload, { headers: RESPONSE_HEADERS });
  } catch (error) {
    const apiError =
      error instanceof ApiError
        ? error
        : new ApiError(
            "Não foi possível carregar o histórico agora.",
            500,
            "CRM_HISTORY_UNAVAILABLE",
          );
    return NextResponse.json(
      { error: apiError.code, message: apiError.message },
      { status: apiError.status, headers: RESPONSE_HEADERS },
    );
  }
}
