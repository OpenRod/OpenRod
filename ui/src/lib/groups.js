import { appliesTo } from "@/lib/egress"

// Groups collect sandboxes so egress policies can follow them. Membership is
// stored by the console (server/org.js), so a sandbox can change groups.

export const groupId = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48).replace(/-$/, "")

// The group a sandbox is in, from the console's overview.
export const groupFor = (org, name) => org?.assignments?.[name] ?? null

// The policies that reach one sandbox, whether or not it exists yet.
export const policiesFor = (policies, sandbox) => (policies ?? []).filter((p) => appliesTo(p, sandbox))

// The policies aimed at a group itself, not at every sandbox.
export const groupPolicies = (policies, id) => (policies ?? []).filter((p) => !p.appliesTo.everyone && p.appliesTo.groups.includes(id))
