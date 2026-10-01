import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'

test('artifact extraction rejects traversal, escaping links, hardlinks and digest mismatch', async () => {
  const source = await fs.readFile(new URL('./setup-artifact-installer.py', import.meta.url), 'utf8')
  const script = `
import io, tarfile, tempfile, pathlib, hashlib, subprocess, sys, json
source=json.loads(sys.stdin.read())
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory).resolve()/'packages'
 code=source.replace("root = pathlib.Path('/sandbox/.openshell/packages')", 'root = pathlib.Path('+repr(str(root))+')')
 def check(name, kind='file', link='', mismatch=False):
  data=io.BytesIO()
  with tarfile.open(fileobj=data,mode='w:gz') as archive:
   item=tarfile.TarInfo(name)
   if kind=='symlink': item.type=tarfile.SYMTYPE; item.linkname=link
   elif kind=='hardlink': item.type=tarfile.LNKTYPE; item.linkname=link
   else: item.size=2
   archive.addfile(item,io.BytesIO(b'ok') if kind=='file' else None)
  blob=data.getvalue(); digest=hashlib.sha256(blob).hexdigest()
  result=subprocess.run([sys.executable,'-c',code,'0'*64 if mismatch else digest],input=blob,capture_output=True)
  return result.returncode
 assert check('../escape')!=0
 assert check('/tmp/escape')!=0
 assert check('link','symlink','../../escape')!=0
 assert check('link','hardlink','target')!=0
 assert check('index.js',mismatch=True)!=0
 assert check('index.js')==0
 assert not (pathlib.Path(directory)/'escape').exists()
`
  const result=spawnSync('python3',['-c',script],{input:JSON.stringify(source),encoding:'utf8'})
  assert.equal(result.status,0,result.stderr)
})
