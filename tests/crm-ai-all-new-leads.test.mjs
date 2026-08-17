import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/20260814234600_crm_ai_all_new_leads.sql', import.meta.url),
  'utf8',
);

test('Bia is triggered from canonical crm_records inserts', () => {
  assert.match(migration, /after insert on public\.crm_records/i);
  assert.match(migration, /'lead_created'/);
  assert.match(migration, /'lead-created:' \|\| new\.id::text/);
});

test('Meta records wait for canonical attribution before AI analysis', () => {
  assert.match(migration, /new\.source_channel, ''\) = 'meta_lead_ads'/i);
  assert.match(migration, /new\.source, ''\) ilike 'Meta Lead Ads%'/i);
});

test('non-open CRM records are not approached', () => {
  assert.match(migration, /new\.record_status <> 'aberta'/i);
});

test('AI enqueue remains fail-open and tenant runtime gated', () => {
  assert.match(migration, /settings\.organization_id = new\.organization_id/i);
  assert.match(migration, /settings\.enabled/i);
  assert.match(migration, /settings\.mode = 'shadow'/i);
  assert.match(migration, /raise warning 'CRM AI enqueue fail-open/i);
  assert.match(migration, /raise warning 'CRM AI immediate dispatch fail-open/i);
});
