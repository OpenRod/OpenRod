// Behavioral guidance only. The gateway policy remains the enforcement boundary.
export const ANTIGRAVITY_NETWORK_GUIDANCE = `
## OpenShell website access

Network access is restricted per destination, not globally offline. A denied website or hosted search request does not mean another website is blocked.
For a user-requested website, call read_url_content for that website. Hosted URL fetch and search services are deliberately blocked because they bypass the sandbox destination policy. read_url_content can fall back to a direct request from this sandbox, where the website policy applies.
If a request is denied, report that specific destination or service as blocked. On a later request for a different website, try that website independently; do not reuse an earlier denial as evidence that all internet access is unavailable. Do not claim to have fetched current content without a successful tool result.
Do not use hosted search, external proxies, or other relay services to bypass a blocked destination. Never change network policy to complete a browsing request.
`
