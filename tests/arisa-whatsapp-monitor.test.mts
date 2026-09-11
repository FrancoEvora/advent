import assert from "node:assert/strict";
import test from "node:test";
import { conversationSearch, mergeMonitorMessages, monitorMessageText, recoverMonitorGap, type MonitorMessage } from "../src/components/arisa/whatsapp-monitor.ts";
import { assistantWorkspacePanels, workspaceLabel, workspaceUrl } from "../src/components/arisa/workspace-navigation.ts";

const message = (id: number, status = "sent"): MonitorMessage => ({ id: String(id).padStart(4, "0"), direction: "outbound", content: `Mensagem ${id}`, occurred_at: "2026-09-10T10:00:00.000Z", delivery_status: status });

test("delivery updates replace rows, preserve older history and keep stable ordering for equal timestamps", () => {
  const before = [message(1), message(3)];
  const after = mergeMonitorMessages(before, [message(3, "read"), message(2)]);
  assert.deepEqual(after.map(row => row.id), ["0001", "0002", "0003"]);
  assert.equal(after[2].delivery_status, "read");
  assert.equal(before[1].delivery_status, "sent");
});

test("resume fills a gap larger than one page, including messages with identical timestamps", async () => {
  const all = Array.from({ length: 130 }, (_, index) => message(index + 1)).reverse();
  let calls = 0;
  const rows = await recoverMonitorGap(message(10), all.slice(0, 50), async cursor => { calls++; return all.filter(row => row.id < cursor.id).slice(0, 50); });
  const merged = mergeMonitorMessages(Array.from({ length: 10 }, (_, index) => message(index + 1)), rows);
  assert.equal(calls, 2); assert.equal(merged.length, 130);
  assert.equal(merged[0].id, "0001"); assert.equal(merged.at(-1)?.id, "0130");
});

test("ordinary refresh needs no additional pagination request", async () => {
  let calls = 0;
  await recoverMonitorGap(message(10), [message(12), message(11), message(10)], async () => { calls++; return []; });
  assert.equal(calls, 0);
});

test("phone search accepts formatted numbers and names treat wildcard characters literally", () => {
  assert.deepEqual(conversationSearch(" +55 (34) 99999-0001 "), { column: "phone", pattern: "%5534999990001%" });
  assert.deepEqual(conversationSearch("Ana_100%"), { column: "contact_name", pattern: "%Ana\\_100\\%%" });
});

test("monitor is an Arisa menu option and never opens the Arisa channel from Bia", () => {
  assert.ok(assistantWorkspacePanels("arisa").includes("whatsapp-conversations"));
  assert.ok(!assistantWorkspacePanels("bia").includes("whatsapp-conversations"));
  assert.equal(workspaceLabel("whatsapp", "bia", true), "Conversas da Bia");
  assert.equal(workspaceLabel("whatsapp-conversations", "arisa", true), "Conversas da Arisa via WhatsApp");
  assert.equal(workspaceUrl("whatsapp-conversations"), "/arisa?painel=whatsapp-conversations");
});

test("media without stored text is identified without fabricating a transcription", () => {
  assert.equal(monitorMessageText({ content: "", message_type: "audio" }), "Áudio recebido");
  assert.equal(monitorMessageText({ content: "Texto recebido", message_type: "text" }), "Texto recebido");
});
