import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { parseMetaCredentialBearer } from "@/lib/integrations/meta/credential-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VECTOR_STORE = /^vs_[A-Za-z0-9_-]{6,}$/;
const OPENAI_FILE = /^file[-_][A-Za-z0-9_-]{6,}$/;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 100_000;
const MAX_TITLE_CHARS = 180;
const MAX_DESCRIPTION_CHARS = 1_000;
const OPENAI_BASE = "https://api.openai.com/v1";
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const MIME_BY_EXTENSION: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
};

type JsonObject = Record<string, unknown>;

type KnowledgeRuntime = {
  apiKey: string;
  vectorStoreId: string | null;
  enabled: boolean;
  apiKeyVersion: number;
};

type KnowledgeDocument = {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  source_type: "file" | "text";
  file_name: string;
  mime_type: string;
  size_bytes: number;
  openai_file_id: string | null;
  vector_store_id: string;
  status: "processing" | "ready" | "failed" | "deleting";
  content_preview: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, status = 400, message = code) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function publicConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key) {
    throw new ApiError("SUPABASE_PUBLIC_UNAVAILABLE", 503);
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
  if (!url || !key || key.length < 32) {
    throw new ApiError("SUPABASE_SERVICE_UNAVAILABLE", 503);
  }
  return { url, key };
}

function serviceClient() {
  const config = serviceConfig();
  return createClient(config.url, config.key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      headers: { "X-Client-Info": "evora-bia-knowledge-admin/1.0" },
    },
  });
}

function enforceSameOrigin(request: NextRequest) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new ApiError("CROSS_ORIGIN_REJECTED", 403);
  }
}

function parseOrganizationId(value: unknown) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ApiError("INVALID_ORGANIZATION", 400);
  }
  return value;
}

function requestOrganizationId(request: NextRequest) {
  return parseOrganizationId(request.nextUrl.searchParams.get("organizationId"));
}

async function authorizedUser(request: NextRequest, organizationId: string) {
  const bearer = parseMetaCredentialBearer(request.headers.get("authorization"));
  if (!bearer) throw new ApiError("SESSION_REQUIRED", 401);

  const config = publicConfig();
  const client = createClient(config.url, config.key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { headers: { Authorization: `Bearer ${bearer}` } },
  });

  const userResult = await client.auth.getUser(bearer);
  if (userResult.error || !userResult.data.user) {
    throw new ApiError("SESSION_EXPIRED", 401);
  }

  const permission = await client.rpc("has_app_permission", {
    p_organization_id: organizationId,
    p_permission_key: "crm.integrations.manage",
  });
  if (permission.error || permission.data !== true) {
    throw new ApiError("AI_KNOWLEDGE_PERMISSION_REQUIRED", 403);
  }

  return { userId: userResult.data.user.id };
}

function safeTitle(value: unknown, fallback = "") {
  const title = typeof value === "string" ? value.trim() : "";
  const resolved = title || fallback.trim();
  if (!resolved || resolved.length > MAX_TITLE_CHARS) {
    throw new ApiError("INVALID_KNOWLEDGE_TITLE", 400);
  }
  return resolved;
}

function safeDescription(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ApiError("INVALID_KNOWLEDGE_DESCRIPTION", 400);
  }
  const description = value.trim();
  if (description.length > MAX_DESCRIPTION_CHARS) {
    throw new ApiError("INVALID_KNOWLEDGE_DESCRIPTION", 400);
  }
  return description || null;
}

function fileExtension(name: string) {
  const normalized = name.trim().toLowerCase();
  const dot = normalized.lastIndexOf(".");
  return dot >= 0 ? normalized.slice(dot) : "";
}

function safeFileName(name: string, fallback: string) {
  const normalized = name
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 180);
  return normalized || fallback;
}

