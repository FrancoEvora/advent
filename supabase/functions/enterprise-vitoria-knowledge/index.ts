import { createClient } from "npm:@supabase/supabase-js@2";

type Obj = Record<string, unknown>;

const PROJECT_ORIGIN = "https://advent-tau.vercel.app";
const ALLOWED_ORIGINS = new Set([
  PROJECT_ORIGIN,
  "https://advent-franco-3095s-projects.vercel.app",
]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 120_000;
const BUCKET = "vitoria-knowledge";
const ALLOWED_MIME = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

class AppError extends Error {
  status: number;
  code: string;
  constructor(code: string, status = 400) {
    super(code);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cors(request: Request) {
  const origin = request.headers.get("origin") || PROJECT_ORIGIN;
  const allow = ALLOWED_ORIGINS.has(origin) || origin.endsWith("-franco-3095s-projects.vercel.app")
    ? origin
    : PROJECT_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

function json(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(request), "Content-Type": "application/json; charset=utf-8" },
  });
}

function bearer(request: Request) {
  return /^Bearer\s+([^\s]{20,8192})$/i.exec(request.headers.get("authorization") || "")?.[1] || "";
}

function uuid(value: unknown, code = "INVALID_ID") {
  const raw = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    throw new AppError(code, 400);
  }
  return raw;
}

function title(value: unknown) {
  const raw = String(value || "").trim();
  if (raw.length < 2 || raw.length > 180) throw new AppError("INVALID_TITLE", 400);
  return raw;
}

function cleanFileName(value: string) {
  const normalized = value.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-");
  return normalized.slice(-160) || "documento";
}

async function openAiJson(apiKey: string, url: string, init: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init.headers || {}),
    },
  });
  const payload = await response.json().catch(() => null) as Obj | null;
  if (!response.ok || !payload) {
    console.error("vitoria-knowledge OpenAI", { status: response.status, endpoint: new URL(url).pathname });
    throw new AppError("KNOWLEDGE_INDEXING_FAILED", response.status === 429 ? 429 : 503);
  }
  return payload;
}

async function ensureVectorStore(admin: ReturnType<typeof createClient>, organizationId: string, apiKey: string, existing?: string | null) {
  if (existing && /^vs_[A-Za-z0-9_-]{6,}$/.test(existing)) return existing;
  const created = await openAiJson(apiKey, "https://api.openai.com/v1/vector_stores", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `Évora Urbanismo · Vitória · ${organizationId}` }),
  });
  const vectorStoreId = typeof created.id === "string" ? created.id : "";
  if (!/^vs_[A-Za-z0-9_-]{6,}$/.test(vectorStoreId)) throw new AppError("VECTOR_STORE_CREATE_FAILED", 503);
  const saved = await admin.rpc("set_vitoria_knowledge_vector_store", {
    p_organization_id: organizationId,
    p_vector_store_id: vectorStoreId,
  });
  if (saved.error) throw new AppError("VECTOR_STORE_SAVE_FAILED", 503);
  return vectorStoreId;
}

async function uploadOpenAiFile(apiKey: string, file: File) {
  const form = new FormData();
  form.set("purpose", "assistants");
  form.set("file", file, file.name);
  const response = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const payload = await response.json().catch(() => null) as Obj | null;
  if (!response.ok || !payload || typeof payload.id !== "string") {
    console.error("vitoria-knowledge file upload", { status: response.status });
    throw new AppError("KNOWLEDGE_FILE_UPLOAD_FAILED", response.status === 429 ? 429 : 503);
  }
  return payload.id;
}

