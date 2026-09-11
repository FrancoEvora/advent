import { biaDeliveryLabel, biaOutboundError } from '../bia/outbound-display';

export type WhatsAppThread = { id: string; peer_phone: string; customer_name: string | null; human_requested: boolean; opted_out_at: string | null; crm_record_id: string | null; last_activity_at?: string; last_message?: string; delivery_status?: string };
export type WhatsAppInbox = { enabled: boolean; verified: boolean; phone: string; threads: WhatsAppThread[]; selected: WhatsAppThread | null; total: number; message_total: number; updated_at: string; messages: { id: string; direction: string; content: string; delivery_status: string; error_code: string | null; occurred_at: string }[] };

// The UI is shared, but all data and operations remain bound to the selected assistant.
export function channelDetails(assistant: 'arisa' | 'bia') {
  return assistant === 'arisa'
    ? { name: 'Arisa', monitor: 'arisa_whatsapp_monitor', control: 'arisa_whatsapp_inbox', outbound: 'arisa-whatsapp' }
    : { name: 'Bia', monitor: 'bia_whatsapp_monitor', control: 'bia_whatsapp_inbox', outbound: 'bia-whatsapp-outbound' };
}
export const deliveryLabel: Record<string,string> = { ...biaDeliveryLabel, prepared: 'Mensagem preparada', queued: 'Enviando…', received: 'Recebida' };
export function outboundError(assistant: 'arisa' | 'bia', code: string | null | undefined): string {
  if (assistant === 'bia' || !code || /^(META_)?\d+$/.test(code)) return biaOutboundError(code);
  const messages: Record<string,string> = {
    SESSION_REQUIRED: 'Entre novamente na central da Arisa.', SESSION_EXPIRED: 'Entre novamente na central da Arisa.',
    ADMIN_REQUIRED: 'Somente administradores ativos podem iniciar conversas.',
    WHATSAPP_PHONE_INVALID: 'Informe o WhatsApp com DDD e código do país.',
    WHATSAPP_CONTACT_BLOCKED: 'Este contato está bloqueado ou pediu para não receber mensagens.',
    WHATSAPP_CONTACT_PHONE_MISMATCH: 'O telefone informado difere do cadastro do contato.',
    WHATSAPP_NOT_CONFIGURED: 'O canal da Arisa precisa estar ativo e verificado.',
    WHATSAPP_TEMPLATE_NOT_FOUND: 'A mensagem inicial em português ainda não está aprovada. Atualize a mensagem para conferir.',
    WHATSAPP_TEMPLATE_CHANGED: 'O modelo mudou. Atualize a mensagem e confira o texto antes de enviar.',
    WHATSAPP_REQUEST_CHANGED: 'Este pedido já foi registrado. Consulte o status antes de iniciar outro.',
    WHATSAPP_CONSENT_REQUIRED: 'Confirme que o contato autorizou receber mensagens pelo WhatsApp.',
    WHATSAPP_SELF_RECIPIENT: 'Informe um destinatário diferente do número da Arisa.',
    WHATSAPP_INVALID: 'Confira os dados do destinatário antes de enviar.',
    WHATSAPP_UNDELIVERABLE: 'A Meta não conseguiu entregar a mensagem a este destinatário.',
  };
  return messages[code] || 'A operação não foi confirmada. Consulte o status antes de tentar novamente.';
}
