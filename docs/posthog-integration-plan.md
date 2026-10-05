# Minimal PostHog integration plan

The implementation and operational details are in [posthog.md](posthog.md).

1. **Understand intent.** Infer interests from explicit feature choices and manual feedback; do not ask onboarding questions.
2. **Understand behavior.** Explicitly observe console state, screen changes, connection/creation/session stages and successful feature use. Keep created vs Ready, browser live vs native handoff, and exploration vs submitted attempts separate.
3. **Understand friction.** Correlate supported retries and structured failure categories, without sending raw errors or treating missing events as failures.
4. **Hear what is missing.** Keep feedback available manually. Do not interrupt users with outcome surveys or blocker questions.
5. **Respect local execution.** Offer a small, muted sidebar notice with **Share anonymous usage**, **No thanks**, and **What is being shared?**, without interrupting the console. Collect no usage events until sharing is chosen; save **No thanks** as sharing off. Let users read technical collection and delivery details without changing consent, also through **Usage & feedback**. Retain only small preference/correlation records and silently drop blocked/offline requests. Avoid queues, retries, logs and any dependency on analytics for product operations.
6. **Review evidence.** Use one production-only dashboard for activation, friction, adoption, return use and feedback. Combine manual feedback with observed actions; document offline, opt-out and external-app blind spots.

The transport uses PostHog’s public capture API directly rather than a full SDK. The release public token is bundled; runtime disable and build overrides are documented. Autocapture, replay, heatmaps, web vitals, person profiles and geo-IP enrichment are excluded.
