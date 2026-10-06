# Self-hosted cloud control plane on GCP

> **Self-hosted deployment.** These files deploy the OpenRod Cloud control plane in your own GCP project. A configured project, Identity Platform, Firestore, HTTPS origin, and reviewed worker artifact are required. The repository does not provide a public hosted service.

Local OpenRod remains account-free on localhost. The control plane accepts any enabled, verified Google account. There is no email allowlist or manual membership approval. To revoke access, disable the account in Identity Platform; current-account checks run on every request and every minute for streams/terminals.

The console VM created by Terraform is the control plane at your public origin, for example `https://console.example.com`. It holds Google session verification credentials, the Firestore machine registry and Compute provisioning permission. User workspace requests run on per-user machines and never reach the control plane's own gateway.

## Per-user machines

- Exactly one VM identity per stable Firebase UID, enforced by Firestore transactions and deterministic Compute names. Multiple tabs and concurrent creation requests share the reservation and Compute request ID.
- Fixed `e2-standard-2` machines in `us-east1-b`, 30 GB boot disk and 100 GB persistent workspace disk, no public IP and no attached service account.
- The control plane's private subnet and Cloud NAT, shared by all workers. Each worker has its own kernel, filesystem, OpenShell gateway, Docker engine and state. No separate VPC is created per user.
- The firewall accepts workspace port 4600 only from the control plane's private IP. Workers cannot reach other workers. Operators use IAP for SSH.
- Each worker requires its own request signature, bound to its owner, HTTP method, full target and a short validity window. The browser receives neither worker addresses nor keys.
- Fleet capacity defaults to 10 reserved machines (`OPENROD_MAX_MACHINES`, integer 1–100), including failed reservations. No public API frees slots or deletes/recreates VMs. Deletion and capacity changes are operator actions.
- Startup runs as a retrying service. Failed provisioning remains visible. A missing previously-ready machine requires operator intervention; user requests do not silently replace its data.

One VM per account does not stop someone creating many Google accounts. The fleet ceiling bounds automatic VM allocation. This deployment has no idle shutdown, payment checks, project spending cap, egress cap, storage snapshot schedule for worker disks, or automatic orphan cleanup. Persistent disks remain billable when a VM stops or is removed. GCP budgets notify; they do not enforce a spending ceiling.

## Identity and storage

The browser uses Firebase Google sign-in with in-memory SDK persistence. The edge exchanges a recent verified ID token for a one-hour Secure, HttpOnly, SameSite=Strict cookie. Current Google verification, disabled status, session revocation, origin and host boundaries remain enforced. Organization custom claims do not gate access. There is no account-write IAM permission on the runtime.

Firestore database `openrod-cloud`, in `us-east1`, stores `machines` owner/VM/lease records, the transactional `control/fleet` counter, and short-lived single-use `handoffs`. It contains sensitive per-worker keys, so only the control-plane service account and authorized operators may access it. The role is conditioned to this database. Browser Firestore access is denied by `firestore.rules`. Workers have no Firestore/IAM credentials.

## Local and cloud continuity

Cloud is unconfigured by default. Set `OPENROD_CLOUD_ORIGIN` (for example `https://console.example.com`) when running local OpenRod; the connection status endpoint exposes the configured origin without a frontend rebuild. Google authentication runs at that origin and returns the verified account to the originating local tab. Sign-in and machine status reads do not allocate a VM. Preparing a cloud destination is an explicit `POST /api/cloud/machine` (or `/api/local-cloud/machine` through local OpenRod). Resource reads return an actionable unavailable state until a machine has been prepared. Authentication started in the cloud console stays in the console.

The local console combines local, connected-host, and cloud resources. Creation dialogs select an explicit destination, and the Connections page manages the cloud account. Terminal sessions and in-flight requests keep their original target; expired cloud access never falls back to local compute. The local backend holds a one-hour authorization in memory, so restarting it requires another sign-in. A second local sign-in for the same account replaces the prior local connection; console logout or account disablement revokes it.

