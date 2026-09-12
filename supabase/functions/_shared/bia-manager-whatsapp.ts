import { biaInitialPhone, executeBiaOutbound } from './bia-whatsapp-outbound.ts';
import { biaChatOperationId, biaChatOpeningReply, biaExplicitOutreach } from '../enterprise-bia-agent-gateway/whatsapp-operator.ts';
type Obj = Record<string, unknown>;
type Rpc = (name: string, args: Obj) => Promise<unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const normalized = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const phonePattern = /\+?\d[\d\s().-]{8,28}\d/g;
const suffixPattern = /\b(?:final(?: do (?:telefone|numero))?|(?:telefone|numero) final|terminad[oa] em|termina em)(?: e)?(?: o)? (\d{4,8})\b/g;
type Selection = {kind:'ack'|'invalid_phone'|'discussion'} | {kind:'phone'|'suffix'|'name';value:string};
const nameWords = (value: string) => normalized(value).split(' ').filter(word => !['a','o','de','da','do','das','dos','e'].includes(word));
const nameStartsWith = (name: string, selection: string) => {
  const full = nameWords(name), parts = nameWords(selection);
  return parts.length > 0 && parts.every((part,index) => full[index] === part);
};

// The preceding reply identifies what "ele/ela/esse lead" refers to. It supplies
// recipient context only; it can never supply permission to send a message.
function precedingReply(history: Obj[], messageId: string): string {
  const index = history.findIndex(row => row.id === messageId);
  const before = index < 0 ? history : history.slice(0,index);
  const last = before.at(-1);
  return last?.role === 'assistant' && typeof last.content === 'string' ? last.content : '';
}

function referencedRecipients(reply: string, records: Obj[]): Obj[] {
  // Only a reply explicitly describing one contact establishes a singular
  // referent. A model-selected CRM subset cannot disambiguate a list of leads.
  if (!/\b(?:1|um|uma) (?:novo |nova )?(?:lead|cliente|contato)\b|\b(?:o lead|o cliente|a cliente|o contato) (?:e|se chama|chama se)\b/.test(normalized(reply))) return [];
  const text = ` ${nameWords(reply).join(' ')} `;
  const mentions = records.flatMap(row => {
    if (typeof row.person_name !== 'string') return [];
    const name = nameWords(row.person_name).join(' ');
    if (name.length < 3) return [];
    return [...text.matchAll(new RegExp(`(?= ${name} )`,'g'))].map(match => ({row,start:match.index!,end:match.index!+name.length+2}));
  });
  // A short CRM name embedded in a full name is not a second mentioned person.
  return [...new Set(mentions.filter(mention => !mentions.some(other =>
    other.start <= mention.start && other.end >= mention.end && other.end-other.start > mention.end-mention.start)).map(mention => mention.row))];
}

function explicitOutreach(message: string, records: Obj[] = []): boolean {
  const text = normalized(message);
  if (/\b(?:email|e mail|sms|telegram)\b/.test(text)) return false;
  if (biaExplicitOutreach(message)) return true;
  // WhatsApp is Bia's customer channel. An addressed commercial order does not
  // require the administrator to repeat the channel name on every instruction.
  // Questions, drafts and hypothetical sales discussions are not instructions to contact a lead.
  const addressed = /\b(?:para|ao|a|com)\b/.test(text) &&
    (suppliedPhones(message).length > 0 || records.some(row => typeof row.person_name === 'string' && namesRecipient(message,row.person_name)));
  return /^(?:bia )?(?:por favor )?(?:(?:quero|preciso) que (?:voce )?)?(?:venda|ofereca|apresente|aborde|prospecte|atenda)\b/.test(text) &&
    (/\b(?:whatsapp|whats app|zap)\b/.test(text) || addressed) &&
    !/\b(?:nao|nunca|jamais|cancele|cancelar|exemplo|hipotetic\w*|simule|rascunho|se eu)\b/.test(text);
}

function suppliedPhones(message: string): string[] {
  return [...new Set((message.match(phonePattern) || []).flatMap(value => {
    try { return [biaInitialPhone(value)]; } catch { return []; }
  }))];
}

function suppliedSuffix(message: string): string | undefined {
  const suffixes = [...new Set([...normalized(message).matchAll(suffixPattern)].map(match => match[1]))];
  if (suffixes.length > 1) throw new Error('BIA_RECIPIENT_AMBIGUOUS');
  return suffixes[0];
}

