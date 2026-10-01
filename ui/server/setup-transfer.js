import { randomUUID } from 'node:crypto'
import { fail } from './setup-discovery.js'
// ExecSandbox messages are limited to 1 MB. Stage bounded chunks rather than
// sending package archives or large skill snapshots in a single RPC.
export async function withSandboxInput(client, sandbox, data, use) {
  const file = '/tmp/openshell-setup-' + randomUUID()
  try {
    for (let offset = 0; offset < data.length; offset += 512 * 1024) {
      const script = `import os,sys,stat\np=sys.argv[1];offset=int(sys.argv[2]);fd=os.open(p,os.O_WRONLY|os.O_NOFOLLOW|(os.O_CREAT|os.O_EXCL if offset==0 else os.O_APPEND),0o600)\nwith os.fdopen(fd,'ab') as f:\n s=os.fstat(f.fileno())\n if not stat.S_ISREG(s.st_mode) or s.st_size!=offset: raise ValueError('Invalid staged input')\n f.write(sys.stdin.buffer.read())`
      const result = await client.sandbox.exec(sandbox.name, ['python3', '-c', script, file, String(offset)], { workspace: sandbox.workspace, noLoginShell: true, stdin: data.subarray(offset, offset + 512 * 1024), timeoutSecs: 30 })
      if (result.exitCode !== 0) throw fail('Could not stage Setup files. Check Python and writable temporary storage.', 409)
    }
    return await use(file)
  } finally {
    await client.sandbox.exec(sandbox.name, ['python3', '-c', 'import os,sys;os.unlink(sys.argv[1])', file], { workspace: sandbox.workspace, noLoginShell: true, timeoutSecs: 10 }).catch(() => {})
  }
}
