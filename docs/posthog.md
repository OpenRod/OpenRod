# Usage sharing and feedback

OpenRod runs on your computer, so the team only learns what works through usage it is allowed to see. Sharing is opt-in.

## What users see

On first opening, a small dialog asks **Help improve OpenRod: share anonymous usage data with us?** with **Share**, **Don’t send data** and **What do you collect?**. Nothing is sent before a choice. **Don’t send data** saves sharing off and sends one anonymous `telemetry_declined` event, without a saved ID, session, screen or location. Closing the dialog saves sharing off and sends nothing. The dialog doesn't ask again. **Usage & feedback** in the sidebar changes the choice and sends feedback. Feedback can be sent with sharing off.

## Turning it off

- Turn sharing off in **Usage & feedback**. This aborts pending usage requests, deletes the local IDs, and sends the same one-off decline event. Events PostHog already received stay there.
- Start OpenRod with `OPENROD_TELEMETRY=0` (or `false`, `off`, `no`), or with `DO_NOT_TRACK=1`, to turn off usage, decline events and feedback whatever the browser chose.

Only packages built by the publish workflow (`OPENROD_ANALYTICS_RELEASE=1`) report to production. Source builds, forks and previews send nothing. Set `OPENROD_ANALYTICS_DEV=1` at build time to send events marked `environment=development`. Cloud and worker modes never send usage.

## What is sent

A small client in the browser posts to PostHog's [capture API](https://posthog.com/docs/api/capture). There is no SDK, autocapture, session replay, retry or stored queue, and delivery failures are silent. Each event passes an allowlist of fields and fixed values; anything else is dropped.

| Event | Meaning |
| --- | --- |
| `telemetry_declined` | An explicit decline or turning sharing off; once per transition, with a fresh, unsaved ID and location disabled. |
| `console_opened` | The console's first known connection state. |
| `view_opened` | A product screen was opened. |
| `flow_started`, `flow_step_changed`, `flow_finished` | Connecting a gateway, creating a sandbox or opening a session: its stages and result (`connected`, `created`, `live`, `handoff_requested`, `failed`, `cancelled`), with a fixed error category. Only a failed attempt continues as a retry of the same flow. |
| `sandbox_ready` | A tracked sandbox later became Ready. |
| `feature_used` | A template build, setup import or activation, network rule or group save, activity filter, file upload, or sandbox start, stop or delete succeeded. |
| `feedback_submitted` | Text the user typed and sent, up to 2,000 characters. |

Events carry the app version, environment, a random installation ID and, while sharing is on, a session ID and the current screen. Feedback sent with sharing off carries only the text, the OpenRod version and a one-off ID.

Never sent: commands, terminal output, files, sandbox, host or template names, paths, repositories, credentials, URLs and error messages. Error messages are matched in the browser against OpenRod's own wording, and only the resulting category is sent.

PostHog (US) uses the sender's IP address to add an approximate location (country, city) to opted-in usage events. The project has **Discard client IP data** turned on, so the address itself is not stored. Feedback sent with sharing off and decline events get no location. Person profiles are turned off in every event.

The public ingestion token in `ui/shared/analytics-release.json` can only write events. To send to another project, set `OPENROD_POSTHOG_TOKEN` and `OPENROD_POSTHOG_HOST` (a US or EU ingestion host) at build time.

## Local state

The browser keeps the choice, the random IDs and, for browser terminals opened in a new tab, a short-lived flow ID that is removed once the tab reads it. Turning sharing off deletes all of it except the choice.

## Dashboard

The production dashboard is [OpenRod usage and feedback](https://us.posthog.com/project/647098/dashboard/2172927). Its queries are in [posthog-dashboard.sql](posthog-dashboard.sql). Missing events are not evidence of anything: offline users and blocked requests are never seen. Decline events count choices, not unique users, and anonymous IDs are not people.