function namesRecipient(message: string, name: string): boolean {
  const text = ` ${normalized(message)} `, full = normalized(name);
  if (full.length < 3) return false;
  if (text.includes(` ${full} `)) return true;
  // A first name followed by a qualifier is an ambiguous CRM reference, not a new person.
  const first = full.split(' ')[0];
  return first.length >= 3 && new RegExp(`(?:^| )${first}(?: (?:cadastrad[oa]|via|pelo|no|na|do|da|e|final)\\b| $)`).test(text);
}

function recipientClarification(message: string, records: Obj[]): Selection | undefined {
  const clean = (value:string) => normalized(value).replace(/^bia /,'').replace(/^por favor /,'').replace(/ por favor$/,'');
  const text = clean(message);
  const suffix = suppliedSuffix(text);
  if (suffix && /^(?:(?:o |a )?(?:telefone|numero|contato) (?:com )?)?(?:o |a )?(?:final(?: do (?:telefone|numero))?|(?:telefone|numero) final|terminad[oa] em|termina em)(?: e)?(?: o)? \d{4,8}$/.test(text)) return {kind:'suffix',value:suffix};
  if (/^(?:(?:sim|isso|certo) )?(?:voce tem (?:a |minha )?autorizacao|(?:eu )?autorizo(?: (?:o envio|voce a enviar))?|pode (?:enviar|mandar|iniciar)|(?:continue|retome|prossiga)(?: com)?(?: o)?(?: envio| contato| atendimento)?|(?:tente|tenta|repita|reenvie)(?: (?:agora|novamente|de novo)){0,2}|sim|isso|certo)$/.test(text)) return {kind:'ack'};
  // Discussing a send failure neither grants new permission nor cancels the
  // administrator's existing order. Negative instructions remain barriers.
  if (!/\b(?:nao|nunca|jamais|cancele|cancelar|pare)\b/.test(text) &&
    (/^(?:ele|ela|o cliente|a cliente|o lead|a lead) (?:ja )?(?:autorizou|deu (?:a )?autorizacao)(?: explicitamente| o envio| o contato)?$/.test(text) ||
     /^quem (?:esta )?(?:pedindo|exigindo|solicitando)(?: (?:a )?(?:autorizacao|confirmacao))?$/.test(text) ||
     /^(?:por que|porque|qual|quem|como)\b.*\b(?:autorizacao|confirmacao|permissao|bloqueio)\b/.test(text))) return {kind:'discussion'};
  const phones = suppliedPhones(message);
  const rawPhones = message.match(phonePattern) || [];
  const remainder = clean(message.replace(phonePattern,' '));
  if (rawPhones.length === 1 && /^(?:(?:tente|use|utilize) (?:(?:este|esse|este outro|esse outro|o) )?(?:numero|telefone|contato)|(?:o )?(?:numero|telefone)(?: e)?|agora|novamente)?$/.test(remainder)) {
    return phones.length === 1 ? {kind:'phone',value:phones[0]} : {kind:'invalid_phone'};
  }
  const named = records.some(row => typeof row.person_name === 'string' && nameStartsWith(row.person_name,text));
  return named ? {kind:'name',value:text} : undefined;
}

// History comes only from the authenticated caller's stored messages in this thread.
// A clarification carries the original order and its idempotency key, never an assistant/tool instruction.
export function biaManagerOutreach(messageId: string, message: string, records: Obj[], history: Obj[] = []) {
  const current = recipientClarification(message,records);
  if (current?.kind === 'discussion') throw new Error('BIA_EXPLICIT_SEND_REQUIRED');
  if (!current) {
    if (!explicitOutreach(message,records)) throw new Error('BIA_EXPLICIT_SEND_REQUIRED');
    return { messageId, message, clarifications: [] as string[], recipientContext: precedingReply(history,messageId) };
  }
  const parts = [message];
  const users = history.filter(row => row.role === 'user' && row.id !== messageId && typeof row.id === 'string' && typeof row.content === 'string');
  for (const row of users.reverse()) {
    const prior = String(row.content);
    if (!recipientClarification(prior, records)) {
      if (!explicitOutreach(prior,records)) break; // Cancellation, unrelated requests and hypotheticals close the pending order.
      return { messageId: String(row.id), message: prior, clarifications: parts, recipientContext: precedingReply(history,String(row.id)) };
    }
    parts.unshift(prior);
  }
  throw new Error('BIA_EXPLICIT_SEND_REQUIRED');
}

