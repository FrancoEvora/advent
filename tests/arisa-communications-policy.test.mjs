import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const manager=()=>readFileSync("supabase/functions/_shared/arisa-manager.ts","utf8");
const calendar=()=>readFileSync("supabase/functions/_shared/arisa-calendar.ts","utf8");
const runtime=()=>readFileSync("supabase/functions/_shared/arisa-whatsapp-runtime.ts","utf8");
const whatsapp=()=>readFileSync("supabase/functions/_shared/arisa-whatsapp.ts","utf8");
const panel=()=>readFileSync("src/components/arisa/ArisaMailPanel.tsx","utf8");
const whatsappPanel=()=>readFileSync("src/components/arisa/ArisaWhatsAppPanel.tsx","utf8");

test("Arisa exposes the official WhatsApp channel and 24h/template rule",()=>{
  assert.match(manager(),/tool\("whatsapp"/);
  assert.match(manager(),/24h/);
  assert.match(manager(),/template APPROVED/);
  assert.match(whatsapp(),/WHATSAPP_TEMPLATE_REQUIRED/);
  assert.match(runtime(),/approvedTemplates/);
  assert.match(whatsapp(),/graph\.facebook\.com/);
});

test("external calendar invitations cannot be empty",()=>{
  assert.match(calendar(),/CALENDAR_DESCRIPTION_REQUIRED/);
  assert.match(calendar(),/result\.attendees\.length > 0/);
  assert.match(manager(),/não envie e-mail vazio/i);
  assert.match(manager(),/meet_url real/);
});

test("uncertain WhatsApp sends are never retried as new messages",()=>{
  const source=runtime();
  assert.match(source,/status==="unknown"/);
  assert.match(source,/Não reenviar automaticamente/);
  assert.match(source,/reconcile/);
});

test("communications workspace exposes Calendar, Meet, Gmail and WhatsApp controls",()=>{
  assert.match(panel(),/ArisaCalendarPanel/);
  assert.match(panel(),/ArisaWhatsAppPanel/);
  assert.match(whatsappPanel(),/WhatsApp da Arisa/);
  assert.match(whatsappPanel(),/templates aprovados/i);
  assert.match(whatsappPanel(),/enterprise-whatsapp-webhook/);
});
