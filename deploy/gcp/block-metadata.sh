#!/usr/bin/env bash
set -euo pipefail
# Every Docker workload/build must be unable to reach the VM identity endpoint.
# Rules precede Docker's return rule, and the service runs after every Docker start.
iptables -N DOCKER-USER 2>/dev/null || true
iptables -C DOCKER-USER -d 169.254.0.0/16 -j REJECT 2>/dev/null || iptables -I DOCKER-USER 1 -d 169.254.0.0/16 -j REJECT
# Fail if the daemon configuration enables IPv6. A guard installed before
# Docker starts closes the reboot/restart window before workloads can run.
python3 - <<'PYCODE'
import json
with open('/etc/docker/daemon.json') as file:
    if json.load(file).get('ipv6') is not False:
        raise SystemExit('Docker IPv6 must stay disabled until equivalent guards exist')
PYCODE