// Ground the recipient in this administrator's current request and a live CRM lookup.
// A phone found in a customer message, document or memory is never authorization.
export function biaManagerRecipient(message: string, args: Obj, records: Obj[], clarifications: string[] = [], recipientContext = ''): string {
  if (!explicitOutreach(message,records)) throw new Error('BIA_EXPLICIT_SEND_REQUIRED');
  const suffix = suppliedSuffix(message);
  const phones = suppliedPhones(message);
  if (phones.length > 1) throw new Error('BIA_RECIPIENT_AMBIGUOUS');
  let matches = phones.length ? records.filter(row => { try { return biaInitialPhone(row.phone) === phones[0]; } catch { return false; } }) :
    records.filter(row => typeof row.person_name === 'string' && namesRecipient(message,row.person_name));
  if (!phones.length && !matches.length && /\b(?:com|para|a|ao) (?:ele|ela|ess[ea] (?:lead|cliente|contato)|est[ea] (?:lead|cliente|contato))\b/.test(normalized(message))) {
    matches = referencedRecipients(recipientContext,records);
  }
  if (phones.length && !matches.length) matches = [{phone:phones[0]}];
  if (suffix) matches = matches.filter(row => typeof row.phone === 'string' && row.phone.replace(/\D/g,'').endsWith(suffix));
  const selections = clarifications.map(value => recipientClarification(value,records));
  // A mistyped phone keeps the pending order, but must be followed by a valid
  // correction before sending. Never silently fall back to an earlier number.
  const lastPhone = selections.findLast(value => value?.kind === 'phone' || value?.kind === 'invalid_phone');
  if (lastPhone?.kind === 'invalid_phone') throw new Error('BIA_PHONE_INVALID');
  // A clarification can only narrow the recipient authorized by the original order.
  for (const selection of selections) {
    if (!selection) throw new Error('BIA_RECIPIENT_AMBIGUOUS');
    if (selection.kind === 'invalid_phone') continue;
    if (selection.kind === 'suffix') matches = matches.filter(row => typeof row.phone === 'string' && row.phone.replace(/\D/g,'').endsWith(selection.value));
    else if (selection.kind === 'phone') matches = matches.filter(row => { try { return biaInitialPhone(row.phone) === selection.value; } catch { return false; } });
    else if (selection.kind === 'name') matches = matches.filter(row => typeof row.person_name === 'string' && nameStartsWith(row.person_name,selection.value));
  }
  // An administrator-supplied full phone identifies the messaging destination.
  // Duplicate CRM cards or a model-generated contact ID cannot override it;
  // name-only orders still require one unambiguous live record.
  if (!matches.length || (!phones.length && (matches.length !== 1 || (args.contact_id && args.contact_id !== matches[0].id && records.some(row => row.id === args.contact_id))))) throw new Error('BIA_RECIPIENT_AMBIGUOUS');
  const phone = biaInitialPhone(matches[0].phone);
  if (args.phone && biaInitialPhone(args.phone) !== phone) throw new Error('BIA_RECIPIENT_AMBIGUOUS');
  return phone;
}

