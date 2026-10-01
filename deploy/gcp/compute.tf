# Customer VMs cannot assign claims, provision machines or change IAM.
resource "google_project_iam_custom_role" "session_verifier" {
  role_id     = "openrod_${replace(var.org_id, "-", "_")}_sessions"
  title       = "OpenRod ${var.org_id} session verifier"
  description = "Read accounts for membership/revocation checks and issue verified-user session cookies."
  permissions = ["firebaseauth.users.get", "firebaseauth.users.createSession"]
  depends_on  = [google_project_service.required]
}
resource "google_service_account" "console" {
  account_id   = local.name
  display_name = "OpenRod ${var.org_id} console"
  depends_on   = [google_project_service.required]
}
resource "google_project_iam_member" "session_verifier" {
  project = var.project_id
  role    = google_project_iam_custom_role.session_verifier.name
  member  = "serviceAccount:${google_service_account.console.email}"
}
data "google_compute_image" "ubuntu" {
  family  = "ubuntu-2404-lts-amd64"
  project = "ubuntu-os-cloud"
}
resource "google_compute_resource_policy" "backup" {
  name   = "${local.name}-daily"
  region = var.region
  snapshot_schedule_policy {
    schedule {
      daily_schedule {
        days_in_cycle = 1
        start_time    = "04:00"
      }
    }
    retention_policy {
      max_retention_days    = 14
      on_source_disk_delete = "KEEP_AUTO_SNAPSHOTS"
    }
    snapshot_properties {
      storage_locations = [var.region]
      labels            = local.labels
    }
  }
}
resource "google_compute_disk" "state" {
  name   = "${local.name}-state"
  zone   = var.zone
  type   = "pd-balanced"
  size   = 100
  labels = local.labels
  disk_encryption_key { kms_key_self_link = google_kms_crypto_key.state.id }
  depends_on = [google_kms_crypto_key_iam_member.compute]
  lifecycle { prevent_destroy = true }
}
resource "google_compute_disk_resource_policy_attachment" "backup" {
  name = google_compute_resource_policy.backup.name
  disk = google_compute_disk.state.name
  zone = var.zone
}
resource "google_compute_instance" "console" {
  name                = local.name
  machine_type        = var.machine_type
  zone                = var.zone
  tags                = [local.name]
  labels              = local.labels
  deletion_protection = true
  can_ip_forward      = false
  boot_disk {
    kms_key_self_link = google_kms_crypto_key.state.id
    initialize_params {
      image = data.google_compute_image.ubuntu.self_link
      size  = 30
      type  = "pd-balanced"
    }
  }
  attached_disk {
    source      = google_compute_disk.state.id
    device_name = "openrod-state"
  }
  network_interface {
    subnetwork = google_compute_subnetwork.customer.id
    # Deliberately no access_config: no public VM address.
  }
  metadata = {
    enable-oslogin           = "TRUE"
    block-project-ssh-keys   = "TRUE"
    disable-legacy-endpoints = "TRUE"
  }
  service_account {
    email  = google_service_account.console.email
    scopes = ["cloud-platform"]
  }
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = startswith(var.zone, "${var.region}-")
      error_message = "zone must belong to region."
    }
  }
  depends_on = [google_compute_router_nat.outbound, google_project_iam_member.session_verifier, google_kms_crypto_key_iam_member.compute]
}
resource "google_compute_instance_group" "console" {
  name      = local.name
  zone      = var.zone
  instances = [google_compute_instance.console.self_link]
  named_port {
    name = "http"
    port = 8080
  }
}
