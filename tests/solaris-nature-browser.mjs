import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.env.QA_PLAYWRIGHT_PATH ? pathToFileURL(process.env.QA_PLAYWRIGHT_PATH).href : 'playwright');
const browser=await chromium.launch({headless:true,...(process.env.QA_BROWSER_CHANNEL ? {channel:process.env.QA_BROWSER_CHANNEL} : {})});
const page=await browser.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
let submitted;let accepted=false;
await page.route('**/api/forms/solaris',async route=>{
  submitted=route.request().postDataJSON();
  await route.fulfill({status:accepted?200:500,contentType:'application/json',body:JSON.stringify(accepted?{id:submitted.requestId}:{error:'Teste de falha'})});
});
await fs.mkdir('qa-output',{recursive:true});
try{
  await page.goto(`${process.env.QA_BASE_URL || 'http://localhost:3107'}/atendimento/solaris/cadastro?utm_source=qa_local&utm_campaign=vizinhos`,{waitUntil:'networkidle'});
  await page.locator('[data-solaris-version="natureza-v1"]').waitFor();
  for(const width of [320,390,768,1440]){
    await page.setViewportSize({width,height:900});
    await page.evaluate(()=>{for(const img of document.images)img.loading='eager'});
    await page.waitForFunction(()=>[...document.querySelectorAll('main img')].every(i=>i.complete&&i.naturalWidth));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`overflow ${width}`);
    const logo=page.getByAltText('Futura Casa — Inteligência Imobiliária, Marketing e Vendas');
    const size=await logo.evaluate(i=>({w:i.clientWidth,h:i.clientHeight,nw:i.naturalWidth,nh:i.naturalHeight}));
    assert.ok(Math.abs(size.w/size.h-size.nw/size.nh)<.05,'Logo must retain its full aspect ratio');
    await page.screenshot({path:`qa-output/solaris-nature-${width}.png`,fullPage:true});
  }
  await page.getByRole('link',{name:'Conhecer os lotes →',exact:true}).click();
  const form=page.locator('#formulario');
  await form.getByRole('button',{name:'Continuar'}).click();
  assert.match(await form.getByRole('alert').innerText(),/nome/);
  await form.getByLabel('Seu nome',{exact:true}).fill('Pessoa QA Local');
  await form.getByLabel('WhatsApp com DDD').fill('(34) 91234-5678');
  await form.getByRole('button',{name:'Continuar'}).click();
  await form.getByRole('radio',{name:'Quero morar'}).check();
  await form.getByRole('button',{name:'Receber lotes e condições'}).click();
  await form.getByRole('alert').waitFor();
  assert.equal(submitted.name,'Pessoa QA Local');assert.equal(submitted.attribution.utm_campaign,'vizinhos');
  const firstId=submitted.requestId;accepted=true;
  await form.getByRole('button',{name:'Receber lotes e condições'}).click();
  await page.waitForFunction(()=>document.querySelector('#formulario')?.textContent.includes('registrado'));
  assert.equal(submitted.requestId,firstId);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({viewports:[320,390,768,1440],overflow:false,images:true,logoUncropped:true,formValidation:true,retry:true,attribution:true,consoleErrors:errors,productionLeadsCreated:0}));
}finally{await browser.close()}
