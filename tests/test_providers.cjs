const test = require('node:test');
const assert = require('node:assert/strict');
const { quotaSamples, remoteSyncSummary } = require('../static/providers.js');

test('quota samples isolate provider windows, resets and gaps in history', () => {
  const reset = Date.parse('2026-09-25T12:00:00Z');
  const limit = { key: 'codex:primary', resets_at: new Date(reset).toISOString(), window_minutes: 300 };
  const sample = { key: limit.key, resets_at: limit.resets_at, observed_ms: reset - 60000, utilization: 20 };
  const result = quotaSamples([
    sample,
    { ...sample, key: 'other:primary' },
    { ...sample, resets_at: '2026-09-26T12:00:00Z' },
    { ...sample, observed_ms: reset - 301 * 60000 },
    { ...sample, observed_ms: reset },
    { ...sample, utilization: NaN },
  ], limit);
  assert.deepEqual(result, [sample]);
  assert.deepEqual(quotaSamples(null, limit), []);
});

test('remote sync summary lists failures per provider and successes once per host', () => {
  const at = '2026-10-08T12:00:00Z';
  const lines = remoteSyncSummary([
    ['claude', { remotes: [{ host: 'box', ok: true, synced_at: at }, { host: 'other', ok: false, error: 'timeout after 60s', synced_at: at }] }],
    ['codex', { remotes: [{ host: 'box', ok: true, synced_at: at }, { host: 'other', ok: true, synced_at: at }] }],
    ['codex', null],
  ], text => `<${text}>`, () => '12:00');
  assert.deepEqual(lines, ['other (claude): <falha no host remoto:> timeout after 60s', 'box: <sincronizado às> 12:00']);
  assert.deepEqual(remoteSyncSummary([['claude', undefined]], t => t, () => ''), []);
});
