import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VECTOR_STORE = /^vs_[A-Za-z0-9_-]{6,}$/;
const OPENAI_FILE = /^file[-_][A-Za-z0-9_-]{6,}$/;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 100_000;
const OPENAI_BASE = "https://api.openai.com/v1";
const MIME_BY_EXTENSION: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
};
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};
const JSON_HEADERS = {
  ...CORS,
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

type Obj = Record<string, unknown>;
type RuntimeConfig = {
  apiKey: string;
  vectorStoreId: string | null;
  enabled: boolean;
  apiKeyVersion: number;
};
type DocumentRow = {
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
type VectorState = { status: "processing" | "ready" | "failed"; error: string | null };

class ApiError extends Error {
  status: number;
  code: string;
  constructor(code: string, status = 400, message = code) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const isObj = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const json = (payload: Obj, status = 200) => new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
const fail = (error: unknown, supportReference: string) => {
  const known = error instanceof ApiError ? error : null;
  const code = known?.code || "AI_KNOWLEDGE_UNAVAILABLE";
  console.error("enterprise-bia-knowledge-admin", {
    supportReference,
    code,
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message.slice(0, 500) : "Unknown failure",
  });
  return json({ ok: false, error: code, supportReference }, known?.status || 503);
};

function defaultKey(name: string) {
  const raw = Deno.env.get(name) || "";
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.default === "string" ? parsed.default : "";
  } catch {
    return "";
  }
}

function configuration() {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const publishableKey = defaultKey("SUPABASE_PUBLISHABLE_KEYS") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceKey = defaultKey("SUPABASE_SECRET_KEYS") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !publishableKey || !serviceKey) throw new ApiError("AI_KNOWLEDGE_SERVICE_UNAVAILABLE", 503);
  return { url, publishableKey, serviceKey };
}

function parseOrganization(value: unknown) {
  if (typeof value !== "string" || !UUID.test(value)) throw new ApiError("INVALID_ORGANIZATION", 400);
  return value;
}

function safeTitle(value: unknown, fallback = "") {
  const title = (typeof value === "string" ? value : "").trim() || fallback.trim();
  if (!title || title.length > 180) throw new ApiError("INVALID_KNOWLEDGE_TITLE", 400);
  return title;
}

function safeDescription(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new ApiError("INVALID_KNOWLEDGE_DESCRIPTION", 400);
  const description = value.trim();
  if (description.length > 1000) throw new ApiError("INVALID_KNOWLEDGE_DESCRIPTION", 400);
  return description || null;
}

function extension(name: string) {
  const normalized = name.trim().toLowerCase();
  const index = normalized.lastIndexOf(".");
  return index >= 0 ? normalized.slice(index) : "";
}

function safeFileName(name: string, fallback: string) {
  return name.normalize("NFKD").replace(/[^\w.\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 180) || fallback;
}

function slugFileName(title: string) {
  const slug = title.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${slug || "conhecimento-bia"}.md`;
}

function publicDocument(row: DocumentRow) {
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

async function context(request: Request, organizationId: string) {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) throw new ApiError("SESSION_REQUIRED", 401);
  const cfg = configuration();
  const caller = createClient(cfg.url, cfg.publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const auth = await caller.auth.getUser();
  if (auth.error || !auth.data.user) throw new ApiError("SESSION_EXPIRED", 401);
  const permission = await caller.rpc("has_app_permission", {
    p_organization_id: organizationId,
    p_permission_key: "crm.integrations.manage",
  });
  if (permission.error || permission.data !== true) throw new ApiError("AI_KNOWLEDGE_PERMISSION_REQUIRED", 403);
  const admin = createClient(cfg.url, cfg.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { admin, userId: auth.data.user.id };
}

function openAiCode(payload: unknown, status: number) {
  if (isObj(payload) && isObj(payload.error)) {
    const raw = typeof payload.error.code === "string" ? payload.error.code : typeof payload.error.type === "string" ? payload.error.type : "";
    if (raw) return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  }
  return `HTTP_${status}`;
}

async function openAi(url: string, apiKey: string, init: RequestInit, accepted: number[] = []) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const multipart = init.body instanceof FormData;
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Beta": "assistants=v2",
        ...(multipart ? {} : { "Content-Type": "application/json" }),
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok && !accepted.includes(response.status)) {
      throw new ApiError(`OPENAI_${openAiCode(payload, response.status)}`, response.status === 429 ? 429 : 502);
    }
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new ApiError("OPENAI_TIMEOUT", 504);
    throw new ApiError("OPENAI_NETWORK", 502);
  } finally {
    clearTimeout(timer);
  }
}

async function runtime(admin: SupabaseClient, organizationId: string): Promise<RuntimeConfig> {
  const result = await admin.rpc("get_crm_ai_knowledge_runtime_credentials", { p_organization_id: organizationId });
  if (result.error || !isObj(result.data)) throw new ApiError("AI_KNOWLEDGE_RUNTIME_UNAVAILABLE", 503);
  const apiKey = typeof result.data.api_key === "string" ? result.data.api_key.trim() : "";
  const rawStore = typeof result.data.knowledge_vector_store_id === "string" ? result.data.knowledge_vector_store_id.trim() : "";
  if (!apiKey || apiKey.length < 32 || /\s/.test(apiKey)) throw new ApiError("AI_KNOWLEDGE_OPENAI_KEY_REQUIRED", 409);
  if (rawStore && !VECTOR_STORE.test(rawStore)) throw new ApiError("AI_KNOWLEDGE_VECTOR_STORE_INVALID", 503);
  return {
    apiKey,
    vectorStoreId: rawStore || null,
    enabled: result.data.enabled === true,
    apiKeyVersion: typeof result.data.api_key_version === "number" ? result.data.api_key_version : 0,
  };
}

async function ensureVectorStore(admin: SupabaseClient, organizationId: string, config: RuntimeConfig) {
  if (config.vectorStoreId) return config.vectorStoreId;
  const created = await openAi(`${OPENAI_BASE}/vector_stores`, config.apiKey, {
    method: "POST",
    body: JSON.stringify({
      name: `Bia · Base de conhecimento · ${organizationId.slice(0, 8)}`,
      metadata: { organization_id: organizationId, application: "evora-gestao" },
    }),
  });
  if (!isObj(created) || typeof created.id !== "string" || !VECTOR_STORE.test(created.id)) {
    throw new ApiError("AI_KNOWLEDGE_VECTOR_STORE_CREATE_FAILED", 502);
  }
  const storeId = created.id;
  const saved = await admin.rpc("set_crm_ai_knowledge_vector_store", {
    p_organization_id: organizationId,
    p_vector_store_id: storeId,
  });
  if (saved.error) {
    await openAi(`${OPENAI_BASE}/vector_stores/${encodeURIComponent(storeId)}`, config.apiKey, { method: "DELETE" }, [404]).catch(() => undefined);
    throw new ApiError("AI_KNOWLEDGE_VECTOR_STORE_SAVE_FAILED", 503);
  }
  return storeId;
}

async function uploadFile(apiKey: string, blob: Blob, fileName: string) {
  const form = new FormData();
  form.append("purpose", "assistants");
  form.append("file", blob, fileName);
  const uploaded = await openAi(`${OPENAI_BASE}/files`, apiKey, { method: "POST", body: form });
  if (!isObj(uploaded) || typeof uploaded.id !== "string" || !OPENAI_FILE.test(uploaded.id)) {
    throw new ApiError("AI_KNOWLEDGE_FILE_UPLOAD_FAILED", 502);
  }
  return uploaded.id;
}

function vectorState(payload: unknown): VectorState {
  if (!isObj(payload)) return { status: "failed", error: "Resposta de indexação inválida." };
  const status = typeof payload.status === "string" ? payload.status : "";
  if (status === "completed") return { status: "ready", error: null };
  if (status === "failed" || status === "cancelled") {
    const last = isObj(payload.last_error) ? payload.last_error : {};
    const message = typeof last.message === "string" ? last.message : typeof last.code === "string" ? last.code : "O arquivo não pôde ser indexado.";
    return { status: "failed", error: message.slice(0, 1000) };
  }
  return { status: "processing", error: null };
}

async function attachFile(apiKey: string, storeId: string, fileId: string, attributes: Record<string, string>) {
  const payload = await openAi(`${OPENAI_BASE}/vector_stores/${encodeURIComponent(storeId)}/files`, apiKey, {
    method: "POST",
    body: JSON.stringify({ file_id: fileId, attributes }),
  });
  return vectorState(payload);
}

async function retrieveState(apiKey: string, storeId: string, fileId: string) {
  return vectorState(await openAi(`${OPENAI_BASE}/vector_stores/${encodeURIComponent(storeId)}/files/${encodeURIComponent(fileId)}`, apiKey, { method: "GET" }));
}

async function waitForIndexing(apiKey: string, storeId: string, fileId: string, initial: VectorState) {
  let state = initial;
  for (let attempt = 0; attempt < 10 && state.status === "processing"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    state = await retrieveState(apiKey, storeId, fileId);
  }
  return state;
}

async function refreshProcessing(admin: SupabaseClient, organizationId: string, config: RuntimeConfig) {
  const result = await admin.from("crm_ai_knowledge_documents").select("*").eq("organization_id", organizationId).eq("status", "processing").not("openai_file_id", "is", null).limit(20);
  if (result.error || !result.data?.length) return;
  await Promise.allSettled((result.data as DocumentRow[]).map(async (document) => {
    if (!document.openai_file_id) return;
    const state = await retrieveState(config.apiKey, document.vector_store_id, document.openai_file_id);
    if (state.status === "processing") return;
    await admin.from("crm_ai_knowledge_documents").update({
      status: state.status,
      error_message: state.error,
      updated_at: new Date().toISOString(),
    }).eq("organization_id", organizationId).eq("id", document.id);
  }));
}

async function listDocuments(admin: SupabaseClient, organizationId: string) {
  const result = await admin.from("crm_ai_knowledge_documents").select("*").eq("organization_id", organizationId).order("created_at", { ascending: false });
  if (result.error) throw new ApiError("AI_KNOWLEDGE_LIST_FAILED", 503);
  return ((result.data || []) as DocumentRow[]).map(publicDocument);
}

async function handleGet(request: Request) {
  const organizationId = parseOrganization(new URL(request.url).searchParams.get("organizationId"));
  const { admin } = await context(request, organizationId);
  let config: RuntimeConfig | null = null;
  let runtimeError: string | null = null;
  try {
    config = await runtime(admin, organizationId);
    await refreshProcessing(admin, organizationId, config);
  } catch (error) {
    runtimeError = error instanceof ApiError ? error.code : "AI_KNOWLEDGE_RUNTIME_UNAVAILABLE";
  }
  const documents = await listDocuments(admin, organizationId);
  return json({
    ok: true,
    status: {
      apiKeyConfigured: Boolean(config?.apiKey),
      vectorStoreConfigured: Boolean(config?.vectorStoreId),
      biaEnabled: config?.enabled === true,
      apiKeyVersion: config?.apiKeyVersion || 0,
      runtimeError,
      readyDocuments: documents.filter((item) => item.status === "ready").length,
      processingDocuments: documents.filter((item) => item.status === "processing").length,
    },
    documents,
  });
}

async function handlePost(request: Request) {
  let uploadedFileId: string | null = null;
  let storeId: string | null = null;
  let apiKey = "";
  try {
    const form = await request.formData();
    const organizationId = parseOrganization(form.get("organizationId"));
    const { admin, userId } = await context(request, organizationId);
    const config = await runtime(admin, organizationId);
    apiKey = config.apiKey;
    storeId = await ensureVectorStore(admin, organizationId, config);
    const description = safeDescription(form.get("description"));
    const mode = form.get("sourceType") === "text" ? "text" : "file";
    const rawText = typeof form.get("textContent") === "string" ? String(form.get("textContent")).trim() : "";
    const rawFile = form.get("file");

    let title: string;
    let fileName: string;
    let mimeType: string;
    let sourceType: "file" | "text";
    let preview: string | null = null;
    let blob: Blob;

    if (mode === "text") {
      if (!rawText || rawText.length > MAX_TEXT_CHARS) throw new ApiError("INVALID_KNOWLEDGE_TEXT", 400);
      title = safeTitle(form.get("title"));
      fileName = slugFileName(title);
      mimeType = "text/markdown";
      sourceType = "text";
      preview = rawText.slice(0, 1000);
      blob = new Blob([`# ${title}\n\n${rawText}`], { type: mimeType });
    } else {
      if (!(rawFile instanceof File) || rawFile.size <= 0) throw new ApiError("KNOWLEDGE_FILE_REQUIRED", 400);
      if (rawFile.size > MAX_FILE_BYTES) throw new ApiError("KNOWLEDGE_FILE_TOO_LARGE", 413);
      const ext = extension(rawFile.name);
      const acceptedMime = MIME_BY_EXTENSION[ext];
      if (!acceptedMime) throw new ApiError("KNOWLEDGE_FILE_TYPE_NOT_ALLOWED", 415);
      title = safeTitle(form.get("title"), rawFile.name.replace(/\.[^.]+$/, ""));
      fileName = safeFileName(rawFile.name, slugFileName(title));
      mimeType = acceptedMime;
      sourceType = "file";
      blob = rawFile.slice(0, rawFile.size, acceptedMime);
    }

    uploadedFileId = await uploadFile(apiKey, blob, fileName);
    const attached = await attachFile(apiKey, storeId, uploadedFileId, {
      organization_id: organizationId,
      source_type: sourceType,
      title: title.slice(0, 180),
    });
    const indexed = await waitForIndexing(apiKey, storeId, uploadedFileId, attached);
    const inserted = await admin.from("crm_ai_knowledge_documents").insert({
      organization_id: organizationId,
      title,
      description,
      source_type: sourceType,
      file_name: fileName,
      mime_type: mimeType,
      size_bytes: blob.size,
      openai_file_id: uploadedFileId,
      vector_store_id: storeId,
      status: indexed.status,
      content_preview: preview,
      error_message: indexed.error,
      metadata: { provider: "openai", purpose: "assistants", searchable: indexed.status === "ready" },
      created_by: userId,
      updated_by: userId,
    }).select("*").single();
    if (inserted.error || !inserted.data) throw new ApiError("AI_KNOWLEDGE_CATALOG_SAVE_FAILED", 503);
    return json({ ok: true, document: publicDocument(inserted.data as DocumentRow), vectorStoreConfigured: true }, indexed.status === "ready" ? 201 : 202);
  } catch (error) {
    if (uploadedFileId && apiKey) {
      if (storeId) await openAi(`${OPENAI_BASE}/vector_stores/${encodeURIComponent(storeId)}/files/${encodeURIComponent(uploadedFileId)}`, apiKey, { method: "DELETE" }, [404]).catch(() => undefined);
      await openAi(`${OPENAI_BASE}/files/${encodeURIComponent(uploadedFileId)}`, apiKey, { method: "DELETE" }, [404]).catch(() => undefined);
    }
    throw error;
  }
}

