import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {normalizePhone,validateSolarisSubmission} from '../src/lib/forms/solaris.ts';
const valid={requestId:'f382e0d3-e8ab-4da4-934b-a939367273f2',name:'Franco',phone:'(11) 91766-4123',purpose:'investir',budget:'acima_500',consent:true,website:'',attribution:{utm_source:'instagram'}};
test('normalizes national and international WhatsApp without changing the number',()=>{assert.equal(normalizePhone(valid.phone),'+5511917664123');assert.equal(normalizePhone('+55 11 91766-4123'),'+5511917664123');assert.equal(normalizePhone('00 99999-9999'),null);assert.equal(normalizePhone('11 11111-1111'),null)});
test('requires contact, purpose and explicit consent',()=>{assert.ok(validateSolarisSubmission(valid));for(const delta of [{consent:false},{purpose:''},{budget:'250_300'},{phone:''},{name:'A'},{requestId:'not-an-id'},{website:'spam'}])assert.equal(validateSolarisSubmission({...valid,...delta}),null)});
test('does not accept caller organization, CRM id or timestamps',()=>{const result=validateSolarisSubmission({...valid,organizationId:'other',crmRecordId:'other',createdAt:'2000-01-01',attribution:{utm_source:'instagram',secret:'no',utm_campaign:'a'.repeat(500)}});assert.ok(result);assert.equal('organizationId' in result,false);assert.equal('createdAt' in result,false);assert.equal(result.attribution.secret,undefined);assert.equal(result.attribution.utm_campaign.length,200)});

test('accepts a submission without investment and preserves legacy answers',()=>{
  const {budget,...withoutBudget}=valid;
  assert.equal(validateSolarisSubmission(withoutBudget)?.budget,null);
  assert.equal(validateSolarisSubmission({...withoutBudget,budget:null})?.budget,null);
  assert.equal(validateSolarisSubmission({...withoutBudget,budget})?.budget,'acima_500');
  assert.equal(validateSolarisSubmission({...withoutBudget,budget:'300_500'})?.budget,'300_500');
  for(const budget of ['',0,false,{},'nao_sei'])assert.equal(validateSolarisSubmission({...withoutBudget,budget}),null);
});
test('the Edge Function accepts the same submissions as the web endpoint',async()=>{
  const {validateSolarisSubmission:edgeValidate}=await import('../supabase/functions/solaris-form/validation.ts');
  const {budget,...withoutBudget}=valid;
  for(const input of [valid,withoutBudget,{...withoutBudget,budget:null},{...withoutBudget,budget:''},{...withoutBudget,consent:false}])
    assert.deepEqual(edgeValidate(input),validateSolarisSubmission(input));
});
