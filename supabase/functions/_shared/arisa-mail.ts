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

// Only allowlisted messages reach the browser. Never expose provider bodies,
// client secrets, authorization codes, tokens or PKCE verifiers in diagnostics.
export const GOOGLE_ERRORS: Record<string, string> = {
  GOOGLE_CLIENT_INVALID: "O Google recusou as credenciais do aplicativo. Confira se o ID e o segredo pertencem ao mesmo cliente OAuth do tipo Aplicativo da Web. Se você gerou um novo segredo, salve o novo valor no painel da Arisa.",
  GOOGLE_AUTH_CODE_INVALID: "O Google recusou o código desta tentativa de conexão. Ele pode ter expirado ou já ter sido usado. Volte ao painel e inicie uma nova conexão no mesmo navegador; não recarregue esta página de retorno.",
  GOOGLE_REDIRECT_MISMATCH: "A URI de redirecionamento do cliente OAuth deve ser exatamente https://advent-tau.vercel.app/arisa/email/callback. Corrija no Google Cloud e inicie uma nova conexão.",
  GOOGLE_OAUTH_REQUEST_INVALID: "O Google recusou a solicitação OAuth. Inicie uma nova conexão pelo painel. Se persistir, informe o código de suporte para verificar o fluxo do aplicativo.",
  GOOGLE_API_DISABLED: "A Gmail API não está habilitada no projeto Google Cloud deste cliente OAuth. Abra APIs e serviços → Biblioteca → Gmail API → Ativar. Aguarde alguns minutos e inicie uma nova conexão.",
  GOOGLE_PERMISSIONS_MISSING: "A leitura e o envio de e-mails não foram autorizados. Inicie uma nova conexão e conceda as duas permissões do Gmail solicitadas pela Arisa.",
  GOOGLE_WORKSPACE_BLOCKED: "O Google Workspace bloqueou o acesso do aplicativo. O administrador da organização precisa conferir os controles de API e autorizar este cliente OAuth.",
  GOOGLE_ACCESS_DENIED: "O Gmail negou o acesso. Confira as permissões do aplicativo, os controles de API do Google Workspace e se o Gmail está ativo para a conta. A recusa não confirma que o token expirou.",
  GOOGLE_MAILBOX_UNAVAILABLE: "A caixa Gmail não está disponível para esta conta. Confira se arisa@evoraurbanismo.com.br é uma conta de usuário com Gmail ativo, e não apenas um alias ou grupo.",
  GOOGLE_REFRESH_TOKEN_MISSING: "O Google não forneceu autorização para manter a conexão. Inicie novamente pelo botão Conectar Google Workspace e conceda as permissões. Se persistir, remova o acesso da Arisa nas conexões da Conta Google e autorize novamente.",
  GOOGLE_ACCOUNT_MISMATCH: "A conta autorizada não é arisa@evoraurbanismo.com.br. Inicie uma nova conexão e escolha essa conta exata.",
  GOOGLE_RECONNECT_REQUIRED: "O Google recusou a autorização armazenada. Ela pode ter sido revogada ou ter expirado. Reconecte a conta pelo painel de e-mail.",
  GOOGLE_LIMIT: "O Google atingiu um limite de uso. Aguarde e tente novamente; reconectar a conta não resolve esse limite. Nenhum e-mail será reenviado automaticamente.",
  GOOGLE_UNAVAILABLE: "Não foi possível concluir a comunicação com o Google. Isso não significa que a autorização expirou. Aguarde e tente novamente pelo painel; nenhum e-mail será reenviado automaticamente.",
  GOOGLE_INVALID_RESPONSE: "O Google retornou uma resposta incompleta ou inesperada. Tente novamente pelo painel; nenhum e-mail será reenviado automaticamente.",
};
export function authorizationUrl(clientId: string, state: string, challenge: string) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: GOOGLE_REDIRECT, response_type: "code", scope: GOOGLE_SCOPES.join(" "), access_type: "offline", prompt: "consent select_account", login_hint: ARISA_EMAIL, state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  return url.toString();
}
export async function googleToken(config: Obj, code?: string, verifier?: string, request: typeof fetch = fetch) {
  const exchange = code !== undefined;
  if (typeof config.client_id !== "string" || !config.client_id.trim() || typeof config.client_secret !== "string" || !config.client_secret.trim()) throw new ManagerError("GOOGLE_CLIENT_INVALID", 409);
  if (exchange && (!code || !verifier)) throw new ManagerError("GOOGLE_AUTH_CODE_INVALID", 409);
  if (!exchange && (typeof config.refresh_token !== "string" || !config.refresh_token)) throw new ManagerError("GOOGLE_REFRESH_TOKEN_MISSING", 409);
  const body = new URLSearchParams({ client_id: config.client_id.trim(), client_secret: config.client_secret.trim(), grant_type: exchange ? "authorization_code" : "refresh_token", ...(exchange ? { code: code!, redirect_uri: GOOGLE_REDIRECT, code_verifier: verifier! } : { refresh_token: String(config.refresh_token) }) });
  let response: Response;
  try {
    response = await request("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(20000) });
  } catch { throw new ManagerError("GOOGLE_UNAVAILABLE", 503); }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = isObject(result) && typeof result.error === "string" ? result.error : "";
    if (response.status === 429) throw new ManagerError("GOOGLE_LIMIT", 429);
    if (response.status >= 500 || reason === "temporarily_unavailable" || reason === "server_error") throw new ManagerError("GOOGLE_UNAVAILABLE", 503);
    if (reason === "invalid_client" || reason === "unauthorized_client" || response.status === 401) throw new ManagerError("GOOGLE_CLIENT_INVALID", 409);
    if (reason === "invalid_grant") throw new ManagerError(exchange ? "GOOGLE_AUTH_CODE_INVALID" : "GOOGLE_RECONNECT_REQUIRED", 409);
    if (reason === "redirect_uri_mismatch") throw new ManagerError("GOOGLE_REDIRECT_MISMATCH", 409);
    if (reason === "invalid_scope") throw new ManagerError("GOOGLE_PERMISSIONS_MISSING", 409);
    if (reason === "access_denied" || reason === "admin_policy_enforced") throw new ManagerError("GOOGLE_WORKSPACE_BLOCKED", 403);
    if (reason === "invalid_request" || reason === "unsupported_grant_type") throw new ManagerError("GOOGLE_OAUTH_REQUEST_INVALID", 409);
    throw new ManagerError("GOOGLE_UNAVAILABLE", 503);
  }
  if (!isObject(result) || typeof result.access_token !== "string" || !result.access_token) throw new ManagerError("GOOGLE_INVALID_RESPONSE", 502);
  return result;
}
export async function gmail(accessToken: string, path: string, options: RequestInit = {}, request: typeof fetch = fetch): Promise<Obj> {
  let response: Response;
  try {
    response = await request("https://gmail.googleapis.com/gmail/v1/users/me/" + path, { ...options, headers: { authorization: "Bearer " + accessToken, "content-type": "application/json" }, signal: AbortSignal.timeout(25000) });
  } catch { throw new ManagerError("GOOGLE_UNAVAILABLE", 503); }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = isObject(result) && isObject(result.error) ? result.error : {};
    const items = [...(Array.isArray(error.errors) ? error.errors : []), ...(Array.isArray(error.details) ? error.details : [])].filter(isObject);
    const reasons = new Set(items.map(item => String(item.reason || "").toLowerCase()));
    const has = (...values: string[]) => values.some(value => reasons.has(value.toLowerCase()));
    const message = typeof error.message === "string" ? error.message : "";
    let code = "GOOGLE_UNAVAILABLE";
    if (response.status === 404) code = "GOOGLE_NOT_FOUND";
    else if (response.status === 401) code = "GOOGLE_RECONNECT_REQUIRED";
    else if (response.status === 429 || has("rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded", "quotaExceeded", "RESOURCE_EXHAUSTED")) code = "GOOGLE_LIMIT";
    else if (response.status === 403) {
      code = has("accessNotConfigured", "SERVICE_DISABLED", "API_DISABLED") || /(?:API.+(?:has not been used|is disabled)|accessNotConfigured)/i.test(message) ? "GOOGLE_API_DISABLED"
        : has("insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT") || /insufficient authentication scopes/i.test(message) ? "GOOGLE_PERMISSIONS_MISSING"
        : has("domainPolicy", "ORG_RESTRICTION_VIOLATION", "admin_policy_enforced") ? "GOOGLE_WORKSPACE_BLOCKED"
        : "GOOGLE_ACCESS_DENIED";
    } else if (response.status === 400 && (has("failedPrecondition") || error.status === "FAILED_PRECONDITION")) code = "GOOGLE_MAILBOX_UNAVAILABLE";
    // Keep the real HTTP status: sendArisaMail relies on it to distinguish a
    // definitive rejection from uncertain acceptance. Never retry a send here.
    throw new ManagerError(code, response.status);
  }
  if (!isObject(result)) throw new ManagerError("GOOGLE_INVALID_RESPONSE", 502);
  return result;
}

