# Optional usage and feedback

OpenRod runs locally. Usage sharing starts only after the authorized browser user chooses **Share anonymous usage**. **Usage & feedback** in the sidebar lets them turn sharing off, change their optional goal, or submit feedback. Closing the first prompt declines sharing. General feedback can be sent explicitly while usage sharing is off, using a one-off anonymous ID.

## Delivery and configuration

A small browser client calls PostHog’s [public capture API](https://posthog.com/docs/api/capture) directly. There is no analytics dependency, SDK download, autocapture, replay, survey SDK, feature-flag request, retry, proxy, or disk queue. At most six requests are in flight, capped at 120 per minute. Each request has a three-second abort timeout. Network, DNS, blocker, HTTP, storage and synchronous exceptions are silent; product operations never await capture. Closing the page can lose an event. Feedback submission closes the form without promising delivery; **Copy text** keeps a copy available to the user.

Production builds use the public ingestion token and US endpoint in `ui/shared/analytics-release.json`, for project 647098. This is a write-only public token, not a personal or administrative API key. For another project, set `OPENROD_POSTHOG_TOKEN` and `OPENROD_POSTHOG_HOST` at build time (US/EU ingestion endpoints only). Set the token to an empty string to build without capture.

Set `OPENROD_TELEMETRY=0` (or `false`) before starting the server to disable all usage and feedback requests, even with saved consent. Development capture is off unless `OPENROD_ANALYTICS_DEV=1`; its events carry `environment=development`. Cloud/worker modes, unauthorized pages, launch-token/handoff URLs and development fleet fixtures are excluded. Runtime configuration is returned only after the existing launch-cookie gate; authentication is unchanged.

## Events and interpretation

Every event has `schema_version`, `app_version`, `environment`, and a random anonymous installation ID. Opted-in events have a session ID with a 30-minute inactivity window and may include a fixed view/goal enum. IDs are scoped to browser storage for the console origin, including its port: different browsers or ports are separate observations.

| Event | Meaning |
| --- | --- |
| `console_opened` | Initial observable gateway state, including an already connected gateway. `first_observed_visit` means a fresh local anonymous ID, not a verified new user. |
| `view_opened` | A change to an allowlisted product screen; no URL, referrer or search terms. |
| `intent_selected` | Explicit selection from project, access, tools, remote, exploring or other. |
| `flow_started` | A submitted connection, sandbox creation or session launch attempt. Safe choices/counts only. |
| `flow_step_changed` | Entered or blocked stage; repeated status polling is deduplicated. Pre-submit exploration has attempt zero. |
| `flow_finished` | Observed connected, created, live, handoff requested, failed or cancelled result. A stable `flow_id` and attempt correlate supported retries. |
| `sandbox_ready` | A tracked creation subsequently observed Ready, distinct from its create response. |
| `feature_used` | Successful template build, setup import/activation, network rule or group membership save, activity filter application, file upload, or sandbox start/stop/delete. |
| `feedback_prompted` | Optional goal/outcome/blocker prompt shown or dismissed. |
| `feedback_submitted` | Explicit text (maximum 2,000 characters), category, optional goal achieved and flow correlation. |

A browser session is `live` only after its WebSocket confirms readiness. Native Terminal/VS Code/Cursor success is **handoff_requested**: OpenRod cannot observe whether the external app became useful. Sandbox creation finishes `created`; readiness is a separate event. Closing the creation dialog does not cancel its background job. Pre-submit dialog cancellation has `start_observed=false` and no duration. Reloads, crashes and lost events can leave unmatched starts.

Optional goal selection follows opt-in. Outcome feedback is offered to a stable 25% sample, after a successful session launch and a one-minute delay in the main console. Two failures of a correlated attempt can offer blocker feedback. Outcome/blocker prompts share a seven-day cooldown; general feedback stays available manually. Browser-origin preferences and safe flow correlation can synchronize between tabs. Revocation aborts in-flight requests and prevents old workflows from being attributed after re-enabling sharing.

## Privacy and local state

An event-specific allowlist strips unknown fields. Names, hosts, paths, repositories, commands, terminal output, setup contents, credential values, request bodies, raw errors and full URLs are never supplied to the transport. Known structured errors map to fixed categories; unknown errors stay `unknown`. Feedback text is the only free-form field and is transmitted only when the user explicitly submits it. Ask users to omit private details.

No cookies or referrers are sent. Geo-IP enrichment and person profiles are disabled, although PostHog still receives ordinary network metadata such as IP addresses. Consent is not an assertion of perfect anonymity. Turning sharing off deletes the local ID, session, goal and correlation state, but leaves the preference and feedback cooldown. Already received events are not retracted. Nothing is stored in the server’s activity archive for telemetry, and there is no offline event backlog.

## Review dashboard

[OpenRod — intent, activation and feedback](https://us.posthog.com/project/647098/dashboard/2172927) uses production events only, with a rolling 30-day window. Its five saved SQL panels are reproduced in [posthog-dashboard.sql](posthog-dashboard.sql). Track activation observations, friction and retry outcomes, meaningful feature use by intent, return activity, and explicit feedback. Keep browser live sessions and external handoffs separate. Do not interpret absent events as abandonment or compute a delivery/opt-in rate: offline users and declined sharing are unobserved. Anonymous IDs do not equal people; public ingestion tokens also permit spoofed events.

Read feedback alongside behavior: repeated failures suggest friction, an unmet stated goal suggests a gap, and missing-capability feedback identifies work that click tracking cannot reveal. CLI-only behavior, external app usage, ignored features, users who decline sharing and offline sessions remain blind spots.

## Verification

`cd ui && npm test && npm run build`. Analytics tests inject storage, clock and transport to verify consent, field filtering, silent failures, bounded requests, revocation, retries, readiness, cross-tab correlation and prompt cooldown. The isolated browser smoke test uses development events; real Docker/SSH provisioning remains covered by existing server tests and requires a separate live environment.
