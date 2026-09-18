/* Run from the repository root: node scripts/test-solaris-instagram.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'src/lib/forms/solaris.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
assert.equal(source, fs.readFileSync(path.join(root, 'supabase/functions/solaris-form/validation.ts'), 'utf8'), 'Frontend/API and Edge validators must remain identical');
const mod = new Module(sourcePath, module);
mod.filename = sourcePath;
mod.paths = module.paths;
mod._compile(ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, sourcePath);
const {normalizeInstagram,validateSolarisSubmission} = mod.exports;
let checks = 1;
const equal = (actual, expected, message) => {assert.deepEqual(actual, expected, message);checks++;};
const valid = [['@Joao.Silva','joao.silva'],[' joao_silva ','joao_silva'],['https://www.instagram.com/Joao.Silva/?igsh=test','joao.silva'],['instagram.com/joao_silva/','joao_silva'],['www.instagram.com/joao_silva','joao_silva'],['a','a'],['a'.repeat(30),'a'.repeat(30)]];
for(const [raw,normalized] of valid)equal(normalizeInstagram(raw),normalized,raw);
const invalid = ['',null,42,{},'@','@@joao','nome com espaço','.joao','joao.','joao..silva','joao/silva','a'.repeat(31),'https://instagram.com.evil.example/joao/','https://evil.example/joao/','https://instagram.com/p/123/','https://instagram.com/reel/123/','https://instagram.com/stories/joao/123/','https://user:password@instagram.com/joao/','javascript:alert(1)','https://instagram.com:444/joao/'];
for(const raw of invalid)equal(normalizeInstagram(raw),null,String(raw));
// Synthetic values are used only in memory. This test never submits a lead.
const base = {requestId:'11111111-2222-4333-8444-555555555555',name:'Teste local sem envio',phone:'(34) 99999-8877',consent:true,purpose:'morar',attribution:{utm_campaign:'teste',instagram:'never_forward_this'}};
for(const instagram of [undefined,null,'','   ']) {
 const parsed=validateSolarisSubmission({...base,instagram});
 assert.ok(parsed);checks++;
 equal(parsed.instagram,null,'Instagram is optional');
 equal(parsed.instagramConsent,false,'WhatsApp consent must not grant Instagram consent');
 equal(parsed.attribution,{utm_campaign:'teste'},'Attribution remains allowlisted');
}
const opted=validateSolarisSubmission({...base,instagram:'@Joao.Silva',instagramConsent:true});
equal(opted.instagram,'joao.silva','Opt-in profile normalized');
equal(opted.instagramConsent,true,'Explicit opt-in accepted');
equal(validateSolarisSubmission({...base,instagram:'@joao',instagramConsent:false}).instagramConsent,false,'Handle allowed without personalization consent');
for(const bad of [{instagramConsent:true},{instagram:'@joao',instagramConsent:'true'},{instagram:'@joao',instagramConsent:1},{instagram:42},{instagram:'https://instagram.com/p/123/'},{consent:false},{website:'spam'},null,[]]) {
 equal(validateSolarisSubmission(bad===null||Array.isArray(bad)?bad:{...base,...bad}),null,'Invalid input rejected');
}
console.log(`${checks} assertions passed; no network requests or CRM writes.`);
