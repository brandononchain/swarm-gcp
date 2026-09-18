# swarm-gcp

The lead intelligence swarm that runs on GitHub Actions at
[brandononchain.com/automations](https://www.brandononchain.com/automations),
ported to Google Cloud.

Same pipeline, different machinery: **Cloud Scheduler** decides when,
a **Cloud Run job** does one pass and exits, **BigQuery** keeps the record,
**Pub/Sub** carries what qualified to whatever acts on it next, and all of it
is **Terraform** so the whole thing can be destroyed and rebuilt from nothing.

```
Cloud Scheduler ──▶ Cloud Run job ──┬──▶ BigQuery  (every signal, partitioned by day)
  every 2 hours      collect         └──▶ Pub/Sub   (only the ones above threshold)
                     normalize                  │
                     score in code              └──▶ dead letter after 5 failures
                     store + publish
```

## Run it with no Google account

```bash
cd worker && npm install
npm test                 # 6 tests, no network
RUN_MODE=local npm start # one real pass, writes worker/out/*.jsonl
```

That does everything the cloud version does except the storing. Read
`worker/out/qualified.jsonl` and you have the same rows BigQuery would hold.

## Run it on Google Cloud

`LEARN.md` walks the whole thing in eight steps, explaining each service as you
create it. Short version:

```bash
gcloud projects create swarm-gcp-yourname
gcloud config set project swarm-gcp-yourname
make build          # Cloud Build pushes the image to Artifact Registry
make apply          # Terraform creates everything else
make run            # one execution now instead of waiting for the schedule
make query          # top scoring signals, straight out of BigQuery
```

## What it costs

Every service here has a free tier that this workload sits inside.

| Service | Free tier | What this uses |
|---|---|---|
| Cloud Run jobs | 180,000 vCPU seconds a month | 12 runs a day at roughly 20 seconds each, about 7,200 |
| BigQuery | 1 TB scanned, 10 GB stored a month | a few MB a month, partitioned so queries scan one day |
| Pub/Sub | 10 GB a month | a few hundred small messages a day |
| Cloud Scheduler | 3 jobs | 1 |
| Artifact Registry | 0.5 GB | one image, older versions expire |

Expect a bill near zero, and set a budget alert anyway. `LEARN.md` step 8
covers that, because "near zero" is a claim you should verify rather than
trust.

## Design decisions worth knowing

- **A job, not a service.** The work is periodic. A Cloud Run service would sit
  there between runs waiting to be billed for readiness it does not need.
- **Scoring is code, not a prompt.** `worker/src/score.js` is deterministic and
  tested, and every score carries the reasons behind it. A model can write the
  opening line later; it does not get to decide what is worth your attention.
- **Idempotent writes.** BigQuery rows carry an `insertId`, so a retried run
  converges instead of duplicating leads.
- **Least privilege, twice.** The job can write one table and publish to one
  topic. The scheduler can start one job. Neither can do the other's work.
- **One dead source does not fail the run.** It is recorded in the structured
  log and the run continues. Every source failing is a real failure and exits 1.
