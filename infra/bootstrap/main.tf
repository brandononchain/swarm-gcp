# Run this once, before the first `terraform init` in ../. It creates the
# GCS bucket that will hold the real Terraform state. This module
# deliberately keeps its own state locally: a bucket can't bootstrap the
# backend that depends on it existing.
#
#   cd infra/bootstrap
#   terraform init
#   terraform apply -var="project_id=$(gcloud config get-value project)"
#
# Then, back in infra/:
#   cp backend.hcl.example backend.hcl   # set bucket to this module's output
#   terraform init -backend-config=backend.hcl

terraform {
  required_version = ">= 1.6"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

variable "project_id" {
  type        = string
  description = "Same project the rest of infra/ deploys into."
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "Bucket location. Regional is fine; state files are tiny."
}

resource "google_storage_bucket" "tfstate" {
  name     = "${var.project_id}-tfstate"
  location = var.region
  project  = var.project_id

  # force_destroy stays false on purpose: deleting state by accident is the
  # kind of mistake this bucket exists to prevent.
  force_destroy               = false
  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  # Old state versions are cheap to keep and expensive to need and not have,
  # but they shouldn't accumulate forever either.
  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      num_newer_versions = 20
    }
  }
}

output "bucket" {
  value       = google_storage_bucket.tfstate.name
  description = "Put this in infra/backend.hcl as `bucket`."
}
