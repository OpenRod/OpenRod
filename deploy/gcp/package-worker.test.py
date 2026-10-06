import importlib.util
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("package_worker", Path(__file__).with_name("package-worker.py"))
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class PackageWorkerTests(unittest.TestCase):
    def test_archive_excludes_state_backups_and_secret_variants(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            allowed = packager.FIXED_FILES + ["ui/dist/index.html", "ui/server/start.js", "deploy/gcp/main.tf", "deploy/gcp/runtime/package-lock.json"]
            forbidden = [
                "deploy/gcp/terraform.tfstate", "deploy/gcp/terraform.tfstate.backup",
                "deploy/gcp/terraform.tfstate.backup.20261006", "deploy/gcp/prod.tfvars.json",
                "deploy/gcp/review.tfplan.json", "deploy/gcp/id.key.backup", "deploy/gcp/cert.pem.old",
                "deploy/gcp/.env.production", "deploy/gcp/console.env", "deploy/gcp/.terraform/provider",
                "ui/server/.state/sessions.sqlite", "ui/server/.ssh/id_rsa", "ui/server/node_modules/a/index.js",
            ]
            for name in allowed + forbidden:
                entry = root / name
                entry.parent.mkdir(parents=True, exist_ok=True)
                entry.write_text(name)
            (root / "ui/server/linked.js").symlink_to(root / "deploy/gcp/console.env")
            output = root / "deploy/gcp/release.tar.gz"
            output.write_text("prior artifact should never include itself")
            result = packager.package(root, output)
            with tarfile.open(output) as archive:
                self.assertEqual(sorted(archive.getnames()), sorted(allowed))
            self.assertEqual(result["files"], len(allowed))
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