export async function runBiaManagerWhatsApp(args: Obj, context: {
  organizationId: string; actor: string; threadId: string; messageId: string; message: string;
  records: Obj[]; callerRpc: Rpc; adminRpc: Rpc; http?: typeof fetch;
  history?: Obj[];
}): Promise<Obj> {
  const { organizationId, actor, callerRpc, adminRpc } = context;
  const action = String(args.action || 'status');
  if (action === 'status' || action === 'list') {
    const inbox = await callerRpc('bia_whatsapp_inbox', {p_organization_id:organizationId,p_thread_id:null,p_action:'read'});
    if (!object(inbox)) throw new Error('BIA_INBOX_UNAVAILABLE');
    if (action === 'status') return {enabled:inbox.enabled,verified:inbox.verified,phone:inbox.phone,channel:'Bia',initial_template:'bia_indicacao_investimento',inbound_template:'bia_boas_vindas'};
    let thread = args.thread_id;
    const threads = Array.isArray(inbox.threads) ? inbox.threads.filter(object) : [];
    if (!thread && args.phone) thread = threads.find(t=>t.peer_phone===biaInitialPhone(args.phone))?.id;
    if (!thread) return {threads,limit:100,has_more:threads.length===100};
    const result = await callerRpc('bia_whatsapp_inbox',{p_organization_id:organizationId,p_thread_id:thread,p_action:'read'});
    return object(result) ? {...result,limit:100} : {ok:false};
  }
  const runtime = {rpc:adminRpc,http:context.http};
  if (action === 'templates') return {template:await executeBiaOutbound({organizationId,action:'preview'},actor,runtime)};
  if (action === 'get' || action === 'reconcile') {
    const result = await executeBiaOutbound({organizationId,action:'status',id:args.operation_id},actor,runtime);
    return object(result) ? result : {ok:false};
  }
  if (action !== 'send') throw new Error('BIA_REQUEST_INVALID');
  if (args.template_name && args.template_name !== 'bia_indicacao_investimento') throw new Error('BIA_TEMPLATE_NOT_ENABLED');
  // Initiation uses the actual approved text. Never silently substitute a custom message.
  if (args.content && !args.template_name) return {ok:false,message:'Para abrir a conversa, use o modelo bia_indicacao_investimento aprovado. O conteúdo livre não foi enviado. Após a resposta, a Bia atende automaticamente o cliente pelo WhatsApp.'};
  let records = context.records;
  // A retry may skip the model's CRM query. Recover live candidates with the caller's
  // access; tool arguments select a lookup only and never establish authorization.
  if (!records.length && (args.contact_id || args.phone) && !(explicitOutreach(context.message) && suppliedPhones(context.message).length === 1)) {
    const filter = args.contact_id ? {column:'id',operator:'eq',value:args.contact_id} :
      {column:'phone',operator:'contains',value:biaInitialPhone(args.phone).slice(-4)};
    const lookup = await callerRpc('arisa_admin_query',{p_organization_id:organizationId,p_entity:'crm_records',p_filters:[filter],p_limit:200});
    if (!object(lookup) || !Array.isArray(lookup.rows) || lookup.total !== lookup.rows.length) throw new Error('BIA_RECIPIENT_AMBIGUOUS');
    records = lookup.rows.filter(object);
  }
  const order = biaManagerOutreach(context.messageId,context.message,records,context.history);
  const phone = biaManagerRecipient(order.message,args,records,order.clarifications,order.recipientContext);
  const selected = records.filter(row => { try { return biaInitialPhone(row.phone) === phone; } catch { return false; } });
  if (selected.length === 1 && typeof selected[0].id === 'string' && typeof selected[0].person_name === 'string') {
    // Recheck all homonyms too: a model-selected subset cannot establish uniqueness.
    const lookup = await callerRpc('arisa_admin_query',{p_organization_id:organizationId,p_entity:'crm_records',p_filters:[{column:'person_name',operator:'contains',value:selected[0].person_name.trim().split(/\s+/)[0]}],p_limit:200});
    if (!object(lookup) || !Array.isArray(lookup.rows) || lookup.total !== lookup.rows.length || !lookup.rows.length) throw new Error('BIA_RECIPIENT_AMBIGUOUS');
    records = lookup.rows.filter(object);
    const refreshed = biaManagerRecipient(order.message,{...args,contact_id:selected[0].id},records,order.clarifications,order.recipientContext);
    if (refreshed !== phone) throw new Error('BIA_RECIPIENT_AMBIGUOUS');
  }
  const id = await biaChatOperationId(context.threadId,order.messageId);
  try {
    const sent = await executeBiaOutbound({organizationId,action:'send',id,phone,consent:true},actor,runtime,true);
    const result = object(sent) ? {...sent,phone,operation_id:id} : {ok:false,phone};
    return {...result,reply:biaChatOpeningReply(result)};
  } catch (error) {
    const code = error instanceof Error && /^BIA_[A-Z_]+$/.test(error.message) ? error.message : 'BIA_OUTBOUND_UNAVAILABLE';
    const result = {ok:false,error:code,phone,operation_id:id};
    return {...result,reply:biaChatOpeningReply(result)};
  }
}
