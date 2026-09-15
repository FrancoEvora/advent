import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const { chromium } = await import(pathToFileURL(path.join(process.env.QA_NODE_MODULES, 'playwright/index.mjs')).href);
const out = 'qa-output/downloads';
await fs.mkdir(out, { recursive: true });
const expectedURL = 'https://qsdffayasuzsmngteika.supabase.co/storage/v1/object/public/solaris-public/book-comercial-solaris-2026-v6-a929eb88.pdf?download=Solaris_Book_2026_V6.pdf';
const expectedSHA = 'a929eb889f7adc97bc821cc16a2f1a93bdae0a5b4be6f0be06b491117ab33da2';
const logos = [
  ['jvf', 'JVF Group', 'FINANCIAMENTO', '57d3a8651ccd9f19dad6902e4dd6b79ed936c22b'],
  ['evora', 'Évora Urbanismo', 'DESENVOLVIMENTO E INFRAESTRUTURA', 'b525a00a16527629c5c1a7ede072ab765537986b'],
  ['zenith', 'Zenith Empreendimentos', 'PARCERIA', 'a73fde926e800aec8d09464bb7f847ac825e68c0'],
];
for (const [id, , , gitSHA] of logos) {
  const file = `public/forms/solaris/book/logo-${id}.webp`;
  const bytes = await fs.readFile(file);
  assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), gitSHA);
  await sharp(bytes, { failOn: 'warning' }).png().toFile(path.join(out, `logo-${id}.png`));
}
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const clientErrors = [];
let attemptedSubmissions = 0;
page.on('pageerror', error => clientErrors.push(error.message));
await page.route('**/api/forms/solaris', async route => { attemptedSubmissions++; await route.abort(); });
try {
  const response = await page.goto('http://127.0.0.1:3000/atendimento/solaris/cadastro?utm_source=qa_downloads&utm_campaign=book_v6', { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200);
  await page.locator('[data-solaris-downloads="book-v6"]').waitFor();
  const links = page.locator('a[data-solaris-book-download="v6"]');
  assert.equal(await links.count(), 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(await links.nth(i).getAttribute('href'), expectedURL);
    assert.equal(await links.nth(i).getAttribute('download'), 'Solaris_Book_2026_V6.pdf');
    assert.equal(await links.nth(i).getAttribute('target'), '_blank');
  }
  for (const [id, name, role] of logos) {
    const item = page.locator(`[data-partner="${id}"]`);
    assert.equal(await item.locator('p').textContent(), role);
    assert.equal(await item.locator('img').getAttribute('alt'), name);
  }
  const widths = [];
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => { for (const image of document.images) image.loading = 'eager'; });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#parceiros img')).every(image => image.complete && image.naturalWidth > 0));
    const bounds = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(bounds.scroll <= bounds.client + 1, `Overflow at ${width}`);
    const positions = await page.locator('#parceiros [data-partner]').evaluateAll(items => items.map(item => { const r = item.getBoundingClientRect(); return { x: r.x, y: r.y }; }));
    if (width <= 760) assert.ok(positions[0].y < positions[1].y && positions[1].y < positions[2].y, 'Mobile partner order');
    else assert.ok(Math.abs(positions[0].y - positions[2].y) < 1, 'Desktop partner columns');
    await page.locator('#parceiros').screenshot({ path: path.join(out, `partners-${width}.png`), animations: 'disabled' });
    if (width === 390 || width === 1440) {
      await page.locator('#embaixador').screenshot({ path: path.join(out, `ambassador-${width}.png`), animations: 'disabled' });
      await page.locator('section[aria-labelledby="proximo-passo-titulo"]').screenshot({ path: path.join(out, `final-cta-${width}.png`), animations: 'disabled' });
    }
    widths.push({ width, ...bounds, pass: true });
  }
  // Real public HEAD: no credentials, cookies, or API key. The server, not just the HTML attribute, forces download.
  const head = await context.request.head(expectedURL, { timeout: 90000 });
  assert.equal(head.status(), 200);
  assert.match(head.headers()['content-type'] || '', /application\/pdf/);
  assert.match(head.headers()['content-disposition'] || '', /attachment/i);
  assert.match(head.headers()['content-disposition'] || '', /Solaris_Book_2026_V6\.pdf/);
  // Click the published link and verify the entire PDF against the original attachment.
  let resolveDownload;
  const gotDownload = new Promise(resolve => { resolveDownload = resolve; });
  page.once('download', resolveDownload);
  context.on('page', popup => popup.once('download', resolveDownload));
  let timeout;
  const deadline = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Download click timed out')), 120000); });
  await page.locator('#embaixador [data-solaris-book-download]').click();
  const download = await Promise.race([gotDownload, deadline]);
  clearTimeout(timeout);
  assert.equal(download.suggestedFilename(), 'Solaris_Book_2026_V6.pdf');
  const stream = await download.createReadStream();
  assert.ok(stream, 'Browser download stream');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of stream) { bytes += chunk.length; hash.update(chunk); }
  const sha256 = hash.digest('hex');
  assert.equal(bytes, 33586339);
  assert.equal(sha256, expectedSHA, 'Download must match the original 23-page attachment exactly');
  await download.delete();
  assert.equal(new URL(page.url()).searchParams.get('utm_source'), 'qa_downloads');
  assert.equal(await page.locator('#formulario input[name="name"]').inputValue(), '');
  assert.equal(attemptedSubmissions, 0, 'Downloading the book must not submit a lead');
  assert.deepEqual(clientErrors, []);
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ pass: true, download: { originalFile: true, bytes, sha256, filename: 'Solaris_Book_2026_V6.pdf', authenticationRequired: false, ungated: true, browserClick: true }, links: 3, partners: logos.map(([id, name, role]) => ({ id, name, role })), layout: widths, clientErrors, crmWrites: 0 }, null, 2));
  console.log('Solaris download: original PDF integrity, real ungated browser download and responsive partner strip verified.');
} catch (error) {
  await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, clientErrors }, null, 2));
  throw error;
} finally { await browser.close(); }
