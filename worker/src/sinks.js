/**
 * Two sinks, one interface. `local` writes JSON lines to ./out so you can run
 * the whole pipeline with no Google account and no spend. `gcp` writes rows to
 * BigQuery and publishes the ones above the threshold to Pub/Sub.
 *
 * Insert ids make the BigQuery write idempotent on a best-effort basis, not a
 * guaranteed one: streaming inserts dedupe by insertId only within a short,
 * undocumented window (historically on the order of a minute). A retry that
 * lands inside that window is deduped for free; a retry that lands outside
 * it can still produce a duplicate row for the same external_id. That's an
 * acceptable risk at this workload's volume, but it is not a correctness
 * guarantee -- a downstream consumer that cannot tolerate duplicates should
 * dedupe on external_id itself (e.g. with a MERGE or a dedup view).
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export function localSink({ dir = 'out' } = {}) {
  return {
    name: 'local',
    async writeRows(rows) {
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, 'signals.jsonl');
      await fs.appendFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      return { written: rows.length, file };
    },
    async publish(messages) {
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, 'qualified.jsonl');
      await fs.appendFile(file, messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
      return { published: messages.length, file };
    },
  };
}

export async function gcpSink({ projectId, dataset, table, topic }) {
  const { BigQuery } = await import('@google-cloud/bigquery');
  const { PubSub } = await import('@google-cloud/pubsub');
  const bq = new BigQuery({ projectId });
  const pubsub = new PubSub({ projectId });

  return {
    name: 'gcp',
    async writeRows(rows) {
      if (rows.length === 0) return { written: 0 };
      await bq
        .dataset(dataset)
        .table(table)
        // insertId dedupes a retry that lands within BigQuery's short,
        // undocumented streaming dedup window. It reduces duplicates, it does
        // not eliminate them -- see the file header comment.
        .insert(rows.map((r) => ({ insertId: r.external_id, json: r })), { raw: true });
      return { written: rows.length };
    },
    async publish(messages) {
      if (messages.length === 0) return { published: 0 };
      const t = pubsub.topic(topic);
      await Promise.all(
        messages.map((m) =>
          t.publishMessage({
            json: m,
            // Ordering key keeps one source's messages in order for any
            // subscriber that asks for ordered delivery.
            orderingKey: m.source,
            attributes: { source: m.source, score: String(m.score) },
          })
        )
      );
      return { published: messages.length };
    },
  };
}
