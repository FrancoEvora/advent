import { biaInitialPhone, executeBiaOutbound } from '../_shared/bia-whatsapp-outbound.ts';

type Obj = Record<string, unknown>;
type OperatorRuntime = {
  authenticate: (token: string) => Promise<string | null>;
  rpc: (name: string, args: Obj) => Promise<unknown>;
  http?: typeof fetch;
};
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function biaAuthenticatedOperator(authorization: string, organizationId: string, runtime: OperatorRuntime): Promise<string | null> {
  if (!authorization.startsWith('Bearer ') || authorization.length > 16000 || !uuid.test(organizationId)) return null;
  try {
    const actor = await runtime.authenticate(authorization.slice(7));
    if (!actor || !uuid.test(actor)) return null;
    await runtime.rpc('bia_whatsapp_outbound_admin', {p_organization_id:organizationId,p_actor:actor,p_action:'access',p_args:{}});
    return actor;
  } catch { return null; }
}

export function biaExplicitOutreach(message: string): boolean {
  const text = message.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (/\b(?:nao|nunca|jamais)\s+(?:me |lhe |ainda )?(?:envie|enviar|mande|mandar|inicie|iniciar|chame|chamar|contate|contatar|entre|fale)\b|\b(?:cancele|cancelar|exemplo|hipotetic\w*|se eu|como (?:eu |voce )?(?:envio|enviar|manda|mandar))\b/.test(text)) return false;
  return /\b(envie|enviar|mande|mandar|inicie|iniciar|chame|chamar|contate|contatar|entre em contato|entrar em contato|fale com|falar com)\b/.test(text);
}

export async function biaChatOperationId(sessionId: string, clientMessageId: string): Promise<string> {
  if (!uuid.test(sessionId) || !uuid.test(clientMessageId)) throw new Error('BIA_REQUEST_INVALID');
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`bia-outreach:${sessionId}:${clientMessageId}`)));
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes.slice(0,16)].map(b=>b.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export async function biaSendFromChat(input: { actor: string | null; organizationId: string; sessionId: string; clientMessageId: string; message: string; candidate: unknown }, runtime: OperatorRuntime): Promise<Obj> {
  if (!input.actor || !uuid.test(input.actor)) return {ok:false,actionExecuted:false,error:'BIA_OUTBOUND_FORBIDDEN'};
  if (!biaExplicitOutreach(input.message)) return {ok:false,actionExecuted:false,needs:'pedido_explicito_de_envio'};
  let phone: string;
  try { phone = biaInitialPhone(input.candidate); } catch { return {ok:false,actionExecuted:false,needs:'numero_com_ddd'}; }
  const supplied = new Set((input.message.match(/\+?\d[\d\s().-]{8,28}\d/g)||[]).flatMap(part=>{
    try {return [biaInitialPhone(part)];} catch {return [];}
  }));
  if (supplied.size !== 1 || !supplied.has(phone)) return {ok:false,actionExecuted:false,needs:'um_numero_inequivoco_no_pedido'};
  try {
    const id = await biaChatOperationId(input.sessionId,input.clientMessageId);
    const result = await executeBiaOutbound({organizationId:input.organizationId,action:'send',id,phone,consent:true},input.actor,runtime,true);
    if (!object(result)) throw new Error('BIA_OUTBOUND_UNAVAILABLE');
    return {...result,ok:true,phone,template:'bia_boas_vindas',actionExecuted:['accepted','sent','delivered','read'].includes(String(result.status))};
  } catch (error) {
    return {ok:false,actionExecuted:false,phone,error:error instanceof Error && /^BIA_[A-Z_]+$/.test(error.message) ? error.message : 'BIA_OUTBOUND_UNAVAILABLE'};
  }
}

export function biaChatOpeningReply(result: Obj): string {
  const phone = String(result.phone||'');
  const target = /^55\d{10,11}$/.test(phone) ? `+${phone}` : 'o contato';
  if (result.status==='delivered'||result.status==='read') return `A mensagem de boas-vindas da Bia foi entregue para ${target}. Quando a pessoa responder, continuarei o atendimento por lá.`;
  if (result.status==='accepted'||result.status==='sent') return `Enviei a mensagem de boas-vindas aprovada para ${target}. A Meta aceitou o envio; a confirmação de entrega ainda está pendente. Quando a pessoa responder, continuarei o atendimento por lá.`;
  if (result.error==='BIA_CONTACT_RECENTLY_SENT') return `Já existe um envio recente para ${target}. Não repeti a mensagem.`;
  if (result.error==='BIA_CONTACT_PAUSED') return `Não enviei para ${target}: esse atendimento está pausado ou o contato pediu para não receber mensagens.`;
  if (result.needs) return 'Informe um único número com DDD no pedido, por exemplo: “Bia, envie a mensagem de boas-vindas para (34) …”.';
  if (result.status==='unknown'||result.status==='sending') return `O envio para ${target} ainda não foi confirmado. Não repeti a tentativa para evitar mensagens duplicadas.`;
  if (result.status==='failed') return `A Meta não concluiu o envio para ${target}. A falha ficou registrada na central de atendimentos.`;
  return `Não consegui concluir o envio para ${target}. Nenhuma mensagem foi confirmada; verifique a conexão e o acesso à conta da Bia.`;
}
