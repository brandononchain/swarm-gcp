variable "project_id" {
  type        = string
  description = "The Google Cloud project. Make a new one for this; deleting a project is the cleanest possible uninstall."
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "Cloud Run, Artifact Registry and Scheduler all live here. us-central1 has the widest free tier."
}

variable "image" {
  type        = string
  description = "Full image URL, e.g. us-central1-docker.pkg.dev/PROJECT/swarm/worker:TAG. Build and push it before the first apply."
}

variable "schedule" {
  type        = string
  default     = "0 */2 * * *"
  description = "Cron for Cloud Scheduler. Every two hours, matching the swarm it replaces."
}

variable "queries" {
  type        = string
  default     = "ai agents,agentic workflows,llm evals"
  description = "Comma separated search terms handed to every source."
}

variable "table_expiration_days" {
  type        = number
  default     = 365
  description = "Partitions older than this are deleted. Storage is cheap; unbounded storage is not."
}
