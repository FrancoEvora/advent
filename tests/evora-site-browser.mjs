import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Public GETs only. No authorized sessions, customer data or message submission.
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(process.env.QA_NODE_MODULES, 'playwright'));
const base = 'https://evora-institucional.vercel.app';
const output = resolve('sites/evora-institucional/dist');
const forbidden = /advent-tau|enterprise\.terraragroup|supabase|service_role|sk-proj-/i;
const report = {url:base,generatedAt:new Date().toISOString(),http:[],browsers:[],messagesSent:0};
await mkdir('qa-output',{recursive:true});
assert.equal(await access('public/evora').then(()=>true,()=>false),false,'Legacy public installation still exists');
assert.equal(await access('src/app/evora/route.ts').then(()=>true,()=>false),false,'Legacy page route still exists');
const nextConfig = await readFile('next.config.ts','utf8');
assert.ok(nextConfig.includes('source: "/evora/:path*"'));
assert.ok(nextConfig.includes('destination: "https://evora-institucional.vercel.app/"'));
const localHtml = await readFile(resolve(output,'index.html'),'utf8');
const response = await fetch(base+'/',{signal:AbortSignal.timeout(25000)});
assert.equal(response.status,200);
const liveHtml = await response.text();
assert.equal(liveHtml,localHtml,'Live production HTML differs from the isolated build');
assert.ok(!forbidden.test(liveHtml));
const csp = response.headers.get('content-security-policy') || '';
for (const directive of ["connect-src 'none'","frame-src 'none'","frame-ancestors 'none'","worker-src 'none'","form-action https://wa.me"]) assert.ok(csp.includes(directive),`Missing CSP: ${directive}`);
report.csp=csp;
report.http.push({path:'/',status:200,matchesBuild:true});
const manifest=JSON.parse(await readFile('sites/evora-institucional/source-manifest.json','utf8'));
for (const path of Object.keys(manifest).filter(p=>p!=='index.html')) {
  const r = await fetch(`${base}/${path}`,{signal:AbortSignal.timeout(25000)});
  assert.equal(r.status,200,path);
  const bytes=Buffer.from(await r.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest[path],path+' integrity');
  report.http.push({path:'/'+path,status:200,integrity:true});
}
for(const path of ['/crm','/financeiro','/api/forms/solaris','/api/financeiro','/arisa','/login','/sw.js','/runtime-config.json']) {
  const r=await fetch(base+path,{redirect:'manual',signal:AbortSignal.timeout(25000)});
  assert.equal(r.status,404,path+' must not serve an ERP route');
  assert.equal(r.headers.get('location'),null,path+' must not proxy/redirect to Enterprise');
  assert.ok(!forbidden.test(await r.text()),path+' contains internal references');
  report.http.push({path,status:r.status,redirect:null});
}
const browser = await chromium.launch({headless:true});
try {
 for (const width of [1440,768,390,360]) {
  const context=await browser.newContext({viewport:{width,height:width>1000?1000:844},deviceScaleFactor:1,reducedMotion:'reduce'});
  const page=await context.newPage();const errors=[],requests=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  page.on('request',r=>requests.push(r.url()));
  await page.goto(base+'/',{waitUntil:'networkidle'});
  await page.evaluate(()=>document.querySelectorAll('img[src]').forEach(i=>i.loading='eager'));
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('img[src]')).every(i=>i.complete&&i.naturalWidth>0));
  await page.evaluate(()=>Promise.all(Array.from(document.querySelectorAll('img[src]'),i=>i.decode())));
  assert.equal(await page.locator('h1').count(),1);
  assert.equal(await page.locator('.global-module-nav,iframe').count(),0);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Horizontal overflow at '+width);
  assert.equal(await page.locator('a[href^="#"]').evaluateAll(as=>as.filter(a=>!document.querySelector(a.getAttribute('href'))).length),0);
  assert.equal(await page.locator('svg use').evaluateAll(xs=>xs.filter(x=>x.closest('svg').getBoundingClientRect().width>0).filter(x=>{const b=x.getBBox();return !b.width&&!b.height;}).length),0);
  assert.equal(await page.locator('#contact-interest option').count(),5);
  if(width<=760){await page.getByRole('button',{name:'Abrir menu',exact:true}).click();assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'),'true');await page.locator('#navegacao a[href="#empreendimentos"]').click();assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'),'false');}
  for(const key of ['solaris','parque']) {
   await page.locator(`[data-gallery="${key}"]`).first().click();
   assert.ok(await page.locator('#gallery').evaluate(d=>d.open));
   const count=key==='solaris'?4:2;
   assert.equal(await page.locator('#gallery-counter').innerText(),`1 / ${count}`);
   for(let i=0;i<count;i++){
    await page.waitForFunction(()=>{const i=document.getElementById('gallery-image');return i.complete&&i.naturalWidth>0;});
    await page.locator('#gallery-image').evaluate(i=>i.decode());
    await page.locator('#gallery-next').click();
   }
   await page.keyboard.press('Escape');
  }
  await page.locator('#solaris a[data-interest]').click();
  assert.equal(await page.locator('#contact-interest').inputValue(),'Solaris Residencial Resort');
  assert.equal(new URL(page.url()).origin,base,'Solaris CTA left institutional origin');
  assert.ok(!(await page.locator('#contact-form').evaluate(f=>f.checkValidity())));
  await page.locator('#contact-name').fill('Teste local de qualidade');
  await page.locator('#contact-message').fill('Validação sem envio de mensagem.');
  await page.locator('#contact-form').evaluate(f=>f.addEventListener('submit',e=>e.preventDefault(),{once:true}));
  await page.locator('#contact-form button[type="submit"]').click();
  assert.match(await page.locator('#wa-message').inputValue(),/Teste local de qualidade/);
  assert.match(await page.locator('#wa-message').inputValue(),/Solaris Residencial Resort/);
  assert.equal(await page.locator('#contact-form').getAttribute('action'),'https://wa.me/5511917664123');
  await page.locator('[data-privacy]').first().click();assert.ok(await page.locator('#privacy').evaluate(d=>d.open));await page.keyboard.press('Escape');
  assert.deepEqual(await context.cookies(),[],'Unexpected cookies');
  assert.equal(await page.evaluate(async()=>(await navigator.serviceWorker.getRegistrations()).length),0);
  assert.ok(requests.every(u=>new URL(u).origin===base),'External resource request detected');
  assert.deepEqual(errors,[]);
  await page.locator('#contact-form').evaluate(f=>f.reset());
  await page.evaluate(()=>{history.replaceState(null,'','/');scrollTo(0,0);});
  await page.screenshot({path:`qa-output/evora-isolado-${width}.png`,fullPage:true});
  if(width===1440)await page.screenshot({path:'qa-output/evora-isolado-preview.png'});
  report.browsers.push({width,status:'PASS',pageErrors:errors,externalRequests:0,cookies:0,serviceWorkers:0,solarisContact:'same-origin, no submission'});
  await context.close();
 }
} finally {
 await browser.close();
 await writeFile('qa-output/isolamento-results.json',JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report,null,2));
