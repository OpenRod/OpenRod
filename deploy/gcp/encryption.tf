data "google_project" "current" { project_id = var.project_id }
resource "google_kms_key_ring" "state" {
  name       = local.name
  location   = var.region
  depends_on = [google_project_service.required]
}
resource "google_kms_crypto_key" "state" {
  name            = "state"
  key_ring        = google_kms_key_ring.state.id
  rotation_period = "7776000s"
  lifecycle { prevent_destroy = true }
}
resource "google_kms_crypto_key_iam_member" "compute" {
  crypto_key_id = google_kms_crypto_key.state.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${data.google_project.current.number}@compute-system.iam.gserviceaccount.com"
  depends_on    = [google_project_service.required]
}
