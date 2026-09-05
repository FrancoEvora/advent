import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const manifest = JSON.parse(read("../public/arisa/manifest.webmanifest"));
const page = read("../src/app/arisa/page.tsx");
const css = read("../src/app/styles/v6-29-arisa-chat.css");

test("Arisa installs as a distinct app and starts at the complete chat address", () => {
  assert.equal(manifest.id, "/arisa");
  assert.equal(manifest.start_url, "/arisa");
  assert.equal(manifest.scope, "/arisa");
  assert.equal(manifest.short_name, "Arisa");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.start_url.startsWith(manifest.scope));
  assert.ok(!manifest.start_url.includes("conversa="), "Installation must not pin a private conversation");
  assert.match(page, /manifest: "\/arisa\/manifest\.webmanifest"/);
  assert.equal(JSON.parse(read("../public/manifest.webmanifest")).start_url, "/", "ERP install remains unchanged");
});

test("iPhone installation receives dedicated app metadata and PNG icons", () => {
  assert.match(page, /appleWebApp: \{ capable: true, title: "Arisa", statusBarStyle: "black-translucent" \}/);
  assert.match(page, /viewportFit: "cover"/);
  assert.match(page, /themeColor: "#075e54"/);
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  assert.equal(manifest.icons[0].src, "/arisa/icon");
  assert.equal(manifest.icons[0].type, "image/png");
  assert.equal(manifest.icons[0].sizes, "512x512");
  assert.match(read("../src/app/arisa/icon.tsx"), /width: 512, height: 512/);
  assert.match(read("../src/app/arisa/apple-icon.tsx"), /width: 180, height: 180/);
});

test("standalone chat respects iPhone cutouts and the home indicator", () => {
  assert.match(css, /\.arisa-chat \.public-agent-chat-head\{[^}]*safe-area-inset-top/);
  assert.match(css, /\.arisa-chat \.arisa-login-footer\{[^}]*safe-area-inset-bottom/);
  assert.match(css, /\.arisa-chat \.arisa-conversations\{[^}]*safe-area-inset-top[^}]*safe-area-inset-bottom/);
  assert.match(css, /\.arisa-chat \.public-agent-shell\{[^}]*safe-area-inset-left[^}]*safe-area-inset-right/);
  assert.match(read("../src/app/styles/v6-27-bia-whatsapp.css"), /\.bia-chat-privacy\{[^}]*safe-area-inset-bottom/);
});
