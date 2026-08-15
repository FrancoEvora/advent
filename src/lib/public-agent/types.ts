export type PublicAgentStage =
  | "welcome"
  | "discovery"
  | "qualification"
  | "contact"
  | "handoff"
  | "completed";

export type PublicAgentProfile = {
  intent?: "morar" | "investir" | "conhecer" | "unknown";
  budget_min?: number | null;
  budget_max?: number | null;
  preferred_area_min?: number | null;
  preferred_area_max?: number | null;
  purchase_horizon?:
    | "ate_3_meses"
    | "3_a_6_meses"
    | "6_a_12_meses"
    | "mais_de_12_meses"
    | "unknown";
  preferred_city?: string | null;
  financing_interest?: boolean | null;
  payment_capacity?: number | null;
  visit_interest?: boolean | null;
  lead_score?: number;
  summary?: string;
};

export type PublicAgentTheme = {
  accent?: string;
  accentStrong?: string;
  navy?: string;
  background?: string;
  quickReplies?: string[];
  trustItems?: string[];
  privacyNotice?: string;
};

export type PublicAgentExperience = {
  slug: string;
  name: string;
  agentName: string;
  title: string;
  subtitle: string;
  eyebrow: string;
  heroImageUrl: string | null;
  theme: PublicAgentTheme;
};

export type PublicAgentMessage = {
  id: number | string;
  direction: "user" | "assistant" | "system";
  content: string;
  created_at?: string;
};

export type PublicAgentSessionPayload = {
  sessionId: string;
  stage: PublicAgentStage;
  profile: PublicAgentProfile;
  converted: boolean;
  leadProtocol: string | null;
  experience: PublicAgentExperience;
  messages: PublicAgentMessage[];
};

export type PublicAgentContextPayload = {
  organizationId: string;
  sessionId: string;
  stage: PublicAgentStage;
  profile: PublicAgentProfile;
  converted: boolean;
  knowledge: {
    approvedFacts?: string[];
    guardrails?: string[];
    qualificationFields?: string[];
  };
  experience: PublicAgentExperience;
  messages: PublicAgentMessage[];
};

export type PublicAgentReply = {
  reply: string;
  stage: PublicAgentStage;
  profile: PublicAgentProfile;
  requestContact: boolean;
  handoffRequested: boolean;
  quickReplies: string[];
  factsUsed: string[];
  riskFlags: string[];
  agentResponseId: string | null;
  supervisorResponseId: string | null;
  supervisorDecision: "approve" | "revise" | "block";
};
