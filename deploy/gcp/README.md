# OpenRod Cloud on GCP

OpenRod local remains account-free on localhost. OpenRod Cloud accepts any enabled, verified Google account. There is no waitlist, email allowlist or manual membership approval. To revoke access, disable the account in Identity Platform; current-account checks run on every request and every minute for streams/terminals.

The existing `openrod-control-plane` VM becomes the control plane at `https://cloud.example.com`. It holds Google session verification credentials, the Firestore machine registry and Compute provisioning permission. Customer workspace requests never reach its pilot gateway. Existing pilot files and gateway state are preserved, but are not copied automatically into users' new machines.

## Per-user machines

- Exactly one VM identity per stable Firebase UID, enforced by Firestore transactions and deterministic Compute names. Multiple tabs and concurrent creation requests share the reservation and Compute request ID.
- Fixed `e2-standard-2` machines in `us-east1-b`, 30 GB boot disk and 100 GB persistent workspace disk, no public IP and no attached service account.
- Existing shared `10.80.0.0/24` network and Cloud NAT. Each worker has its own kernel, filesystem, OpenShell gateway, Docker engine and state. No separate VPC is created per user.
- The firewall accepts workspace port 4600 only from the control plane's private IP. Workers cannot reach other workers. Operators use IAP for SSH.
- Each worker requires its own request signature, bound to its owner, HTTP method, full target and a short validity window. The browser receives neither worker addresses nor keys.
- Fleet capacity defaults to 10 reserved machines (`OPENROD_MAX_MACHINES`, integer 1–100), including failed reservations. No public API frees slots or deletes/recreates VMs. Deletion and capacity changes are operator actions.
- Startup runs as a retrying service. Failed provisioning remains visible. A missing previously-ready machine requires operator intervention; customer requests do not silently replace its data.

One VM per account does not stop someone creating many Google accounts. The fleet ceiling bounds automatic VM allocation. This pilot has no idle shutdown, payment checks, project spending cap, egress cap, storage snapshot schedule for worker disks, or automatic orphan cleanup. Persistent disks remain billable when a VM stops or is removed. GCP budgets notify; they do not enforce a spending ceiling.

## Identity and storage

The browser uses Firebase Google sign-in with in-memory SDK persistence. The edge exchanges a recent verified ID token for a one-hour Secure, HttpOnly, SameSite=Strict cookie. Current Google verification, disabled status, session revocation, origin and host boundaries remain enforced. Legacy organization claims do not gate access. There is no account-write IAM permission on the runtime.

Firestore database `openrod-cloud`, in `us-east1`, stores `machines` owner/VM/lease records, the transactional `control/fleet` counter, and short-lived single-use `handoffs`. It contains sensitive per-worker keys, so only the control-plane service account and authorized operators may access it. The role is conditioned to this database. Browser Firestore access is denied by `firestore.rules`. Workers have no Firestore/IAM credentials.

## Local and cloud continuity

A ready local sandbox exposes **Continue in cloud**. It opens the cloud console, signs in with Google, prepares the user's VM, and exchanges a five-minute single-use handoff ticket with the local page. The local backend sends workspace files to the cloud backend. A ready cloud sandbox exposes **Continue locally**, opening local OpenRod at `http://127.0.0.1:4600` and passing the same validated bundle through an origin/source/nonce-checked browser exchange.

Transfers make a new uniquely named copy and leave the source untouched. They preserve regular files, executable bits, selected agent/shell session and portable saved image recipes. Recipes rebuild on the destination architecture rather than copying ARM/AMD images. Provider credentials and template environment values are omitted. Known credential files, private-key contents, symlinks, `.git`, installed dependencies and caches are excluded. These filters cannot identify every secret embedded in arbitrary source code or Docker recipes; review project contents before copying. Custom startup commands are replaced with a shell; reconnect credentials on the destination. Image-only local templates without a recipe fall back to Ubuntu and show a warning.

Limits: 25 MiB decoded workspace files, 2,000 files, 36 MiB JSON request; image rebuilds may take minutes. This copies files and reconstructs the launch environment. It does not migrate running processes, an atomic filesystem snapshot, unsaved editor buffers, git history, agent home-directory chats, machine-level settings or organization/network policies. Failed imports can leave a destination sandbox/template for inspection.

## Deploy

Use the existing protected Terraform state in this directory. Do not copy local Terraform state or credentials into the application artifact. Authenticate with `gcloud auth login` and application-default login if Terraform uses ADC. Review the exact Terraform plan: the changes add Firestore, database-conditioned registry IAM, limited Compute provisioning IAM and private-worker firewall rules; they must not replace/delete pilot infrastructure.

```sh
terraform init
terraform plan -var='org_id=your-org' -var='domain=cloud.example.com' -out=customer.tfplan
terraform apply customer.tfplan
firebase deploy --project your-gcp-project-id --config firebase.cloud.json --only firestore:rules
```

Configure the existing root-owned `/etc/openrod/console.env`, retaining the public Firebase identifiers and attached ADC:

```dotenv
OPENROD_MODE=cloud
GOOGLE_CLOUD_PROJECT=your-gcp-project-id
OPENROD_ORG_ID=your-org
OPENROD_PUBLIC_ORIGIN=https://cloud.example.com
OPENROD_FIREBASE_API_KEY=YOUR_PUBLIC_WEB_API_KEY
OPENROD_FIREBASE_AUTH_DOMAIN=your-gcp-project-id.firebaseapp.com
OPENROD_MAX_MACHINES=10
OPENROD_WORKER_ZONE=us-east1-b
OPENROD_WORKER_SUBNET=projects/your-gcp-project-id/regions/us-east1/subnetworks/openrod-control-plane
OPENROD_WORKER_ARTIFACT_ORIGIN=http://control-plane-private-ip:8080
OPENROD_WORKER_ARTIFACT=/var/lib/openrod/worker-app.tar.gz
OPENROD_WORKER_ARTIFACT_SHA256=SHA256_OF_REVIEWED_ARTIFACT
```

The worker artifact must contain `ui` source/package/vendor files, default policy files, and `deploy/gcp` host setup/startup/service scripts. Exclude `.git`, `.env`, `.state`, `node_modules`, local keys, Terraform state/plans and `.terraform`. Keep existing policy and `.state` when updating the control plane. Build UI before restarting `openrod-console`. Artifact bytes must match the configured checksum. Workers fetch only through a per-worker authenticated endpoint over the private network, verify the checksum and install pinned Node v24.21.0/OpenShell v0.1.2. Root bootstrap credentials never reach customer browsers.

## Acceptance

Local tests/build and Terraform validation are separate from live acceptance. Verify actual runtime IAM transactions, private worker bootstrap, no attached service account/public IP, owner-specific HTTP/SSE/terminal routing, anonymous and wrong-owner rejection, two-way file transfer and metadata blocking. Test a reboot and retained workspace. Public sandbox service forwarding, backups/restore and strong cloud billing caps require separate work before claiming them.
