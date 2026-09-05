import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const manifest = JSON.parse(read("../public/arisa/manifest.webmanifest"));
const page = read("../src/app/arisa/page.tsx");
const css = read("../src/app/styles/v6-29-arisa-chat.css");
const chat = read("../src/components/arisa/ArisaChat.tsx");

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
  assert.match(page, /icon: \{ url: "\/arisa\/icon\?v=evora-1", type: "image\/png", sizes: "512x512" \}/);
  assert.match(page, /apple: \{ url: "\/arisa\/apple-icon\?v=evora-1", type: "image\/png", sizes: "180x180" \}/);
  assert.match(page, /themeColor: "#79B82B"/);
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  assert.equal(manifest.icons[0].src, "/arisa/icon?v=evora-1");
  assert.equal(manifest.theme_color, "#79B82B");
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
  assert.match(css, /\.public-agent-page\.bia-whatsapp\.arisa-chat\{[^}]*height:var\(--arisa-viewport-height,100dvh\)[^}]*padding:0/);
  assert.match(css, /\.arisa-chat \.bia-chat-privacy\{[^}]*var\(--arisa-safe-bottom,env\(safe-area-inset-bottom/);
  assert.doesNotMatch(chat, /setProperty\("--public-agent-viewport/);
});

test("home-screen icon preserves the original Evora logomark and accessible brand contrast", () => {
  const symbol = read("../src/components/arisa/EvoraAppIcon.tsx");
  const brand = read("../public/evora-brand.svg");
  const rectangles = [...brand.matchAll(/<rect[^>]+\/>/g)].map(match => match[0].replaceAll(/\s/g, ""));
  for (const rectangle of rectangles) assert.ok(symbol.replaceAll(/\s/g, "").includes(rectangle));
  assert.match(symbol, /fill="#79B82B"/);
  for (const path of ["icon", "apple-icon"]) assert.match(read(`../src/app/arisa/${path}.tsx`), /EvoraAppIcon\(\)/);
  const luminance = hex => {
    const linear = hex.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
  };
  assert.ok((luminance("79B82B") + .05) / (luminance("19310f") + .05) >= 4.5);
  assert.match(css, /--arisa-green:#79B82B;--arisa-ink:#19310f/);
  assert.match(css, /\.arisa-chat \.arisa-composer textarea\{font-size:16px/);
});

test("Arisa uses the supplied portrait as her accessible profile photo", () => {
  assert.match(chat, /import Image from "next\/image"/);
  assert.match(chat, /src="\/arisa-profile\.webp" alt="Foto de perfil da Arisa" width=\{42\} height=\{42\} priority/);
  assert.doesNotMatch(chat, /className="public-agent-avatar arisa-avatar" aria-hidden="true">A/);
  assert.match(css, /\.arisa-chat \.arisa-avatar img\{[^}]*object-fit:cover[^}]*object-position:center 42%/);
  const portrait = readFileSync(new URL("../public/arisa-profile.webp", import.meta.url));
  assert.equal(portrait.subarray(0, 4).toString(), "RIFF");
  assert.equal(portrait.subarray(8, 12).toString(), "WEBP");
  assert.ok(statSync(new URL("../public/arisa-profile.webp", import.meta.url)).size < 100_000);
});
