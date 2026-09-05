import { getSupabase } from "@/lib/supabase";

export type Thread = { id: string; title: string; updated_at: string };
export type ChatFile = { id: string; file_name: string; mime_type: string; storage_path: string; size_bytes: number; operation_item_id: string | null };
export type Message = { id: string; role: "user" | "assistant"; content: string; file_ids: string[]; status: "queued" | "processing" | "completed" | "failed"; parent_id: string | null; created_at: string; lease_expires_at: string | null; metadata: { message?: string; support_reference?: string } };
export type Action = { id: string; message_id: string; action: string; entity: string; record_id: string | null; summary: string; created_at: string };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function client() { const value = getSupabase(); if (!value) throw new Error("A conexão não está configurada."); return value; }
export function errorText(error: unknown) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const message = error instanceof Error ? error.message : typeof record.message === "string" ? record.message : "Não foi possível concluir. Tente novamente.";
  if (record.code === "42501" || /ADMIN_REQUIRED|row.level security|permission denied/i.test(message)) return "Este chat exige um administrador ativo. Entre novamente ou confira seu acesso.";
  if (record.code === "42P01" || record.code === "PGRST202") return "O chat ainda não está disponível no servidor. Atualize após a publicação.";
  return message;
}
export async function callManager(body: Record<string, unknown>) {
  const { data, error } = await client().functions.invoke("arisa-manager", { body });
  if (error) {
    const response = "context" in error && error.context instanceof Response ? error.context : null;
    if (response) { const value = await response.json().catch(() => null); if (typeof value?.message === "string") throw new Error(value.message); }
    throw error;
  }
  if (!data?.ok) throw new Error(data?.message || "A operação não foi confirmada.");
  return data;
}
export function fileMime(file: File) {
  const map: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", xml: "application/xml", csv: "text/csv", ofx: "application/x-ofx", txt: "text/plain", webm: "audio/webm", m4a: "audio/mp4", mp4: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav" };
  const mime = map[file.name.split(".").pop()?.toLowerCase() || ""];
  if (!mime) throw new Error("Envie PDF, imagem, XML, CSV, OFX, texto ou áudio.");
  if (!file.size || file.size > 8388608) throw new Error("Cada arquivo precisa ter conteúdo e no máximo 8 MB.");
  return mime;
}
export async function uploadFile(file: File, organizationId: string, userId: string, threadId: string): Promise<ChatFile> {
  const mime = fileMime(file);
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const hash = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, "0")).join("");
  const path = `${organizationId}/${userId}/${threadId}/${crypto.randomUUID()}.${file.name.split(".").pop()?.toLowerCase()}`;
  const upload = await client().storage.from("arisa-chat").upload(path, file, { contentType: mime, upsert: false });
  if (upload.error) throw upload.error;
  const registered = await client().rpc("arisa_chat_register_file", { p_thread_id: threadId, p_path: path, p_name: file.name.slice(0, 250), p_mime: mime, p_size: file.size, p_hash: hash });
  if (registered.error) {
    const existing = await client().from("arisa_chat_files").select("*").eq("storage_path", path).maybeSingle();
    if (!existing.error && existing.data) return existing.data as ChatFile;
    if (!existing.error && !existing.data) await client().storage.from("arisa-chat").remove([path]);
    throw registered.error;
  }
  return registered.data as ChatFile;
}
export async function openFile(file: ChatFile) {
  // Open synchronously so Safari does not treat the eventual private URL as an unsolicited popup.
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  try {
    const signed = await client().storage.from("arisa-chat").createSignedUrl(file.storage_path, 120, { download: file.file_name });
    if (signed.error || !signed.data?.signedUrl) throw signed.error || new Error("O arquivo não está disponível.");
    if (tab) tab.location.replace(signed.data.signedUrl); else window.location.assign(signed.data.signedUrl);
  } catch (error) { tab?.close(); throw error; }
}
