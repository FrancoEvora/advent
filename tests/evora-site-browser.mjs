import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(process.env.QA_NODE_MODULES, 'playwright'));
const root = resolve('public');
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.avif':'image/avif','.webp':'image/webp','.png':'image/png'};
const server = createServer(async (req,res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname === '/evora' ? '/evora/index.html' : url.pathname;
    const file = resolve(root, '.' + decodeURIComponent(path));
    if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    let bytes = await readFile(file);
    if (url.pathname === '/evora') bytes = Buffer.from(bytes.toString().replaceAll('="./','="/evora/'));
    res.writeHead(200, {'Content-Type':types[extname(file)] || 'application/octet-stream'});res.end(bytes);
  } catch { res.writeHead(404).end('Not found'); }
});
await new Promise(r => server.listen(3188,'127.0.0.1',r));
await mkdir('qa-output',{recursive:true});
const browser = await chromium.launch({headless:true});
const results=[];
try {
  for (const width of [1440, 768, 390, 360]) {
    const context = await browser.newContext({viewport:{width,height:width>1000?1000:844},deviceScaleFactor:1,reducedMotion:'reduce'});
    const page = await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:3188/evora',{waitUntil:'networkidle'});
    await page.evaluate(()=>document.querySelectorAll('img[src]').forEach(i=>i.loading='eager'));
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('img[src]')).every(i=>i.complete && i.naturalWidth>0));
    await page.evaluate(()=>Promise.all(Array.from(document.querySelectorAll('img[src]'),i=>i.decode())));
    assert.equal(await page.locator('h1').count(),1);
    assert.equal(await page.locator('.global-module-nav').count(),0);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1),'Horizontal overflow at '+width);
    assert.equal(await page.locator('a[href^="#"]').evaluateAll(as=>as.filter(a=>!document.querySelector(a.getAttribute('href'))).length),0);
    assert.equal(await page.locator('svg use').evaluateAll(xs=>xs.filter(x=>x.closest('svg').getBoundingClientRect().width>0).filter(x=>{let b=x.getBBox();return !b.width&&!b.height;}).length),0,'Visible SVG icons missing');
    assert.equal(await page.locator('#contact-interest option').count(),5);
    assert.ok(!(await page.locator('#contact-form').evaluate(f=>f.checkValidity())));
    if (width<=760) {
      await page.getByRole('button',{name:'Abrir menu',exact:true}).click();
      assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'),'true');
      await page.locator('#navegacao a[href="#empreendimentos"]').click();
      assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'),'false');
    }
    await page.locator('[data-gallery="solaris"]').first().click();
    assert.ok(await page.locator('#gallery').evaluate(d=>d.open));
    assert.equal(await page.locator('#gallery-counter').innerText(),'1 / 4');
    for (let i=0;i<4;i++) {
      await page.waitForFunction(()=>{const i=document.getElementById('gallery-image');return i.complete && i.naturalWidth>0;});
      await page.locator('#gallery-image').evaluate(i=>i.decode());
      if (i===1 && width===1440) await page.screenshot({path:'qa-output/gallery-desktop.png'});
      await page.locator('#gallery-next').click();
    }
    await page.keyboard.press('Escape');assert.ok(!(await page.locator('#gallery').evaluate(d=>d.open)));
    await page.locator('[data-gallery="parque"]').click();
    assert.equal(await page.locator('#gallery-counter').innerText(),'1 / 2');
    await page.locator('#gallery-next').click();
    await page.waitForFunction(()=>{const i=document.getElementById('gallery-image');return i.complete && i.naturalWidth>0;});
    await page.locator('#gallery [data-close]').click();
    await page.locator('[data-interest="Parque das Árvores"]').click();
    assert.equal(await page.locator('#contact-interest').inputValue(),'Parque das Árvores');
    await page.locator('#contact-name').fill('Teste de qualidade');
    await page.locator('#contact-message').fill('Mensagem de validação — não enviada.');
    await page.locator('#contact-form').evaluate(f=>f.addEventListener('submit',e=>e.preventDefault(),{once:true}));
    await page.locator('#contact-form button[type="submit"]').click();
    assert.match(await page.locator('#wa-message').inputValue(),/Teste de qualidade/);
    assert.match(await page.locator('#wa-message').inputValue(),/Parque das Árvores/);
    await page.locator('[data-privacy]').first().click();assert.ok(await page.locator('#privacy').evaluate(d=>d.open));
    await page.keyboard.press('Escape');
    await page.locator('#contact-form').evaluate(f=>f.reset());
    await page.evaluate(async()=>{for(const i of document.querySelectorAll('img[src]'))await i.decode();history.replaceState(null,'','/evora');scrollTo(0,0);});
    await page.screenshot({path:`qa-output/evora-${width}.png`,fullPage:true});
    if(width===1440)await page.screenshot({path:'qa-output/evora-desktop-hero.png'});
    assert.deepEqual(errors,[]);results.push({width,status:'PASS',errors,images:'loaded',overflow:false,whatsapp:'validated locally; no message sent'});
    await context.close();
  }
  await writeFile('qa-output/results.json',JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
} finally { await browser.close(); await new Promise(r=>server.close(r)); }
