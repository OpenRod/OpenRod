// The OpenShell release OpenRod is tested with. Bump all of these together, and
// also gateway-install.js (VERSION, RELEASES digests), remote-runtime.js (image and
// version check), remote-hosts.js (chart) and policy.js (provider URL).
export const OPENSHELL_VERSION = '0.1.2'
export const OPENSHELL_TAG = `v${OPENSHELL_VERSION}`
export const INSTALL_URL = `https://raw.githubusercontent.com/NVIDIA/OpenShell/${OPENSHELL_TAG}/install.sh`
// install.sh at tag v0.1.2 (commit 6648bd0c290efbc41ba131ee9831ee45cd431f94), 45210 bytes.
export const INSTALL_SHA256 = '5c98a86a4b811c471b212219cb2a62d458244220ffa71ac8e3baf3700b17b871'
export const INSTALL_COMMAND = `curl -LsSf ${INSTALL_URL} | OPENSHELL_VERSION=${OPENSHELL_TAG} sh`
