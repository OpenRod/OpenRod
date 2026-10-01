locals {
  name = "openrod-${var.org_id}"
  labels = {
    application  = "openrod"
    organization = var.org_id
    managed_by   = "terraform"
  }
}
resource "google_project_service" "required" {
  for_each           = toset(["compute.googleapis.com", "iap.googleapis.com", "identitytoolkit.googleapis.com", "iam.googleapis.com", "cloudkms.googleapis.com"])
  service            = each.key
  disable_on_destroy = false
}
resource "google_compute_network" "customer" {
  name                    = local.name
  auto_create_subnetworks = false
  depends_on              = [google_project_service.required]
}
resource "google_compute_subnetwork" "customer" {
  name                     = local.name
  network                  = google_compute_network.customer.id
  region                   = var.region
  ip_cidr_range            = "10.80.0.0/24"
  private_ip_google_access = true
  log_config {
    aggregation_interval = "INTERVAL_5_SEC"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}
resource "google_compute_router" "customer" {
  name    = local.name
  network = google_compute_network.customer.id
  region  = var.region
}
resource "google_compute_router_nat" "outbound" {
  name                               = local.name
  router                             = google_compute_router.customer.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}
resource "google_compute_firewall" "iap_ssh" {
  name          = "${local.name}-iap-ssh"
  network       = google_compute_network.customer.id
  source_ranges = ["35.235.240.0/20"]
  target_tags   = [local.name]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
  log_config { metadata = "INCLUDE_ALL_METADATA" }
}
resource "google_compute_firewall" "load_balancer" {
  name          = "${local.name}-lb"
  network       = google_compute_network.customer.id
  source_ranges = ["35.191.0.0/16", "130.211.0.0/22"]
  target_tags   = [local.name]
  allow {
    protocol = "tcp"
    ports    = ["8080"]
  }
  log_config { metadata = "INCLUDE_ALL_METADATA" }
}
