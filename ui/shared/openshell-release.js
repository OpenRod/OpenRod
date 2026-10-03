// The OpenShell release OpenRod is tested with. Bump all of these together, and
// also gateway-install.js (VERSION, RELEASES digests), remote-runtime.js (image and
// version check), remote-hosts.js (chart) and policy.js (provider URL).
export const OPENSHELL_VERSION = '0.1.2'
export const OPENSHELL_TAG = `v${OPENSHELL_VERSION}`
export const INSTALL_URL = `https://raw.githubusercontent.com/NVIDIA/OpenShell/${OPENSHELL_TAG}/install.sh`
// install.sh at tag v0.1.2 (commit 6648bd0c290efbc41ba131ee9831ee45cd431f94), 45210 bytes.
export const INSTALL_SHA256 = '5c98a86a4b811c471b212219cb2a62d458244220ffa71ac8e3baf3700b17b871'
export const INSTALL_COMMAND = `curl -LsSf ${INSTALL_URL} | OPENSHELL_VERSION=${OPENSHELL_TAG} sh`
// On macOS sandboxes run in the MicroVM driver (e2fsprogs plus gateway.env), set
// up before the installer so its first gateway start already uses it.
export const MAC_INSTALL_COMMAND = `brew install e2fsprogs && mkdir -p ~/.config/openshell && { [ -e ~/.config/openshell/gateway.env ] || echo OPENSHELL_COMPUTE_DRIVER=vm > ~/.config/openshell/gateway.env; } && ${INSTALL_COMMAND}`
export const installCommand = (platform) => platform === 'darwin' ? MAC_INSTALL_COMMAND : INSTALL_COMMAND
