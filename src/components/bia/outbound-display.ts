export const biaDeliveryLabel: Record<string, string> = {
  sending: 'Enviando…', accepted: 'Aceita pela Meta', sent: 'Enviada', delivered: 'Entregue', read: 'Lida',
  failed: 'Falha no envio', unknown: 'Aguardando confirmação', not_found: 'Envio ainda não registrado',
};
export function biaOutboundError(code: string | null | undefined): string {
  const messages: Record<string, string> = {
    BIA_AUTH_REQUIRED: 'Entre novamente na central da Bia.',
    BIA_OUTBOUND_FORBIDDEN: 'Somente administradores ativos podem iniciar conversas.',
    BIA_RECIPIENT_NAME_INVALID: 'Informe um nome com até 80 caracteres, sem números ou símbolos especiais.',
    BIA_PHONE_INVALID: 'Informe um número brasileiro válido, com DDD.',
    BIA_CHANNEL_DISABLED: 'O canal da Bia precisa estar ativo e verificado.',
    BIA_TEMPLATE_UNAVAILABLE: 'Não foi possível consultar o modelo na Meta. Tente atualizar a mensagem.',
    BIA_TEMPLATE_NOT_APPROVED: 'A Meta ainda não liberou este modelo para envio.',
    BIA_TEMPLATE_CHANGED: 'O modelo mudou. Atualize a mensagem e confira o texto antes de enviar.',
    BIA_CONTACT_PAUSED: 'Este contato está pausado ou pediu para não receber mensagens.',
    BIA_CONTACT_RECENTLY_SENT: 'Este contato já recebeu uma abertura nas últimas 24 horas. Consulte o histórico.',
    BIA_SEND_RATE_LIMIT: 'Aguarde um minuto antes de iniciar outra conversa.',
    BIA_SELF_RECIPIENT: 'Informe o número do cliente, diferente do WhatsApp da Bia.',
    BIA_SESSION_INACTIVE: 'Este atendimento está encerrado ou bloqueado. Consulte a equipe responsável.',
    BIA_REQUEST_CHANGED: 'Os dados deste envio mudaram. Consulte o histórico antes de tentar novamente.',
    META_131042: 'A Meta apontou uma pendência de pagamento na conta do WhatsApp.',
    META_131026: 'A Meta não conseguiu entregar a mensagem a este número.',
    META_131049: 'A Meta limitou a entrega desta mensagem de marketing ao destinatário.',
    META_132001: 'A Meta não encontrou o modelo aprovado neste idioma.',
    META_190: 'A credencial do WhatsApp precisa ser renovada.',
    SEND_UNCONFIRMED: 'Ainda não houve confirmação. Consulte o status antes de fazer outro envio.',
  };
  if (!code) return '';
  return messages[code] || messages['META_' + code] || (/^(META_)?\d+$/.test(code) ? `A Meta informou uma falha (${code.replace('META_', '')}).` : 'Não foi possível concluir a operação. Consulte o status antes de tentar novamente.');
}