Native terminal, Cursor and VS Code actions use an authenticated SSH tunnel to the selected sandbox. Managed SSH aliases and verified public host keys are installed locally; gateway credentials stay on the private worker. No public worker SSH port or user GCP credentials are needed.

The sandbox detail view offers **Continue in cloud** and **Continue locally**. After connecting Cloud, an optional import prompt appears. Later, use **Connections → OpenRod Cloud → Import data** and choose the resource categories to copy. See [configuration imports](../../docs/cloud-imports.md) for resource dependencies, conflict review, history pagination, and credential exclusions.

Transfers make a new uniquely named copy and leave the source untouched. They preserve regular files, executable bits, selected agent/shell session and portable saved image recipes. Recipes rebuild on the destination architecture rather than copying ARM/AMD images. Provider credentials and template environment values are omitted. Known credential files, private-key contents, symlinks, `.git`, `.openshell` Setup runtime state, installed dependencies and caches are excluded. These filters cannot identify every secret embedded in arbitrary source code or Docker recipes; review project contents before copying. Saved MCP/skill Setup references are omitted because destination Setup registries differ; reconnect these on the destination. Custom startup commands are replaced with a shell; reconnect credentials on the destination. Image-only local templates without a recipe fall back to Ubuntu and show a warning.

Limits: 25 MiB decoded workspace files, 2,000 files, 36 MiB JSON request; image rebuilds may take minutes. This copies files and reconstructs the launch environment. It does not migrate running processes, an atomic filesystem snapshot, unsaved editor buffers, git history, agent home-directory chats, machine-level settings or organization/network policies. Failed imports can leave a destination sandbox/template for inspection.

## Deploy

The project needs Identity Platform with Google sign-in enabled and a Firebase web app for the public identifiers below. Run Terraform from this directory and keep its state private; do not copy Terraform state or credentials into the application artifact. Authenticate with `gcloud auth login` and application-default login if Terraform uses ADC. Review the plan before applying it: it creates the private network and Cloud NAT, the control-plane VM and its encrypted state disk, the HTTPS load balancer, Firestore, database-conditioned registry IAM, limited Compute provisioning IAM and private-worker firewall rules.

```sh
terraform init
terraform plan -var='project_id=YOUR_PROJECT_ID' -var='org_id=your-org' -var='domain=console.example.com' -out=openrod.tfplan
terraform apply openrod.tfplan
firebase deploy --project YOUR_PROJECT_ID --config firebase.cloud.json --only firestore:rules
```

Point the domain's A record at the `dns_address` output. On the control-plane VM (`ssh_command` output), run `deploy/gcp/setup-host.sh` as root with a pinned Node 24 release and follow the steps it prints. Configure root-owned `/etc/openrod/console.env` with the public Firebase identifiers; the VM's attached service account provides ADC:

```dotenv
OPENROD_MODE=cloud
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
OPENROD_ORG_ID=your-org
OPENROD_PUBLIC_ORIGIN=https://console.example.com
OPENROD_FIREBASE_API_KEY=YOUR_PUBLIC_WEB_API_KEY
OPENROD_FIREBASE_AUTH_DOMAIN=YOUR_PROJECT_ID.firebaseapp.com
OPENROD_MAX_MACHINES=10
OPENROD_FIRESTORE_DATABASE=openrod-cloud
OPENSHELL_CONSOLE_DATA_DIR=/var/lib/openrod/console-state
OPENROD_WORKER_ZONE=us-east1-b
OPENROD_WORKER_SUBNET=projects/YOUR_PROJECT_ID/regions/us-east1/subnetworks/YOUR_SUBNET
OPENROD_WORKER_ARTIFACT_ORIGIN=http://CONTROL_PLANE_PRIVATE_IP:8080
OPENROD_WORKER_ARTIFACT=/var/lib/openrod/worker-app.tar.gz
OPENROD_WORKER_ARTIFACT_SHA256=SHA256_OF_REVIEWED_ARTIFACT
```

