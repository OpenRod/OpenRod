# Minimal PostHog integration plan

The implementation and operational details are in [posthog.md](posthog.md).

1. **Understand intent.** Offer one optional goal question after opt-in; carry the fixed goal enum into subsequent observations.
2. **Understand behavior.** Explicitly observe console state, screen changes, connection/creation/session stages and successful feature use. Keep created vs Ready, browser live vs native handoff, and exploration vs submitted attempts separate.
3. **Understand friction.** Correlate supported retries and structured failure categories, without sending raw errors or treating missing events as failures.
4. **Hear what is missing.** Provide manual feedback and lightly sampled contextual outcome/blocker prompts, with skip and cooldown controls. Free-form feedback is submitted explicitly.
5. **Respect local execution.** Require opt-in, retain only small preference/correlation records, and silently drop blocked/offline requests. Avoid queues, retries, logs and any dependency on analytics for product operations.
6. **Review evidence.** Use one production-only dashboard for activation, friction, adoption, return use and feedback. Combine stated goals and feedback with observed actions; document offline, opt-out and external-app blind spots.

The transport uses PostHog’s public capture API directly rather than a full SDK. The release public token is bundled; runtime disable and build overrides are documented. Autocapture, replay, heatmaps, web vitals, person profiles and geo-IP enrichment are excluded.
