import { cloudConfig } from '../../ui/server/security.js'
import { createCloudRuntime } from '../../ui/server/cloud-runtime.js'

// Read-only deployment check: validates artifact/config, obtains ADC, and reads
// the named registry. It never reserves a fleet slot or calls Compute create.
let runtime
try {
  const config = cloudConfig()
  runtime = await createCloudRuntime(config)
  console.info(JSON.stringify({ ready: await runtime.ready(), mode: config.mode, project: config.firebase.projectId, origin: config.origin, computeProvisioned: false }))
} catch (error) {
  console.error(`OpenRod Cloud preflight failed: ${error.message}`)
  process.exitCode = 1
} finally { await runtime?.close() }
