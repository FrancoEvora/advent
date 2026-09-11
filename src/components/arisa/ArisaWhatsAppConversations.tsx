"use client";
import AssistantWhatsAppPanel from '../assistants/AssistantWhatsAppPanel';
export default function ArisaWhatsAppConversations(props: { organizationId: string; userId: string }) {
  return <AssistantWhatsAppPanel key={props.organizationId} {...props} assistant="arisa" />;
}