Install the cloud-only Admin SDK alongside the checked-out application, build the frontend, and run a read-only deployment preflight as the application user. The local npm package and workers do not install or load the Admin SDK.

```sh
npm ci --prefix /var/lib/openrod/app/ui
npm ci --omit=dev --prefix /var/lib/openrod/app/deploy/gcp/runtime
npm run build --prefix /var/lib/openrod/app/ui
# Run as openrod with the same environment supplied to the systemd service.
node /var/lib/openrod/app/deploy/gcp/preflight.mjs
```

The preflight verifies the artifact checksum, ADC, and a read of the named Firestore registry. It does not allocate compute or verify Google sign-in end to end. Cloud startup performs these checks too and fails before listening if they fail. `/healthz` reports process liveness; `/readyz` also checks the registry with a bounded response timeout and is the load-balancer health target. Session revocations live in `OPENSHELL_CONSOLE_DATA_DIR/cloud-sessions.sqlite`, outside the deployable application tree.

After a reviewed successful preflight, enable `openrod-console`. Validate Google sign-in, explicit provisioning, and actual sandbox creation in staging. `OPENROD_WORKER_BIND=127.0.0.1` is available for isolated worker smoke tests through a local tunnel; deployed private workers default to `0.0.0.0` and rely on the worker firewall and signed requests.

## Release and rollback

Record the Git revision, lockfiles, artifact checksum, Node/OpenShell versions, and Terraform plan for each release. Stage the artifact at a new path and update both artifact path and checksum together. Preserve the state directory and the named registry. Do not replace an artifact while a worker is bootstrapping from it. Roll back the application and matching artifact configuration together; do not restore an older database snapshot over live work as a code rollback. Exercise backup restoration independently before promising a recovery objective. Worker disk backups, fleet cleanup, and spending caps still require operator implementation.

Create the reviewed application archive with `python3 deploy/gcp/package-worker.py /absolute/output.tar.gz` after building the frontend. The packager includes the application and deployment files and excludes dependency trees, local environment files, infrastructure state and private-key files. Review the emitted checksum and contents before using it as the provisioning artifact.

Run `python3 deploy/gcp/package-worker.test.py` to verify archive exclusions, including Terraform state backups, JSON variable files, credential-file backups, and symlinks. File filters cannot identify secrets embedded in ordinary source files; review the archive inputs before release.

## Existing infrastructure and staged upgrades

Existing fleet identities are configuration, independent of OpenRod branding. Preserve the database, machine document IDs, worker keys and persistent disks. Do not change a prefix to rename the product: that would allocate a second fleet for existing accounts.

These explicit settings support a pre-OpenRod deployment without copying or renaming its registry:

```dotenv
OPENROD_FIRESTORE_DATABASE=legacy-cloud
OPENROD_WORKER_PREFIX=legacy-user
OPENROD_WORKER_PROTOCOL=legacy
OPENROD_WORKER_OWNER_LABEL=legacy_owner
OPENROD_WORKER_NETWORK_TAG=legacy-user-worker
OPENROD_SESSION_COOKIE=__Host-legacy_session
OPENROD_SESSION_FILE=/absolute/existing/state/sessions.sqlite
OPENROD_PROXY_CLIENT_IP_HEADER=x-legacy-client-ip
OPENROD_PROVISIONING_ENABLED=false
```

`legacy` selects the existing signed worker transport header. It does not weaken owner, origin, signature or expiration checks. Updated workers can temporarily use the same protocol while the control plane and fleet roll forward. `OPENROD_PROXY_CLIENT_IP_HEADER` independently selects the header your loopback reverse proxy overwrites; use its default `x-openrod-client-ip` with the current nginx configuration. Never trust a forwarded-IP header the proxy passes through unchanged. Convert the root-owned deployment environment from its prior variable names into the corresponding `OPENROD_*` names without printing its values. Keep new provisioning disabled until a matching reviewed OpenRod worker artifact and firewall tag have been installed.

