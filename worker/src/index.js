/**
 * One run of the swarm: collect, normalize, score, store, publish.
 *
 * This is a Cloud Run job, not a service. It starts, does one pass, exits with
 * 0 or 1, and Cloud Scheduler decides when it runs again. There is no server
 * sitting idle between runs, which is why this costs about the price of a
 * coffee a month rather than a small instance.
 *
 *   npm run local     no Google account, writes ./out/*.jsonl
 *   npm start         needs PROJECT_ID, BQ_DATASET, BQ_TABLE, PUBSUB_TOPIC
 */

import { SOURCES } from './sources.js';
import { DEFAULT_PROFILE, scoreSignal } from './score.js';
import { localSink, gcpSink } from './sinks.js';

const env = (key, fallback) => process.env[key] ?? fallback;

export function buildRows(signals, profile = DEFAULT_PROFILE, now = Date.now()) {
  const seen = new Set();
  const rows = [];
  for (const signal of signals) {
    if (seen.has(signal.external_id)) continue; // two sources, one signal
    seen.add(signal.external_id);
    const { score, reasons, rejected } = scoreSignal(signal, profile, now);
    rows.push({
      ...signal,
      metrics: JSON.stringify(signal.metrics ?? {}),
      score,
      reasons: reasons.join('; '),
      qualified: !rejected,
      scored_at: new Date(now).toISOString(),
      run_id: env('CLOUD_RUN_EXECUTION', `local-${new Date(now).toISOString()}`),
    });
  }
  return rows.sort((a, b) => b.score - a.score);
}

async function main() {
  const queries = env('QUERIES', 'ai agents,agentic workflows,llm evals')
    .split(',')
    .map((q) => q.trim())
    .filter(Boolean);
  const limit = Number(env('LIMIT_PER_QUERY', '25'));
  const mode = env('RUN_MODE', 'gcp');

  const collected = [];
  const failures = [];
  for (const [name, fetchSignals] of Object.entries(SOURCES)) {
    for (const query of queries) {
      try {
        collected.push(...(await fetchSignals({ query, limit })));
      } catch (err) {
        // One dead source does not fail the run. It is recorded, and the run
        // reports it, so a source that is quietly broken shows up in the logs
        // instead of looking like a slow week.
        failures.push(`${name}/${query}: ${err.message}`);
      }
    }
  }

  const rows = buildRows(collected);
  const qualified = rows.filter((r) => r.qualified);

  const sink =
    mode === 'local'
      ? localSink()
      : await gcpSink({
          projectId: env('PROJECT_ID'),
          dataset: env('BQ_DATASET', 'swarm'),
          table: env('BQ_TABLE', 'signals'),
          topic: env('PUBSUB_TOPIC', 'qualified-leads'),
        });

  const stored = await sink.writeRows(rows);
  const published = await sink.publish(qualified);

  // Structured logs, because Cloud Logging indexes JSON fields and you will
  // want to chart these later without parsing strings.
  console.log(
    JSON.stringify({
      severity: failures.length ? 'WARNING' : 'INFO',
      message: 'swarm run complete',
      sink: sink.name,
      collected: collected.length,
      unique: rows.length,
      qualified: qualified.length,
      failures,
      ...stored,
      ...published,
    })
  );

  if (failures.length === Object.keys(SOURCES).length * queries.length) {
    throw new Error('every source failed');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(JSON.stringify({ severity: 'ERROR', message: err.message }));
    process.exit(1);
  });
}
