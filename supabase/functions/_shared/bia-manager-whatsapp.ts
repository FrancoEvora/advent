import { biaInitialPhone, executeBiaOutbound } from './bia-whatsapp-outbound.ts';
import { biaChatOperationId, biaChatOpeningReply, biaExplicitOutreach } from '../enterprise-bia-agent-gateway/whatsapp-operator.ts';
type Obj = Record<string, unknown>;
type Rpc = (name: string, args: Obj) => Promise<unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const normalized = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const phonePattern = /\+?\d[\d\s().-]{8,28}\d/g;
const suffixPattern = /\b(?:final(?: do (?:telefone|numero))?|(?:telefone|numero) final|terminad[oa] em|termina em)(?: e)?(?: o)? (\d{4,8})\b/g;
type Selection = {kind:'ack'} | {kind:'phone'|'suffix'|'name';value:string};

function explicitOutreach(message: string): boolean {
  if (biaExplicitOutreach(message)) return true;
  const text = normalized(message);
  // A direct commercial instruction with a channel and recipient is also an outreach order.
  // Questions, drafts and hypothetical sales discussions are not instructions to contact a lead.
  return /^(?:bia )?(?:por favor )?(?:(?:quero|preciso) que (?:voce )?)?(?:venda|ofereca|apresente|aborde|prospecte|atenda)\b/.test(text) &&
    /\b(?:whatsapp|whats app|zap)\b/.test(text) &&
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
  if (/^(?:(?:sim|isso|certo) )?(?:voce tem (?:a |minha )?autorizacao|autorizo(?: o envio)?|pode (?:enviar|mandar|iniciar)|(?:continue|retome|prossiga)(?: com)?(?: o)?(?: envio| contato| atendimento)?|(?:tente|tenta|repita|reenvie)(?: (?:agora|novamente|de novo)){0,2}|sim|isso|certo)$/.test(text)) return {kind:'ack'};
  const phones = suppliedPhones(message);
  const remainder = clean(message.replace(phonePattern,' '));
  if (phones.length === 1 && /^(?:(?:tente|use|utilize) (?:(?:este|esse|este outro|esse outro|o) )?(?:numero|telefone|contato)|(?:o )?(?:numero|telefone)(?: e)?|agora|novamente)?$/.test(remainder)) return {kind:'phone',value:phones[0]};
  const named = records.find(row => typeof row.person_name === 'string' &&
    [normalized(row.person_name), 'a '+normalized(row.person_name), 'o '+normalized(row.person_name)].includes(text));
  return named ? {kind:'name',value:normalized(String(named.person_name))} : undefined;
}

// History comes only from the authenticated caller's stored messages in this thread.
// A clarification carries the original order and its idempotency key, never an assistant/tool instruction.
export function biaManagerOutreach(messageId: string, message: string, records: Obj[], history: Obj[] = []) {
  if (!recipientClarification(message, records)) {
    if (!explicitOutreach(message)) throw new Error('BIA_EXPLICIT_SEND_REQUIRED');
    return { messageId, message, clarifications: [] as string[] };
  }
  const parts = [message];
  const users = history.filter(row => row.role === 'user' && row.id !== messageId && typeof row.id === 'string' && typeof row.content === 'string');
  for (const row of users.reverse()) {
    const prior = String(row.content);
    if (!recipientClarification(prior, records)) {
      if (!explicitOutreach(prior)) break; // Cancellation, unrelated requests and hypotheticals close the pending order.
      return { messageId: String(row.id), message: prior, clarifications: parts };
    }
    parts.unshift(prior);
  }
  throw new Error('BIA_EXPLICIT_SEND_REQUIRED');
}

// Ground the recipient in this administrator's current request and a live CRM lookup.
// A phone found in a customer message, document or memory is never authorization.
export function biaManagerRecipient(message: string, args: Obj, records: Obj[], clarifications: string[] = []): string {
  if (!explicitOutreach(message)) throw new Error('BIA_EXPLICIT_SEND_REQUIRED');
  const suffix = suppliedSuffix(message);
  const phones = suppliedPhones(message);
  if (phones.length > 1) throw new Error('BIA_RECIPIENT_AMBIGUOUS');
  let matches = phones.length ? records.filter(row => { try { return biaInitialPhone(row.phone) === phones[0]; } catch { return false; } }) :
    records.filter(row => typeof row.person_name === 'string' && namesRecipient(message,row.person_name));
  if (phones.length && !matches.length) matches = [{phone:phones[0]}];
  if (suffix) matches = matches.filter(row => typeof row.phone === 'string' && row.phone.replace(/\D/g,'').endsWith(suffix));
  // A clarification can only narrow the recipient authorized by the original order.
  for (const clarification of clarifications) {
    const selection = recipientClarification(clarification,records);
    if (!selection) throw new Error('BIA_RECIPIENT_AMBIGUOUS');
    if (selection.kind === 'suffix') matches = matches.filter(row => typeof row.phone === 'string' && row.phone.replace(/\D/g,'').endsWith(selection.value));
    else if (selection.kind === 'phone') matches = matches.filter(row => { try { return biaInitialPhone(row.phone) === selection.value; } catch { return false; } });
    else if (selection.kind === 'name') matches = matches.filter(row => typeof row.person_name === 'string' && normalized(row.person_name) === selection.value);
  }
  if (matches.length !== 1 || (args.contact_id && args.contact_id !== matches[0].id)) throw new Error('BIA_RECIPIENT_AMBIGUOUS');
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
  const phone = biaManagerRecipient(order.message,args,records,order.clarifications);
  const selected = records.filter(row => { try { return biaInitialPhone(row.phone) === phone; } catch { return false; } });
  if (selected.length === 1 && typeof selected[0].id === 'string' && typeof selected[0].person_name === 'string') {
    // Recheck all homonyms too: a model-selected subset cannot establish uniqueness.
    const lookup = await callerRpc('arisa_admin_query',{p_organization_id:organizationId,p_entity:'crm_records',p_filters:[{column:'person_name',operator:'contains',value:selected[0].person_name.trim().split(/\s+/)[0]}],p_limit:200});
    if (!object(lookup) || !Array.isArray(lookup.rows) || lookup.total !== lookup.rows.length || !lookup.rows.length) throw new Error('BIA_RECIPIENT_AMBIGUOUS');
    records = lookup.rows.filter(object);
    const refreshed = biaManagerRecipient(order.message,{...args,contact_id:selected[0].id},records,order.clarifications);
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
