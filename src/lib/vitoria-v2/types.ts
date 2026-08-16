export type VitoriaStage =
  | "welcome"
  | "discovery"
  | "qualification"
  | "contact"
  | "handoff"
  | "completed";

export type VitoriaPresenceState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "success";

export type VitoriaProfile = {
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
  house_style?: string | null;
  house_floors?: number | null;
  house_bedrooms?: number | null;
  house_suites?: number | null;
  house_notes?: string | null;
  contact_name?: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
  contact_city?: string | null;
  contact_consent?: boolean | null;
  contact_consent_requested?: boolean | null;
  marketing_consent?: boolean | null;
  lead_score?: number;
  summary?: string;
};

export type VitoriaAvatarConfig = {
  mode?: "animated_svg" | "image" | "video";
  displayName?: string;
  subtitle?: string;
  voice?: string;
  imageUrl?: string | null;
  videoUrl?: string | null;
};

export type VitoriaCapabilities = {
  voiceInput?: boolean;
  voiceOutput?: boolean;
  documentPresentation?: boolean;
  houseSimulation?: boolean;
  enterpriseCommercialData?: boolean;
  inChatContactCapture?: boolean;
  humanHandoff?: boolean;
};

export type VitoriaTheme = {
  accent?: string;
  accentSecondary?: string;
  gold?: string;
  background?: string;
  quickReplies?: string[];
  privacyNotice?: string;
};

export type VitoriaExperience = {
  slug: string;
  name: string;
  agentName: string;
  title: string;
  subtitle: string;
  eyebrow: string;
  greetingText?: string | null;
  heroImageUrl?: string | null;
  avatar?: VitoriaAvatarConfig;
  capabilities?: VitoriaCapabilities;
  theme?: VitoriaTheme;
};

export type VitoriaResource = {
  id: string;
  type: "document" | "image" | "link" | "house_simulation";
  title: string;
  description?: string | null;
  url?: string | null;
  mimeType?: string | null;
  thumbnailUrl?: string | null;
  disclaimer?: string | null;
};

export type VitoriaMessage = {
  id: string | number;
  direction: "user" | "assistant" | "system";
  content: string;
  resources?: VitoriaResource[];
  createdAt?: string;
};

export type VitoriaSession = {
  sessionId: string;
  stage: VitoriaStage;
  profile: VitoriaProfile;
  converted: boolean;
  leadProtocol?: string | null;
  experience: VitoriaExperience;
  messages: VitoriaMessage[];
  generatedAssets?: VitoriaResource[];
};

export type VitoriaReply = {
  reply: string;
  stage: VitoriaStage;
  profile: VitoriaProfile;
  quickReplies: string[];
  resources: VitoriaResource[];
  requestContact: boolean;
  handoffRequested: boolean;
  contactCaptured: boolean;
  protocol?: string | null;
  presenceHint?: VitoriaPresenceState;
  degraded?: boolean;
};
