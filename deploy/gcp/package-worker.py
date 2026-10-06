#!/usr/bin/env python3
"""Package reviewed application files without local environment or runtime state."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tarfile

FIXED_FILES = ["ui/package.json", "ui/package-lock.json", "ui/index.html", "ui/vite.config.js", "ui/jsconfig.json", "ui/components.json", "ui/LICENSE", "ui/NOTICE", "ui/THIRD_PARTY_NOTICES.md", "ui/SETUPS.md", "docs/cloud-imports.md"]
FOLDERS = ["ui/server", "ui/shared", "ui/src", "ui/public", "ui/vendor", "ui/dist", "ui/scripts", "deploy/gcp"]
# Match sensitive suffixes even when followed by .backup, .json, or editor
# extensions. Terraform state and tfvars JSON are not application source.
SENSITIVE_SUFFIX = re.compile(r"\.(?:tfvars|tfstate|tfplan|pem|key|p12|pfx|pyc)(?:[.~_-]|$)", re.I)
EXCLUDED_PARTS = {"node_modules", ".state", ".terraform", ".git", ".ssh", "__pycache__"}


def package(root, output):
    if not output.is_absolute():
        raise SystemExit("Use an absolute output path")
    if not (root / "ui/dist/index.html").is_file():
        raise SystemExit("Build the frontend before packaging")
    candidates = [root / name for name in FIXED_FILES]
    if any(not entry.is_file() or entry.is_symlink() for entry in candidates):
        raise SystemExit("Required application files must be present and cannot be symlinks")
    for folder in FOLDERS:
        candidates.extend((root / folder).rglob("*"))
    files = []
    for entry in candidates:
        relative = entry.relative_to(root)
        if not entry.is_file() or entry.is_symlink() or entry.resolve() == output.resolve():
            continue
        if any(part in EXCLUDED_PARTS for part in relative.parts):
            continue
        if any(parent.is_symlink() for parent in entry.parents if parent != root and root in parent.parents):
            continue
        if entry.name.startswith(".env") or entry.name.endswith(".env") or SENSITIVE_SUFFIX.search(entry.name):
            continue
        files.append(str(relative))
    files = sorted(set(files))
    previous = os.umask(0o077)
    try:
        with tarfile.open(output, "w:gz") as archive:
            for item in files:
                archive.add(root / item, arcname=item, recursive=False)
    finally:
        os.umask(previous)
    output.chmod(0o600)
    return {"artifact": str(output), "files": len(files), "bytes": output.stat().st_size, "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 deploy/gcp/package-worker.py /absolute/output.tar.gz")
    print(json.dumps(package(Path(__file__).resolve().parents[2], Path(sys.argv[1]))))
