# This database is control-plane state, not customer workspace data.
resource "google_project_service" "firestore" {
  service            = "firestore.googleapis.com"
  disable_on_destroy = false
}
resource "google_firestore_database" "cloud" {
  project                 = var.project_id
  name                    = "openrod-cloud"
  location_id             = var.region
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "ABANDON"
  depends_on              = [google_project_service.firestore]
  lifecycle { prevent_destroy = true }
}
resource "google_project_iam_custom_role" "machine_registry" {
  role_id     = "openrod_${replace(var.org_id, "-", "_")}_machines"
  title       = "ShellOS private machine registry"
  permissions = ["datastore.databases.get", "datastore.entities.get", "datastore.entities.create", "datastore.entities.update"]
}
resource "google_project_iam_member" "machine_registry" {
  project = var.project_id
  role    = google_project_iam_custom_role.machine_registry.name
  member  = "serviceAccount:${google_service_account.console.email}"
  condition {
    title      = "cloud_registry_only"
    expression = "resource.name == 'projects/${var.project_id}/databases/openrod-cloud'"
  }
}
resource "google_project_iam_custom_role" "machine_provisioner" {
  role_id     = "openrod_${replace(var.org_id, "-", "_")}_provisioner"
  title       = "ShellOS fixed private worker provisioning"
  permissions = ["compute.instances.create", "compute.instances.get", "compute.instances.setMetadata", "compute.instances.setLabels", "compute.instances.setTags", "compute.disks.create", "compute.disks.use", "compute.subnetworks.use"]
}
resource "google_project_iam_member" "machine_provisioner" {
  project = var.project_id
  role    = google_project_iam_custom_role.machine_provisioner.name
  member  = "serviceAccount:${google_service_account.console.email}"
}
resource "google_compute_firewall" "workers" {
  name          = "${local.name}-private-workers"
  network       = google_compute_network.customer.id
  source_ranges = ["${google_compute_instance.console.network_interface[0].network_ip}/32"]
  target_tags   = ["openrod-user-worker"]
  allow {
    protocol = "tcp"
    ports    = ["4600"]
  }
  log_config { metadata = "INCLUDE_ALL_METADATA" }
}
resource "google_compute_firewall" "worker_artifact" {
  name        = "${local.name}-worker-bootstrap"
  network     = google_compute_network.customer.id
  source_tags = ["openrod-user-worker"]
  target_tags = [local.name]
  allow {
    protocol = "tcp"
    ports    = ["8080"]
  }
  log_config { metadata = "INCLUDE_ALL_METADATA" }
}
resource "google_compute_firewall" "worker_iap" {
  name          = "${local.name}-worker-iap"
  network       = google_compute_network.customer.id
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["openrod-user-worker"]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
  log_config { metadata = "INCLUDE_ALL_METADATA" }
}
