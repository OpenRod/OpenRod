-- Saved panels: https://us.posthog.com/project/647098/dashboard/2172927
-- Production only, rolling 30 days. Observations are not a complete user census.

-- Activation: separate creation, readiness, browser live and native handoff.
SELECT event, properties.flow AS flow, properties.outcome AS outcome,
       uniq(distinct_id) AS anonymous_ids, count() AS observations
FROM events
WHERE properties.environment = 'production' AND timestamp >= now() - INTERVAL 30 DAY
  AND (event IN ('console_opened', 'flow_started', 'sandbox_ready')
       OR (event = 'flow_finished' AND properties.outcome IN ('connected', 'created', 'live', 'handoff_requested')))
GROUP BY event, flow, outcome ORDER BY observations DESC;

-- Friction: explicit results and attempt numbers; missing finishes are unknown.
SELECT properties.flow AS flow, properties.outcome AS outcome,
       properties.error_category AS error_category, properties.attempt AS attempt,
       count() AS observations
FROM events
WHERE event = 'flow_finished' AND properties.environment = 'production'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY flow, outcome, error_category, attempt ORDER BY observations DESC;

-- Meaningful adoption; intent is historical, with new observations unspecified.
SELECT coalesce(properties.intent, 'unspecified') AS intent,
       properties.feature AS feature, properties.action AS action,
       uniq(distinct_id) AS anonymous_ids, count() AS observations
FROM events
WHERE event = 'feature_used' AND properties.environment = 'production'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY intent, feature, action ORDER BY observations DESC;

-- Return use: distribution of observed active days, not a cohort retention rate.
SELECT active_days, count() AS anonymous_ids FROM (
  SELECT distinct_id, uniq(toDate(timestamp)) AS active_days FROM events
  WHERE properties.environment = 'production' AND timestamp >= now() - INTERVAL 30 DAY
    AND (event = 'feature_used' OR (event = 'flow_finished' AND properties.outcome IN ('live', 'handoff_requested')))
  GROUP BY distinct_id
) GROUP BY active_days ORDER BY active_days ASC;

-- Explicit feedback: includes one-off feedback from users with sharing off.
SELECT timestamp, properties.intent AS intent, properties.prompt AS prompt,
       properties.category AS category, properties.goal_achieved AS goal_achieved,
       properties.text AS feedback, properties.feedback_only AS feedback_only,
       properties.flow_id AS flow_id
FROM events
WHERE event = 'feedback_submitted' AND properties.environment = 'production'
  AND timestamp >= now() - INTERVAL 30 DAY
ORDER BY timestamp DESC LIMIT 200;
