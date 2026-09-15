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
  manifest.push({file,width:metadata.width,height:metadata.height,hasAlpha:metadata.hasAlpha,bytes:(await fs.stat(source)).size});
}
assert.equal(manifest.length,13);
assert.ok(manifest.find(item=>item.file==='leo-chaves-embaixador.avif')?.hasAlpha,'Portrait must preserve its transparent background');
assert.deepEqual(manifest.filter(item=>item.file==='parque-das-arvores-setores.avif').map(({width,height})=>[width,height]),[[1024,683]]);
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
const quote='A vida é feita de momentos simples e verdadeiros. Estar perto da família, compartilhar bons encontros e sentir a paz de um lugar que inspira bem-estar é o que realmente importa. O Solaris nasce com esse espírito: um convite para viver com mais leveza, conexão e qualidade de vida.';
try{
  const response=await page.goto(url,{waitUntil:'networkidle'});
  assert.equal(response.status(),200);
  await page.locator('[data-solaris-version="book-v6"][data-solaris-revision="parque-embaixador"]').waitFor();
  assert.equal(await page.locator('#mapa-titulo, dialog').count(),0,'Former implantation section is replaced, not duplicated');
  assert.equal((await page.locator('#embaixador blockquote').innerText()).replace(/\s+/g,' ').trim(),quote);
  assert.match(await page.locator('#embaixador figcaption').innerText(),/Leo Chaves[\s\S]*Embaixador Évora Urbanismo/);
  assert.equal(await page.locator('#embaixador a[href="#formulario"]').count(),1);
  assert.equal(await page.getByText('O Solaris traduz um jeito de viver',{exact:false}).count(),0,'Do not publish the unsourced draft quote');
  for(const width of [320,390,768,1440]){
    await page.setViewportSize({width,height:900});
    await page.evaluate(()=>{for(const im of document.images)im.loading='eager';});
    await page.waitForFunction(()=>Array.from(document.images).filter(i=>i.closest('main')).every(i=>i.complete&&i.naturalWidth>0));
    await page.evaluate(()=>window.scrollTo(0,0)); await page.waitForTimeout(250);
    const bounds=await page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
    assert.ok(bounds.scroll<=bounds.client+1,`Horizontal overflow at ${width}: ${JSON.stringify(bounds)}`);
    const neighborhood=await page.locator('#localizacao img').evaluate(im=>({src:im.getAttribute('src'),width:im.getBoundingClientRect().width,height:im.getBoundingClientRect().height,naturalWidth:im.naturalWidth,naturalHeight:im.naturalHeight}));
    assert.match(neighborhood.src,/parque-das-arvores-setores\.avif/);
    assert.ok(Math.abs(neighborhood.width/neighborhood.height-1024/683)<.01,'Neighborhood labels must not be cropped');
    assert.equal(neighborhood.naturalWidth,1024);
    await page.screenshot({path:path.join(output,`page-${width}.png`),fullPage:true,animations:'disabled'});
    if(width===1440)await page.screenshot({path:path.join(output,'hero-desktop.png'),animations:'disabled'});
    if(width===390)await page.screenshot({path:path.join(output,'hero-mobile.png'),animations:'disabled'});
    if(width===390||width===1440){
      await page.locator('#localizacao').screenshot({path:path.join(output,`location-${width}.png`),animations:'disabled'});
      await page.locator('#embaixador').screenshot({path:path.join(output,`ambassador-${width}.png`),animations:'disabled'});
    }
    results.push({width,...bounds,pass:true,neighborhoodUncropped:true});
  }
  const [mapPage]=await Promise.all([context.waitForEvent('page'),page.getByRole('link',{name:'Ampliar mapa do bairro',exact:false}).click()]);
  await mapPage.waitForLoadState('domcontentloaded');
  assert.match(mapPage.url(),/\/parque-das-arvores-setores\.avif/);
  await mapPage.waitForFunction(()=>Array.from(document.images).some(im=>im.complete&&im.naturalWidth===1024));
  await mapPage.close();
  const gallery=[['Lazer resort','resort'],['Natureza','natureza'],['Bem-estar','academia'],['Esportes','tenis'],['Família','familia'],['Hípica','hipica']];
  for(const [label,asset] of gallery){
    await page.getByRole('tab',{name:label,exact:true}).click();
    await page.waitForFunction(expected=>{
      const image=document.querySelector('#experiencia-painel img');
      return image instanceof HTMLImageElement && image.getAttribute('src')?.includes(`/${expected}.avif`) && image.complete && image.naturalWidth>0;
    },asset);
    assert.equal(await page.getByRole('tab',{name:label,exact:true}).getAttribute('aria-selected'),'true');
  }
  await page.getByRole('tab',{name:'Hípica',exact:true}).press('Home');
  await page.waitForFunction(()=>document.querySelector('#tab-resort')?.getAttribute('aria-selected')==='true');
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
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({pass:true,layout:results,decodedImages:manifest.length,clientErrors:errors,tabs:6,neighborhoodMap:true,ambassador:true,quoteSource:'Book V6 page 2',form:'mocked only; no CRM writes',attribution:true,receiptValidation:true,idempotency:true},null,2));
  console.log('Solaris: supplied map and portrait, sourced testimonial, responsive layouts, tabs and mocked capture flow passed. No CRM writes.');
}catch(error){
  await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});
  await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({message:error.message,stack:error.stack,clientErrors:errors},null,2));
  throw error;
}finally{await browser.close();}
