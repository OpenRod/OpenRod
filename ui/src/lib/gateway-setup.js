const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const CONTROL = /[\u0000-\u001f\u007f]/

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function absoluteDirectory(value) {
  return typeof value === 'string' && value.startsWith('/') && !CONTROL.test(value) && !value.split('/').includes('..')
}

function port(value) {
  return /^\d+$/.test(String(value)) && Number(value) >= 1 && Number(value) <= 65535
}

export function registrationPlan({ name = '', configDir = '', bundleDir = '', mode = 'loopback', endpoint = '', kubeContext = '', namespace = '', service = '', servicePort = '', localPort = '', gateways = [] }) {
  const errors = []
  if (!SAFE_NAME.test(name)) errors.push('Use a gateway name of 1–64 letters, digits, dots, underscores or dashes, beginning with a letter or digit.')
  if (gateways.some((gateway) => gateway.name === name)) errors.push('That registration already exists. Check it instead, or choose an unused name.')
  if (!absoluteDirectory(configDir) || !configDir.endsWith('/openshell')) errors.push('The console must report its OpenShell directory under XDG_CONFIG_HOME before commands can be generated.')
  if (!absoluteDirectory(bundleDir) || bundleDir === '/') errors.push('Enter the absolute path of your private local bundle directory (no ~, control characters or .. segments).')
  let tunnelCommand = null
  if (mode === 'kubernetes') {
    if (!kubeContext.trim() || CONTROL.test(kubeContext)) errors.push('Enter the exact Kubernetes context from your administrator.')
    if (!DNS_LABEL.test(namespace)) errors.push('Enter a valid Kubernetes namespace.')
    if (!DNS_LABEL.test(service)) errors.push('Enter a valid Kubernetes service name.')
    if (!port(localPort) || !port(servicePort)) errors.push('Local and service ports must be numbers from 1 to 65535.')
    endpoint = `https://127.0.0.1:${localPort}`
  } else if (mode !== 'loopback') {
    errors.push('Generate commands only for an existing private loopback endpoint or Kubernetes tunnel.')
  }
  try {
    const url = new URL(endpoint)
    if (CONTROL.test(endpoint) || url.username || url.password || url.protocol !== 'https:' || url.search || url.hash || url.pathname !== '/') {
      errors.push('Use an HTTPS endpoint without credentials, path, query or fragment. Plain HTTP, OIDC and edge authentication are unsupported.')
    }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) errors.push('These commands are for loopback endpoints only. Register a non-loopback gateway with your administrator’s existing OpenShell CLI workflow, then refresh registrations.')
  } catch {
    errors.push('Enter a complete HTTPS loopback endpoint, including its port.')
  }
  const destination = `${configDir.replace(/\/$/, '')}/gateways/${name}`
  if (bundleDir === destination || bundleDir.startsWith(`${destination}/`)) errors.push('Keep the original bundle outside the new registration directory so it can be restored unchanged.')
  if (errors.length) return { errors, endpoint, destination, registrationCommand: null, tunnelCommand: null }
  if (mode === 'kubernetes') {
    tunnelCommand = `kubectl --context=${shellQuote(kubeContext)} --namespace=${shellQuote(namespace)} port-forward --address=127.0.0.1 ${shellQuote(`service/${service}`)} ${shellQuote(`${Number(localPort)}:${Number(servicePort)}`)}`
  }
  const registrationCommand = `(
  set -eu
  umask 077
  export XDG_CONFIG_HOME=${shellQuote(configDir.slice(0, -'/openshell'.length) || '/')}
  bundle=${shellQuote(bundleDir)}
  registration=${shellQuote(destination)}
  if [ -e "$registration" ] || [ -L "$registration" ]; then
    printf '%s\\n' 'Refusing to overwrite an existing registration directory. Choose an unused name or inspect the existing registration.' >&2
    exit 1
  fi
  for file in ca.crt tls.crt tls.key; do
    test -s "$bundle/$file" && test -r "$bundle/$file" || { printf '%s\\n' "Missing or unreadable administrator bundle file: $file" >&2; exit 1; }
  done
  mkdir -p "$XDG_CONFIG_HOME/openshell/gateways"
  mkdir "$registration"
  restore_bundle() {
    mkdir -p "$registration/mtls" &&
    chmod 700 "$registration" "$registration/mtls" &&
    install -m 600 "$bundle/ca.crt" "$registration/mtls/ca.crt" &&
    install -m 600 "$bundle/tls.crt" "$registration/mtls/tls.crt" &&
    install -m 600 "$bundle/tls.key" "$registration/mtls/tls.key"
  }
  restore_bundle
  trap 'result=$?; trap - 0; if ! restore_bundle; then printf "%s\\n" "Bundle restoration failed. Restore the original administrator bundle before checking this registration." >&2; exit 1; fi; exit "$result"' 0
  trap 'exit 130' INT
  trap 'exit 143' TERM
  "\${OPENSHELL_BIN:-openshell}" gateway add ${shellQuote(endpoint)} --name ${shellQuote(name)} --local
)`
  return { errors, endpoint, destination, registrationCommand, tunnelCommand }
}
