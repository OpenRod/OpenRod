variable "project_id" {
  description = "Existing GCP project with billing enabled."
  type        = string
  default     = "openshell-viewer"
}
variable "region" {
  description = "GCP region; use us-east1, not AWS us-east-1."
  type        = string
  default     = "us-east1"
}
variable "zone" {
  description = "Zone for the single organization VM."
  type        = string
  default     = "us-east1-b"
}
variable "org_id" {
  description = "Unique organization ID; must match the openrod_org custom claim. Use a separate state per organization."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,24}$", var.org_id))
    error_message = "org_id must start with a lowercase letter and contain 2 to 25 lowercase letters, digits or dashes."
  }
}
variable "domain" {
  description = "Customer console DNS name; point its A record to the load balancer output."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]+\\.[a-z]{2,}$", var.domain))
    error_message = "Supply a DNS name without a scheme or path."
  }
}
variable "machine_type" {
  description = "Initial Docker-backed capacity; resize after workload measurement."
  type        = string
  default     = "e2-standard-4"
}
