import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createCompute, workerDeploymentConfig } from './compute.js'
import { createMachineStore, createMachineManager, workerReady } from './machines.js'
import { createCloudConnections } from './cloud-connections.js'
import { createHandoffs } from './cloud-proxy.js'
import { workerPrefix, ownerLabel } from './cloud-deployment.js'

// Keep the Admin SDK outside the local npm package and worker installation.
// Only the explicitly selected cloud control plane ever loads it.
async function loadCloudAdmin() {
  const require = createRequire(new URL('../../deploy/gcp/runtime/package.json', import.meta.url))
  try {
    return { ...require('firebase-admin/app'), ...require('firebase-admin/auth'), ...require('firebase-admin/firestore') }
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') throw Error('Cloud runtime dependencies are missing. Run npm ci --prefix deploy/gcp/runtime from the repository root.')
    throw error
  }
}

export function cloudRuntimeConfig(config, env = process.env) {
  if (config.mode !== 'cloud') throw Error('Cloud runtime requires cloud mode')
  const maxMachines = Number(env.OPENROD_MAX_MACHINES ?? 10)
  if (!Number.isInteger(maxMachines) || maxMachines < 1 || maxMachines > 100) throw Error('OPENROD_MAX_MACHINES must be between 1 and 100')
  const databaseId = env.OPENROD_FIRESTORE_DATABASE ?? 'openrod-cloud'
  if (!/^[a-z][a-z0-9-]{2,61}[a-z0-9]$/.test(databaseId)) throw Error('Invalid OPENROD_FIRESTORE_DATABASE')
  const artifact = env.OPENROD_WORKER_ARTIFACT
  if (!artifact || !path.isAbsolute(artifact)) throw Error('OPENROD_WORKER_ARTIFACT must identify the reviewed worker artifact by absolute path')
  const prefix = workerPrefix(env.OPENROD_WORKER_PREFIX), label = ownerLabel(env.OPENROD_WORKER_OWNER_LABEL)
  if (env.OPENROD_PROVISIONING_ENABLED !== undefined && !['true', 'false'].includes(env.OPENROD_PROVISIONING_ENABLED)) throw Error('OPENROD_PROVISIONING_ENABLED must be true or false')
  return { maxMachines, databaseId, artifact, prefix, ownerLabel: label, allowProvisioning: env.OPENROD_PROVISIONING_ENABLED !== 'false', deployment: workerDeploymentConfig(config, env) }
}

export async function verifyWorkerArtifact(filename, expectedHash) {
  if (!fs.statSync(filename).isFile()) throw Error('Worker artifact must be a regular file')
  const digest = createHash('sha256')
  for await (const chunk of fs.createReadStream(filename)) digest.update(chunk)
  if (digest.digest('hex') !== expectedHash) throw Error('Worker artifact checksum does not match OPENROD_WORKER_ARTIFACT_SHA256')
}

export async function createCloudRuntime(config, { env = process.env, revocations, loadAdmin = loadCloudAdmin, computeFactory = createCompute } = {}) {
  const settings = cloudRuntimeConfig(config, env)
  await verifyWorkerArtifact(settings.artifact, settings.deployment.artifactHash)
  const admin = await loadAdmin()
  const credential = admin.applicationDefault()
  const app = admin.initializeApp({ projectId: config.firebase.projectId, credential }, `openrod-${randomUUID()}`)
  let db, closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try { await db?.terminate() } finally { await admin.deleteApp(app) }
  }
  try {
    const auth = admin.getAuth(app)
    db = admin.getFirestore(app, settings.databaseId)
    // Fail startup before advertising readiness if ADC or registry IAM is broken.
    // This is read-only and never reserves a fleet slot or creates a VM.
    await credential.getAccessToken()
    await db.collection('control').doc('fleet').get()
    const compute = await computeFactory(config, credential, { env })
    const store = createMachineStore(db, { maxMachines: settings.maxMachines, prefix: settings.prefix })
    const machines = createMachineManager(store, compute, { ownerLabel: settings.ownerLabel, allowProvisioning: settings.allowProvisioning, ready: (record, address) => workerReady(record, address, { host: config.host, protocol: record.workerProtocol ?? config.workerProtocol }) })
    const handoffs = createHandoffs(db, Date.now, settings.prefix)
    const connections = createCloudConnections(db, auth, { org: config.org, isSessionRevoked: hash => revocations?.hasDigest(hash) ?? false })
    return { auth, machines, handoffs, connections, artifact: settings.artifact, close, async ready() { await db.collection('control').doc('fleet').get(); return true } }
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}
