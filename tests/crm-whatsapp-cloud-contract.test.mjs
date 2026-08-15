import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const foundation=readFileSync(new URL("../supabase/migrations/20260815000500_crm_whatsapp_cloud_foundation.sql",import.meta.url),"utf8");
const delivery=readFileSync(new URL("../supabase/migrations/20260815001000_crm_whatsapp_message_delivery.sql",import.meta.url),"utf8");
const claim=readFileSync(new URL("../supabase/migrations/20260815001500_crm_whatsapp_send_claim.sql",import.meta.url),"utf8");
const context=readFileSync(new URL("../supabase/migrations/20260815002000_crm_whatsapp_inbound_context.sql",import.meta.url),"utf8");
const webhook=readFileSync(new URL("../src/app/api/integrations/whatsapp/webhook/route.ts",import.meta.url),"utf8");
const send=readFileSync(new URL("../src/app/api/integrations/whatsapp/send/route.ts",import.meta.url),"utf8");
const server=readFileSync(new URL("../src/lib/integrations/whatsapp/server.ts",import.meta.url),"utf8");

const all=[foundation,delivery,claim,context,webhook,send,server].join("\n");

test("WhatsApp secrets remain server-side and Vault-backed",()=>{
  assert.match(foundation,/vault\.create_secret/i);
  assert.match(foundation,/access_token_vault_id/i);
  assert.doesNotMatch(all,/NEXT_PUBLIC_[A-Z0-9_]*WHATSAPP/i);
});

test("webhook preserves Meta HMAC and delegates receiver binding to secure Edge runtime",()=>{
  assert.match(webhook,/enterprise-whatsapp-webhook/);
  assert.match(webhook,/x-hub-signature-256/i);
  assert.match(webhook,/headers\.set\("x-hub-signature-256", signature\)/i);
  assert.match(foundation,/get_whatsapp_runtime_by_phone_number_id/i);
  assert.match(foundation,/phone_number_id=trim\(p_phone_number_id\)/i);
});

test("inbound messages are idempotent and enqueue message_received after persistence",()=>{
  assert.match(foundation,/crm_messages_provider_message_uidx/);
  const insertIndex=foundation.indexOf("insert into public.crm_messages");
  const enqueueIndex=foundation.indexOf("'message_received'");
  assert.ok(insertIndex>=0&&enqueueIndex>insertIndex);
  assert.match(foundation,/whatsapp-inbound:'\|\|trim\(p_provider_message_id\)/i);
});

test("WhatsApp-created leads do not receive a competing lead_created job",()=>{
  assert.match(foundation,/source_channel,''\) in \('meta_lead_ads','whatsapp_inbound'\)/i);
});

test("human takeover blocks AI continuation",()=>{
  assert.match(foundation,/status='human_active' then false/i);
  assert.match(foundation,/c\.ai_enabled=true and c\.status<>'human_active'/i);
});

test("supervised outbound is permissioned, fenced and DNC-safe",()=>{
  assert.match(send,/crm\.copilot\.approve_send/);
  assert.match(claim,/delivery_status='queued'/i);
  assert.match(claim,/do_not_contact_at is not null/i);
  assert.match(claim,/denied','revoked/i);
  assert.match(send,/release_whatsapp_send_claim/);
});

test("Cloud API transport is server-only and uses Phone Number ID messages endpoint",()=>{
  assert.match(server,/graph\.facebook\.com/);
  assert.match(server,/phoneNumberId\)\}\/messages/);
  assert.match(server,/Authorization: `Bearer/);
});

test("provider delivery status cannot regress",()=>{
  assert.match(delivery,/rank_current/i);
  assert.match(delivery,/rank_new>rank_current/i);
});

test("customer inbound text is captured into the CRM context before agent analysis",()=>{
  assert.match(context,/Mensagem recebida no WhatsApp:/);
  assert.match(context,/first_response_at=coalesce/i);
  assert.match(context,/crm_messages_whatsapp_inbound_context/i);
});
