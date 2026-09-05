import assert from 'node:assert/strict';
import test from 'node:test';
import { CrmReconciliationError, isCrmOperationsSnapshot, runCrmReconciliation } from '../src/lib/crm/operations.ts';

const batch = (reviewed: number, changed: number, cursor: string | null, more: boolean) => ({
  data: { reviewed, changed, next_after_id: cursor, has_more: more, external_delivery: false }, error: null,
});

test('processes all pages with keyset cursor and reports confirmed changes only', async () => {
  const cursors: (string | null)[] = [];
  const progress: number[] = [];
  const result = await runCrmReconciliation(after => {
    cursors.push(after);
    return Promise.resolve(after === null ? batch(100, 18, 'lead-100', true) : batch(3, 0, 'lead-103', false));
  }, current => progress.push(current.reviewed));
  assert.deepEqual(cursors, [null, 'lead-100']);
  assert.deepEqual(progress, [100, 103]);
  assert.deepEqual(result, { reviewed: 103, changed: 18 });
});

test('empty CRM completes without claiming work', async () => {
  assert.deepEqual(await runCrmReconciliation(() => Promise.resolve(batch(0, 0, null, false))), { reviewed: 0, changed: 0 });
});

test('server error after committed batch exposes partial progress and does not continue', async () => {
  let calls = 0;
  await assert.rejects(runCrmReconciliation(() => {
    calls += 1;
    return Promise.resolve(calls === 1 ? batch(100, 5, 'cursor', true) : { data: null, error: { code: '42501' } });
  }), error => {
    assert.ok(error instanceof CrmReconciliationError);
    assert.deepEqual(error.progress, { reviewed: 100, changed: 5 });
    assert.match(error.message, /perfil/);
    return true;
  });
  assert.equal(calls, 2);
});

test('network failure is not reported as successful completion', async () => {
  await assert.rejects(runCrmReconciliation(() => Promise.reject(new Error('network'))), error => {
    assert.ok(error instanceof CrmReconciliationError);
    assert.deepEqual(error.progress, { reviewed: 0, changed: 0 });
    return true;
  });
});

test('repeated cursor stops instead of looping or double-counting', async () => {
  let calls = 0;
  await assert.rejects(runCrmReconciliation(() => {
    calls += 1;
    return Promise.resolve(batch(1, 1, 'same', true));
  }), error => {
    assert.ok(error instanceof CrmReconciliationError);
    assert.deepEqual(error.progress, { reviewed: 1, changed: 1 });
    return true;
  });
  assert.equal(calls, 2);
});

test('malformed counts and possible external actions violate the execution contract', async () => {
  for (const overrides of [{ changed: 11 }, { reviewed: -1 }, { external_delivery: true }, { has_more: true, next_after_id: null }]) {
    const response = batch(10, 1, null, false);
    await assert.rejects(runCrmReconciliation(() => Promise.resolve({ ...response, data: { ...response.data, ...overrides } })), CrmReconciliationError);
  }
});

test('snapshot validates canonical categories and change records before rendering', () => {
  const snapshot = {
    generated_at: '2026-09-05T12:00:00Z', category_limit: 50, can_reconcile: false,
    summary: { decision: 0, missing_data: 0, failed: 0, completed: 1, processing: 0 },
    items: [{ id: 'event', lead_id: 'lead', lead_name: 'Teste', category: 'completed', title: 'Atualizado', detail: 'Histórico', occurred_at: null, changes: { next_action_at: { before: null, after: '2026-09-06T12:00:00Z' } } }],
  };
  assert.equal(isCrmOperationsSnapshot(snapshot), true);
  assert.equal(isCrmOperationsSnapshot({ ...snapshot, summary: { ...snapshot.summary, failed: -1 } }), false);
  assert.equal(isCrmOperationsSnapshot({ ...snapshot, items: [{ ...snapshot.items[0], changes: { next_action_at: null } }] }), false);
});
