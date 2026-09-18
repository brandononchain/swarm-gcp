import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROFILE, freshness, scoreSignal } from '../src/score.js';
import { buildRows } from '../src/index.js';

const now = Date.parse('2026-09-18T00:00:00Z');
const signal = (over = {}) => ({
  source: 'github',
  external_id: 'github:1',
  title: 'acme/agent-runtime',
  body: 'agentic workflows with evals',
  signal_at: '2026-09-17T00:00:00Z',
  metrics: { stars: 40 },
  ...over,
});

test('freshness halves over the half life', () => {
  const fresh = freshness('2026-09-18T00:00:00Z', now, 14);
  const old = freshness('2026-09-04T00:00:00Z', now, 14);
  assert.equal(fresh, 1);
  assert.ok(Math.abs(old - 0.5) < 1e-9);
});

test('a deal breaker rejects whatever else matched', () => {
  const r = scoreSignal(signal({ title: 'awesome list of ai agents', body: 'hiring agentic llm evals' }), DEFAULT_PROFILE, now);
  assert.equal(r.score, 0);
  assert.equal(r.rejected, true);
  assert.match(r.reasons[0], /deal breaker/);
});

test('every score carries its reasons', () => {
  const r = scoreSignal(signal(), DEFAULT_PROFILE, now);
  assert.ok(r.score > 0 && r.score <= 1);
  assert.ok(r.reasons.some((x) => x.includes('agentic')));
  assert.ok(r.reasons.some((x) => x.startsWith('freshness')));
});

test('a stale signal scores below a fresh copy of itself', () => {
  const fresh = scoreSignal(signal(), DEFAULT_PROFILE, now).score;
  const stale = scoreSignal(signal({ signal_at: '2026-06-01T00:00:00Z' }), DEFAULT_PROFILE, now).score;
  assert.ok(stale < fresh);
});

test('attention alone cannot qualify a signal', () => {
  const r = scoreSignal(
    signal({ title: 'acme/design-tokens', body: 'a color palette', metrics: { stars: 90000 } }),
    DEFAULT_PROFILE,
    now
  );
  assert.equal(r.rejected, true);
});

test('buildRows dedupes by external id and sorts by score', () => {
  const rows = buildRows(
    [signal(), signal(), signal({ external_id: 'github:2', title: 'acme/notes', body: 'a notes app' })],
    DEFAULT_PROFILE,
    now
  );
  assert.equal(rows.length, 2);
  assert.ok(rows[0].score >= rows[1].score);
  assert.equal(typeof rows[0].metrics, 'string'); // BigQuery gets a JSON string
  assert.ok(rows[0].run_id);
});
