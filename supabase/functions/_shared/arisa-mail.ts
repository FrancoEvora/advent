import { isObject, ManagerError, UUID, type Obj } from "./arisa-manager.ts";

export const ARISA_EMAIL = "arisa@evoraurbanismo.com.br";
export const GOOGLE_REDIRECT = "https://advent-tau.vercel.app/arisa/email/callback";
export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"];
export type MailAttachment = { name: string; mime: string; bytes: Uint8Array; bucket?: string; path?: string; file_id?: string; archive_id?: string };
export type MailInput = { to: string[]; cc: string[]; subject: string; body: string; fileIds: string[]; archiveIds: string[]; crmRecordId: string | null };
const EMAIL = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,63}$/i;

export function addresses(value: unknown, required = true): string[] {
  if (!Array.isArray(value) || value.length > 20 || (required && !value.length)) throw new ManagerError("MAIL_RECIPIENT_INVALID", 422);
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length > 254 || !EMAIL.test(item) || /[\r\n\0]/.test(item)) throw new ManagerError("MAIL_RECIPIENT_INVALID", 422);
    const email = item.toLowerCase(); if (!result.includes(email)) result.push(email);
  }
  return result;
}
export function mailInput(value: Obj): MailInput {
  if (typeof value.subject !== "string" || !value.subject.trim() || value.subject.length > 250 || /[\r\n\0]/.test(value.subject) || typeof value.body !== "string" || !value.body.trim() || value.body.length > 150000 || value.body.includes("\0")) throw new ManagerError("MAIL_INVALID", 422);
  const ids = (value: unknown) => {
    if (!Array.isArray(value) || value.length > 10 || value.some(id => typeof id !== "string" || !UUID.test(id))) throw new ManagerError("MAIL_ATTACHMENT_INVALID", 422);
    return [...new Set(value as string[])];
  };
  return { to: addresses(value.to), cc: addresses(value.cc ?? [], false), subject: value.subject.trim(), body: value.body.trim(), fileIds: ids(value.fileIds ?? value.file_ids ?? []), archiveIds: ids(value.archiveIds ?? value.archive_ids ?? []), crmRecordId: typeof value.crmRecordId === "string" ? value.crmRecordId : typeof value.crm_record_id === "string" ? value.crm_record_id : null };
}
export function base64(bytes: Uint8Array) {
  let result = ""; for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(result);
}
export function base64url(bytes: Uint8Array) { return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
export function unbase64(value: string) {
  const raw = atob(value.replaceAll("-", "+").replaceAll("_", "/")); return Uint8Array.from(raw, char => char.charCodeAt(0));
}
const encoded = (value: string) => {
  const chunks: string[] = []; let chunk = "";
  for (const char of value) { if (new TextEncoder().encode(chunk + char).length > 42) { chunks.push(chunk); chunk = ""; } chunk += char; }
  if (chunk) chunks.push(chunk);
  return chunks.map(text => "=?UTF-8?B?" + base64(new TextEncoder().encode(text)) + "?=").join("\r\n ");
};
const fold = (value: string) => value.match(/.{1,76}/g)?.join("\r\n") ?? "";
export function mimeMessage(input: MailInput, files: MailAttachment[], id: string, date: string) {
  if (!UUID.test(id) || !Number.isFinite(Date.parse(date))) throw new ManagerError("MAIL_INVALID", 422);
  if (files.length > 10 || files.reduce((n, f) => n + f.bytes.length, 0) > 18 * 1024 * 1024) throw new ManagerError("MAIL_ATTACHMENTS_TOO_LARGE", 422);
  const boundary = "arisa_" + id.replaceAll("-", ""); const messageId = `<${id}@evoraurbanismo.com.br>`;
  const lines = ["From: Arisa - Evora Urbanismo <" + ARISA_EMAIL + ">", "To: " + input.to.join(",\r\n "), ...(input.cc.length ? ["Cc: " + input.cc.join(",\r\n ")] : []), "Subject: " + encoded(input.subject), "Date: " + new Date(date).toUTCString(), "Message-ID: " + messageId, "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", fold(base64(new TextEncoder().encode(input.body + "\n\nArisa\nGestora da plataforma · Évora Urbanismo\n" + ARISA_EMAIL)))];
  for (const file of files) {
    if (!/^[a-z\d!#$&^_.+-]+\/[a-z\d!#$&^_.+-]+$/i.test(file.mime) || /[\r\n\0]/.test(file.name) || file.name.length > 250) throw new ManagerError("MAIL_ATTACHMENT_INVALID", 422);
    lines.push(`--${boundary}`, "Content-Type: " + file.mime, `Content-Disposition: attachment; filename="${encoded(file.name)}"`, "Content-Transfer-Encoding: base64", "", fold(base64(file.bytes)));
  }
  lines.push(`--${boundary}--`, "");
  return { bytes: new TextEncoder().encode(lines.join("\r\n")), messageId };
}
export function authorizationUrl(clientId: string, state: string, challenge: string) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: GOOGLE_REDIRECT, response_type: "code", scope: GOOGLE_SCOPES.join(" "), access_type: "offline", prompt: "consent select_account", login_hint: ARISA_EMAIL, state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  return url.toString();
}
export async function googleToken(config: Obj, code?: string, verifier?: string, request: typeof fetch = fetch) {
  const body = new URLSearchParams({ client_id: String(config.client_id), client_secret: String(config.client_secret), grant_type: code ? "authorization_code" : "refresh_token", ...(code ? { code, redirect_uri: GOOGLE_REDIRECT, code_verifier: verifier || "" } : { refresh_token: String(config.refresh_token) }) });
  const response = await request("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(20000) });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok || !isObject(result) || typeof result.access_token !== "string") throw new ManagerError("GOOGLE_RECONNECT_REQUIRED", 409);
  return result;
}
export async function gmail(accessToken: string, path: string, options: RequestInit = {}, request: typeof fetch = fetch): Promise<Obj> {
  const response = await request("https://gmail.googleapis.com/gmail/v1/users/me/" + path, { ...options, headers: { authorization: "Bearer " + accessToken, "content-type": "application/json" }, signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new ManagerError(response.status === 404 ? "GOOGLE_NOT_FOUND" : [401,403].includes(response.status) ? "GOOGLE_RECONNECT_REQUIRED" : response.status === 429 ? "GOOGLE_LIMIT" : "GOOGLE_UNAVAILABLE", response.status);
  const result: unknown = await response.json(); if (!isObject(result)) throw new ManagerError("GOOGLE_INVALID_RESPONSE"); return result;
}
export function gmailContent(value: Obj) {
  const payload = isObject(value.payload) ? value.payload : {};
  const headers = Array.isArray(payload.headers) ? payload.headers.filter(isObject) : [];
  const header = (name: string) => String(headers.find(h => String(h.name).toLowerCase() === name)?.value || "");
  const plain: string[] = [], html: string[] = [], files: { id: string; name: string; mime: string; size: number; data?: string }[] = [];
  const walk = (part: Obj) => {
    const body = isObject(part.body) ? part.body : {};
    if (typeof part.filename === "string" && part.filename) files.push({ id: String(body.attachmentId || ""), name: part.filename.slice(0,250), mime: String(part.mimeType || "application/octet-stream"), size: Number(body.size || 0), ...(typeof body.data === "string" ? { data: body.data } : {}) });
    else if (typeof body.data === "string") {
      const content = new TextDecoder().decode(unbase64(body.data));
      if (part.mimeType === "text/plain") plain.push(content); else if (part.mimeType === "text/html") html.push(content);
    }
    if (Array.isArray(part.parts)) part.parts.filter(isObject).forEach(walk);
  }; walk(payload);
  const text = plain.length ? plain.join("\n") : html.join("\n").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?\s*>|<\/p>/gi,"\n").replace(/<[^>]*>/g," ").replaceAll("&nbsp;"," ").replaceAll("&amp;","&").replaceAll("&lt;","<").replaceAll("&gt;",">");
  const extract = (value: string) => [...value.matchAll(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,63}/gi)].map(match => match[0].toLowerCase());
  const labels=Array.isArray(value.labelIds)?value.labelIds:[],draft=labels.includes("DRAFT"),sent=labels.includes("SENT");
  return { subject: header("subject") || "(Sem assunto)", sender: extract(header("from"))[0] || "remetente não identificado", to: extract(header("to")), cc: extract(header("cc")), body: text, files, messageId: header("message-id"), date: new Date(Number(value.internalDate) || Date.now()).toISOString(),direction:draft||sent?"outbound":"inbound",status:draft?"draft":sent?"sent":"received" };
}
