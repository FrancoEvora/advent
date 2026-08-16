import { createClient } from "npm:@supabase/supabase-js@2";

type Obj = Record<string, unknown>;
type Credentials = { apiKey: string; vectorStoreId: string | null };

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const ALLOWED_EXT = new Set(["pdf","txt","md","doc","docx"]);

class KnowledgeError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 503) { super(code); this.name = "KnowledgeError"; this.code = code; this.status = status; }
}

const J = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const obj = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const uuid = (value: unknown): string | null => { const text = str(value); return text && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text) ? text : null; };
const bool = (value: unknown) => value === true || value === "true";
const safeTags = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string").map(item=>item.trim().toLowerCase().slice(0,60)).filter(Boolean))].slice(0,20) : typeof value === "string" ? [...new Set(value.split(",").map(item=>item.trim().toLowerCase().slice(0,60)).filter(Boolean))].slice(0,20) : [];

function bearer(request: Request) {
  return /^Bearer\s+([^\s]{20,8192})$/i.exec(request.headers.get("authorization") || "")?.[1] || "";
}
function cleanFilename(name: string) {
  const safe = name.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g,"-").replace(/-+/g,"-").replace(/^[-.]+|[-.]+$/g,"").slice(0,160);
  return safe || `arquivo-${Date.now()}.txt`;
}
function extension(name: string) { return name.toLowerCase().split(".").pop() || ""; }
function openAiError(payload: unknown, fallback: string) {
  if (obj(payload) && obj(payload.error) && typeof payload.error.message === "string") return payload.error.message.slice(0,300);
  return fallback;
}

async function apiRequest(apiKey: string, path: string, init: RequestInit) {
  const response = await fetch(`https://api.openai.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers || {}) },
  });
  const payload = await response.json().catch(()=>null);
  if (!response.ok) throw new KnowledgeError(`OPENAI_${response.status}: ${openAiError(payload,"Falha na base vetorial")}`, response.status===429?429:503);
  return payload as Obj;
}

async function getCredentials(admin: ReturnType<typeof createClient>, organizationId: string): Promise<Credentials> {
  const result = await admin.rpc("get_vitoria_knowledge_runtime_credentials", { p_organization_id: organizationId });
  if (result.error || !obj(result.data)) throw new KnowledgeError("VITORIA_RUNTIME_UNAVAILABLE", 503);
  const apiKey = str(result.data.api_key);
  const vectorStoreId = str(result.data.vector_store_id);
  if (!apiKey || apiKey.length < 32 || /\s/.test(apiKey)) throw new KnowledgeError("VITORIA_OPENAI_KEY_MISSING", 409);
  return { apiKey, vectorStoreId: vectorStoreId && /^vs_[A-Za-z0-9_-]+$/.test(vectorStoreId) ? vectorStoreId : null };
}

async function ensureVectorStore(admin: ReturnType<typeof createClient>, organizationId: string, credentials: Credentials) {
  if (credentials.vectorStoreId) return credentials.vectorStoreId;
  const created = await apiRequest(credentials.apiKey, "/vector_stores", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `Évora Urbanismo · Base da Vitória · ${organizationId.slice(0,8)}` }),
  });
  const id = str(created.id);
  if (!id) throw new KnowledgeError("VITORIA_VECTOR_STORE_CREATE_FAILED", 503);
  const saved = await admin.rpc("set_vitoria_knowledge_vector_store", { p_organization_id: organizationId, p_vector_store_id: id });
  if (saved.error) throw new KnowledgeError("VITORIA_VECTOR_STORE_SAVE_FAILED", 503);
  return id;
}

async function uploadOpenAiFile(apiKey: string, file: File) {
  const form = new FormData();
  form.append("purpose", "user_data");
  form.append("file", file, file.name);
  const response = await fetch("https://api.openai.com/v1/files", { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form });
  const payload = await response.json().catch(()=>null) as Obj | null;
  if (!response.ok || !payload) throw new KnowledgeError(`OPENAI_FILE_${response.status}: ${openAiError(payload,"Falha no envio")}`, response.status===429?429:503);
  const id = str(payload.id);
  if (!id) throw new KnowledgeError("VITORIA_OPENAI_FILE_ID_MISSING", 503);
  return id;
}

async function attachAndWait(apiKey: string, vectorStoreId: string, openAiFileId: string, attributes: Obj) {
  const attached = await apiRequest(apiKey, `/vector_stores/${encodeURIComponent(vectorStoreId)}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: openAiFileId, attributes }),
  });
  const vectorFileId = str(attached.id) || openAiFileId;
  let status = str(attached.status) || "processing";
  for (let attempt=0; attempt<20 && !["completed","failed","cancelled"].includes(status); attempt++) {
    await new Promise(resolve=>setTimeout(resolve,1000));
    const current = await apiRequest(apiKey, `/vector_stores/${encodeURIComponent(vectorStoreId)}/files/${encodeURIComponent(vectorFileId)}`, { method: "GET" });
    status = str(current.status) || status;
  }
  return { vectorFileId, status: status === "completed" ? "completed" : status === "failed" || status === "cancelled" ? "failed" : "processing" };
}

