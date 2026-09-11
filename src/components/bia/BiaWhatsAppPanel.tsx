"use client";
import AssistantWhatsAppPanel from '../assistants/AssistantWhatsAppPanel';
export default function BiaWhatsAppPanel(props: { organizationId: string; userId: string }) {
  return <AssistantWhatsAppPanel key={props.organizationId} {...props} assistant="bia" />;
}
