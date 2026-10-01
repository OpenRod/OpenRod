# Private AWS evaluation

**Archived administrator-run evaluation, not the normal connection flow.** The [console connection guide](../../README.md#set-up-a-connection) now uses SSH hosts and a second local gateway. The console does not deploy AWS/Kubernetes resources or run commands on this page. These existing evaluation files remain available for explicit administrator use.

These files preserve the configuration used for the AWS SSH smoke: EKS 1.35, one `t3.large` AL2023 worker, VPC CNI network-policy enforcement, encrypted gp3 storage, Agent Sandbox 1.0.4, and OpenShell 0.1.2. They create billable resources in `eu-central-1`. This is a single-node evaluation, not a highly available production platform.

**Do not expose this gateway publicly.** Its Service is ClusterIP and the example uses a loopback Kubernetes port-forward. `allowUnauthenticatedUsers: true` deliberately bypasses OpenShell user authorization; mTLS does not replace Kubernetes-driver user authentication. Use a dedicated cluster with trusted workloads and tightly controlled Kubernetes/Secret access. Public or shared use requires an upstream OIDC/trusted-proxy setup and console support for that authentication mode; the console currently supports mTLS registrations only.

The EKS Kubernetes API is publicly reachable with AWS authentication. Workers use public subnets, avoiding NAT gateway cost. No EC2 SSH ingress or public sandbox SSH listener is configured. Review endpoint CIDR restrictions and node/network architecture before adapting this example.

## Provision

Prerequisites for the **administrator**, not every console user: AWS CLI with `aws login`, `eksctl`, `kubectl`, Helm, Python 3, and OpenShell CLI 0.1.2. Authenticate as a suitably authorized non-root IAM principal using short-term credentials. Commands below run from the repository root. Profile `openshell-aws`, cluster/context `openshell-remote`, gateway `aws-eks`, and sandbox `aws-ssh-test` are evaluation example names, not pre-existing account-specific prerequisites. Choose another cluster name/region in `cluster.yaml` if needed; update the commands consistently.

```bash
aws login --profile openshell-aws
export AWS_PROFILE=openshell-aws
export AWS_REGION=eu-central-1
aws sts get-caller-identity

eksctl create cluster --config-file deploy/aws/cluster.yaml
aws eks update-kubeconfig --name openshell-remote --alias openshell-remote
kubectl --context openshell-remote apply -f deploy/aws/storage-class.yaml
kubectl --context openshell-remote apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.4/sandbox.yaml
kubectl --context openshell-remote get pods -n agent-sandbox-system

helm upgrade --install openshell oci://ghcr.io/nvidia/openshell/helm-chart \
  --version 0.1.2 --kube-context openshell-remote \
  --namespace openshell --create-namespace \
  --values deploy/aws/openshell-values.yaml --wait --timeout 10m
kubectl --context openshell-remote -n openshell get pods,pvc,services
```

Wait for the controller and gateway to be ready before creating a sandbox. The chart installs sandbox-network policies; the VPC CNI must actually enforce them. Merely observing a NetworkPolicy object is not evidence of enforcement.

## Connect privately

Keep this running in its own terminal with the AWS profile above. Explicit loopback binding keeps the gateway private:

```bash
kubectl --context openshell-remote -n openshell port-forward \
  --address 127.0.0.1 svc/openshell 18080:8080
```

If you already have this evaluation's valid `aws-eks` registration, skip registration and proceed to the environment-pinned console launch below. Do not overwrite an unrelated registration.

The following administrator-run block reads the chart's client bundle once into a private temporary directory without printing secrets, installs it before registration, then restores that **same original bundle** afterward—even if the CLI exits unsuccessfully. It refuses an existing registration directory (including a symlink). Run it in another terminal with the same AWS profile:

```bash
(
  set -eu
  umask 077
  config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/openshell"
  target="$config_dir/gateways/aws-eks"
  if [ -e "$target" ] || [ -L "$target" ]; then
    printf '%s\n' 'Registration name aws-eks already exists; refusing to overwrite.' >&2
    exit 1
  fi
  bundle=$(mktemp -d "${TMPDIR:-/tmp}/openshell-client.XXXXXX")
  trap 'rm -f "$bundle/ca.crt" "$bundle/tls.crt" "$bundle/tls.key"; rmdir "$bundle"' EXIT
  export BUNDLE_DIR="$bundle"
  python3 - <<'PY'
import base64, json, os, pathlib, subprocess
target = pathlib.Path(os.environ['BUNDLE_DIR'])
target.chmod(0o700)
secret = json.loads(subprocess.check_output([
    'kubectl', '--context', 'openshell-remote', '-n', 'openshell',
    'get', 'secret', 'openshell-client-tls', '-o', 'json'
]))['data']
for name in ('ca.crt', 'tls.crt', 'tls.key'):
    destination = target / name
    with os.fdopen(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as file:
        file.write(base64.b64decode(secret[name], validate=True))
PY
  mkdir -p "$config_dir/gateways"
  mkdir "$target" "$target/mtls"
  chmod 700 "$target" "$target/mtls"
  copy_original_bundle() {
    for file in ca.crt tls.crt tls.key; do
      install -m 600 "$bundle/$file" "$target/mtls/$file" || return
    done
  }
  copy_original_bundle
  result=0
  "${OPENSHELL_BIN:-openshell}" gateway add https://127.0.0.1:18080 \
    --name aws-eks --local || result=$?
  copy_original_bundle
  exit "$result"
)
```

The second copy is intentional: **OpenShell 0.1.2 registration was observed replacing the preinstalled bundle**. Do not omit restoration or disable TLS verification. A failed registration may leave a partial directory; inspect it rather than bypassing the guard. `--local` describes the tunnel endpoint, not where the workload executes. This step writes `metadata.json` and mode-0600 files in `gateways/aws-eks/mtls/` under `$XDG_CONFIG_HOME/openshell` (otherwise `~/.config/openshell`) and may change the CLI's active gateway. It does not select the console context. Non-loopback remote registrations use the administrator's existing CLI workflow, not this tunnel command or an invented `--mtls` flag.

A console user without Kubernetes Secret access should receive an approved registration from the administrator through a secure channel, not broaden their cluster privileges to run this extraction.

## Create and validate a sandbox

The administrator creates the evaluation sandbox; this is a remote mutation, not a connection check:

```bash
openshell --gateway aws-eks --workspace default sandbox create \
  --name aws-ssh-test --from ubuntu:24.04 \
  --no-tty --detach --no-auto-providers -- /bin/sleep infinity

kubectl --context openshell-remote -n openshell get pods
```

The simplified connection picker no longer contains Kubernetes registration/check steps. To inspect this existing evaluation explicitly, keep its tunnel running and launch the console with `OPENSHELL_GATEWAY=aws-eks OPENSHELL_WORKSPACE=default npm start` from `ui/`, after building it as described in [the source instructions](../../README.md#run-from-source). This environment-pinned mode activates immediately; it is not a read-only connection check. Restore the tunnel or cloud login if connectivity fails.

Activation starts activity collection. Existing configured delivery workers and service-close deadlines can resume; organization-policy sweeping stays off unless `OPENSHELL_CONSOLE_SWEEP=1`. Read the [persistent-effects summary](../../README.md#what-is-saved-and-what-runs).

Open `aws-ssh-test` once it is **Ready**, then choose **SSH shell → Open SSH in terminal**. Run `hostname` and `pwd`; for this evaluation they should be `default--aws-ssh-test` and `/sandbox`. Exit normally and verify temporary SSH config cleanup; direct SSH does not write `~/.ssh/config`. The uncustomized Ubuntu image may lack a passwd entry for the runtime's UID 10001, producing `I have no name!` or `whoami` warnings. This does not indicate an SSH transport failure; use an image with the intended runtime identity for normal development.

Also verify **Open in browser** separately: it is an SDK-backed terminal, not OpenSSH. A default-deny network check must compare direct workload-pod traffic against a permitted control path; OpenShell-mediated exec/SSH traffic intentionally goes through the supervisor and is not a bypass probe. For missing tools, certificates, workspace access, unsupported auth, or a sandbox that is not Ready, follow the [symptom-based troubleshooting table](../../README.md#troubleshooting).

## Costs and teardown

EKS control-plane time, EC2, EBS, public IPv4, and data transfer continue billing while this environment exists. Stopping a sandbox or closing the browser does not stop cluster billing. No cleanup command is run automatically.

When you intentionally want to destroy this evaluation, first export any data you need and delete its sandbox through OpenShell. Then stop the port-forward and remove the cluster:

```bash
# Destructive: deletes this evaluation sandbox and cluster.
openshell --gateway aws-eks --workspace default sandbox delete aws-ssh-test
AWS_PROFILE=openshell-aws eksctl delete cluster --name openshell-remote --region eu-central-1 --wait
```

Confirm CloudFormation deletion succeeds and inspect for retained EBS volumes, snapshots, and other resources before assuming billing has stopped. Remove the local `aws-eks` registration and client bundle only when no longer needed. If this was the console's saved selection, stop the console and move aside its `console-context.json` before starting it again, or activate another valid context. Removing the cluster or registration does not erase local Activity archives, delivery configuration, or service deadlines; review those separately using the [local-state reference](../../ui/README.md#console-data-directory).

Sources: [OpenShell upstream](https://github.com/NVIDIA/OpenShell), [Kubernetes setup](https://docs.nvidia.com/openshell/kubernetes/setup), [OpenShell access control](https://docs.nvidia.com/openshell/kubernetes/access-control), [Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox/releases/tag/v1.0.4), [EKS VPC CNI network policies](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy.html).