async function authorizedUser(request: Request) {
  const token = bearer(request);
  if (!token) throw new KnowledgeError("AUTH_REQUIRED", 401);
  const url = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !anonKey || !serviceRole) throw new KnowledgeError("SERVICE_CONFIG_MISSING", 503);
  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const userResult = await userClient.auth.getUser(token);
  if (userResult.error || !userResult.data.user) throw new KnowledgeError("AUTH_REQUIRED", 401);
  const admin = createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return { user: userResult.data.user, admin };
}

async function requirePermission(admin: ReturnType<typeof createClient>, organizationId: string, userId: string) {
  const result = await admin.rpc("vitoria_knowledge_authorized", { p_organization_id: organizationId, p_user_id: userId });
  if (result.error || result.data !== true) throw new KnowledgeError("FORBIDDEN", 403);
}

async function listState(admin: ReturnType<typeof createClient>, organizationId: string) {
  const [sources, experiences, projects] = await Promise.all([
    admin.rpc("list_vitoria_knowledge_sources_v2", { p_organization_id: organizationId }),
    admin.rpc("get_vitoria_experience_settings", { p_organization_id: organizationId }),
    admin.from("projects").select("id,code,name,city,state,status").eq("organization_id",organizationId).eq("active",true).order("name"),
  ]);
  if (sources.error || experiences.error || projects.error) throw new KnowledgeError("VITORIA_KNOWLEDGE_LIST_FAILED", 503);
  return { sources: sources.data || [], experiences: experiences.data || [], projects: projects.data || [] };
}

async function ingestFile(input: {
  admin: ReturnType<typeof createClient>;
  organizationId: string;
  userId: string;
  projectId: string | null;
  scope: string;
  title: string;
  description: string | null;
  publicDocument: boolean;
  tags: string[];
  sortOrder: number;
  file: File;
  sourceType: "text" | "file";
}) {
  const { admin, organizationId, userId, projectId, scope, title, description, publicDocument, tags, sortOrder, file, sourceType } = input;
  if (file.size < 1 || file.size > MAX_FILE_BYTES) throw new KnowledgeError("FILE_SIZE_INVALID", 413);
  if (!ALLOWED_MIME.has(file.type) || !ALLOWED_EXT.has(extension(file.name))) throw new KnowledgeError("FILE_TYPE_INVALID", 415);
  const credentials = await getCredentials(admin, organizationId);
  const vectorStoreId = await ensureVectorStore(admin, organizationId, credentials);
  const sourceId = crypto.randomUUID();
  const storagePath = `${organizationId}/${sourceId}/${cleanFilename(file.name)}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const storage = await admin.storage.from("vitoria-knowledge").upload(storagePath, bytes, { contentType: file.type, upsert: false });
  if (storage.error) throw new KnowledgeError("VITORIA_STORAGE_UPLOAD_FAILED", 503);
  let openAiFileId: string | null = null;
  try {
    openAiFileId = await uploadOpenAiFile(credentials.apiKey, file);
    const attached = await attachAndWait(credentials.apiKey, vectorStoreId, openAiFileId, {
      organization_id: organizationId,
      project_id: scope === "project" ? projectId || "" : "",
      scope,
      title: title.slice(0,180),
    });
    const saved = await admin.rpc("upsert_vitoria_knowledge_source_v2", {
      p_id: sourceId,
      p_organization_id: organizationId,
      p_project_id: projectId,
      p_scope: scope,
      p_source_type: sourceType,
      p_title: title,
      p_content_preview: sourceType === "text" ? (await file.text()).slice(0,1200) : description || file.name,
      p_storage_path: storagePath,
      p_original_filename: file.name,
      p_mime_type: file.type,
      p_bytes: file.size,
      p_openai_file_id: openAiFileId,
      p_vector_store_id: vectorStoreId,
      p_vector_file_status: attached.status,
      p_created_by: userId,
      p_public_document: publicDocument,
      p_display_description: description,
      p_tags: tags,
      p_sort_order: sortOrder,
    });
    if (saved.error) throw new KnowledgeError("VITORIA_KNOWLEDGE_SAVE_FAILED", 503);
    return { id: sourceId, status: attached.status, vectorStoreId };
  } catch (error) {
    await admin.storage.from("vitoria-knowledge").remove([storagePath]);
    if (openAiFileId) await fetch(`https://api.openai.com/v1/files/${encodeURIComponent(openAiFileId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${credentials.apiKey}` } }).catch(()=>null);
    throw error;
  }
}