function slugFileName(title: string) {
  const slug = title
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${slug || "conhecimento-bia"}.md`;
}

function toPublicDocument(row: KnowledgeDocument) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    sourceType: row.source_type,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes || 0),
    status: row.status,
    preview: row.content_preview,
    error: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function openAiHeaders(apiKey: string, json = true) {
  return {
    Authorization: `Bearer ${apiKey}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

function openAiErrorCode(payload: unknown, status: number) {
  if (isObject(payload) && isObject(payload.error)) {
    const code =
      typeof payload.error.code === "string"
        ? payload.error.code
        : typeof payload.error.type === "string"
          ? payload.error.type
          : "";
    if (code) return code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  }
  return `HTTP_${status}`;
}

async function openAiJson(
  url: string,
  apiKey: string,
  init: RequestInit,
  acceptedStatuses: number[] = [],
) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...openAiHeaders(apiKey, !(init.body instanceof FormData)),
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok && !acceptedStatuses.includes(response.status)) {
    throw new ApiError(
      `OPENAI_${openAiErrorCode(payload, response.status)}`,
      response.status === 429 ? 429 : 502,
    );
  }
  return { payload };
}

async function runtimeCredentials(
  admin: SupabaseClient,
  organizationId: string,
): Promise<KnowledgeRuntime> {
  const result = await admin.rpc("get_crm_ai_knowledge_runtime_credentials", {
    p_organization_id: organizationId,
  });
  if (result.error || !isObject(result.data)) {
    throw new ApiError("AI_KNOWLEDGE_RUNTIME_UNAVAILABLE", 503);
  }

  const apiKey =
    typeof result.data.api_key === "string" ? result.data.api_key.trim() : "";
  const rawVectorStore =
    typeof result.data.knowledge_vector_store_id === "string"
      ? result.data.knowledge_vector_store_id.trim()
      : "";
  if (!apiKey || apiKey.length < 32 || /\s/.test(apiKey)) {
    throw new ApiError("AI_KNOWLEDGE_OPENAI_KEY_REQUIRED", 409);
  }
  if (rawVectorStore && !VECTOR_STORE.test(rawVectorStore)) {
    throw new ApiError("AI_KNOWLEDGE_VECTOR_STORE_INVALID", 503);
  }

  return {
    apiKey,
    vectorStoreId: rawVectorStore || null,
    enabled: result.data.enabled === true,
    apiKeyVersion:
      typeof result.data.api_key_version === "number"
        ? result.data.api_key_version
        : 0,
  };
}

async function ensureVectorStore(
  admin: SupabaseClient,
  organizationId: string,
  runtimeConfig: KnowledgeRuntime,
) {
  if (runtimeConfig.vectorStoreId) return runtimeConfig.vectorStoreId;

  const created = await openAiJson(
    `${OPENAI_BASE}/vector_stores`,
    runtimeConfig.apiKey,
    {
      method: "POST",
      body: JSON.stringify({
        name: `Bia · Base de conhecimento · ${organizationId.slice(0, 8)}`,
        metadata: {
          organization_id: organizationId,
          application: "evora-gestao",
        },
      }),
    },
  );
  if (
    !isObject(created.payload) ||
    typeof created.payload.id !== "string" ||
    !VECTOR_STORE.test(created.payload.id)
  ) {
    throw new ApiError("AI_KNOWLEDGE_VECTOR_STORE_CREATE_FAILED", 502);
  }

  const vectorStoreId = created.payload.id;
  const saved = await admin.rpc("set_crm_ai_knowledge_vector_store", {
    p_organization_id: organizationId,
    p_vector_store_id: vectorStoreId,
  });
  if (saved.error) {
    await openAiJson(
      `${OPENAI_BASE}/vector_stores/${encodeURIComponent(vectorStoreId)}`,
      runtimeConfig.apiKey,
      { method: "DELETE" },
      [404],
    ).catch(() => undefined);
    throw new ApiError("AI_KNOWLEDGE_VECTOR_STORE_SAVE_FAILED", 503);
  }

  return vectorStoreId;
}

