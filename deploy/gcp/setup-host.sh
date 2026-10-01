#!/usr/bin/env bash
# Run on a NEW dedicated Ubuntu 24.04 VM after reviewing the Terraform plan.
# This initializes only the blank disk named openrod-state and installs host packages.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo on the customer VM' >&2; exit 1; }
[[ $(uname -m) == x86_64 ]] || { echo 'This setup expects amd64' >&2; exit 1; }
[[ ${1:-} =~ ^v24\.[0-9]+\.[0-9]+$ ]] || { echo 'Pass a pinned Node 24 release, e.g. v24.x.y' >&2; exit 1; }
node_release=$1
config_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
state_disk=/dev/disk/by-id/google-openrod-state
[[ -b $state_disk ]] || { echo 'The openrod-state disk is missing' >&2; exit 1; }
mkdir -p /var/lib/openrod
if ! blkid "$state_disk" >/dev/null 2>&1; then
  [[ -z $(wipefs --no-act --noheadings "$state_disk") ]] || { echo 'Disk has an unknown signature; refusing to format it' >&2; exit 1; }
  mkfs.ext4 "$state_disk"
fi
[[ $(blkid -s TYPE -o value "$state_disk") == ext4 ]] || { echo 'Expected an ext4 state disk' >&2; exit 1; }
if ! mountpoint -q /var/lib/openrod; then mount "$state_disk" /var/lib/openrod; fi
state_uuid=$(blkid -s UUID -o value "$state_disk")
grep -q "UUID=$state_uuid " /etc/fstab || printf 'UUID=%s /var/lib/openrod ext4 defaults 0 2\n' "$state_uuid" >> /etc/fstab
id openrod >/dev/null 2>&1 || useradd --create-home --home-dir /var/lib/openrod --shell /bin/bash openrod
chown openrod:openrod /var/lib/openrod
chmod 700 /var/lib/openrod
apt-get update
apt-get install -y python3 ca-certificates curl gnupg nginx git iptables xz-utils dbus-user-session
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
printf 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n' > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
usermod -aG docker openrod
# Put Docker image/build/sandbox state on the snapshotted customer disk.
mkdir -p /etc/docker
# Accept our previous configuration and upgrade its DNS idempotently.
# GCE's resolver shares the metadata IP, which Docker workloads must not reach.
python3 "$config_dir/configure-docker.py"
systemctl stop docker containerd
# Docker 29+ stores image/container snapshots separately in containerd.
containerd config default > /etc/containerd/config.toml
python3 - <<'PYCONFIG'
import pathlib, re, tomllib
config = pathlib.Path('/etc/containerd/config.toml')
text = config.read_text()
if tomllib.loads(text).get('root') != '/var/lib/containerd':
    raise SystemExit('Unexpected default containerd root; refusing to replace it')
text, count = re.subn(r'^root = .*$', 'root = "/var/lib/openrod/containerd"', text, count=1, flags=re.MULTILINE)
if count != 1 or tomllib.loads(text).get('root') != '/var/lib/openrod/containerd':
    raise SystemExit('Could not configure persistent containerd root')
config.write_text(text)
PYCONFIG
mkdir -p /etc/systemd/system/docker.service.d /etc/systemd/system/containerd.service.d
printf '[Unit]\nRequiresMountsFor=/var/lib/openrod\n[Service]\nExecStartPre=/usr/local/sbin/openrod-block-metadata\n' > /etc/systemd/system/docker.service.d/openrod-state.conf
printf '[Unit]\nRequiresMountsFor=/var/lib/openrod\n' > /etc/systemd/system/containerd.service.d/openrod-state.conf
install -m 0755 "$config_dir/block-metadata.sh" /usr/local/sbin/openrod-block-metadata
install -m 0644 "$config_dir/openrod-metadata-guard.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable openrod-metadata-guard.service
systemctl restart containerd docker
systemctl start openrod-metadata-guard.service
# Verify official Node archive checksums before installation.
node_tmp=$(mktemp -d)
trap 'rm -rf "$node_tmp"' EXIT
curl -fsSL "https://nodejs.org/dist/$node_release/node-$node_release-linux-x64.tar.xz" -o "$node_tmp/node-$node_release-linux-x64.tar.xz"
curl -fsSL "https://nodejs.org/dist/$node_release/SHASUMS256.txt" -o "$node_tmp/SHASUMS256.txt"
(cd "$node_tmp" && grep " node-$node_release-linux-x64.tar.xz$" SHASUMS256.txt | sha256sum -c -)
tar -xJf "$node_tmp/node-$node_release-linux-x64.tar.xz" -C /usr/local --strip-components=1
mkdir -p /etc/openrod
chmod 700 /etc/openrod
install -m 0644 "$config_dir/openrod-console.service" /etc/systemd/system/
rm -f /etc/nginx/sites-enabled/default
install -m 0644 "$config_dir/nginx.conf" /etc/nginx/conf.d/openrod.conf
nginx -t
systemctl enable nginx
systemctl restart nginx
loginctl enable-linger openrod
systemctl start "user@$(id -u openrod).service"
printf 'Host prepared. Install the pinned OpenShell release for user openrod, copy the app and configure /etc/openrod/console.env before enabling openrod-console.\n'