Deno.serve(async request => {
  try {
    if (!['GET','POST','DELETE','PATCH'].includes(request.method)) return J({ ok:false,error:"METHOD_NOT_ALLOWED" },405);
    const { user, admin } = await authorizedUser(request);
    const contentType = request.headers.get("content-type")?.toLowerCase() || "";
    let action = request.method === "GET" ? "list" : request.method === "DELETE" ? "delete" : request.method === "PATCH" ? "update_source" : "";
    let payload: Obj = {};
    let form: FormData | null = null;
    if (contentType.startsWith("multipart/form-data")) {
      form = await request.formData();
      action = str(form.get("action")) || "upload";
      payload = Object.fromEntries([...form.entries()].filter(([,value])=>typeof value === "string"));
    } else if (request.method !== "GET") {
      const parsed = await request.json().catch(()=>null);
      if (!obj(parsed)) throw new KnowledgeError("INVALID_JSON",400);
      payload = parsed;
      action = str(payload.action) || action;
    } else {
      const url = new URL(request.url);
      payload = Object.fromEntries(url.searchParams.entries());
    }

    const organizationId = uuid(payload.organizationId || form?.get("organizationId"));
    if (!organizationId) throw new KnowledgeError("ORGANIZATION_REQUIRED",400);
    await requirePermission(admin, organizationId, user.id);

    if (action === "list") return J({ ok:true,data:await listState(admin,organizationId) });

    if (action === "add_text") {
      const title = str(payload.title)?.slice(0,180), content = str(payload.content);
      if (!title || !content || content.length > 250_000) throw new KnowledgeError("TEXT_SOURCE_INVALID",400);
      const scope = payload.scope === "project" ? "project" : "organization";
      const projectId = scope === "project" ? uuid(payload.projectId) : null;
      if (scope === "project" && !projectId) throw new KnowledgeError("PROJECT_REQUIRED",400);
      const file = new File([content],`${cleanFilename(title)}.md`,{type:"text/markdown"});
      const result = await ingestFile({ admin,organizationId,userId:user.id,projectId,scope,title,description:str(payload.description)?.slice(0,500)||null,publicDocument:bool(payload.publicDocument),tags:safeTags(payload.tags),sortOrder:Math.max(0,Math.min(10000,Number(payload.sortOrder)||100)),file,sourceType:"text" });
      return J({ ok:true,data:result });
    }

    if (action === "upload") {
      if (!form) throw new KnowledgeError("MULTIPART_REQUIRED",415);
      const file = form.get("file");
      if (!(file instanceof File)) throw new KnowledgeError("FILE_REQUIRED",400);
      const title = (str(form.get("title")) || file.name).slice(0,180);
      const scope = form.get("scope") === "project" ? "project" : "organization";
      const projectId = scope === "project" ? uuid(form.get("projectId")) : null;
      if (scope === "project" && !projectId) throw new KnowledgeError("PROJECT_REQUIRED",400);
      const result = await ingestFile({ admin,organizationId,userId:user.id,projectId,scope,title,description:str(form.get("description"))?.slice(0,500)||null,publicDocument:bool(form.get("publicDocument")),tags:safeTags(form.get("tags")),sortOrder:Math.max(0,Math.min(10000,Number(form.get("sortOrder"))||100)),file,sourceType:"file" });
      return J({ ok:true,data:result });
    }

    if (action === "delete") {
      const sourceId = uuid(payload.sourceId);
      if (!sourceId) throw new KnowledgeError("SOURCE_REQUIRED",400);
      const sourceResult = await admin.rpc("get_vitoria_knowledge_source",{p_organization_id:organizationId,p_source_id:sourceId});
      if (sourceResult.error || !obj(sourceResult.data)) throw new KnowledgeError("SOURCE_NOT_FOUND",404);
      const source = sourceResult.data;
      const credentials = await getCredentials(admin,organizationId);
      const vectorStoreId = str(source.vector_store_id), openAiFileId = str(source.openai_file_id), storagePath = str(source.storage_path);
      if (vectorStoreId && openAiFileId) await fetch(`https://api.openai.com/v1/vector_stores/${encodeURIComponent(vectorStoreId)}/files/${encodeURIComponent(openAiFileId)}`,{method:"DELETE",headers:{Authorization:`Bearer ${credentials.apiKey}`}}).catch(()=>null);
      if (openAiFileId) await fetch(`https://api.openai.com/v1/files/${encodeURIComponent(openAiFileId)}`,{method:"DELETE",headers:{Authorization:`Bearer ${credentials.apiKey}`}}).catch(()=>null);
      if (storagePath) await admin.storage.from("vitoria-knowledge").remove([storagePath]);
      const deleted = await admin.rpc("delete_vitoria_knowledge_source_v2",{p_organization_id:organizationId,p_source_id:sourceId});
      if (deleted.error) throw new KnowledgeError("SOURCE_DELETE_FAILED",503);
      return J({ok:true,data:{id:sourceId}});
    }

    if (action === "update_source") {
      const sourceId = uuid(payload.sourceId), title = str(payload.title);
      if (!sourceId || !title) throw new KnowledgeError("SOURCE_INVALID",400);
      const result = await admin.rpc("update_vitoria_knowledge_source_metadata",{
        p_organization_id:organizationId,p_source_id:sourceId,p_title:title,
        p_public_document:bool(payload.publicDocument),p_display_description:str(payload.description),
        p_tags:safeTags(payload.tags),p_sort_order:Math.max(0,Math.min(10000,Number(payload.sortOrder)||100)),
        p_active:payload.active !== false,
      });
      if(result.error)throw new KnowledgeError("SOURCE_UPDATE_FAILED",503);
      return J({ok:true,data:result.data});
    }

    if (action === "update_experience") {
      const experienceId = uuid(payload.experienceId);
      if (!experienceId) throw new KnowledgeError("EXPERIENCE_REQUIRED",400);
      const theme = obj(payload.theme) ? payload.theme : {};
      const result = await admin.rpc("update_vitoria_experience_settings",{
        p_organization_id:organizationId,p_experience_id:experienceId,
        p_title:str(payload.title)||"Atendimento com a Vitória",
        p_subtitle:str(payload.subtitle)||"Converse com a Vitória.",
        p_eyebrow:str(payload.eyebrow)||"Évora Urbanismo",
        p_hero_image_url:str(payload.heroImageUrl),
        p_custom_instructions:str(payload.customInstructions)||"",
        p_theme:theme,
      });
      if(result.error)throw new KnowledgeError("EXPERIENCE_UPDATE_FAILED",503);
      return J({ok:true,data:result.data});
    }

    throw new KnowledgeError("ACTION_INVALID",400);
  } catch(error) {
    const status = error instanceof KnowledgeError ? error.status : 503;
    const code = error instanceof KnowledgeError ? error.code : "VITORIA_KNOWLEDGE_UNAVAILABLE";
    if (!(error instanceof KnowledgeError)) console.error("enterprise-vitoria-knowledge",{name:error instanceof Error?error.name:"UnknownError"});
    return J({ok:false,error:code},status);
  }
});