export async function completeGoogleGrant(config: Obj, code: string, verifier: string, previous: () => Promise<Obj | null>, request: typeof fetch = fetch) {
  const token = await googleToken(config, code, verifier, request);
  const scopes = typeof token.scope === "string" ? token.scope.split(/\s+/) : [];
  if (!GOOGLE_SCOPES.every(scope => scopes.includes(scope))) throw new ManagerError("GOOGLE_PERMISSIONS_MISSING", 409);
  const profile = await gmail(String(token.access_token), "profile", {}, request);
  if (String(profile.emailAddress).toLowerCase() !== ARISA_EMAIL) throw new ManagerError("GOOGLE_ACCOUNT_MISMATCH", 409);
  let refresh = typeof token.refresh_token === "string" && token.refresh_token ? token.refresh_token : null;
  if (!refresh) {
    // Google may omit refresh_token on a subsequent grant. Reuse only the
    // already-authorized mailbox/client and verify it, never another account.
    const saved = await previous();
    if (!saved || saved.client_id !== config.client_id || saved.sender !== ARISA_EMAIL || typeof saved.refresh_token !== "string" || !saved.refresh_token) throw new ManagerError("GOOGLE_REFRESH_TOKEN_MISSING", 409);
    const renewed = await googleToken(saved, undefined, undefined, request);
    const savedProfile = await gmail(String(renewed.access_token), "profile", {}, request);
    if (String(savedProfile.emailAddress).toLowerCase() !== ARISA_EMAIL) throw new ManagerError("GOOGLE_ACCOUNT_MISMATCH", 409);
    refresh = saved.refresh_token;
  }
  return { email: ARISA_EMAIL, refresh_token: refresh, scopes };
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