async function attachToVectorStore(apiKey: string, vectorStoreId: string, fileId: string, attributes: Obj) {
  const attached = await openAiJson(apiKey, `https://api.openai.com/v1/vector_stores/${encodeURIComponent(vectorStoreId)}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId, attributes }),
  });
  return typeof attached.status === "string" ? attached.status : "processing";
}

async function authorize(request: Request) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) throw new AppError("SERVICE_CONFIG_MISSING", 503);
  const token = bearer(request);
  if (!token) throw new AppError("SESSION_REQUIRED", 401);
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const userResult = await admin.auth.getUser(token);
  if (userResult.error || !userResult.data.user) throw new AppError("SESSION_EXPIRED", 401);
  return { admin, user: userResult.data.user, supabaseUrl };
}

async function permission(admin: ReturnType<typeof createClient>, organizationId: string, userId: string) {
  const check = await admin.rpc("vitoria_knowledge_authorized", {
    p_organization_id: organizationId,
    p_user_id: userId,
  });
  if (check.error || check.data !== true) throw new AppError("AI_RUNTIME_PERMISSION_REQUIRED", 403);
}

async function runtime(admin: ReturnType<typeof createClient>, organizationId: string) {
  const result = await admin.rpc("get_vitoria_knowledge_runtime_credentials", {
    p_organization_id: organizationId,
  });
  if (result.error || !isObj(result.data)) throw new AppError("AI_RUNTIME_NOT_CONFIGURED", 409);
  const apiKey = typeof result.data.api_key === "string" ? result.data.api_key : "";
  if (apiKey.length < 32 || /\s/.test(apiKey)) throw new AppError("OPENAI_KEY_REQUIRED", 409);
  return {
    apiKey,
    vectorStoreId: typeof result.data.vector_store_id === "string" ? result.data.vector_store_id : null,
  };
}

async function addSource(request: Request, admin: ReturnType<typeof createClient>, userId: string, organizationId: string, payload: Obj) {
  const sourceTitle = title(payload.title);
  const scope = payload.scope === "project" ? "project" : "organization";
  const projectId = scope === "project" ? uuid(payload.projectId, "INVALID_PROJECT") : null;
  const text = String(payload.text || "").trim();
  if (text.length < 10 || text.length > MAX_TEXT_CHARS) throw new AppError("INVALID_KNOWLEDGE_TEXT", 400);
  const current = await runtime(admin, organizationId);
  const vectorStoreId = await ensureVectorStore(admin, organizationId, current.apiKey, current.vectorStoreId);
  const sourceId = crypto.randomUUID();
  const fileName = `${cleanFileName(sourceTitle)}.txt`;
  const file = new File([text], fileName, { type: "text/plain" });
  const storagePath = `${organizationId}/${sourceId}/${fileName}`;
  const stored = await admin.storage.from(BUCKET).upload(storagePath, file, { contentType: "text/plain", upsert: false });
  if (stored.error) throw new AppError("KNOWLEDGE_STORAGE_FAILED", 503);
  let openaiFileId = "";
  try {
    openaiFileId = await uploadOpenAiFile(current.apiKey, file);
    const status = await attachToVectorStore(current.apiKey, vectorStoreId, openaiFileId, {
      organization_id: organizationId,
      source_id: sourceId,
      scope,
      project_id: projectId || "organization",
    });
    const saved = await admin.rpc("upsert_vitoria_knowledge_source", {
      p_id: sourceId,
      p_organization_id: organizationId,
      p_project_id: projectId,
      p_scope: scope,
      p_source_type: "text",
      p_title: sourceTitle,
      p_content_preview: text.slice(0, 1200),
      p_storage_path: storagePath,
      p_original_filename: fileName,
      p_mime_type: "text/plain",
      p_bytes: file.size,
      p_openai_file_id: openaiFileId,
      p_vector_store_id: vectorStoreId,
      p_vector_file_status: status === "completed" ? "completed" : "processing",
      p_created_by: userId,
    });
    if (saved.error) throw new AppError("KNOWLEDGE_SAVE_FAILED", 503);
    return { id: sourceId, status };
  } catch (error) {
    await admin.storage.from(BUCKET).remove([storagePath]).catch(() => null);
    if (openaiFileId) await fetch(`https://api.openai.com/v1/files/${encodeURIComponent(openaiFileId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${current.apiKey}` } }).catch(() => null);
    throw error;
  }
}