async function handleDelete(request: Request) {
  const body = await request.json().catch(() => null) as unknown;
  if (!isObj(body)) throw new ApiError("INVALID_REQUEST", 400);
  const organizationId = parseOrganization(body.organizationId);
  const documentId = typeof body.documentId === "string" && UUID.test(body.documentId) ? body.documentId : null;
  if (!documentId) throw new ApiError("INVALID_DOCUMENT", 400);
  const { admin, userId } = await context(request, organizationId);
  const config = await runtime(admin, organizationId);
  const found = await admin.from("crm_ai_knowledge_documents").select("*").eq("organization_id", organizationId).eq("id", documentId).maybeSingle();
  if (found.error) throw new ApiError("AI_KNOWLEDGE_LOOKUP_FAILED", 503);
  if (!found.data) throw new ApiError("KNOWLEDGE_DOCUMENT_NOT_FOUND", 404);
  const document = found.data as DocumentRow;
  await admin.from("crm_ai_knowledge_documents").update({ status: "deleting", updated_by: userId, updated_at: new Date().toISOString() }).eq("organization_id", organizationId).eq("id", documentId);
  if (document.openai_file_id) {
    await openAi(`${OPENAI_BASE}/vector_stores/${encodeURIComponent(document.vector_store_id)}/files/${encodeURIComponent(document.openai_file_id)}`, config.apiKey, { method: "DELETE" }, [404]);
    await openAi(`${OPENAI_BASE}/files/${encodeURIComponent(document.openai_file_id)}`, config.apiKey, { method: "DELETE" }, [404]);
  }
  const removed = await admin.from("crm_ai_knowledge_documents").delete().eq("organization_id", organizationId).eq("id", documentId);
  if (removed.error) throw new ApiError("AI_KNOWLEDGE_DELETE_FAILED", 503);
  return json({ ok: true, deleted: true, documentId });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const supportReference = `BIA-KB-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  try {
    if (request.method === "GET") return await handleGet(request);
    if (request.method === "POST") return await handlePost(request);
    if (request.method === "DELETE") return await handleDelete(request);
    throw new ApiError("METHOD_NOT_ALLOWED", 405);
  } catch (error) {
    return fail(error, supportReference);
  }
});
