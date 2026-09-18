output "run_job" {
  value       = google_cloud_run_v2_job.swarm.name
  description = "Start a run by hand: gcloud run jobs execute <this> --region <region>"
}

output "bigquery_table" {
  value       = "${var.project_id}.${google_bigquery_dataset.swarm.dataset_id}.${google_bigquery_table.signals.table_id}"
  description = "Query it: bq query --nouse_legacy_sql 'select * from `<this>` order by score desc limit 20'"
}

output "pubsub_subscription" {
  value       = google_pubsub_subscription.qualified_pull.name
  description = "Read what qualified: gcloud pubsub subscriptions pull <this> --auto-ack --limit 5"
}

output "image_repo" {
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.swarm.repository_id}"
  description = "Push worker images here."
}