async function addFile(request: Request, admin: ReturnType<typeof createClient>, userId: string, organizationId: string, form: FormData) {
  const sourceTitle = title(form.get("title"));
  const scope = form.get("scope") === "project" ? "project" : "organization";
  const projectId = scope === "project" ? uuid(form.get("projectId"), "INVALID_PROJECT") : null;
  const raw = form.get("file");
  if (!(raw instanceof File) || raw.size < 1 || raw.size > MAX_FILE_BYTES) throw new AppError("INVALID_KNOWLEDGE_FILE", 400);
  if (!ALLOWED_MIME.has(raw.type)) throw new AppError("UNSUPPORTED_KNOWLEDGE_FILE", 415);
  const fileName = cleanFileName(raw.name);
  const file = new File([await raw.arrayBuffer()], fileName, { type: raw.type });
  const current = await runtime(admin, organizationId);
  const vectorStoreId = await ensureVectorStore(admin, organizationId, current.apiKey, current.vectorStoreId);
  const sourceId = crypto.randomUUID();
  const storagePath = `${organizationId}/${sourceId}/${fileName}`;
  const stored = await admin.storage.from(BUCKET).upload(storagePath, file, { contentType: raw.type, upsert: false });
  if (stored.error) throw new AppError("KNOWLEDGE_STORAGE_FAILED", 503);
  let openaiFileId = "";
  try {
    openaiFileId = await uploadOpenAiFile(current.apiKey, file);
    const status = await attachToVectorStore(current.apiKey, vectorStoreId, openaiFileId, {
      organization_id: organizationId,
      source_id: sourceId,
      scope,
      project_id: projectId || "organization",
    });
    const saved = await admin.rpc("upsert_vitoria_knowledge_source", {
      p_id: sourceId,
      p_organization_id: organizationId,
      p_project_id: projectId,
      p_scope: scope,
      p_source_type: "file",
      p_title: sourceTitle,
      p_content_preview: `Arquivo ${fileName}`,
      p_storage_path: storagePath,
      p_original_filename: fileName,
      p_mime_type: raw.type,
      p_bytes: file.size,
      p_openai_file_id: openaiFileId,
      p_vector_store_id: vectorStoreId,
      p_vector_file_status: status === "completed" ? "completed" : "processing",
      p_created_by: userId,
    });
    if (saved.error) throw new AppError("KNOWLEDGE_SAVE_FAILED", 503);
    return { id: sourceId, status };
  } catch (error) {
    await admin.storage.from(BUCKET).remove([storagePath]).catch(() => null);
    if (openaiFileId) await fetch(`https://api.openai.com/v1/files/${encodeURIComponent(openaiFileId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${current.apiKey}` } }).catch(() => null);
    throw error;
  }
}

async function removeSource(admin: ReturnType<typeof createClient>, organizationId: string, sourceId: string) {
  const current = await runtime(admin, organizationId);
  const result = await admin.rpc("delete_vitoria_knowledge_source", {
    p_organization_id: organizationId,
    p_source_id: sourceId,
  });
  if (result.error || !isObj(result.data)) throw new AppError("KNOWLEDGE_NOT_FOUND", 404);
  const data = result.data;
  if (typeof data.storage_path === "string" && data.storage_path) {
    await admin.storage.from(BUCKET).remove([data.storage_path]).catch(() => null);
  }
  if (typeof data.openai_file_id === "string" && data.openai_file_id) {
    if (typeof data.vector_store_id === "string" && data.vector_store_id) {
      await fetch(`https://api.openai.com/v1/vector_stores/${encodeURIComponent(data.vector_store_id)}/files/${encodeURIComponent(data.openai_file_id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${current.apiKey}` } }).catch(() => null);
    }
    await fetch(`https://api.openai.com/v1/files/${encodeURIComponent(data.openai_file_id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${current.apiKey}` } }).catch(() => null);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  try {
    if (request.method !== "POST") throw new AppError("METHOD_NOT_ALLOWED", 405);
    const { admin, user } = await authorize(request);
    const contentType = request.headers.get("content-type") || "";
    let organizationId = "";
    let action = "";
    let payload: Obj = {};
    let form: FormData | null = null;
    if (contentType.toLowerCase().startsWith("multipart/form-data")) {
      form = await request.formData();
      organizationId = uuid(form.get("organizationId"), "INVALID_ORGANIZATION");
      action = String(form.get("action") || "");
    } else {
      payload = await request.json().catch(() => null) as Obj;
      if (!isObj(payload)) throw new AppError("INVALID_REQUEST", 400);
      organizationId = uuid(payload.organizationId, "INVALID_ORGANIZATION");
      action = String(payload.action || "");
    }
    await permission(admin, organizationId, user.id);

    if (action === "list") {
      const result = await admin.rpc("list_vitoria_knowledge_sources", { p_organization_id: organizationId });
      if (result.error) throw new AppError("KNOWLEDGE_LIST_FAILED", 503);
      return json(request, { ok: true, sources: result.data || [] });
    }
    if (action === "add_text") {
      const result = await addSource(request, admin, user.id, organizationId, payload);
      return json(request, { ok: true, ...result }, 201);
    }
    if (action === "add_file" && form) {
      const result = await addFile(request, admin, user.id, organizationId, form);
      return json(request, { ok: true, ...result }, 201);
    }
    if (action === "delete") {
      await removeSource(admin, organizationId, uuid(payload.sourceId, "INVALID_SOURCE"));
      return json(request, { ok: true });
    }
    throw new AppError("INVALID_ACTION", 400);
  } catch (error) {
    const known = error instanceof AppError ? error : null;
    if (!known) console.error("enterprise-vitoria-knowledge", { errorName: error instanceof Error ? error.name : "UnknownError" });
    return json(request, { ok: false, error: known?.code || "KNOWLEDGE_UNAVAILABLE" }, known?.status || 503);
  }
});
