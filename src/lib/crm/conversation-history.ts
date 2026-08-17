export type CrmConversationChannel =
  | "site"
  | "whatsapp"
  | "instagram"
  | "facebook"
  | "email"
  | "internal";

export type CrmConversationSummary = {
  id: string;
  channel: CrmConversationChannel;
  status: string;
  aiEnabled: boolean;
  assignedUserId: string | null;
  startedAt: string;
  lastMessageAt: string | null;
  humanTakeoverAt: string | null;
  closedAt: string | null;
};

export type CrmConversationAttachment = {
  id: string | null;
  type: "document" | "image" | "project";
  title: string;
  description: string | null;
  url: string | null;
  mimeType: string | null;
  badge: string | null;
  disclaimer: string | null;
};

export type CrmConversationAudio = {
  url: string;
  mimeType: string | null;
  durationSeconds: number | null;
};

export type CrmConversationSimulationScenario = {
  months: number;
  monthlyPayment: number;
};

export type CrmConversationSimulation = {
  projectName: string | null;
  unitCode: string | null;
  price: number | null;
  downPayment: number | null;
  balloonCount: number | null;
  balloonAmount: number | null;
  scenarios: CrmConversationSimulationScenario[];
};

export type CrmConversationMessage = {
  id: string;
  conversationId: string;
  direction: "inbound" | "outbound" | "internal";
  actorType: "lead" | "ai" | "human" | "system";
  channel: CrmConversationChannel;
  content: string;
  deliveryStatus: string;
  occurredAt: string;
  audio: CrmConversationAudio | null;
  attachments: CrmConversationAttachment[];
  simulation: CrmConversationSimulation | null;
};

export type CrmConversationHistoryResponse = {
  conversations: CrmConversationSummary[];
  messages: CrmConversationMessage[];
  pagination: {
    pageSize: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
};
