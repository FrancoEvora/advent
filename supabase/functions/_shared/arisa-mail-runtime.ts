import type { SupabaseClient } from "npm:@supabase/supabase-js@2.110.7";
import { isObject, ManagerError, operationKey, UUID, type Obj } from "./arisa-manager.ts";
import { sha256 } from "./arisa-document.ts";
import { base64url, gmail, gmailContent, googleToken, mailInput, mimeMessage, unbase64, type MailAttachment } from "./arisa-mail.ts";
import { calendarId, calendarPlainText, eventId, googleCalendar, hasMeetingContext, safeEvent, timeRange, timezone } from "./arisa-calendar.ts";

export async function mailService(admin: SupabaseClient, action: string, org: string, actor: string | null, args: Obj = {}): Promise<Obj> {
  const { data, error } = await admin.rpc("arisa_mail_service", { p_action: action, p_org: org, p_actor: actor, p_args: args });
  if (error) throw new ManagerError(/^[A-Z_]+$/.test(error.message) ? error.message : "MAIL_SERVICE_UNAVAILABLE", error.code === "42501" ? 403 : 409);
  return isObject(data) ? data : {};
}
async function upload(admin: SupabaseClient, path: string, bytes: Uint8Array, mime: string) {
  const result = await admin.storage.from("arisa-mail").upload(path, bytes, { contentType: mime, upsert: false });
  if (result.error && !/already exists|duplicate/i.test(result.error.message)) throw new ManagerError("MAIL_ARCHIVE_FAILED");
}
async function setMail(admin: SupabaseClient, org: string, id: string, values: Obj) {
  const { error, data } = await admin.from("arisa_mail_messages").update({ ...values, updated_at: new Date().toISOString() }).eq("id", id).eq("organization_id", org).select("id").single();
  if (error || !data) throw new ManagerError("MAIL_ARCHIVE_FAILED");
}
export async function outboundFiles(caller: SupabaseClient, org: string, actor: string, fileIds: string[], archiveIds: string[]): Promise<MailAttachment[]> {
  const files: MailAttachment[] = [];
  for (const id of fileIds) {
    const row = await caller.from("arisa_chat_files").select("*").eq("id", id).eq("organization_id", org).eq("owner_user_id", actor).maybeSingle();
    if (row.error || !row.data) throw new ManagerError("MAIL_ATTACHMENT_INVALID", 422);
    const file = row.data;
    const stored = await caller.storage.from("arisa-chat").download(file.storage_path);
    if (stored.error || !stored.data || stored.data.size !== file.size_bytes) throw new ManagerError("MAIL_ATTACHMENT_INVALID", 422);
    const bytes = new Uint8Array(await stored.data.arrayBuffer());
    if (await sha256(bytes) !== file.file_hash) throw new ManagerError("MAIL_ATTACHMENT_INVALID", 422);
    files.push({ name: file.file_name, mime: file.mime_type, bytes, bucket: "arisa-chat", path: file.storage_path, file_id: id });
  }
  for (const id of archiveIds) {
    const row = await caller.from("arisa_archive").select("id,title,content,payload").eq("id",id).eq("organization_id",org).eq("source","generated_content").eq("owner_user_id",actor).maybeSingle();
    if (row.error || !row.data) throw new ManagerError("MAIL_ATTACHMENT_INVALID",422);
    const format = String(row.data.payload?.format || "txt");
    files.push({ name: String(row.data.payload?.file_name || row.data.title + ".txt").replace(/[\r\n\0]/g," ").slice(0,250), mime: ({ txt:"text/plain",md:"text/markdown",csv:"text/csv",html:"text/html" } as Record<string,string>)[format] || "text/plain", bytes: new TextEncoder().encode(row.data.content), archive_id:id });
  }
  return files;
}

