export type WhatsAppChannelStatus = {
  enabled?: boolean; configured?: boolean; ready?: boolean; display_phone_number?: string;
  phone_number_id?: string; graph_api_version?: string; webhook_path?: string; webhook_url?: string;
  webhook_confirmed?: boolean; webhook_verified_at?: string | null; last_inbound_at?: string | null;
  access_token_configured?: boolean; app_secret_configured?: boolean; verify_token_configured?: boolean;
};

export type WhatsAppMessage = {
  id: string; operation_id?: string | null; direction: string; content: string; contact_name?: string | null;
  phone?: string | null; occurred_at: string; status?: string | null; delivery_status?: string | null;
  template_name?: string | null; provider_message_id?: string | null;
};

export type WhatsAppTemplate = {
  name: string; language: string; category?: string; components?: unknown[];
};

export function whatsappDeliveryLabel(message: Pick<WhatsAppMessage, "direction" | "status" | "delivery_status">) {
  if (message.direction === "inbound") return "Mensagem recebida";
  if (message.delivery_status === "failed" || message.status === "failed") return "Envio recusado";
  if (message.delivery_status === "read") return "Leitura informada pelo WhatsApp";
  if (message.delivery_status === "delivered") return "Entrega confirmada";
  if (message.delivery_status === "sent" || message.status === "completed") return "Envio aceito pela Meta";
  if (message.status === "unknown") return "Resultado não confirmado";
  if (message.status === "queued" || message.delivery_status === "queued") return "Envio em andamento";
  return "Mensagem preparada";
}

export function whatsappReceptionLabel(status: WhatsAppChannelStatus) {
  if (status.last_inbound_at) return "Há mensagens recebidas registradas neste canal.";
  if (status.webhook_verified_at) return "Webhook verificado pela Meta. Ainda não há mensagens recebidas registradas.";
  if (status.webhook_confirmed) return "Cadastro do webhook informado. O recebimento ainda não foi comprovado por mensagens.";
  return "O recebimento depende do cadastro e da verificação do webhook na Meta.";
}

export function whatsappReconcileLabel(result: Record<string, unknown>) {
  if (result.delivery_status === "failed" || result.status === "failed") return "O WhatsApp informou falha neste envio. A mensagem não foi reenviada.";
  if (result.delivery_status === "read") return "O WhatsApp informou a leitura desta mensagem.";
  if (result.delivery_status === "delivered") return "A entrega desta mensagem foi confirmada.";
  if (result.delivery_status === "sent" || result.accepted_by_meta === true || result.sent_confirmed_by_meta === true) return "A Meta confirmou o aceite do envio. A entrega depende do status informado pelo WhatsApp.";
  return typeof result.message === "string" ? result.message : "O resultado ainda está em conferência. Nenhuma mensagem foi reenviada.";
}

export function whatsappTemplateText(template: WhatsAppTemplate) {
  return (template.components || []).flatMap(component => {
    if (!component || typeof component !== "object") return [];
    const value = component as Record<string, unknown>;
    return typeof value.text === "string" && value.text.trim() ? [value.text] : [];
  }).join("\n\n");
}
