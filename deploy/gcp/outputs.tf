output "console_url" {
  description = "Console URL, after DNS and certificate activation."
  value       = "https://${var.domain}"
}
output "dns_address" {
  description = "Set the domain's A record to this address."
  value       = google_compute_global_address.console.address
}
output "ssh_command" {
  description = "Operator access requires OS Login and IAP permissions."
  value       = "gcloud compute ssh ${google_compute_instance.console.name} --project=${var.project_id} --zone=${var.zone} --tunnel-through-iap"
}
output "runtime_service_account" {
  description = "Control-plane runtime service account."
  value       = google_service_account.console.email
}
