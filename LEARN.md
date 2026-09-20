# Learn this by building it

Eight steps. Each one has a thing to run, a thing to look at, and a question to
answer. If you can answer all eight questions you know this stack well enough
to design on it in an interview, which is the point.

Budget about three hours. Nothing here should cost more than a dollar.

---

## 1. Run it with no cloud at all

```bash
cd worker && npm install && npm test
RUN_MODE=local npm start
head -3 out/qualified.jsonl
```

**Look at** `worker/src/index.js`. The whole pipeline is collect, dedupe,
score, store, publish. The only thing the cloud changes is where the last two
steps write.

**Question:** which line decides whether this run talks to Google, and why is
that a single line?

---

## 2. Make a project and understand billing

```bash
gcloud projects create swarm-gcp-yourname --name="Swarm GCP"
gcloud config set project swarm-gcp-yourname
gcloud billing projects link swarm-gcp-yourname --billing-account=YOUR_BILLING_ID
gcloud services list --enabled
```

A project is the unit of isolation, the unit of billing, and the unit of
deletion. This is why the advice is always "make a new project", not "reuse
one": deleting the project removes everything, including things you forgot.

**Question:** what is the difference between a project, a billing account and
an organization, and which one owns the quota you will eventually hit?

---

## 3. Build the image with Cloud Build

```bash
make build
gcloud artifacts docker images list us-central1-docker.pkg.dev/$(gcloud config get-value project)/swarm
```

`make build` runs `gcloud builds submit`, which uploads `worker/` to Cloud
Build, builds the Dockerfile on Google's machines, and pushes the result to
Artifact Registry. No Docker daemon needed locally.

**Look at** `worker/Dockerfile`. It installs production dependencies only and
runs as the `node` user rather than root.

**Question:** why does the image have no build step and no shell entrypoint?

---

## 4. Point Terraform at remote state, then read it before you apply

```bash
make bootstrap                                 # one-time: creates the state bucket
cp infra/backend.hcl.example infra/backend.hcl # set bucket to the output above
make init                                      # terraform init -backend-config=backend.hcl
cd infra && terraform plan \
  -var="project_id=$(gcloud config get-value project)" \
  -var="image=us-central1-docker.pkg.dev/$(gcloud config get-value project)/swarm/worker:v1"
```

Read the plan output. Every resource in it is in `infra/main.tf` with a comment
saying why it exists. The two service accounts are the part to slow down on:
one identity for the job, one for the scheduler, each with the smallest role
that works.

**Question:** the job has both `bigquery.dataEditor` on one table and
`bigquery.jobUser` on the project. Why are both needed, and what would break if
you deleted either?

---

## 5. Apply, then run it by hand

```bash
make apply
make run
make logs
```

`make run` starts one execution instead of waiting two hours. `make logs` reads
the structured JSON the worker prints. Cloud Logging indexes those fields, so
`jsonPayload.qualified` is queryable rather than a string you would have to
parse.

**Question:** the job sets `max_retries = 1`. What happens to the BigQuery rows
if the run fails halfway and retries, and why does `worker/src/sinks.js` call
that "best-effort" safe rather than fully safe?

---

## 6. Query what it collected

```bash
make query
bq query --nouse_legacy_sql \
  'select source, countif(qualified) as good, count(*) as all_rows
   from `'"$(gcloud config get-value project)"'.swarm.signals`
   where scored_at > timestamp_sub(current_timestamp(), interval 1 day)
   group by source'
```

Now remove the `where` clause and run it again. Watch the bytes scanned in the
output change. That number is the bill.

**Question:** the table is partitioned on `scored_at` and clustered on
`source, qualified`. Which of those two saved you money in the query above, and
which one would save money in a query filtering only by source?

---

## 7. Watch a message move

```bash
make pull
gcloud pubsub subscriptions describe qualified-leads-pull
```

Pull the messages and note that they come back again if you do not acknowledge
them. That is the point: Pub/Sub holds a message until something confirms it
handled it, retries with backoff, and after five failures moves it to the dead
letter topic instead of retrying forever -- which only works because
`infra/main.tf` also grants the Pub/Sub service agent publisher on the
dead-letter topic and subscriber on this subscription. Skip either binding and
the dead-letter policy silently does nothing.

**Question:** the worker publishes with an ordering key of `source`. What does
that guarantee, and what does it deliberately not guarantee?

---

## 8. Put a cost ceiling on it, then tear it down

Set a budget alert in the console under Billing, Budgets and alerts. Five
dollars, alert at 50, 90 and 100 percent. Do this before you forget the project
exists.

```bash
make destroy                                   # removes everything Terraform made
cd infra/bootstrap && terraform destroy -var="project_id=$(gcloud config get-value project)" # removes the state bucket
gcloud projects delete $(gcloud config get-value project)   # removes the rest
```

**Question:** `terraform destroy` leaves a few things behind. Which ones, and
why does deleting the project matter more than the destroy?

### 8b. Deploy from CI instead of by hand

`.github/workflows/deploy.yml` builds the image and runs `terraform apply` on
every push to `main`, authenticating with Workload Identity Federation so no
service account key is ever stored in GitHub. To turn it on:

1. Create a Workload Identity Pool + Provider trusting `repo:brandononchain/swarm-gcp`.
2. Create a deploy service account, grant it just the roles `infra/main.tf`
   needs (project IAM admin over the resources it manages, not `roles/owner`),
   and let the pool impersonate it.
3. Set repo variables `GCP_PROJECT_ID`, `GCP_REGION`, `TF_STATE_BUCKET` and
   secrets `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA`.

**Question:** why does `permissions: id-token: write` replace a downloaded
service account key, and what would an attacker gain from stealing this
workflow's credentials versus a long-lived key?

---

## What to do next, in order

1. **Swap a source.** Replace the GitHub search in `worker/src/sources.js` with
   an Apify actor. Nothing downstream changes, which is the test of whether the
   normalized shape was right.
2. **Add a subscriber.** A second Cloud Run job, or a Cloud Function, that pulls
   from `qualified-leads` and drafts the opening line. That is where a model
   belongs: after the scoring, never inside it.
3. **Tighten the CD service account.** Step 8b ships CI/CD wired up; the next
   move is scoping the deploy service account down to exactly the roles
   `infra/main.tf` grants, instead of anything broader used to get it working.
4. **Make BigQuery writes exactly-once.** insertId dedup is best-effort (see
   `worker/src/sinks.js`). If a downstream consumer can't tolerate duplicates,
   land rows in a staging table and `MERGE` into `signals` on `external_id`
   instead of streaming inserts directly.

Each of those is a paragraph you can defend in an interview, which is worth
more than the certification you could buy with the same three hours.