export function meetingMailBody(event: Obj, calendar: string, introduction: unknown = ""): string {
  if (typeof introduction !== "string" || introduction.length > 130000 || introduction.includes("\0")) throw new ManagerError("MAIL_INVALID", 422);
  if (event.status === "cancelled") throw new ManagerError("CALENDAR_EVENT_CANCELLED", 409);
  const current = safeEvent(event, calendar);
  const description = calendarPlainText(current.description);
  if (!hasMeetingContext(description)) throw new ManagerError("CALENDAR_DESCRIPTION_REQUIRED", 422);
  if (current.meet_status === "pending") throw new ManagerError("CALENDAR_MEET_PENDING", 409);
  if (current.meet_status === "failure") throw new ManagerError("CALENDAR_MEET_UNAVAILABLE", 409);
  // Never forward a model-supplied or stale conference link in a meeting email.
  const suppliedLinks = introduction.match(/https?:\/\/meet\.google\.com\/[^\s<>\]\)]+/gi) ?? [];
  if (suppliedLinks.some(link => link.replace(/[.,;!?]+$/, "") !== current.meet_url)) throw new ManagerError("CALENDAR_LINK_MISMATCH", 422);
  const start = isObject(event.start) ? event.start : {}, end = isObject(event.end) ? event.end : {};
  const range = timeRange(start.dateTime, end.dateTime, 7), zone = timezone(start.timeZone ?? end.timeZone);
  const format = (value: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: zone, dateStyle: "full", timeStyle: "short" }).format(new Date(value));
  const cleanDescription = description.replace(/https?:\/\/meet\.google\.com\/[^\s<>]+/gi, "").trim();
  const details = [String(current.title), "Objetivo e pauta:\n" + cleanDescription,
    "Início: " + format(range.start) + "\nTérmino: " + format(range.end) + "\nFuso horário: " + zone];
  if (current.location) details.push("Local: " + calendarPlainText(current.location));
  if (current.meet_url) details.push("Google Meet: " + current.meet_url);
  if (current.google_url) details.push("Compromisso no Google Agenda: " + current.google_url);
  return [introduction.trim() || "Olá,\n\nCompartilho os detalhes da nossa reunião.", ...details,
    "Por favor, confirme sua participação pelo convite da agenda ou responda a este e-mail caso precise ajustar o horário."].join("\n\n");
}

