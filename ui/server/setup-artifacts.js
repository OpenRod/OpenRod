import fs from 'node:fs/promises'
import path from 'node:path'
import { artifactFile } from './setup-packages.js'
import { withSandboxInput } from './setup-transfer.js'
import { fail } from './setup-discovery.js'
const extractor = await fs.readFile(path.join(import.meta.dirname, 'setup-artifact-installer.py'), 'utf8')
export async function installArtifacts(client, sandbox, items) {
  for (const artifact of new Map(items.filter(i => i.artifact).map(i => [i.artifact.digest, i.artifact])).values()) {
    const runtime = await client.sandbox.exec(sandbox.name, ['node', '-e', "console.log(JSON.stringify({arch:process.arch,platform:process.platform,major:process.versions.node.split('.')[0],glibc:Boolean(process.report.getReport().header.glibcVersionRuntime)}))"], {workspace:sandbox.workspace,noLoginShell:true,timeoutSecs:10})
    let compatible = false
    try { const env=JSON.parse(runtime.stdout.toString()); compatible = env.arch === artifact.arch && env.platform === 'linux' && env.major === artifact.node.split('.')[0] && env.glibc } catch {}
    if (!compatible) throw fail('Prepared package needs Linux with glibc, Node.js 22 and the same CPU architecture as its builder. Rebuild for this target.',409)
    if (!/^[a-f0-9]{64}$/.test(artifact.digest)) throw fail('Invalid package digest.',409)
    const baked = `/sandbox/.openshell/bundles/${artifact.digest}.tar.gz`
    const present = await client.sandbox.exec(sandbox.name, ['python3', '-c', 'import os,sys;sys.exit(0 if os.path.isfile(sys.argv[1]) else 1)', baked], { workspace:sandbox.workspace, noLoginShell:true, timeoutSecs:10 })
    const extract = file => client.sandbox.exec(sandbox.name, ['python3', '-c', `import sys;sys.stdin=open(sys.argv[2], 'r');\n${extractor}`, artifact.digest, file], { workspace: sandbox.workspace, noLoginShell: true, timeoutSecs: 120 })
    // Baked archives receive the same digest/traversal checks as uploaded ones.
    const result = present.exitCode === 0 ? await extract(baked) : await withSandboxInput(client, sandbox, (await artifactFile(artifact)).data, extract)
    let output
    try { output = JSON.parse(result.stdout.toString()) } catch { throw fail('Prepared package could not be installed.', 409) }
    if (result.exitCode !== 0 || output.error) throw fail(output.error || 'Prepared package could not be installed.', 409)
  }
}
