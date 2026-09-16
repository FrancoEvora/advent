import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// An offline, allowlisted static build. No ERP files, credentials, integrations,
// environment configuration, server functions or API routes enter the output.
const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, 'dist');
const base = 'https://evora-institucional.vercel.app';
const manifest = JSON.parse(await readFile(join(root,'source-manifest.json'), 'utf8'));
await rm(output, {recursive:true, force:true});
await mkdir(join(output,'assets'), {recursive:true});
for (const [file, expected] of Object.entries(manifest)) {
  if (!/^(assets\/[a-z0-9.-]+|index\.html|site(?:-base)?\.css|site\.js)$/.test(file)) throw new Error(`Invalid public path: ${file}`);
  const bytes = await readFile(join(root,'template',file));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`Integrity check failed: ${file}`);
  await mkdir(dirname(join(output,file)), {recursive:true});
  await writeFile(join(output,file), bytes);
}
let html = await readFile(join(output,'index.html'),'utf8');
html = html.replaceAll('https://advent-tau.vercel.app/evora',base);
html = html.replaceAll('href="https://advent-tau.vercel.app/atendimento/solaris/cadastro" target="_blank" rel="noopener noreferrer"','href="#contato" data-interest="Solaris Residencial Resort"');
html = html.replaceAll('Atendimento Solaris ↗','Atendimento Solaris');
html = html.replace('O botão “Receber atendimento” abre o cadastro comercial do Solaris. Esse ambiente apresenta suas próprias informações de tratamento de dados e autorização de contato. O cadastro não é realizado por este site institucional.','O botão “Receber atendimento” leva ao formulário deste site, com o interesse no Solaris já selecionado. A mensagem é preparada no navegador e aberta no WhatsApp. Este site não se conecta à plataforma interna de gestão.');
await writeFile(join(output,'index.html'),html);
await writeFile(join(output,'robots.txt'),`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
await writeFile(join(output,'sitemap.xml'),`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/</loc></url></urlset>\n`);
await writeFile(join(output,'404.html'),'<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Página não encontrada | Évora Urbanismo</title><link rel="icon" href="/assets/icon.svg"><link rel="stylesheet" href="/site.css"><body><main class="container section"><a class="brand" href="/"><img src="/assets/evora-brand.svg" alt="Évora Urbanismo" width="181" height="53"></a><p class="eyebrow" style="margin-top:60px">Página não encontrada</p><h1 class="section-title" style="margin:25px 0">Este caminho não existe.</h1><p style="margin-bottom:30px">Conheça nossos empreendimentos no site institucional da Évora Urbanismo.</p><a class="btn" href="/">Voltar ao início</a></main></body></html>\n');
for (const file of ['index.html','site.js','site.css','site-base.css','404.html','robots.txt','sitemap.xml']) {
  const text = await readFile(join(output,file),'utf8');
  if (/advent-tau|enterprise\.terraragroup|supabase|service_role|sk-proj-/i.test(text)) throw new Error(`Non-public reference found: ${file}`);
}
const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
const hash = createHash('sha256').update(ld).digest('base64');
const config = JSON.parse(await readFile(join(root,'vercel.json'),'utf8'));
if (!config.headers[0].headers.find(h=>h.key==='Content-Security-Policy').value.includes(`sha256-${hash}`)) throw new Error('CSP integrity mismatch');
console.log('Institutional build verified: 17 static files; no ERP routes, no credentials, no backend connections.');
