import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const component = readFileSync(
  new URL("../src/components/public-agent/PublicAgentExperience.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../src/app/styles/v6-26-public-agent.css", import.meta.url),
  "utf8",
);

test("mobile chat locks the document and follows the iOS visual viewport", () => {
  assert.match(component, /classList\.add\("public-agent-active"\)/);
  assert.match(component, /--public-agent-viewport-height/);
  assert.match(component, /--public-agent-viewport-width/);
  assert.match(component, /--public-agent-viewport-top/);
  assert.match(styles, /html\.public-agent-active,body\.public-agent-active\{[^}]*overflow:hidden/);
  assert.match(styles, /\.public-agent-page\{position:fixed;top:var\(--public-agent-viewport-top/);
});

test("only the message history receives vertical conversation scrolling", () => {
  assert.match(component, /ref=\{messagesRef\}[\s\S]{0,400}className="public-agent-messages"/);
  assert.match(component, /messagesPane\.scrollTo\(\{ top: messagesPane\.scrollHeight/);
  assert.doesNotMatch(component, /scrollIntoView/);
  assert.match(styles, /\.public-agent-messages\{[^}]*overflow-y:auto/);
  assert.match(styles, /\.public-agent-messages\{[^}]*overscroll-behavior-y:contain/);
  assert.match(styles, /\.public-agent-messages\{[^}]*touch-action:pan-y/);
});
