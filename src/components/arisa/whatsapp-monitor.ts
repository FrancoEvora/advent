import type { WhatsAppMessage } from "./whatsapp-display";

export type MonitorMessage = WhatsAppMessage & { message_type?: string; thread_id?: string };
export type WhatsAppConversation = {
  id: string; phone: string; contact_name: string | null; last_message_at: string | null;
  last_inbound_at: string | null; opted_out_at: string | null;
  arisa_whatsapp_messages: MonitorMessage[];
};

export function conversationSearch(value: string) {
  const text = value.trim().slice(0, 100);
  const phone = !/[\p{L}]/u.test(text) ? text.replace(/\D/g, "") : "";
  return { column: phone ? "phone" : "contact_name", pattern: `%${(phone || text).replace(/[\\%_]/g, "\\$&")}%` };
}

// New delivery states replace the previous row without duplicating a message.
export function mergeMonitorMessages(previous: MonitorMessage[], incoming: MonitorMessage[]) {
  const messages = new Map(previous.map(message => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  return [...messages.values()].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id));
}

export function olderMessagesFilter(message: Pick<MonitorMessage, "id" | "occurred_at">) {
  return `occurred_at.lt.${message.occurred_at},and(occurred_at.eq.${message.occurred_at},id.lt.${message.id})`;
}

function compareMessages(a: MonitorMessage, b: MonitorMessage) {
  return a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id);
}

// Resuming after many new messages must not leave a hole between loaded history and the latest page.
export async function recoverMonitorGap(previousNewest: MonitorMessage | null, recent: MonitorMessage[], fetchOlder: (cursor: MonitorMessage) => Promise<MonitorMessage[]>) {
  let cursor = recent.at(-1);
  const recovered = [...recent];
  while (previousNewest && cursor && compareMessages(cursor, previousNewest) > 0) {
    const rows = await fetchOlder(cursor);
    const next = rows.at(-1);
    if (!next || compareMessages(next, cursor) >= 0) break;
    recovered.push(...rows); cursor = next;
  }
  return recovered;
}

export function monitorMessageText(message: Pick<MonitorMessage, "content" | "message_type">) {
  if (message.content?.trim()) return message.content;
  const labels: Record<string, string> = { audio: "Áudio recebido", image: "Imagem recebida", video: "Vídeo recebido", document: "Documento recebido", sticker: "Figurinha recebida", location: "Localização recebida", contacts: "Contato compartilhado" };
  return labels[message.message_type || ""] || "Mensagem sem conteúdo de texto.";
}
