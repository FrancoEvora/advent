"use client";
import { AssistantStartConversation } from '../assistants/AssistantStartConversation';
export function BiaStartConversation(props: { organizationId: string; userId: string; initialPhone?: string; onClose: (threadId?: string) => void }) {
  return <AssistantStartConversation key={props.organizationId} {...props} assistant="bia" />;
}
