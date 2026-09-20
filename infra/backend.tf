# State lives in the versioned GCS bucket created by infra/bootstrap, not on
# a laptop. A backend block cannot reference variables or a .tfvars file --
# Terraform needs the bucket name before it has read any of that -- so the
# bucket is supplied at init time instead.
#
#   cd infra/bootstrap && terraform init && terraform apply -var="project_id=$(gcloud config get-value project)"
#   cd .. && cp backend.hcl.example backend.hcl   # fill in the bucket name from the output above
#   terraform init -backend-config=backend.hcl
#
# Or just `make bootstrap && make init`, which does the same thing.
terraform {
  backend "gcs" {}
}
