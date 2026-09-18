/**
 * Two sinks, one interface. `local` writes JSON lines to ./out so you can run
 * the whole pipeline with no Google account and no spend. `gcp` writes rows to
 * BigQuery and publishes the ones above the threshold to Pub/Sub.
 *
 * Insert ids make the BigQuery write idempotent: rerunning the job over the
 * same window does not duplicate rows, which matters because Cloud Run jobs
 * retry on failure and a retry is a rerun.
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
        // insertId is what makes a retried job safe: BigQuery drops a row it
        // has already seen with the same id inside its dedup window.
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
