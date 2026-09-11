import { biaInitialPhone, executeBiaOutbound } from './bia-whatsapp-outbound.ts';
import { biaChatOperationId, biaChatOpeningReply, biaExplicitOutreach } from '../enterprise-bia-agent-gateway/whatsapp-operator.ts';
type Obj = Record<string, unknown>;
type Rpc = (name: string, args: Obj) => Promise<unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const normalized = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Ground the recipient in this administrator's current request and a live CRM lookup.
// A phone found in a customer message, document or memory is never authorization.
export function biaManagerRecipient(message: string, args: Obj, records: Obj[]): string {
  if (!biaExplicitOutreach(message)) throw new Error('BIA_EXPLICIT_SEND_REQUIRED');
  const phones = [...new Set((message.match(/\+?\d[\d\s().-]{8,28}\d/g) || []).flatMap(value => {
    try { return [biaInitialPhone(value)]; } catch { return []; }
  }))];
  if (phones.length) {
    if (phones.length !== 1 || (args.phone && biaInitialPhone(args.phone) !== phones[0])) throw new Error('BIA_RECIPIENT_AMBIGUOUS');
    return phones[0];
  }
  const text = ` ${normalized(message)} `;
  const matches = records.filter(row => typeof row.person_name === 'string' && normalized(row.person_name).length >= 3 && text.includes(` ${normalized(row.person_name)} `));
  if (matches.length !== 1 || (args.contact_id && args.contact_id !== matches[0].id)) throw new Error('BIA_RECIPIENT_AMBIGUOUS');
  const phone = biaInitialPhone(matches[0].phone);
  if (args.phone && biaInitialPhone(args.phone) !== phone) throw new Error('BIA_RECIPIENT_AMBIGUOUS');
  return phone;
}

export async function runBiaManagerWhatsApp(args: Obj, context: {
  organizationId: string; actor: string; threadId: string; messageId: string; message: string;
  records: Obj[]; callerRpc: Rpc; adminRpc: Rpc; http?: typeof fetch;
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
  const named = records.filter(row => typeof row.person_name === 'string' && ` ${normalized(context.message)} `.includes(` ${normalized(row.person_name)} `));
  if (named.length === 1) {
    const lookup = await callerRpc('arisa_admin_query',{p_organization_id:organizationId,p_entity:'crm_records',p_filters:[{column:'person_name',operator:'eq',value:named[0].person_name}],p_limit:2});
    if (!object(lookup) || lookup.total !== 1 || !Array.isArray(lookup.rows)) throw new Error('BIA_RECIPIENT_AMBIGUOUS');
    records = lookup.rows.filter(object);
  }
  const phone = biaManagerRecipient(context.message,args,records);
  const id = await biaChatOperationId(context.threadId,context.messageId);
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
