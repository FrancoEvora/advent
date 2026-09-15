import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';

const {chromium}=await import(pathToFileURL(path.join(process.env.QA_NODE_MODULES,'playwright/index.mjs')).href);
const output='qa-output';
await fs.mkdir(path.join(output,'images'),{recursive:true});
const manifest=[];
for(const file of (await fs.readdir('public/forms/solaris/book')).filter(f=>f.endsWith('.avif'))){
  const source=path.join('public/forms/solaris/book',file);
  const image=sharp(source,{failOn:'warning'});
  const metadata=await image.metadata();
  assert.ok(metadata.width>0&&metadata.height>0,file);
  await image.png().toFile(path.join(output,'images',file.replace('.avif','.png')));
  manifest.push({file,width:metadata.width,height:metadata.height,bytes:(await fs.stat(source)).size});
}
assert.equal(manifest.length,11);
await fs.writeFile(path.join(output,'assets.json'),JSON.stringify(manifest,null,2));
const browser=await chromium.launch({headless:true});
const context=await browser.newContext();
const page=await context.newPage();
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
const submissions=[];
let replyMode='wrong-receipt';
await page.route('**/api/forms/solaris',async route=>{
  const body=route.request().postDataJSON(); submissions.push(body);
  await new Promise(resolve=>setTimeout(resolve,200));
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({id:replyMode==='ok'?body.requestId:'not-the-receipt'})});
});
const url='http://127.0.0.1:3000/atendimento/solaris/cadastro?utm_source=qa_local&utm_campaign=book_v6&fbclid=qa_local';
const results=[];
try{
  const response=await page.goto(url,{waitUntil:'networkidle'});
  assert.equal(response.status(),200);
  await page.locator('[data-solaris-version="book-v6"]').waitFor();
  for(const width of [320,390,768,1440]){
    await page.setViewportSize({width,height:900});
    await page.evaluate(()=>{for(const im of document.images)im.loading='eager';});
    await page.waitForFunction(()=>Array.from(document.images).filter(i=>i.closest('main')).every(i=>i.complete&&i.naturalWidth>0));
    await page.evaluate(()=>window.scrollTo(0,0)); await page.waitForTimeout(250);
    const bounds=await page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
    assert.ok(bounds.scroll<=bounds.client+1,`Horizontal overflow at ${width}: ${JSON.stringify(bounds)}`);
    await page.screenshot({path:path.join(output,`page-${width}.png`),fullPage:true,animations:'disabled'});
    if(width===1440)await page.screenshot({path:path.join(output,'hero-desktop.png'),animations:'disabled'});
    if(width===390)await page.screenshot({path:path.join(output,'hero-mobile.png'),animations:'disabled'});
    results.push({width,...bounds,pass:true});
  }
  for(const label of ['Lazer resort','Natureza','Bem-estar','Esportes','Família','Hípica']){
    await page.getByRole('tab',{name:label,exact:true}).click();
    await page.locator('#experiencia-painel img').evaluate(im=>im.decode());
    assert.equal(await page.getByRole('tab',{name:label,exact:true}).getAttribute('aria-selected'),'true');
  }
  await page.getByRole('tab',{name:'Hípica',exact:true}).press('Home');
  assert.equal(await page.getByRole('tab',{name:'Lazer resort',exact:true}).getAttribute('aria-selected'),'true');
  await page.getByRole('link',{name:'Ampliar implantação'}).click();
  assert.equal(await page.locator('dialog').evaluate(d=>d.open),true);
  await page.screenshot({path:path.join(output,'map.png'),animations:'disabled'});
  await page.getByRole('button',{name:'Fechar implantação'}).click();
  assert.equal(await page.locator('dialog').evaluate(d=>d.open),false);
  await page.getByText('Conheça os 16 espaços indicados no book',{exact:false}).click();
  assert.equal(await page.locator('details[open] ol li').count(),16);
  await page.getByRole('link',{name:'Quero conhecer o Solaris',exact:false}).click();
  assert.equal(new URL(page.url()).searchParams.get('utm_source'),'qa_local');
  const form=page.locator('#formulario');
  await form.getByRole('button',{name:'Continuar'}).click();
  assert.match(await form.getByRole('alert').innerText(),/nome/);
  await form.getByLabel('Seu nome',{exact:true}).fill('Pessoa QA Local');
  await form.getByRole('button',{name:'Continuar'}).click();
  assert.match(await form.getByRole('alert').innerText(),/WhatsApp/);
  await form.getByLabel('WhatsApp com DDD').fill('(34) 91234-5678');
  await form.getByRole('button',{name:'Continuar'}).click();
  await form.getByRole('button',{name:'Receber lotes e condições'}).click();
  assert.match(await form.getByRole('alert').innerText(),/Selecione/);
  assert.equal(submissions.length,0);
  await form.getByRole('radio',{name:'Quero morar'}).check();
  await form.getByRole('button',{name:'Voltar'}).click();
  assert.equal(await form.getByLabel('Seu nome',{exact:true}).inputValue(),'Pessoa QA Local');
  await form.getByRole('button',{name:'Continuar'}).click();
  await form.getByRole('button',{name:'Receber lotes e condições'}).click();
  await form.getByRole('alert').waitFor();
  assert.equal(submissions.length,1);
  assert.equal(await form.getByText('Seu interesse foi registrado.').count(),0);
  replyMode='ok';
  await form.getByRole('button',{name:'Receber lotes e condições'}).click();
  await form.getByText('Seu interesse foi registrado.',{exact:true}).waitFor();
  assert.equal(submissions.length,2);
  assert.equal(submissions[0].requestId,submissions[1].requestId);
  assert.equal(submissions[1].consent,true);
  assert.equal(submissions[1].purpose,'morar');
  assert.equal(submissions[1].attribution.utm_campaign,'book_v6');
  assert.equal(submissions[1].attribution.fbclid,'qa_local');
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({pass:true,layout:results,decodedImages:manifest.length,clientErrors:errors,tabs:6,map:true,form:'mocked only; no CRM writes',attribution:true,receiptValidation:true,idempotency:true},null,2));
  console.log('Solaris book: images, responsive layouts, tabs, map and mocked capture flow passed. No CRM writes.');
}catch(error){
  await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});
  await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({message:error.message,stack:error.stack,clientErrors:errors},null,2));
  throw error;
}finally{await browser.close();}