Stage the application in a separate release directory and bind staged services to a different loopback port. Leave live services and their environment files unchanged. For worker smoke tests, create a separate gateway workspace (names are limited to 19 characters) and set **both** `OPENSHELL_WORKSPACE` and a separate `OPENSHELL_CONSOLE_DATA_DIR` in the staged worker environment. A separate state directory alone does not isolate network-policy synchronization from live sandboxes.

Use an SSH/IAP tunnel for health checks. For signed worker requests, run `worker-request.mjs ENV_FILE PORT METHOD /api/path [JSON_FILE|-]` on the worker with access to its root-owned staged environment; it prints only the response. Test with the authenticated operator's own worker and the isolated workspace. A staged control plane still targets the configured fleet, so do not run mutation tests through it until its worker routing is explicitly isolated.

After creating a disposable smoke sandbox in that workspace, run `worker-terminal-smoke.mjs ENV_FILE PORT SANDBOX ISOLATED_WORKSPACE`. It verifies anonymous/wrong-owner rejection, obtains a terminal ticket, executes a signed WebSocket shell, writes a unique marker under `/sandbox`, lists it through the Files API, and downloads matching bytes. Add `--agents` for a Claude/Codex recipe to require both installed CLI version commands to succeed. It leaves the markers for inspection and refuses the default workspace. This operator test does not replace Google-authenticated browser sign-in and local-return validation.

Before promotion, verify workspace selection, resource imports, sandbox creation, ownership rejection, and source preservation. Promotion requires a matching artifact/configuration, preserved session revocations, and a tested route back to the previous release. Stop the staged units and close tunnels after the migration or test session. Test workspaces and imported resources can be retained for inspection or explicitly removed after review.

The worker artifact must contain `ui` source/package/vendor files, default policy files, and `deploy/gcp` host setup/startup/service scripts. Exclude `.git`, `.env`, `.state`, `node_modules`, local keys, Terraform state/plans and `.terraform`. Keep existing policy and `.state` when updating the control plane. Build UI before restarting `openrod-console`. Artifact bytes must match the configured checksum. Do not replace the artifact while a worker is bootstrapping against its previous checksum; wait for pending workers to finish before releasing a new artifact. Workers fetch only through a per-worker authenticated endpoint over the private network, verify the checksum and install pinned Node v24.21.0/OpenShell v0.1.2. Root bootstrap credentials never reach users' browsers.

## Docker DNS and metadata protection

Host bootstrap configures Docker with public DNS resolvers `8.8.8.8` and `8.8.4.4`. GCP's host resolver is `169.254.169.254`; using it inside Docker conflicts with the link-local metadata guard and causes image builds to hang or fail during package downloads. Keep the `DOCKER-USER` link-local rejection enabled. Image recipes use `apt-get update --error-on=any` so failed repository downloads remain visible.

Include `deploy/gcp/configure-docker.py` in every worker artifact. The helper accepts a fresh host or an earlier OpenRod Docker configuration, and refuses unexpected configurations. To update a running worker, run the reviewed helper as root, restart Docker, and restart `openrod-metadata-guard`; schedule the restart around active sandbox work. Verify DNS in a container and an actual Docker build `RUN` step, then confirm metadata HTTP remains blocked. Do not add a blanket firewall exception for metadata DNS.

## Verify a deployment

Local tests, the build and Terraform validation do not cover a live deployment. Verify actual runtime IAM transactions, private worker bootstrap, no attached service account/public IP, owner-specific HTTP/SSE/terminal routing, anonymous and wrong-owner rejection, two-way file transfer, container DNS, successful default template image builds and metadata blocking in both containers and build steps. Repeat DNS/build/metadata checks after Docker restart and VM reboot, including a freshly provisioned worker. Test retained workspace. Public sandbox service forwarding, worker backup/restore and enforced billing caps are not implemented.
