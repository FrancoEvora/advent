import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectBiaResources } from '../src/components/bia/conversation-resources.ts';
import type { PublicAgentSimulation } from '../src/lib/public-agent/types.ts';

test('restored and newly received cards are deduplicated without losing changed simulations', () => {
  const simulation = { unitCode: 'A1', generatedAt: '2026-09-08', downPayment: 10000 } as PublicAgentSimulation;
  const attachment = { type: 'document' as const, title: 'Proposta', url: 'https://example.com/proposta.pdf' };
  const result = collectBiaResources([{ simulation, attachments: [attachment] }, { simulation: { ...simulation }, attachments: [attachment] }, { simulation: { ...simulation, downPayment: 12000 } }]);
  assert.equal(result.simulations.length, 2);
  assert.equal(result.attachments.length, 1);
  assert.equal(result.simulations[1].downPayment, 12000);
});
test('archive ignores missing, malformed and executable URLs', () => {
  const attachments = ['javascript:alert(1)', 'data:text/html,test', '', 'https://example.com/folder/file.pdf'].map(url => ({ type: 'document' as const, title: 'Arquivo', url }));
  assert.deepEqual(collectBiaResources([{ attachments }]).attachments.map(a => a.url), ['https://example.com/folder/file.pdf']);
});
