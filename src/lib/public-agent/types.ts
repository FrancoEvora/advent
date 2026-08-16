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
  selected_unit_code?: string | null;
  house_style?: string | null;
  bedrooms?: number | null;
  lead_score?: number;
  summary?: string;
};

export type PublicAgentContactCapture = {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  collecting?: boolean;
};

export type PublicAgentTheme = {
  accent?: string;
  accentStrong?: string;
  navy?: string;
  background?: string;
  quickReplies?: string[];
  trustItems?: string[];
  privacyNotice?: string;
  visualMode?: "immersive" | "classic";
  voice?: string;
  voiceEnabled?: boolean;
  autoSpeak?: boolean;
  avatarMotion?: boolean;
  capabilities?: string[];
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
  contactCapture?: PublicAgentContactCapture;
  contactConsented?: boolean;
  converted: boolean;
  leadProtocol: string | null;
  experience: PublicAgentExperience;
  messages: PublicAgentMessage[];
};

export type PublicAgentCommercialUnit = {
  unitCode: string;
  blockCode?: string | null;
  lotNumber?: string | null;
  area?: number | null;
  frontage?: number | null;
  depth?: number | null;
  corner?: boolean;
  topography?: string | null;
  orientation?: string | null;
  listPrice?: number | null;
  pricePerSqm?: number | null;
  updatedAt?: string | null;
};

export type PublicAgentCommercialPayload = {
  realTime?: boolean;
  asOf?: string | null;
  project?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  policy?: Record<string, unknown> | null;
  units?: PublicAgentCommercialUnit[];
};

export type PublicAgentDocument = {
  id: string;
  title: string;
  description?: string | null;
  category: string;
  sourceType: "text" | "file";
  mimeType?: string | null;
  bytes?: number | null;
  projectId?: string | null;
  updatedAt?: string | null;
  url?: string | null;
};

export type PublicAgentGeneratedAsset = {
  id: string;
  kind: "house_simulation" | "document_preview" | "other";
  url: string;
  mimeType: string;
  promptSummary?: string | null;
  createdAt?: string;
};

export type PublicAgentReply = {
  reply: string;
  stage: PublicAgentStage;
  profile: PublicAgentProfile;
  contactCapture?: PublicAgentContactCapture;
  contactConsented?: boolean;
  requestContact: boolean;
  handoffRequested: boolean;
  quickReplies: string[];
  factsUsed: string[];
  riskFlags: string[];
  commercialAction?: string;
  commercial?: PublicAgentCommercialPayload | null;
  documents?: PublicAgentDocument[];
  imageBrief?: string | null;
  generatedAsset?: PublicAgentGeneratedAsset | null;
  converted?: boolean;
  leadProtocol?: string | null;
  agentResponseId: string | null;
  supervisorResponseId: string | null;
  supervisorDecision: "approve" | "revise" | "block";
};
