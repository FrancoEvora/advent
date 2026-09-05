import { getSupabase } from "@/lib/supabase";
import type { InputKind, JsonRecord, OperationItem } from "./types";

export const OPERATION_BUCKET = "arisa-operations";
export const ITEM_COLUMNS = "id,organization_id,input_kind,storage_path,file_name,mime_type,size_bytes,file_hash,status,payload,extracted,outcome,issues,entry_id,created_at,updated_at,attempts,error_code,error_message";
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function operationClient() {
  const client = getSupabase();
  if (!client) throw new Error("A conexão está indisponível. Atualize a página e entre novamente.");
  return client;
}

export function operationError(error: unknown): string {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const message = error instanceof Error ? error.message : typeof record.message === "string" ? record.message : "Não foi possível concluir a operação. Tente novamente.";
  if (record.code === "42501" || /permission denied|access denied|row.level security/i.test(message)) return "Seu perfil não tem permissão para esta operação. Solicite a alçada à administração.";
  if (record.code === "42P01" || record.code === "PGRST202" || /schema cache/i.test(message)) return "A rotina ainda não está disponível no servidor. Atualize a página após a publicação da plataforma.";
  if (/JWT expired|invalid jwt|unauthorized/i.test(message)) return "Sua sessão expirou. Entre novamente para continuar.";
  return message;
}

export async function processOperation(organizationId: string, itemId: string) {
  const { data, error } = await operationClient().functions.invoke("arisa-operations", { body: { action: "process", organizationId, itemId } });
  if (error) {
    const response = "context" in error && error.context instanceof Response ? error.context : null;
    if (response) {
      const body = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null;
      const detail = typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : null;
      if (detail) throw new Error(detail);
    }
    throw error;
  }
  if (data?.error || data?.success === false) throw new Error(typeof data.error === "string" ? data.error : data.message || "O processamento não foi concluído. Consulte o detalhe do documento.");
  return data;
}

function fileMime(file: File, inputKind: InputKind): string {
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  const allowed: Record<InputKind, Record<string, string>> = {
    payable: { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", xml: "application/xml" },
    bank_statement: { csv: "text/csv", ofx: "application/x-ofx" },
  };
  const mime = allowed[inputKind][ext];
  if (!mime) throw new Error(inputKind === "payable" ? "Envie PDF, JPG, PNG, WebP ou XML de documento financeiro." : "Envie um extrato em CSV ou OFX.");
  if (!file.size) throw new Error("O arquivo está vazio. Escolha um documento com conteúdo.");
  if (file.size > MAX_FILE_BYTES) throw new Error("O arquivo excede o limite de 8 MB.");
  return mime;
}

export async function intakeOperation(file: File, inputKind: InputKind, organizationId: string, userId: string, context: JsonRecord): Promise<{ item: OperationItem; duplicate: boolean }> {
  const mime = fileMime(file, inputKind);
  if (inputKind === "bank_statement" && !context.bank_account_id) throw new Error("Selecione a conta bancária a que o extrato pertence.");
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const extension = file.name.split(".").pop()?.toLowerCase() || "bin";
  const path = `${organizationId}/${userId}/${crypto.randomUUID()}.${extension}`;
  const client = operationClient();
  const upload = await client.storage.from(OPERATION_BUCKET).upload(path, file, { contentType: mime, upsert: false });
  if (upload.error) throw upload.error;
  const { data, error } = await client.rpc("arisa_intake_document", {
    p_organization_id: organizationId, p_storage_path: path, p_file_name: file.name,
    p_mime_type: mime, p_size_bytes: file.size, p_file_hash: hash, p_input_kind: inputKind, p_context: context,
  });
  if (error) {
    // A timeout can occur after the transaction committed. Only delete when absence is confirmed.
    const lookup = await client.from("arisa_operation_items").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("storage_path", path);
    if (!lookup.error && lookup.count === 0) await client.storage.from(OPERATION_BUCKET).remove([path]);
    throw error;
  }
  const item = (Array.isArray(data) ? data[0] : data) as OperationItem | null;
  if (!item?.id) throw new Error("O documento foi enviado, mas o registro não retornou confirmação. Atualize a fila antes de reenviar.");
  const duplicate = item.storage_path !== path;
  if (duplicate) await client.storage.from(OPERATION_BUCKET).remove([path]);
  return { item, duplicate };
}

export async function getOriginalUrl(item: OperationItem): Promise<string> {
  const { data, error } = await operationClient().storage.from(OPERATION_BUCKET).createSignedUrl(item.storage_path, 120);
  if (error) throw error;
  if (!data?.signedUrl) throw new Error("Não foi possível abrir o documento. Tente novamente.");
  return data.signedUrl;
}
