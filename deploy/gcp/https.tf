resource "google_compute_global_address" "console" { name = local.name }
resource "google_compute_health_check" "console" {
  name = local.name
  http_health_check {
    port         = 8080
    request_path = "/healthz"
  }
}
resource "google_compute_security_policy" "console" {
  name = local.name
  rule {
    priority = 100
    action   = "deny(403)"
    match {
      expr { expression = "evaluatePreconfiguredWaf('cve-canary')" }
    }
    description = "Block known CVE attack signatures, including Log4j payloads."
  }
  rule {
    priority = 1000
    action   = "throttle"
    match {
      versioned_expr = "SRC_IPS_V1"
      config { src_ip_ranges = ["*"] }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = 600
        interval_sec = 60
      }
    }
    description = "Limit abusive traffic before it reaches the console."
  }
  rule {
    priority = 2147483647
    action   = "allow"
    match {
      versioned_expr = "SRC_IPS_V1"
      config { src_ip_ranges = ["*"] }
    }
  }
}
resource "google_compute_backend_service" "console" {
  name                  = local.name
  protocol              = "HTTP"
  port_name             = "http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  timeout_sec           = 3600
  health_checks         = [google_compute_health_check.console.id]
  security_policy       = google_compute_security_policy.console.id
  backend { group = google_compute_instance_group.console.self_link }
  log_config {
    enable      = true
    sample_rate = 1.0
  }
}
resource "google_compute_url_map" "console" {
  name            = local.name
  default_service = google_compute_backend_service.console.id
}
resource "google_compute_managed_ssl_certificate" "console" {
  name = local.name
  managed { domains = [var.domain] }
}
resource "google_compute_ssl_policy" "console" {
  name            = local.name
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"
}
resource "google_compute_target_https_proxy" "console" {
  name             = local.name
  url_map          = google_compute_url_map.console.id
  ssl_certificates = [google_compute_managed_ssl_certificate.console.id]
  ssl_policy       = google_compute_ssl_policy.console.id
}
resource "google_compute_global_forwarding_rule" "console" {
  name                  = local.name
  ip_address            = google_compute_global_address.console.address
  port_range            = "443"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_https_proxy.console.id
}