async function uploadOpenAiFile(
  apiKey: string,
  blob: Blob,
  fileName: string,
) {
  const form = new FormData();
  form.append("purpose", "assistants");
  form.append("file", blob, fileName);

  const uploaded = await openAiJson(`${OPENAI_BASE}/files`, apiKey, {
    method: "POST",
    body: form,
  });
  if (
    !isObject(uploaded.payload) ||
    typeof uploaded.payload.id !== "string" ||
    !OPENAI_FILE.test(uploaded.payload.id)
  ) {
    throw new ApiError("AI_KNOWLEDGE_FILE_UPLOAD_FAILED", 502);
  }
  return uploaded.payload.id;
}

type VectorFileState = {
  status: "processing" | "ready" | "failed";
  error: string | null;
};

function parseVectorFileState(payload: unknown): VectorFileState {
  if (!isObject(payload)) {
    return { status: "failed", error: "Resposta de indexação inválida." };
  }
  const status = typeof payload.status === "string" ? payload.status : "";
  if (status === "completed") return { status: "ready", error: null };
  if (status === "failed" || status === "cancelled") {
    const lastError = isObject(payload.last_error)
      ? typeof payload.last_error.message === "string"
        ? payload.last_error.message
        : typeof payload.last_error.code === "string"
          ? payload.last_error.code
          : null
      : null;
    return {
      status: "failed",
      error: (lastError || "O arquivo não pôde ser indexado.").slice(0, 1000),
    };
  }
  return { status: "processing", error: null };
}

async function attachToVectorStore(
  apiKey: string,
  vectorStoreId: string,
  fileId: string,
  attributes: Record<string, string>,
) {
  const attached = await openAiJson(
    `${OPENAI_BASE}/vector_stores/${encodeURIComponent(vectorStoreId)}/files`,
    apiKey,
    {
      method: "POST",
      body: JSON.stringify({ file_id: fileId, attributes }),
    },
  );
  return parseVectorFileState(attached.payload);
}

async function vectorFileState(
  apiKey: string,
  vectorStoreId: string,
  fileId: string,
) {
  const retrieved = await openAiJson(
    `${OPENAI_BASE}/vector_stores/${encodeURIComponent(vectorStoreId)}/files/${encodeURIComponent(fileId)}`,
    apiKey,
    { method: "GET" },
  );
  return parseVectorFileState(retrieved.payload);
}

async function waitForIndexing(
  apiKey: string,
  vectorStoreId: string,
  fileId: string,
  initial: VectorFileState,
) {
  let state = initial;
  for (
    let attempt = 0;
    attempt < 12 && state.status === "processing";
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    state = await vectorFileState(apiKey, vectorStoreId, fileId);
  }
  return state;
}

async function refreshProcessingDocuments(
  admin: SupabaseClient,
  organizationId: string,
  runtimeConfig: KnowledgeRuntime,
) {
  const rows = await admin
    .from("crm_ai_knowledge_documents")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "processing")
    .not("openai_file_id", "is", null)
    .limit(20);
  if (rows.error || !rows.data?.length) return;

  await Promise.allSettled(
    (rows.data as KnowledgeDocument[]).map(async (document) => {
      if (!document.openai_file_id) return;
      const state = await vectorFileState(
        runtimeConfig.apiKey,
        document.vector_store_id,
        document.openai_file_id,
      );
      if (state.status === "processing") return;
      await admin
        .from("crm_ai_knowledge_documents")
        .update({
          status: state.status,
          error_message: state.error,
          updated_at: new Date().toISOString(),
        })
        .eq("organization_id", organizationId)
        .eq("id", document.id);
    }),
  );
}

async function listDocuments(
  admin: SupabaseClient,
  organizationId: string,
) {
  const result = await admin
    .from("crm_ai_knowledge_documents")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  if (result.error) throw new ApiError("AI_KNOWLEDGE_LIST_FAILED", 503);
  return ((result.data || []) as KnowledgeDocument[]).map(toPublicDocument);
}

function responseError(error: unknown) {
  const known = error instanceof ApiError ? error : null;
  return NextResponse.json(
    { ok: false, error: known?.code || "AI_KNOWLEDGE_UNAVAILABLE" },
    { status: known?.status || 503, headers: NO_STORE_HEADERS },
  );
}