export async function sendArisaMail(caller: SupabaseClient, admin: SupabaseClient, org: string, actor: string, args: Obj, context: { requestId: string; messageId?: string; lease?: string }) {
  let preparedArgs = args, calendarReference: Obj | null = null, connectedAccess: string | null = null;
  if (args.calendar_event_id !== undefined) {
    const calendar = calendarId(args.calendar_id ?? "primary"), id = eventId(args.calendar_event_id);
    const status = await mailService(admin, "status", org, actor);
    if (status.connected !== true || status.calendar_authorized !== true) throw new ManagerError("CALENDAR_AUTH_REQUIRED", 409);
    const config = await mailService(admin, "runtime", org, actor), token = await googleToken(config);
    connectedAccess = String(token.access_token);
    const event = await googleCalendar(connectedAccess, `calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(id)}`);
    if (event.id !== id) throw new ManagerError("CALENDAR_UNAVAILABLE", 502);
    preparedArgs = { ...args, body: meetingMailBody(event, calendar, args.body ?? "") };
    const current = safeEvent(event, calendar);
    calendarReference = { calendar_id: calendar, event_id: id, meet_url: current.meet_url, google_url: current.google_url, etag: current.etag };
  }
  const input = mailInput(preparedArgs);
  const files = await outboundFiles(caller,org,actor,input.fileIds,input.archiveIds);
  const descriptors = files.map(({bytes,...file})=>({...file,size:bytes.length}));
  // One message per explicit user request, including after a model retry changes wording.
  const key = await operationKey("send_email",{ actor,request_id:context.requestId });
  const draft = await mailService(admin,"prepare",org,actor,{operation_key:key,source_message_id:context.messageId ?? null,lease:context.lease ?? null,to:input.to,cc:input.cc,subject:input.subject,body:input.body,attachments:descriptors,crm_record_id:input.crmRecordId});
  const id = String(draft.id);
  if (draft.status === "sent") return { ok:true,id,status:"sent",provider_message_id:draft.provider_message_id,replayed:true,communication:{kind:"email",accepted_by:"Gmail",delivery_confirmed:false} };
  if (["sending","unknown"].includes(String(draft.status))) return { ok:false,id,status:draft.status,message:"O resultado deste envio precisa ser conferido no Gmail. Não reenviar automaticamente." };
  if (draft.subject !== input.subject || draft.body !== input.body || JSON.stringify(draft.recipients) !== JSON.stringify(input.to) || JSON.stringify(draft.cc) !== JSON.stringify(input.cc)) throw new ManagerError("MAIL_REQUEST_CHANGED",409);
  const attachmentKeys=(items:Obj[])=>items.map(file=>file.file_id||file.archive_id||file.path||file.name);
  if(JSON.stringify(attachmentKeys(Array.isArray(draft.attachments)?draft.attachments.filter(isObject):[]))!==JSON.stringify(attachmentKeys(descriptors)))throw new ManagerError("MAIL_REQUEST_CHANGED",409);
  const mime = mimeMessage(input,files,id,String(draft.created_at));
  const path = `${org}/${id}/original.eml`;
  await upload(admin,path,mime.bytes,"message/rfc822");
  const copies: Obj[] = [];
  for (const [index,file] of files.entries()) {
    const hash=await sha256(file.bytes),copyPath=`${org}/${id}/outbound-${index}-${hash}.bin`;
    await upload(admin,copyPath,file.bytes,file.mime);
    copies.push({name:file.name,mime:file.mime,size:file.bytes.length,bucket:"arisa-mail",path:copyPath,hash,file_id:file.file_id,archive_id:file.archive_id});
  }
  // Preserve the original MIME and attachment copies even when OAuth needs renewal.
  const archived=await admin.from("arisa_mail_messages").update({raw_path:path,rfc_message_id:mime.messageId,attachments:copies}).eq("organization_id",org).eq("id",id).in("status",["draft","failed"]);
  if(archived.error)throw new ManagerError("MAIL_ARCHIVE_FAILED");
  if (!connectedAccess) {
    const config = await mailService(admin,"runtime",org,actor), token = await googleToken(config);
    connectedAccess = String(token.access_token);
  }
  const begin = await mailService(admin,"send_begin",org,actor,{id,raw_path:path,rfc_message_id:mime.messageId,lease:context.lease ?? null});
  if (begin.send !== true) return { ok:false,id,status:isObject(begin.message)?begin.message.status:"unknown",message:"Este envio já está registrado. Consulte o arquivo." };
  let result: Obj;
  try {
    result = await gmail(connectedAccess,"messages/send",{method:"POST",body:JSON.stringify({raw:base64url(mime.bytes)})});
    if (typeof result.id !== "string") throw new ManagerError("GOOGLE_INVALID_RESPONSE");
  } catch(error) {
    // A network error or 5xx may happen after Gmail accepted the message.
    const definitive = error instanceof ManagerError && [400,401,403,404,413,429].includes(error.status);
    await setMail(admin,org,id,{status:definitive?"failed":"unknown",error_code:error instanceof ManagerError?error.code:"MAIL_RESULT_UNKNOWN"});
    return {ok:false,id,status:definitive?"failed":"unknown",message:definitive?"O Gmail recusou o envio. Consulte a conexão da conta.":"O Gmail não confirmou o resultado. A mensagem está arquivada e será conferida, sem reenvio automático."};
  }
  try { await setMail(admin,org,id,{status:"sent",provider_message_id:result.id,provider_thread_id:result.threadId,sent_at:new Date().toISOString(),error_code:null}); }
  catch { return {ok:false,id,status:"unknown",message:"O Gmail aceitou a mensagem, mas o registro final precisa ser conciliado. Não reenviar."}; }
  return {ok:true,id,status:"sent",provider_message_id:result.id,to:input.to,subject:input.subject,attachments:files.length,accepted_by:"Gmail",delivery_confirmed:false,
    communication:{kind:"email",calendar:calendarReference,attendee_acceptance_confirmed:false}};
}

