import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const runner=process.env.QA_PLAYWRIGHT_PATH || (process.env.QA_NODE_MODULES ? path.join(process.env.QA_NODE_MODULES,'playwright/index.mjs') : null);
const {chromium}=await import(runner ? pathToFileURL(runner).href : 'playwright');
const browser=await chromium.launch({headless:true,...(process.env.QA_BROWSER_CHANNEL ? {channel:process.env.QA_BROWSER_CHANNEL} : {})});
const page=await browser.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
let submitted, accepted=false, requests=0;
await page.route('**/api/forms/solaris',async route=>{
  requests++; submitted=route.request().postDataJSON();
  await route.fulfill({status:accepted?200:500,contentType:'application/json',body:JSON.stringify(accepted?{id:submitted.requestId}:{error:'Teste de falha'})});
});
const base=process.env.QA_BASE_URL || 'http://localhost:3107';
await fs.mkdir('qa-output/book-alignment',{recursive:true});
try{
  const response=await page.goto(`${base}/atendimento/solaris/cadastro?utm_source=qa_local&utm_campaign=book_v6`,{waitUntil:'networkidle'});
  assert.equal(response.status(),200);
  await page.locator('[data-solaris-version="revista-book-v6"]').waitFor();
  assert.equal(await page.locator('#formulario').count(),1);
  assert.equal(await page.locator('header img[alt="Solaris Residencial Resort"]').count(),1);
  assert.equal(await page.getByAltText('Futura Casa — Inteligência Imobiliária, Marketing e Vendas').count(),1);
  assert.equal(await page.locator('footer img[alt^="Futura Casa"]').count(),1);
  assert.equal(await page.locator('#inicio img[alt^="Futura Casa"]').count(),0);
  const links=page.locator('a[data-solaris-book-download="editorial-v6"]');
  const downloadURL=new URL(await links.first().getAttribute('href'),base).href;
  const download=await page.request.get(downloadURL);
  assert.equal(download.status(),200);
  assert.match(download.headers()['content-type'],/pdf/);
  const bytes=await download.body();
  const expected=await fs.readFile('public/forms/solaris/downloads/solaris-book-2026-v6.pdf');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),createHash('sha256').update(expected).digest('hex'));
  assert.equal(await page.locator('a[href$="#page=8"]').count(),1);
  await page.evaluate(()=>{for(const image of document.images)image.loading='eager'});
  await page.waitForFunction(()=>[...document.querySelectorAll('main img')].every(i=>i.complete&&i.naturalWidth));
  const targets=await page.locator('main a[href^="#"]').evaluateAll(links=>links.map(a=>a.getAttribute('href').slice(1)));
  for(const id of new Set(targets))assert.equal(await page.locator(`[id="${id}"]`).count(),1,`target ${id}`);
  const viewports=[];
  for(const width of [320,390,768,1440]){
    await page.setViewportSize({width,height:900});
    await page.evaluate(()=>scrollTo(0,0));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`overflow ${width}`);
    const formTop=await page.locator('#formulario').evaluate(el=>el.getBoundingClientRect().top+scrollY);
    assert.ok(formTop<1080,`Form in opening ${width}: ${formTop}`);
    const map=page.locator('img[alt^="Implantação humanizada"]');
    const size=await map.evaluate(i=>({w:i.clientWidth,h:i.clientHeight,nw:i.naturalWidth,nh:i.naturalHeight}));
    assert.ok(Math.abs(size.w/size.h-size.nw/size.nh)<.03,'Full map aspect ratio');
    viewports.push({width,formTop:Math.round(formTop)});
    await page.screenshot({path:`qa-output/book-alignment/cover-${width}.png`});
    if(width===390||width===1440){
      for(const id of ['vizinhos','parque-linear','implantacao','caderno-natureza','autor']){
        await page.locator(`#${id}`).scrollIntoViewIfNeeded();
        await page.screenshot({path:`qa-output/book-alignment/${id}-${width}.png`});
      }
      await page.locator('footer').scrollIntoViewIfNeeded();
      await page.screenshot({path:`qa-output/book-alignment/footer-${width}.png`});
    }
  }
  await page.getByRole('link',{name:'Quero conhecer o Solaris →',exact:true}).click();
  const top=await page.locator('#formulario').evaluate(el=>el.getBoundingClientRect().top);
  assert.ok(top>=90&&top<160,`form anchor ${top}`);
  const form=page.locator('#formulario');
  await form.getByRole('button',{name:'Continuar'}).click();
  assert.match(await form.getByRole('alert').innerText(),/nome/);
  await form.getByLabel('Seu nome',{exact:true}).fill('Pessoa QA Local');
  await form.getByLabel('WhatsApp com DDD').fill('(34) 91234-5678');
  await form.getByRole('button',{name:'Continuar'}).click();
  await form.getByRole('radio',{name:'Quero morar'}).check();
  await form.getByRole('button',{name:'Receber lotes e condições'}).click();
  await form.getByRole('alert').waitFor();
  assert.equal(submitted.name,'Pessoa QA Local');assert.equal(submitted.attribution.utm_campaign,'book_v6');
  const firstId=submitted.requestId;accepted=true;
  await form.getByRole('button',{name:'Receber lotes e condições'}).click();
  await page.waitForFunction(()=>document.querySelector('#formulario')?.textContent.includes('registrado'));
  assert.equal(submitted.requestId,firstId);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({viewports,overflow:false,singleForm:true,downloadBytes:bytes.length,downloadHashVerified:true,formValidation:true,retry:true,attribution:true,mockedSubmissions:requests,productionLeadsCreated:0,consoleErrors:errors}));
}finally{await browser.close()}
