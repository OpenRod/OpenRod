#!/usr/bin/env python3
"""Configure dedicated OpenRod hosts without routing container DNS to GCE metadata."""
import json
import os
from pathlib import Path
import sys
import tempfile

BASE = {"data-root": "/var/lib/openrod/docker", "ipv6": False}
CONFIG = {**BASE, "dns": ["8.8.8.8", "8.8.4.4"]}


def configure(file):
    if file.exists() and json.loads(file.read_text()) not in (BASE, CONFIG):
        raise SystemExit("Existing Docker configuration differs; refusing to replace it")
    # Atomic update; interrupted writes must not leave Docker unable to start.
    descriptor, name = tempfile.mkstemp(prefix=".openrod-daemon-", dir=file.parent)
    try:
        with os.fdopen(descriptor, "w") as output:
            output.write(json.dumps(CONFIG) + "\n")
        os.replace(name, file)
    finally:
        if os.path.exists(name):
            os.unlink(name)


if __name__ == "__main__":
    configure(Path(sys.argv[1] if len(sys.argv) > 1 else "/etc/docker/daemon.json"))