export async function GET(request: NextRequest) {
  try {
    enforceSameOrigin(request);
    const organizationId = requestOrganizationId(request);
    await authorizedUser(request, organizationId);
    const admin = serviceClient();

    let runtimeConfig: KnowledgeRuntime | null = null;
    let runtimeError: string | null = null;
    try {
      runtimeConfig = await runtimeCredentials(admin, organizationId);
      await refreshProcessingDocuments(admin, organizationId, runtimeConfig);
    } catch (error) {
      runtimeError =
        error instanceof ApiError
          ? error.code
          : "AI_KNOWLEDGE_RUNTIME_UNAVAILABLE";
    }

    const documents = await listDocuments(admin, organizationId);
    return NextResponse.json(
      {
        ok: true,
        status: {
          apiKeyConfigured: Boolean(runtimeConfig?.apiKey),
          vectorStoreConfigured: Boolean(runtimeConfig?.vectorStoreId),
          biaEnabled: runtimeConfig?.enabled === true,
          apiKeyVersion: runtimeConfig?.apiKeyVersion || 0,
          runtimeError,
          readyDocuments: documents.filter((item) => item.status === "ready")
            .length,
          processingDocuments: documents.filter(
            (item) => item.status === "processing",
          ).length,
        },
        documents,
      },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(request: NextRequest) {
  let uploadedFileId: string | null = null;
  let vectorStoreId: string | null = null;
  let apiKey = "";

  try {
    enforceSameOrigin(request);
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("multipart/form-data")
    ) {
      throw new ApiError("MULTIPART_REQUIRED", 415);
    }

    const form = await request.formData();
    const organizationId = parseOrganizationId(form.get("organizationId"));
    const { userId } = await authorizedUser(request, organizationId);
    const admin = serviceClient();
    const runtimeConfig = await runtimeCredentials(admin, organizationId);
    apiKey = runtimeConfig.apiKey;
    vectorStoreId = await ensureVectorStore(
      admin,
      organizationId,
      runtimeConfig,
    );

    const description = safeDescription(form.get("description"));
    const rawFile = form.get("file");
    const rawText =
      typeof form.get("textContent") === "string"
        ? String(form.get("textContent")).trim()
        : "";
    const mode = form.get("sourceType") === "text" ? "text" : "file";

    let title = "";
    let fileName = "";
    let mimeType = "";
    let sourceType: "file" | "text";
    let contentPreview: string | null = null;
    let blob: Blob;

    if (mode === "text") {
      if (!rawText || rawText.length > MAX_TEXT_CHARS) {
        throw new ApiError("INVALID_KNOWLEDGE_TEXT", 400);
      }
      title = safeTitle(form.get("title"));
      fileName = slugFileName(title);
      mimeType = "text/markdown";
      sourceType = "text";
      contentPreview = rawText.slice(0, 1000);
      blob = new Blob([`# ${title}\n\n${rawText}`], { type: mimeType });
    } else {
      if (!(rawFile instanceof File) || rawFile.size <= 0) {
        throw new ApiError("KNOWLEDGE_FILE_REQUIRED", 400);
      }
      if (rawFile.size > MAX_FILE_BYTES) {
        throw new ApiError("KNOWLEDGE_FILE_TOO_LARGE", 413);
      }
      const extension = fileExtension(rawFile.name);
      const acceptedMime = MIME_BY_EXTENSION[extension];
      if (!acceptedMime) {
        throw new ApiError("KNOWLEDGE_FILE_TYPE_NOT_ALLOWED", 415);
      }
      title = safeTitle(
        form.get("title"),
        rawFile.name.replace(/\.[^.]+$/, ""),
      );
      fileName = safeFileName(rawFile.name, slugFileName(title));
      mimeType = acceptedMime;
      sourceType = "file";
      blob = rawFile.slice(0, rawFile.size, acceptedMime);
    }

    uploadedFileId = await uploadOpenAiFile(apiKey, blob, fileName);
    const attached = await attachToVectorStore(
      apiKey,
      vectorStoreId,
      uploadedFileId,
      {
        organization_id: organizationId,
        source_type: sourceType,
        title: title.slice(0, 180),
      },
    );
    const indexed = await waitForIndexing(
      apiKey,
      vectorStoreId,
      uploadedFileId,
      attached,
    );

    const inserted = await admin
      .from("crm_ai_knowledge_documents")
      .insert({
        organization_id: organizationId,
        title,
        description,
        source_type: sourceType,
        file_name: fileName,
        mime_type: mimeType,
        size_bytes: blob.size,
        openai_file_id: uploadedFileId,
        vector_store_id: vectorStoreId,
        status: indexed.status,
        content_preview: contentPreview,
        error_message: indexed.error,
        metadata: {
          provider: "openai",
          purpose: "assistants",
          searchable: indexed.status === "ready",
        },
        created_by: userId,
        updated_by: userId,
      })
      .select("*")
      .single();

    if (inserted.error || !inserted.data) {
      throw new ApiError("AI_KNOWLEDGE_CATALOG_SAVE_FAILED", 503);
    }

    return NextResponse.json(
      {
        ok: true,
        document: toPublicDocument(inserted.data as KnowledgeDocument),
        vectorStoreConfigured: true,
      },
      {
        status: indexed.status === "ready" ? 201 : 202,
        headers: NO_STORE_HEADERS,
      },
    );
  } catch (error) {
    if (uploadedFileId && apiKey) {
      if (vectorStoreId) {
        await openAiJson(
          `${OPENAI_BASE}/vector_stores/${encodeURIComponent(vectorStoreId)}/files/${encodeURIComponent(uploadedFileId)}`,
          apiKey,
          { method: "DELETE" },
          [404],
        ).catch(() => undefined);
      }
      await openAiJson(
        `${OPENAI_BASE}/files/${encodeURIComponent(uploadedFileId)}`,
        apiKey,
        { method: "DELETE" },
        [404],
      ).catch(() => undefined);
    }
    return responseError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    enforceSameOrigin(request);
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    ) {
      throw new ApiError("JSON_REQUIRED", 415);
    }

    const body = (await request.json()) as unknown;
    if (!isObject(body)) throw new ApiError("INVALID_REQUEST", 400);
    const organizationId = parseOrganizationId(body.organizationId);
    const documentId =
      typeof body.documentId === "string" && UUID.test(body.documentId)
        ? body.documentId
        : null;
    if (!documentId) throw new ApiError("INVALID_DOCUMENT", 400);

    const { userId } = await authorizedUser(request, organizationId);
    const admin = serviceClient();
    const runtimeConfig = await runtimeCredentials(admin, organizationId);

    const existing = await admin
      .from("crm_ai_knowledge_documents")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("id", documentId)
      .maybeSingle();
    if (existing.error) throw new ApiError("AI_KNOWLEDGE_LOOKUP_FAILED", 503);
    if (!existing.data) throw new ApiError("KNOWLEDGE_DOCUMENT_NOT_FOUND", 404);

    const document = existing.data as KnowledgeDocument;
    await admin
      .from("crm_ai_knowledge_documents")
      .update({
        status: "deleting",
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq("organization_id", organizationId)
      .eq("id", documentId);

    if (document.openai_file_id) {
      await openAiJson(
        `${OPENAI_BASE}/vector_stores/${encodeURIComponent(document.vector_store_id)}/files/${encodeURIComponent(document.openai_file_id)}`,
        runtimeConfig.apiKey,
        { method: "DELETE" },
        [404],
      );
      await openAiJson(
        `${OPENAI_BASE}/files/${encodeURIComponent(document.openai_file_id)}`,
        runtimeConfig.apiKey,
        { method: "DELETE" },
        [404],
      );
    }

    const removed = await admin
      .from("crm_ai_knowledge_documents")
      .delete()
      .eq("organization_id", organizationId)
      .eq("id", documentId);
    if (removed.error) throw new ApiError("AI_KNOWLEDGE_DELETE_FAILED", 503);

    return NextResponse.json(
      { ok: true, deleted: true, documentId },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return responseError(error);
  }
}
