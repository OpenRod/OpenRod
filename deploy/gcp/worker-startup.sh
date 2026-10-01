#!/usr/bin/env bash
set -euo pipefail
umask 077
# Secrets are passed to root through Compute metadata, never printed.
settings='__OPENROD_WORKER_SETTINGS__'
if [[ -e /etc/openrod/worker-installed ]]; then exit 0; fi
mkdir -p /etc/openrod
printf '%s' "$settings" | base64 -d > /etc/openrod/worker-settings.json
python3 - <<'PY'
import json,pathlib
s=json.loads(pathlib.Path('/etc/openrod/worker-settings.json').read_text())
pathlib.Path('/etc/openrod/artifact-url').write_text(s['artifactOrigin']+'/internal/worker-artifact')
pathlib.Path('/etc/openrod/artifact-curl').write_text('header = "Authorization: Bearer '+s['key']+'"\nheader = "X-OpenRod-Worker: '+s['name']+'"\n')
PY
curl --fail --silent --show-error --retry 10 --retry-delay 10 --config /etc/openrod/artifact-curl "$(cat /etc/openrod/artifact-url)" -o /etc/openrod/app.tar.gz
python3 - <<'PY'
import hashlib,json,pathlib
s=json.loads(pathlib.Path('/etc/openrod/worker-settings.json').read_text())
if hashlib.sha256(pathlib.Path('/etc/openrod/app.tar.gz').read_bytes()).hexdigest()!=s['artifactHash']:raise SystemExit('Worker artifact checksum mismatch')
PY
mkdir -p /opt/openrod-bootstrap
tar xzf /etc/openrod/app.tar.gz -C /opt/openrod-bootstrap
# Fresh VM only; persistent disk survives service restarts/reboots.
if [[ ! -e /etc/openrod/host-prepared ]]; then
 bash /opt/openrod-bootstrap/deploy/gcp/setup-host.sh v24.21.0
 touch /etc/openrod/host-prepared
fi
mkdir -p /var/lib/openrod/app
cp -a /opt/openrod-bootstrap/. /var/lib/openrod/app/
chown -R openrod:openrod /var/lib/openrod/app
# Application user cannot query metadata even through a host image build.
openrod_uid=$(id -u openrod)
iptables -C OUTPUT -m owner --uid-owner "$openrod_uid" -d 169.254.0.0/16 -j REJECT 2>/dev/null || iptables -I OUTPUT -m owner --uid-owner "$openrod_uid" -d 169.254.0.0/16 -j REJECT
cat > /etc/systemd/system/openrod-worker-metadata.service <<UNIT
[Unit]
Before=openrod-console.service
After=network.target
[Service]
Type=oneshot
ExecStart=/usr/sbin/iptables -I OUTPUT -m owner --uid-owner $openrod_uid -d 169.254.0.0/16 -j REJECT
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now openrod-worker-metadata
curl -fsSL https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.1.2/install.sh -o /etc/openrod/openshell-install.sh
env SUDO_USER=openrod OPENSHELL_VERSION=v0.1.2 OPENSHELL_INSTALL_METHOD=deb sh /etc/openrod/openshell-install.sh
sudo -iu openrod bash -c 'cd /var/lib/openrod/app/ui && npm ci && npm run build'
python3 - <<'PY'
import json,pathlib
s=json.loads(pathlib.Path('/etc/openrod/worker-settings.json').read_text())
lines={'OPENROD_MODE':'worker','OPENROD_PUBLIC_ORIGIN':s['origin'],'OPENROD_WORKER_UID':s['uid'],'OPENROD_WORKER_KEY':s['key'],'OPENSHELL_CONFIG_DIR':'/var/lib/openrod/.config/openshell','OPENSHELL_GATEWAY':'openshell'}
# JSON string quoting matches systemd EnvironmentFile and handles arbitrary UIDs.
pathlib.Path('/etc/openrod/console.env').write_text(''.join(k+'='+json.dumps(v)+'\n' for k,v in lines.items()))
PY
chmod 600 /etc/openrod/console.env
# Workers are private: the control-plane firewall is the sole ingress path.
systemctl disable --now nginx
systemctl enable --now openrod-console
touch /etc/openrod/worker-installed
rm -f /etc/openrod/artifact-curl /etc/openrod/artifact-url /etc/openrod/app.tar.gz /etc/openrod/worker-settings.json
