# Short commands for the long ones. Read the real command in each recipe: the
# point is to learn what gcloud is doing, not to hide it.

PROJECT ?= $(shell gcloud config get-value project 2>/dev/null)
REGION  ?= us-central1
TAG     ?= v1
IMAGE   = $(REGION)-docker.pkg.dev/$(PROJECT)/swarm/worker:$(TAG)

test:            ## run the unit tests
	cd worker && npm test

local:           ## one full pass with no Google account, writes worker/out/
	cd worker && RUN_MODE=local npm start

build:           ## build and push the worker image to Artifact Registry
	gcloud builds submit worker --tag $(IMAGE)

plan:            ## what Terraform would change
	cd infra && terraform plan -var="project_id=$(PROJECT)" -var="image=$(IMAGE)"

apply:           ## create or update everything
	cd infra && terraform apply -var="project_id=$(PROJECT)" -var="image=$(IMAGE)"

run:             ## start one run by hand instead of waiting for the schedule
	gcloud run jobs execute swarm-worker --region $(REGION) --wait

logs:            ## the last run's structured logs
	gcloud logging read 'resource.type="cloud_run_job"' --limit 20 --format='value(timestamp,jsonPayload.message,jsonPayload.qualified)'

query:           ## top scoring signals from the last day
	bq query --nouse_legacy_sql 'select score, source, title, url from `$(PROJECT).swarm.signals` where scored_at > timestamp_sub(current_timestamp(), interval 1 day) and qualified order by score desc limit 20'

pull:            ## read what was published as qualified
	gcloud pubsub subscriptions pull qualified-leads-pull --auto-ack --limit 5

cost:            ## this month so far, by service
	gcloud billing accounts list

destroy:         ## remove everything this created
	cd infra && terraform destroy -var="project_id=$(PROJECT)" -var="image=$(IMAGE)"

.PHONY: test local build plan apply run logs query pull cost destroy
