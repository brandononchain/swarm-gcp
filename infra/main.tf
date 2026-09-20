# Everything the swarm needs on Google Cloud, in one apply.
#
# Read this file top to bottom once before running it. The shape is:
#   Scheduler (when) -> Cloud Run job (the work) -> BigQuery (the record)
#                                                -> Pub/Sub (what happens next)
# Each piece runs as its own service account with only the permissions it uses,
# which is the part of a cloud build that interviewers actually ask about.

locals {
  services = [
    "run.googleapis.com",
    "cloudscheduler.googleapis.com",
    "bigquery.googleapis.com",
    "pubsub.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
  ]
}

# Needed to build the Pub/Sub service agent's email below. This is not
# related to the project you run Terraform as; it is the identity Google
# manages on your behalf for the Pub/Sub service itself.
data "google_project" "this" {
  project_id = var.project_id
}

# An API you have not enabled is the most common first error on a new project.
resource "google_project_service" "enabled" {
  for_each                   = toset(local.services)
  service                    = each.value
  disable_dependent_services = false
  disable_on_destroy         = false
}

# ---------------------------------------------------------------- registry ---

resource "google_artifact_registry_repository" "swarm" {
  location      = var.region
  repository_id = "swarm"
  format        = "DOCKER"
  description   = "Worker images for the lead swarm"

  # Keep the last 10 images and let the rest expire, so storage does not creep.
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }

  depends_on = [google_project_service.enabled]
}

# ---------------------------------------------------------------- identity ---

# The job's identity. It can write to one table and publish to one topic.
# Nothing else. If this service account leaked tomorrow, that is the blast
# radius.
resource "google_service_account" "job" {
  account_id   = "swarm-job"
  display_name = "Lead swarm Cloud Run job"
}

# Scheduler needs its own identity to invoke the job, because "who started this
# run" should be answerable from the audit log.
resource "google_service_account" "scheduler" {
  account_id   = "swarm-scheduler"
  display_name = "Lead swarm scheduler"
}

# ---------------------------------------------------------------- big query ---

resource "google_bigquery_dataset" "swarm" {
  dataset_id                 = "swarm"
  location                   = "US"
  description                = "Signals collected by the lead swarm"
  delete_contents_on_destroy = true
  depends_on                 = [google_project_service.enabled]
}

resource "google_bigquery_table" "signals" {
  dataset_id          = google_bigquery_dataset.swarm.dataset_id
  table_id            = "signals"
  deletion_protection = false

  # Partitioning by day is what keeps a query over one week from scanning a
  # year. BigQuery bills on bytes scanned, so this is the cost control.
  time_partitioning {
    type          = "DAY"
    field         = "scored_at"
    expiration_ms = var.table_expiration_days * 24 * 60 * 60 * 1000
  }

  # Clustering puts rows with the same source and score range near each other,
  # so the common filters read fewer bytes still.
  clustering = ["source", "qualified"]

  schema = jsonencode([
    { name = "external_id", type = "STRING", mode = "REQUIRED" },
    { name = "source", type = "STRING", mode = "REQUIRED" },
    { name = "title", type = "STRING" },
    { name = "url", type = "STRING" },
    { name = "body", type = "STRING" },
    { name = "author", type = "STRING" },
    { name = "signal_at", type = "TIMESTAMP" },
    { name = "metrics", type = "JSON" },
    { name = "score", type = "FLOAT" },
    { name = "reasons", type = "STRING" },
    { name = "qualified", type = "BOOLEAN" },
    { name = "scored_at", type = "TIMESTAMP", mode = "REQUIRED" },
    { name = "run_id", type = "STRING" },
  ])
}

resource "google_bigquery_table_iam_member" "job_writes" {
  dataset_id = google_bigquery_dataset.swarm.dataset_id
  table_id   = google_bigquery_table.signals.table_id
  role       = "roles/bigquery.dataEditor"
  member     = "serviceAccount:${google_service_account.job.email}"
}

# Running a query needs the right to start a job in the project, which is
# separate from the right to read a table. This trips up everyone once.
resource "google_project_iam_member" "job_bq_user" {
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${google_service_account.job.email}"
}

# ----------------------------------------------------------------- pub sub ---

resource "google_pubsub_topic" "qualified" {
  name       = "qualified-leads"
  depends_on = [google_project_service.enabled]
}

# Messages that fail delivery five times land here instead of retrying forever.
resource "google_pubsub_topic" "dead_letter" {
  name = "qualified-leads-dead-letter"
}

resource "google_pubsub_subscription" "qualified_pull" {
  name  = "qualified-leads-pull"
  topic = google_pubsub_topic.qualified.id

  # Long enough for a human to look, short enough that a forgotten subscription
  # does not hold messages for a month.
  message_retention_duration = "604800s" # 7 days
  ack_deadline_seconds       = 60

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter.id
    max_delivery_attempts = 5
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

# dead_letter_policy above is otherwise inert. Pub/Sub moves a message to the
# dead-letter topic by having its own service agent publish to that topic and
# pull (to ack) from the source subscription on your behalf. Neither
# permission exists by default, so without these two bindings a message that
# exhausts max_delivery_attempts just keeps failing past the limit instead of
# ever reaching qualified-leads-dead-letter -- a common and silent Terraform
# gotcha.
resource "google_pubsub_topic_iam_member" "pubsub_sa_publishes_dead_letter" {
  topic  = google_pubsub_topic.dead_letter.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription_iam_member" "pubsub_sa_subscribes_source" {
  subscription = google_pubsub_subscription.qualified_pull.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_topic_iam_member" "job_publishes" {
  topic  = google_pubsub_topic.qualified.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.job.email}"
}

# --------------------------------------------------------------- cloud run ---

resource "google_cloud_run_v2_job" "swarm" {
  name     = "swarm-worker"
  location = var.region

  template {
    template {
      service_account = google_service_account.job.email
      # A failed run is retried once, then left failed. Retrying forever on a
      # broken source burns money and hides the breakage.
      max_retries = 1
      timeout     = "600s"

      containers {
        image = var.image

        env {
          name  = "PROJECT_ID"
          value = var.project_id
        }
        env {
          name  = "BQ_DATASET"
          value = google_bigquery_dataset.swarm.dataset_id
        }
        env {
          name  = "BQ_TABLE"
          value = google_bigquery_table.signals.table_id
        }
        env {
          name  = "PUBSUB_TOPIC"
          value = google_pubsub_topic.qualified.name
        }
        env {
          name  = "QUERIES"
          value = var.queries
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }
      }
    }
  }

  depends_on = [google_project_service.enabled]
}

# --------------------------------------------------------------- scheduler ---

resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_job" {
  name     = google_cloud_run_v2_job.swarm.name
  location = google_cloud_run_v2_job.swarm.location
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "every_two_hours" {
  name      = "swarm-schedule"
  schedule  = var.schedule
  time_zone = "America/Chicago"
  region    = var.region

  # Scheduler calls the Cloud Run Admin API to start one execution. There is no
  # public endpoint on the job, so nothing outside this project can trigger it.
  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.swarm.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }

  retry_config {
    retry_count = 1
  }

  depends_on = [google_project_service.enabled]
}