async function archiveGmailMessage(admin: SupabaseClient, org: string, access: string, providerId: string) {
  let existing = await admin.from("arisa_mail_messages").select("id,status,raw_path").eq("organization_id",org).eq("provider_message_id",providerId).maybeSingle();
  if (existing.error) throw new ManagerError("MAIL_ARCHIVE_FAILED");
  if (existing.data?.raw_path && ["received","sent"].includes(existing.data.status)) return;
  const full = await gmail(access,"messages/"+encodeURIComponent(providerId)+"?format=full");
  // Gmail can externalize large text bodies as attachment IDs without filenames.
  const hydrate = async (part: Obj): Promise<void> => {
    const body=isObject(part.body)?part.body:{};
    if(!part.filename && ["text/plain","text/html"].includes(String(part.mimeType)) && typeof body.attachmentId==="string" && typeof body.data!=="string") {
      const stored=await gmail(access,`messages/${encodeURIComponent(providerId)}/attachments/${encodeURIComponent(body.attachmentId)}`);
      if(typeof stored.data!=="string")throw new ManagerError("MAIL_ARCHIVE_FAILED"); body.data=stored.data;
    }
    if(Array.isArray(part.parts))for(const child of part.parts.filter(isObject))await hydrate(child);
  };
  if(isObject(full.payload))await hydrate(full.payload);
  const content = gmailContent(full);
  if (!existing.data && /^<[a-f\d-]{36}@evoraurbanismo\.com\.br>$/i.test(content.messageId)) {
    existing = await admin.from("arisa_mail_messages").select("id,status,raw_path").eq("organization_id",org).eq("rfc_message_id",content.messageId).maybeSingle();
    if (existing.error) throw new ManagerError("MAIL_ARCHIVE_FAILED");
  }
  const id = existing.data?.id || crypto.randomUUID();
  const outbound = content.direction==="outbound";
  if (!existing.data) {
    const inserted = await admin.from("arisa_mail_messages").insert({id,organization_id:org,direction:outbound?"outbound":"inbound",sender:content.sender,recipients:content.to,cc:content.cc,subject:content.subject,body:content.body,provider_message_id:providerId,provider_thread_id:full.threadId,rfc_message_id:content.messageId,status:"archive_pending",occurred_at:content.date});
    if (inserted.error) throw new ManagerError("MAIL_ARCHIVE_FAILED");
  }
  const rawPath=`${org}/${id}/gmail-original.eml`;
  {
    const raw=await gmail(access,"messages/"+encodeURIComponent(providerId)+"?format=raw");
    if(typeof raw.raw!=="string") throw new ManagerError("MAIL_ARCHIVE_FAILED");
    await upload(admin,rawPath,unbase64(raw.raw),"message/rfc822");
  }
  const attachments: Obj[]=[];
  for (const [index,file] of content.files.entries()) {
    const data=file.data ?? (await gmail(access,`messages/${encodeURIComponent(providerId)}/attachments/${encodeURIComponent(file.id)}`)).data;
    if(typeof data!=="string") throw new ManagerError("MAIL_ARCHIVE_FAILED");
    const bytes=unbase64(data), hash=await sha256(bytes), path=`${org}/${id}/${index}-${hash}.bin`;
    await upload(admin,path,bytes,file.mime);
    attachments.push({name:file.name,mime:file.mime,size:bytes.length,bucket:"arisa-mail",path,hash});
  }
  await setMail(admin,org,id,{direction:content.direction,sender:content.sender,recipients:content.to,cc:content.cc,subject:content.subject,body:content.body,raw_path:rawPath,attachments,provider_message_id:providerId,provider_thread_id:full.threadId,status:content.status,error_code:null,occurred_at:content.date,...(content.status==="sent"?{sent_at:content.date}:{})});
}

