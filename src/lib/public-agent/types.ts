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
  metadata?: Record<string, unknown>;
  created_at?: string;
};

export type PublicAgentAudio = {
  url: string;
  mimeType: string;
  durationSeconds: number;
};

export type PublicAgentSessionPayload = {
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

export type PublicAgentAttachment = {
  type: "document" | "image" | "project";
  id?: string;
  title: string;
  description?: string | null;
  url?: string | null;
  mimeType?: string | null;
  badge?: string | null;
  disclaimer?: string | null;
  metadata?: Record<string, unknown>;
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

export type PublicAgentCommercialContext = {
  realTime?: boolean;
  asOf?: string | null;
  project?: {
    name?: string | null;
    slug?: string | null;
  } | null;
  summary?: {
    availableCount?: number | null;
    minimumArea?: number | null;
    maximumArea?: number | null;
    minimumPrice?: number | null;
    maximumPrice?: number | null;
  } | null;
  policy?: {
    name?: string | null;
    description?: string | null;
    minimumDownPaymentPct?: number | null;
    maximumInstallments?: number | null;
    monthlyInterestRate?: number | null;
    indexer?: string | null;
    reservationValidityHours?: number | null;
    parameters?: Record<string, unknown>;
  } | null;
  units?: PublicAgentCommercialUnit[];
};

export type PublicAgentSimulation = {
  projectName: string;
  unitCode: string;
  area: number | null;
  price: number;
  minimumDownPaymentPct: number;
  minimumDownPaymentApplied: boolean;
  downPaymentPct: number;
  downPayment: number;
  downPaymentInstallments: number;
  downPaymentInstallmentAmount: number;
  downPaymentInterestRate: number;
  balloonCount: number;
  balloonAmount: number;
  balloonFrequencyMonths: number;
  monthlyInterestRate: number;
  indexer: string;
  calculationMethod: "PRICE";
  scenarios: Array<{
    months: number;
    monthlyPayment: number;
    financedAmount: number;
    balloonTotal: number;
  }>;
  generatedAt: string;
  disclaimer: string;
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

export type PublicAgentTurnResponse = {
  status: "processing" | "completed";
  requestId?: string;
  clientMessageId?: string;
  retryAfterMs?: number;
  reply?: string;
  stage?: PublicAgentStage;
  profile?: PublicAgentProfile;
  contactCapture?: Record<string, unknown>;
  serviceConsented?: boolean;
  marketingConsented?: boolean;
  requestContact?: boolean;
  handoffRequested?: boolean;
  quickReplies?: string[];
  action?: string;
  selectedUnitCode?: string | null;
  commercial?: PublicAgentCommercialContext | null;
  simulation?: PublicAgentSimulation | null;
  attachments?: PublicAgentAttachment[];
  holdStatus?: Record<string, unknown> | null;
  converted?: boolean;
  leadProtocol?: string | null;
  degraded?: boolean;
  revision?: number;
};

export type PublicAgentTranscriptionResponse = {
  status: "processing" | "completed";
  requestId?: string;
  clientMessageId?: string;
  retryAfterMs?: number;
  text?: string;
  audio?: PublicAgentAudio;
};

export type PublicAgentAction = "experience" | "session" | "message" | "transcribe";
