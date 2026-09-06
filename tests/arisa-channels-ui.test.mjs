import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { workspacePanel, workspacePanels, workspaceUrl } from "../src/components/arisa/workspace-navigation.ts";
import { whatsappDeliveryLabel, whatsappReceptionLabel, whatsappReconcileLabel, whatsappTemplateText } from "../src/components/arisa/whatsapp-display.ts";

test("each workspace channel can be bookmarked without losing the current conversation", () => {
  const thread = "387dc95e-105b-4377-92cb-a3c8ed0f4401";
  for (const panel of workspacePanels) {
    const url = new URL(workspaceUrl(panel, thread), "https://advent-tau.vercel.app");
    assert.equal(workspacePanel(url.searchParams.get("painel")), panel);
    assert.equal(url.searchParams.get("conversa"), thread);
  }
  assert.equal(workspaceUrl("whatsapp"), "/arisa?painel=whatsapp");
  assert.equal(workspaceUrl("agenda"), "/arisa?painel=agenda");
  assert.equal(workspaceUrl(null, thread), `/arisa?conversa=${thread}`);
  assert.equal(workspacePanel(["email", "whatsapp"]), null);
  assert.equal(workspacePanel("__proto__"), null);
});

test("Meta acceptance is never presented as delivery or read confirmation", () => {
  assert.equal(whatsappDeliveryLabel({ direction: "outbound", status: "completed", delivery_status: "sent" }), "Envio aceito pela Meta");
  assert.equal(whatsappDeliveryLabel({ direction: "outbound", status: "completed", delivery_status: "delivered" }), "Entrega confirmada");
  assert.equal(whatsappDeliveryLabel({ direction: "outbound", status: "completed", delivery_status: "read" }), "Leitura informada pelo WhatsApp");
  assert.equal(whatsappDeliveryLabel({ direction: "outbound", status: "completed", delivery_status: "failed" }), "Envio recusado");
  assert.equal(whatsappDeliveryLabel({ direction: "outbound", status: "unknown", delivery_status: "queued" }), "Resultado não confirmado");
  assert.equal(whatsappDeliveryLabel({ direction: "inbound", delivery_status: "received" }), "Mensagem recebida");
});

test("configuration or a verified webhook alone never claims actual incoming messages", () => {
  assert.match(whatsappReceptionLabel({ ready: true, configured: true }), /depende/);
  assert.match(whatsappReceptionLabel({ webhook_confirmed: true }), /ainda não foi comprovado/);
  assert.match(whatsappReceptionLabel({ webhook_verified_at: "2026-09-06T12:00:00Z" }), /Ainda não há mensagens/);
  assert.match(whatsappReceptionLabel({ last_inbound_at: "2026-09-06T12:01:00Z" }), /Há mensagens recebidas registradas/);
});

test("reconciliation notices use provider evidence and prioritize failed delivery over a completed operation", () => {
  assert.match(whatsappReconcileLabel({ status: "completed", delivery_status: "failed", accepted_by_meta: true }), /falha/);
  assert.match(whatsappReconcileLabel({ status: "completed" }), /ainda está em conferência/);
  assert.match(whatsappReconcileLabel({ status: "completed", accepted_by_meta: true }), /aceite do envio/);
  assert.match(whatsappReconcileLabel({ delivery_status: "delivered" }), /entrega.*confirmada/);
});

test("approved template previews preserve meaningful text and placeholders, never interpolate arbitrary objects", () => {
  const rendered = whatsappTemplateText({ name: "reuniao", language: "pt_BR", components: [
    { type: "HEADER", text: "Reunião da Évora" },
    { type: "BODY", text: "Olá, {{1}}. Reunião em {{2}}.\nMeet: {{3}}" },
    { type: "BUTTONS", buttons: [{ type: "URL", url: "https://example.org" }] }, null, { text: { unsafe: true } },
  ] });
  assert.equal(rendered, "Reunião da Évora\n\nOlá, {{1}}. Reunião em {{2}}.\nMeet: {{3}}");
  assert.equal(whatsappTemplateText({ name: "midia", language: "pt_BR" }), "");
});

test("workspace mounts dedicated channels and WhatsApp never changes the shared Bia runtime", () => {
  const source = readFileSync("src/components/arisa/ArisaWhatsAppPanel.tsx", "utf8");
  assert.doesNotMatch(source, /configure_whatsapp_runtime|\.rpc\(|access_token_vault|app_secret_vault/);
  assert.match(source, /action: "list"/);
  assert.match(source, /operation_id: message.operation_id/);
  assert.match(source, /webhook_confirmed:/);
  assert.match(source, /A conferência não reenvia a mensagem/);
  const workspace = readFileSync("src/components/arisa/ArisaWorkspace.tsx", "utf8");
  assert.match(workspace, /tab === "whatsapp" \? <ArisaWhatsAppPanel/);
  assert.match(workspace, /tab === "email" \|\| tab === "agenda"/);
  assert.match(workspace, /if \(tab !== "archive" && tab !== "memory"\) return/);
});
