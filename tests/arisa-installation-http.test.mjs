import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";

// Run after next build. Checking rendered HTML catches inherited root metadata
// that source-only tests cannot detect (especially Apple's home-screen icon).
test("built Arisa serves its own install metadata and valid PNG icons", { timeout: 45000 }, async () => {
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3108"], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Next server readiness timeout")), 15000);
      server.stdout.on("data", chunk => {
        if (chunk.toString().includes("Ready in")) { clearTimeout(timer); resolve(); }
      });
      server.once("error", error => { clearTimeout(timer); reject(error); });
      server.once("exit", code => { clearTimeout(timer); reject(new Error(`Next server exited: ${code}`)); });
    });
    const request = path => fetch(`http://127.0.0.1:3108${path}`, { signal: AbortSignal.timeout(10000) });
    for (const path of ["/arisa", "/arisa?conversa=00000000-0000-0000-0000-000000000000"]) {
      const response = await request(path);
      assert.equal(response.status, 200);
      const html = await response.text();
      const manifests = [...html.matchAll(/<link[^>]*rel="manifest"[^>]*>/g)].map(match => match[0]);
      assert.equal(manifests.length, 1);
      assert.match(manifests[0], /href="\/arisa\/manifest.webmanifest"/);
      assert.match(html, /<meta name="application-name" content="Arisa"/);
      assert.match(html, /<meta name="mobile-web-app-capable" content="yes"/);
      assert.match(html, /<meta name="apple-mobile-web-app-title" content="Arisa"/);
      assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/);
      assert.match(html, /<meta name="theme-color" content="#79B82B"/);
      const appleIcons = [...html.matchAll(/<link[^>]*rel="apple-touch-icon"[^>]*>/g)].map(match => match[0]);
      assert.equal(appleIcons.length, 1);
      assert.match(appleIcons[0], /href="\/arisa\/apple-icon\?v=evora-1"/);
      assert.doesNotMatch(appleIcons[0], /href="\/icon.svg"/);
    }
    const manifestResponse = await request("/arisa/manifest.webmanifest");
    assert.equal(manifestResponse.status, 200);
    assert.match(manifestResponse.headers.get("content-type"), /manifest\+json/);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.start_url, "/arisa");
    assert.equal(manifest.id, "/arisa");
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.theme_color, "#79B82B");
    for (const [path, size] of [[manifest.icons[0].src, 512], ["/arisa/apple-icon?v=evora-1", 180]]) {
      const response = await request(path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /image\/png/);
      const png = Buffer.from(await response.arrayBuffer());
      assert.equal(png.subarray(1, 4).toString(), "PNG");
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
    }
    const root = await (await request("/")).text();
    assert.match(root, /<link rel="manifest" href="\/manifest.webmanifest"/);
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      const closed = once(server, "exit");
      server.kill("SIGTERM");
      await closed;
    }
  }
});
