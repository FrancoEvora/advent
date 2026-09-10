# Bia: authenticated commercial manager

/bia renders the same ArisaChat, shared workspace, notifications, files, recorder, transcription and speech controls as /arisa. /atendimento/solaris redirects existing iPhone bookmarks to /bia; incoming customer WhatsApp continues through enterprise-bia-agent-gateway. The operator page requires an active organization administrator.

The persisted assistant column identifies each private thread. Existing threads default to arisa, new threads use assistant_chat_create_thread. No customer history or Arisa conversation is copied into a Bia thread. Archives preserve channel and assistant provenance. Organization knowledge, corporate email and calendar retain their actual sources and connected account.

arisa-manager derives identity from the caller-visible stored thread, never from request-body claims. Bia receives all existing administrative tools plus canonical commercial simulations. Queries and mutations use the caller token and existing organization/lease/revision checks. Text and transcribed audio run through this identical path.

Bia's WhatsApp tool always uses bia_whatsapp_inbox and bia_whatsapp_outbound_admin, never the Arisa channel. An explicit current instruction and a supplied phone or unique fully named CRM lead are required to start a conversation. The approved bia_boas_vindas template, opt-out/pause, rate limits, durable idempotency and uncertain-send handling remain enforced. A direct chat request needs no review link or second confirmation. Customer replies continue through Bia's automatic WhatsApp pipeline.

Validation: shared UI/tool parity, CRM tool loop, server identity and authorization, recipient grounding, duplicate-send protection, canonical simulation kernel, TypeScript, Deno, full production build and transactionally rolled-back database checks for thread separation, archive attribution, a real simulation and foreign-organization denial. No customer messages are sent by these tests.
