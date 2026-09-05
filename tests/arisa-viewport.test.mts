import assert from "node:assert/strict";
import { test } from "node:test";
import { chatViewport } from "../src/components/arisa/chat-viewport.ts";

const screen = { layoutHeight: 852, visualHeight: 852, offsetTop: 0, scale: 1, editing: false };
const full = { height: "100dvh", top: "0px", keyboard: false };

test("closed keyboard uses the entire CSS viewport even with stale startup or Safari toolbar metrics", () => {
  assert.deepEqual(chatViewport(screen), full);
  assert.deepEqual(chatViewport({ ...screen, visualHeight: 790, offsetTop: 24 }), full);
  assert.deepEqual(chatViewport({ ...screen, visualHeight: 500 }), full);
});
test("software keyboard moves the composer above the keyboard and removes the home-indicator gap", () => {
  assert.deepEqual(chatViewport({ ...screen, visualHeight: 490.4, offsetTop: 12.3, editing: true }), { height: "490px", top: "12px", keyboard: true });
  assert.deepEqual(chatViewport({ ...screen, layoutHeight: 393, visualHeight: 220, editing: true }), { height: "220px", top: "0px", keyboard: true });
});
test("closing the keyboard, blurring, or attaching a hardware keyboard restores full screen", () => {
  assert.deepEqual(chatViewport({ ...screen, editing: true }), full);
  assert.deepEqual(chatViewport({ ...screen, visualHeight: 490, editing: false }), full);
  assert.deepEqual(chatViewport({ ...screen, visualHeight: 780, editing: true }), full);
});
test("pinch zoom is preserved rather than mistaken for a software keyboard", () => {
  assert.deepEqual(chatViewport({ ...screen, visualHeight: 400, scale: 2, editing: true }), full);
  assert.deepEqual(chatViewport({ ...screen, visualHeight: 0, editing: true }), full);
});