export async function reconcileArisaMail(admin: SupabaseClient, org: string, access: string, id?: string) {
  let query=admin.from("arisa_mail_messages").select("id,rfc_message_id").eq("organization_id",org).in("status",["unknown","sending"]);
  if(id) {if(!UUID.test(id)) throw new ManagerError("MAIL_INVALID",422); query=query.eq("id",id);}
  else query=query.lt("updated_at",new Date(Date.now()-180000).toISOString());
  const rows=await query.limit(10); if(rows.error) throw new ManagerError("MAIL_ARCHIVE_FAILED");
  let confirmed=0;
  for(const row of rows.data||[]) {
    if(!row.rfc_message_id) continue;
    const result=await gmail(access,"messages?"+new URLSearchParams({q:"in:sent rfc822msgid:"+row.rfc_message_id,maxResults:"5"}));
    const messages=Array.isArray(result.messages)?result.messages.filter(isObject):[];
    if(messages.length===1 && typeof messages[0].id==="string") {await archiveGmailMessage(admin,org,access,messages[0].id);confirmed++;}
  }
  return {confirmed};
}

export async function syncArisaMail(admin: SupabaseClient, org: string, deadline=Date.now()+110000) {
  const claim=await mailService(admin,"sync_claim",org,null); if(typeof claim.lease!=="string") return {busy:true,archived:0};
  let count=0;
  try {
    const config=await mailService(admin,"runtime",org,null), token=await googleToken(config), access=String(token.access_token);
    let cursor=isObject(claim.cursor)?claim.cursor:{};
    if(!cursor.mode) {const profile=await gmail(access,"profile"); cursor={mode:"full",baseline:profile.historyId};}
    const full=cursor.mode==="full";
    const params=new URLSearchParams({maxResults:"10"});
    if(typeof cursor.page==="string") params.set("pageToken",cursor.page);
    if(full) params.set("includeSpamTrash","true"); else params.set("startHistoryId",String(cursor.history));
    let listing: Obj;
    try {listing=await gmail(access,(full?"messages?":"history?")+params);}
    catch(error) {if(!full && error instanceof ManagerError && error.code==="GOOGLE_NOT_FOUND") {await mailService(admin,"sync_finish",org,null,{lease:claim.lease,cursor:{}}); return {archived:0,resync:true};} throw error;}
    const messages=full?(Array.isArray(listing.messages)?listing.messages.filter(isObject):[]):(Array.isArray(listing.history)?listing.history.filter(isObject).flatMap(h=>Array.isArray(h.messages)?h.messages.filter(isObject):[]):[]);
    for(const id of [...new Set(messages.map(m=>String(m.id)))]) {
      if(Date.now()>deadline-12000) throw new ManagerError("MAIL_SYNC_CONTINUE");
      try {await archiveGmailMessage(admin,org,access,id);count++;} catch(error) {if(error instanceof ManagerError && error.code==="GOOGLE_NOT_FOUND") continue;throw error;}
    }
    const next=listing.nextPageToken?{...cursor,page:listing.nextPageToken}:{mode:"history",history:full?cursor.baseline:listing.historyId};
    await mailService(admin,"sync_finish",org,null,{lease:claim.lease,cursor:next});
    if(Date.now()<deadline-30000) await reconcileArisaMail(admin,org,access);
    return {archived:count,more:Boolean(listing.nextPageToken)};
  } catch(error) {
    const code=error instanceof ManagerError?error.code:"MAIL_SYNC_UNAVAILABLE";
    await mailService(admin,"sync_finish",org,null,{lease:claim.lease,error:code}).catch(()=>{});
    throw new ManagerError(code,503);
  }
}
